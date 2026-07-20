# TECHI Agent v2.0 — Ndryshimet e Plota

> **SHËNIM SIGURIE (2026-07):** Ky dokument përshkruan historikun e v2.0.
> `set_remote_password` me plaintext është hequr dhe refuzohet; kontrata
> aktuale është `docs/architecture/remote-support-credentials.md`.
>
> **Agent 2.1.16 compatibility note (2026-07-20):** the current
> rollback-compatible agent release candidate restores Agent 2.1.6 communication
> behavior for backend `92a521c`: existing `agent_id` + `device_id` identities
> work without re-enrollment, `agent_credential` is not required, auth migration
> is disabled/removed from runtime, and heartbeat sends no HMAC
> `X-Techi-Agent-*` headers. Production canary is pending.

## Versioni: 1.0.0 → 2.0.0 | Data: Qershor 2026

---

## Skedarët e Modifikuar

### enrollment.go
- `agentVersion = "2.0.0"` (ishte "1.0.0")
- Konstanta ndikon te: enrollment request, heartbeat payload, log messages

### heartbeat.go
- `HeartbeatPayload` struct ka fushën e re: `AgentVersion string \`json:"agent_version,omitempty"\``
- `buildHeartbeatPayload()` vendos `AgentVersion: agentVersion` automatikisht
- Backend e ruan në `devices.agent_version` dhe e përdor për update check

### actions.go
- `HeartbeatResponse` struct zgjeruar:
  ```go
  HeartbeatIntervalSecs int          `json:"heartbeat_interval_seconds,omitempty"`
  AgentUpdate           *AgentUpdate `json:"agent_update,omitempty"`
  ```
- Struct i ri `AgentUpdate` (Available, Version, URL, Checksum)
- `pendingIntervalChange atomic.Int64` — global për interval dinamik
- `dispatch()` historikisht shtoi command cases; `set_remote_password` tani
  është retired dhe nuk dispatch-ohet.
- `handleChangeHeartbeatInterval()` — cross-platform, shkruan `pendingIntervalChange`

### agent.go
- `applyPendingInterval(*time.Duration)` — funksion i ri, lexon `pendingIntervalChange`
- Loop kryesor: pas çdo heartbeat cycle, aplikon intervalin e ri nëse ka ndryshuar
- `ticker.Reset(interval)` — ndryshimi është live, pa restart të service-it

### main.go (`runSingleHeartbeat`)
- Pas `processActions()`, proceson `HeartbeatIntervalSecs` → `pendingIntervalChange.Store()`
- Nëse `AgentUpdate.Available` → `go performSelfUpdate(hbResp.AgentUpdate)` (non-blocking)

### actions_windows.go
- `handleSetRemotePassword` është hequr; credential-et aplikohen vetëm me generation authority
- `handleRegisterTechiProtocol(ctx)`: regjistron `techiremotesupport://` në HKLM via PowerShell
- `handleRebootPC(ctx, params)`: `shutdown /r /t {delay} /f` (min 30s, max 3600s)
- `handleRunPowerShell(ctx, params)`: executes PS1 script me timeout (max 300s), output max 4096 chars
- `handleSelfUpdate(ctx, params)`: manual trigger, ndërton `AgentUpdate` nga params dhe thërret `performSelfUpdate()`

### actions_other.go
- Stubs për 5 funksionet e reja (Windows-only error message)

---

## Skedarët e Rinj

### update.go (`//go:build windows`)
- `performSelfUpdate(*AgentUpdate)` — shkarkimi + verifikimi + instalimi i MSI
- `downloadAgentMSI(url, dest)` — 3 tentativa me exponential backoff (30s/60s/90s)
- `installAgentMSI(msiPath)` — `msiexec /i /quiet /norestart REINSTALL=ALL`
- Ripërdor `downloadFile()`, `sha256Matches()`, `sanitizeCachePart()` nga `rustdesk_manage.go`
- Exit code 3010 (reboot required) trajtohet si sukses
- MSI cache path: `%ProgramData%\TechiAgent\cache\techi-agent-{version}.msi`

### update_other.go (`//go:build !windows`)
- Stub `performSelfUpdate()` — log message, pa gabim

