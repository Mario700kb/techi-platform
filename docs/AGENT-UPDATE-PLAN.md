# TECHI Agent — Plani Final i Update Sistemit

## Filozofia
"MSI instalohet 1 herë — pas kësaj, gjithçka kontrollohet nga UI."

Agjenti është executor i thjeshtë dhe i qëndrueshëm. Funksionaliteti i ri
shtohet vetëm në backend dhe eksponohet nga UI — kurrë nuk duhet ri-deployu
MSI për shtesa të reja.

---

## Gjendja Aktuale (v1.0.0)

### Çfarë funksionon:
- Heartbeat çdo 60s (konfigurueshëm nga config.json)
- Lexon pending_actions[] nga response
- Actions të suportuara: ping, refresh_inventory, sync_inventory,
  restart_device, restart_agent, immediate_heartbeat, sync_rustdesk,
  restart_rustdesk, reinstall_rustdesk, reopen_rustdesk,
  apply_power_policy, repair_config_rustdesk, deploy_remote_support
- Windows Service "TechiAgent" me auto-recovery (1m/1m/5m)
- Telemetry: CPU/RAM/Disk/Uptime/Latency
- RustDesk self-healing: install/config/service/password

### Çfarë mungon (gaps kritike):
- NUK lexon heartbeat_interval_seconds nga response (intervali është fiks në config)
- NUK ka self-update mekanizëm
- NUK raporton agent_version në heartbeat
- NUK regjistron techiremotesupport:// protocol
- Nuk ka MSI builder (distributohet si .exe + config.json)

---

## Heartbeat Response — Skema Finale (v2.0)

Shtesa minimale në HeartbeatResponse struct (actions.go):

```go
type HeartbeatResponse struct {
    PendingActions        []PendingAction `json:"pending_actions"`
    HeartbeatIntervalSecs int             `json:"heartbeat_interval_seconds,omitempty"`
    AgentUpdate           *AgentUpdate    `json:"agent_update,omitempty"`
}

type AgentUpdate struct {
    Available bool   `json:"available"`
    Version   string `json:"version"`
    URL       string `json:"download_url"`
    Checksum  string `json:"sha256,omitempty"`
}
```

Heartbeat REQUEST — shto agent_version në çdo heartbeat:
```go
AgentVersion string `json:"agent_version"` // "1.1.0"
```

---

## Actions të Reja për v2.0

Shto në dispatch() në actions.go:

| Action | Payload | Çfarë bën |
|--------|---------|-----------|
| set_remote_password | {"password": "xxx"} | Ndrysho pass TECHI Remote Support |
| change_heartbeat_interval | {"seconds": 300} | Ndrysho intervalin live |
| collect_full_inventory | {} | Force sync inventar i plotë |
| reboot_pc | {"delay_seconds": 60} | Reboot i kontrolluar me delay |
| run_powershell | {"script": "...", "timeout": 30} | Ekzekuto PS1 script |
| self_update | (nga agent_update response) | Shkarko + instalo MSI të ri |
| register_protocol | {} | Regjistro techiremotesupport:// në registry |

---

## Self-Update Mekanizmi

Logjika në agent.go (pas çdo heartbeat response):

```go
// Pas processActions(), kontrollo nëse ka update
if hbResp.AgentUpdate != nil && hbResp.AgentUpdate.Available {
    log.Printf("self_update: version %s available", hbResp.AgentUpdate.Version)
    if err := performSelfUpdate(cfg, hbResp.AgentUpdate); err != nil {
        log.Printf("self_update: failed: %v", err)
    }
    // Nëse update-i kërkon restart, TechiAgent service do riniset vetë
}
```

Funksioni `performSelfUpdate()` (update_windows.go):
1. Shkarko MSI te `C:\ProgramData\TechiAgent\cache\techi-agent-{version}.msi`
2. Verifiko SHA256 checksum nëse është dhënë
3. Ekzekuto `msiexec /i ... /qn /norestart` (trajtoj exit code 3010 si sukses)
4. Detach PowerShell process që rinis service pas 10s

Kushtet e sigurisë:
- Nëse versioni aktual == versioni i ri → skip
- Nëse checksum nuk përputhet → abort + log
- Nëse MSI dështon 3 herë → abort, vazhdo heartbeat normal
- Update ndodh vetëm 1 herë për version (ruhet në config `last_update_version`)

---