### installer/installer.wxs
- WiX v4 Package, `UpgradeCode = A1B2C3D4-E5F6-7890-ABCD-EF1234567890` (KONSTANT)
- 3 komponentë: AgentExe, AgentService (me SCM auto-recovery), ProtocolReg
- Install path: `C:\Program Files\TECHI Agent\techi-agent.exe`
- Service: `TechiAgent`, auto-start, LocalSystem, recovery 1m/1m/5m
- Protocol: `HKLM\SOFTWARE\Classes\techiremotesupport\` me shell\open\command

### installer/build.bat
- Build script për Windows: `go build` → `wix build` → MSI
- Output: `TECHI-Endpoint-Deployment-2.0.0.msi` + SHA256 via certutil

### installer/build.sh
- Cross-compile script për macOS/Linux: `GOOS=windows go build` → `dotnet wix build`
- Output: SHA256 via `sha256sum` ose `shasum -a 256`

---

## Backend Ndryshimet (HAPI 8)

### alembic migration `c4d5e6f7a8b9`
```sql
ALTER TABLE devices ADD COLUMN agent_version VARCHAR(20);
```

### app/models/device.py
- `agent_version = Column(String(20), nullable=True)` shtuar para `client_id`

### app/schemas/device.py
- `DeviceUpdate` ka fushën e re: `agent_version: Optional[str] = None`

### app/schemas/agent.py
- `AgentHeartbeatPayload` ka fushën e re: `agent_version: Optional[str] = None`
- Klasa e re `AgentUpdateInfo` (available, version, download_url, sha256)
- `AgentHeartbeatResponse` ka fushën e re: `agent_update: Optional[AgentUpdateInfo] = None`

### app/api/v1/endpoints/agent.py
- Response dict ka `"agent_update": None` (populated në Faza 3 kur package service ekziston)

---

## Invariants (kurrë nuk ndryshojnë)

1. **Heartbeat endpoint**: `POST /api/v1/agent/heartbeat` — i njëjtë
2. **Enrollment endpoint**: `POST /api/v1/agent/enroll` — i njëjtë
3. **pending_actions[] format** — i njëjtë (backward compatible me v1.0.0)
4. **Config file path**: `C:\ProgramData\TECHI\agent.config.json` — i njëjtë
5. **Service name**: `TechiAgent` — i njëjtë
6. **UpgradeCode MSI**: `A1B2C3D4-E5F6-7890-ABCD-EF1234567890` — KURRË ndryshon

---

## Backward Compatibility

- Agent v1.0.0 vazhdon të funksionojë: fushat e reja në response janë `omitempty`
- Backend pranon heartbeat pa `agent_version` (nullable column)
- `dispatch()` e v1.0.0 injoron gracefully action types të panjohura (Go JSON unmarshal)
- v2.0.0 pranon response pa `agent_update` (pointer, nil nëse mungon)

---

## Siguria

- `run_powershell`: log çdo ekzekutim (script length + device + timestamp)
- `self_update`: verifiko SHA256 para instalimit, 3 tentativa, abort nëse mismatch
- `reboot_pc`: minimum delay 30s (mos lejon 0s)
- `set_remote_password`: retired; plaintext nuk lejohet në payload ose process arguments
- MSI install: `/quiet /norestart` — pa UI, pa reboot automatik

---

## Testimi Manual Pas Build

1. Instalo `TECHI-Endpoint-Deployment-2.0.0.msi` në 1 PC test
2. Verifiko: `services.msc` → "TechiAgent" Running, Startup: Automatic
3. Verifiko: `regedit` → `HKLM\SOFTWARE\Classes\techiremotesupport` ekziston
4. Verifiko: `agent.log` ka `agent_version="2.0.0"` në heartbeat
5. Dërgoj **ping** nga Command Center → queued → delivered → completed
6. Dërgoj **run_powershell** script `"Get-Date | ConvertTo-Json"` → output JSON me datën
7. Konfirmo që **set_remote_password** refuzohet dhe nuk persiston payload
8. Dërgoj **reboot_pc** me delay 60s → konfirmo reboot pas 60s
9. Dërgoj **register_protocol** → verifiko regjistri me regedit
10. Dërgoj **change_heartbeat_interval** seconds=120 → verifiko log interval changes