## Heartbeat Interval Dinamik

Lexo `heartbeat_interval_seconds` nga response dhe apliko live pa restart:

```go
// Në fund të runSingleHeartbeat(), pas processActions():
if hbResp.HeartbeatIntervalSecs > 0 {
    newInterval := time.Duration(hbResp.HeartbeatIntervalSecs) * time.Second
    if newInterval != currentInterval {
        log.Printf("heartbeat interval changed: %s → %s", currentInterval, newInterval)
        ticker.Reset(newInterval)
        currentInterval = newInterval
    }
}
```

Kufi i sigurt: minimum 30s, maksimum 3600s (1 orë).

---

## agent_version në Heartbeat

Shto fushën në HeartbeatPayload (heartbeat.go):

```go
AgentVersion string `json:"agent_version"` // "1.0.0"
```

Backend e përdor për:
- Të shfaqë versionin në UI (Device Details)
- Të vendosë nëse `agent_update.available = true`
- Statistika të fleet-it (sa devices janë në version të vjetër)

---

## register_protocol Action

Regjistro `techiremotesupport://` URL scheme në Windows Registry:

```
HKCR\techiremotesupport\(Default) = "URL:TECHI Remote Support Protocol"
HKCR\techiremotesupport\URL Protocol = ""
HKCR\techiremotesupport\shell\open\command\(Default) =
    "C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe" "%1"
```

Kodi ekzistues `ensureRustDeskProtocolHandler()` (actions_windows.go) tashmë
bën diçka të ngjashme për `rustdesk://` — kopjo dhe adapto për `techiremotesupport://`.

---

## MSI Builder — Rruga e Rekomanduar

Për të krijuar MSI të distribushëm:

**Tool**: WiX Toolset v4 (`wix.exe`)

**Struktura e propozuar:**
```
agent/
  installer/
    techi-agent.wxs      # WiX source
    build-msi.ps1        # Build script (cross-compile + WiX)
    product.guid.txt     # Upgrade GUID (i pandryshueshëm)
```

**MSI instalon:**
- `C:\Program Files\TECHI\techi-agent.exe`
- `C:\ProgramData\TECHI\agent.config.json` (nga template, nëse nuk ekziston)
- Windows Service "TechiAgent" (via CustomAction: `techi-agent.exe install`)

**Upgrade GUID**: Duhet të jetë KONSTANT për të gjithë versionet (e mundëson
`msiexec /i` të upgradeojë pa uninstall manual).

**Self-update flow:**
```
UI → backend → agent_update response →
agent shkarko MSI → msiexec /i /qn →
service riniset → version i ri aktiv
```

---

## Prioritetet e Implementimit

| Prioritet | Feature | Kompleksiteti | Impakti |
|-----------|---------|---------------|---------|
| P0 | agent_version në heartbeat | E ulët | I lartë — nevojitet për update logic |
| P0 | HeartbeatIntervalSecs nga response | E ulët | I lartë — kontroll nga UI |
| P1 | AgentUpdate struct + self_update action | E mesme | I lartë — updates pa MSI manual |
| P1 | Backend endpoint: /api/v1/agent/version | E mesme | I lartë — nevojitet për P0/P1 |
| P2 | register_protocol action | E ulët | I mesëm |
| P2 | run_powershell action | E mesme | I mesëm |
| P3 | WiX MSI builder | E lartë | I lartë — distribim zyrtar |
| P3 | change_heartbeat_interval action | E ulët | I ulët |

---

## Ndryshimet Backend të Nevojshme

### 1. Heartbeat response (ekzistues → shtesa)

Endpoint: `POST /api/v1/agent/heartbeat`

Lexo fushat e reja nga request:
- `agent_version` — ruaj në `devices.agent_version`

Shto në response:
```json
{
  "pending_actions": [...],
  "heartbeat_interval_seconds": 120,
  "agent_update": {
    "available": true,
    "version": "1.1.0",
    "download_url": "https://...",
    "sha256": "abc123..."
  }
}
```

### 2. Endpoint i ri (opsional)

`GET /api/v1/agent/latest-version` — kthehet versioni i fundit i disponueshëm.
Backend e komparohet me `agent_version` nga heartbeat dhe vendos `available: true/false`.

### 3. UI — Device Details

Shfaq `Agent Version: v1.0.0` dhe badge `Update Available` nëse ka version të ri.

---

## Rregullat e Pandryshueshme (Invariants)

1. **Backward compatibility**: Backend duhet të pranojë heartbeat pa `agent_version` (v1.0.0 nuk e dërgon)
2. **Graceful ignore**: Agjenti duhet të injorojë fusha të panjohura në response (JSON unmarshal Go e bën automatikisht)
3. **Update vetëm me checksum**: Kurrë mos instalo MSI pa verifikuar SHA256
4. **Service stability**: Self-update nuk duhet të bllokojë heartbeat loop — ekzekuto në goroutine të veçantë
5. **Config persistence**: `heartbeat_interval_seconds` nga response NUK ruhet në config.json — humbitet pas restart (backend e risjell në heartbeat të ardhshëm)

---

## Skenari i Dështimit

- Nëse download dështon → log error, vazhdo me heartbeat normal
- Nëse msiexec dështon → log error + callback me status=failed
- Service recovery (1m/1m/5m) kujdeset për restart nëse crash

---

## techiremotesupport:// Protocol Registration

Shto në actions_windows.go si action "register_protocol" DHE
ekzekutohet automatikisht gjatë install nga MSI:

```go
func registerTechiProtocol(installPath string) error {
    // HKLM\SOFTWARE\Classes\techiremotesupport
    // (Default) = "URL:TECHI Remote Support Protocol"
    // URL Protocol = ""
    // shell\open\command = "C:\Program Files\TECHI Remote Support\..." "%1"
    key, _, err := registry.CreateKey(registry.LOCAL_MACHINE,
        `SOFTWARE\Classes\techiremotesupport`, registry.ALL_ACCESS)
    // ... set values
}
```

---

## MSI Build Plan (WiX)

Krijo agent/installer/ folder me:
- installer.wxs — WiX XML manifest
- build.bat — script kompilimi

MSI përmban:
1. techi-agent.exe → `C:\Program Files\TECHI Agent\`
2. config.json default → `C:\ProgramData\TECHI\`
3. Post-install: sc create TechiAgent + registry protocol
4. Uninstall: sc delete + cleanup ProgramData (opsional)

Version string në MSI: nga agentVersion konstante

---

## Faza e Zhvillimit

### FAZA 1 — Backend + UI Command Center (pa MSI, 2-3 ditë) ✅ KOMPLETUAR
**Qëllimi:** UI e plotë për dërgimin e komandave, para ndryshimit të agjentit.

Backend:
- [x] DB migration: tabela agent_command_batches + batch_id në remote_actions
- [x] POST /api/v1/commands/bulk
- [x] GET /api/v1/commands/{batch_id}/progress
- [x] GET /api/v1/commands/history
- [x] DELETE /api/v1/commands/{batch_id}
- [x] Backend mbart komandat te pending_actions[] në heartbeat response
  — automatikisht via remote_actions tabela ekzistuese (collect_pending_for_delivery)

UI (Agent Config tab):
- [x] Panel "Send Command" me target selector (all/client/group/devices)
- [x] Payload fields dinamike për çdo command type
  — set_remote_password: password + confirm + show/hide
  — change_heartbeat_interval: number 60–3600s
  — reboot_pc: delay_seconds + warning
  — run_powershell: textarea + timeout + owner warning
  — register_protocol: info text
- [x] Confirm modal (2-hap për reboot_pc — type device count)
- [x] Progress bar real-time 0–100% (poll çdo 3s)
- [x] Status per device: queued/delivered/executing/completed/failed/timeout
- [x] History e komandave (collapsible, click për re-open batch)
- [x] Permission gates: admin/owner për set_remote_password/reboot_pc; owner-only për run_powershell

Command types të suportuar (Faza 1 backend):
ping, restart_agent, restart_device, reboot_pc, collect_inventory,
sync_rustdesk, restart_rustdesk, set_remote_password,
change_heartbeat_interval, run_powershell, register_protocol

### FAZA 2 — Agent Golang v2.0 (3-4 ditë) ✅ KOMPLETUAR
**Qëllimi:** Agjent i modifikuar (jo nga e para) me command execution + self-update.

Skedarët e modifikuar:
- [x] actions.go — HeartbeatResponse struct + dispatch() shtesa
- [x] agent.go — heartbeat_interval_seconds dinamik + update check
- [x] enrollment.go — agentVersion konstante → "2.0.0"
- [x] heartbeat.go — shto agent_version në payload
- [x] actions_windows.go — set_remote_password, reboot_pc, run_powershell, self_update, register_protocol

Skedarët e rinj:
- [x] update.go — performSelfUpdate() me SHA256 + retry
- [x] update_other.go — stub për non-Windows
- [x] installer/installer.wxs — WiX v4 MSI manifest
- [x] installer/build.bat — MSI build script (Windows)
- [x] installer/build.sh — MSI build script (macOS cross-compile)

Backend shtesa:
- [x] alembic migration c4d5e6f7a8b9 — devices.agent_version VARCHAR(20)
- [x] AgentHeartbeatPayload — agent_version field
- [x] AgentUpdateInfo schema + AgentHeartbeatResponse.agent_update
- [x] DeviceUpdate.agent_version — ruhet nga çdo heartbeat

### MSI Build Process (GitHub Actions — automatik)

**Workflow**: `.github/workflows/build-agent-msi.yml`
**Trigger**: push te `stable/phase-2-heartbeat` kur ndryshohet ndonjë skedar `agent/`
**Runner**: `windows-latest` (Windows Server 2022, native — pa cross-compile)

Hapat e workflow:
1. Checkout repo
2. Setup Go 1.21 me cache `agent/go.sum`
3. `dotnet tool install --global wix --version 4.0.5`
4. `wix extension add --global WixToolset.Util.wixext/4.0.5` (për `util:ServiceConfig`)
5. `go build -ldflags="-s -w" -o installer/techi-agent.exe .` (nga `agent/`)
6. `wix build installer.wxs -ext WixToolset.Util.wixext -d SourceDir=. -o TECHI-Endpoint-Deployment-2.0.0.msi`
7. SHA256 checksum → skedar `.sha256` bashkë me MSI-n
8. Upload artifact `TECHI-Endpoint-Deployment-2.0.0` (30 ditë, tab Actions → Artifacts)

**Si të shkarkosh MSI-n:**
1. GitHub → repo → tab **Actions**
2. Kliko run → seksioni **Artifacts**
3. Shkarko `TECHI-Endpoint-Deployment-2.0.0` (ZIP me MSI + SHA256)

**Trigger manual**: Actions → "Build TECHI Agent MSI" → **Run workflow**

---

### FAZA 3 — MSI Deploy Final (1-2 ditë)
**Qëllimi:** MSI i ndërtuar nga CI, deploy VETËM 1 HERË via GPO ekzistues.

- [x] MSI build automatik via GitHub Actions (CI/CD)
- [ ] Ngarko MSI te /api/v1/agent-packages nga UI (backend + UI për package upload)
- [ ] GPO ekzistues shpërndan MSI-n e ri (hera e fundit e ndërhyrjes GPO)
- [ ] Monitoring: verifikoji 556 device-t si updatojnë via dashboard (agent_version në UI)

### Pas FAZA 3 — Gjithçka nga UI
- Komanda të reja → shtohen vetëm në backend
- Agent update → nga UI, pa GPO
- Password rotation → bulk nga UI
- Config ndryshime → heartbeat_interval, log_level, server_url

---

## Rregullat e Sigurisë

1. run_powershell — vetëm nëse operator ka rol owner/admin
2. reboot_pc — kërkon konfirmim 2-hap nga UI
3. self_update — vetëm nga agent_update response (jo nga pending_actions direkt)
4. Callback secret për çdo action
5. Timeout per action (default 30s, max 300s)

---

## Statusi i Detyrave

| Detyrë | Statusi | Faza |
|--------|---------|------|
| Backend agent_command_batches table | ✅ Done | 1 |
| POST /commands/bulk API | ✅ Done | 1 |
| GET /commands/{batch_id}/progress | ✅ Done | 1 |
| Heartbeat delivery via pending_actions[] | ✅ Done | 1 |
| Command Center UI (Send/Progress/History) | ✅ Done | 1 |
| HeartbeatResponse v2 struct | ✅ Done | 2 |
| Actions të reja (set_password, reboot, etc) | ✅ Done | 2 |
| self_update logjika | ✅ Done | 2 |
| protocol registration | ✅ Done | 2 |
| WiX MSI builder | ⏳ Pending | 3 |
| Deploy final via GPO | ⏳ Pending | 3 |

---

*Krijuar: Qershor 2026 | Versioni i agjentit aktual: 1.0.0 | Target: 2.0.0*
