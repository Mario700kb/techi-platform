# TECHI Platform — PROJECT STATE (Single Source of Truth)

## PROJECT STATUS

| | |
|---|---|
| **Last Updated** | 2026-07-16 |
| **Production Verified** | 2026-07-11 (Connect V3-mockup alignment deployed `92a521c`: no schema step needed, backend+frontend rebuilt, all containers healthy, smoke 8/8 against `https://api-rdp.techi.com.al`, zero real errors, ~1262 heartbeat log lines/2min, new `GET /connect-status` + `client_os` param confirmed live 401-not-500. **NOT dark** — the Catalog Connect split button + categorized menu changed live for every operator (no flag). Live browser click-through still owner's step — same constraint as the previous two deploys (no browser tool; bootstrap credentials don't match the live `owner` account); see the 2026-07-11 Connect-mockup CHANGELOG entry's validation checklist) |
| **Current Production Branch** | `stable/phase-2-heartbeat` (prod runs the pushed tip, commit `92a521c`) |
| **Current Development Branch** | `stable/phase-2-heartbeat`; credential/native remediation is a local source-only candidate (7 inherited commits plus 6 new local remediation commits) plus a new source-only heartbeat-auth migration mode candidate, not pushed, deployed, or activated; rollout remains disabled |
| **Backend Version** | `PROJECT_VERSION 1.0.0`, code of commit `218203d` (deployed; container health verified) |
| **Agent Version** | **2.1.8 split-deployment canary candidate in validation**. Broken 2.1.7 Windows packages were deactivated and 2.1.6 restored active on 2026-07-11. **2.1.6 remains the production-safe fallback**: its core service startup, heartbeat, telemetry, Remote Support, self-update, watchdog, and most GPO deployment behavior are production-proven; the remaining work is edge-case installer/deployment hardening. Real standalone/domain canaries found and fixed 2.1.8 candidate issues: combined-MSI Agent/Remote Support start ordering, helper subcommands (`installer-marker create` etc.) entering normal runtime and writing `state=operational` with a helper PID, MSI registration drift where EXE 2.1.8 could run while Windows Installer registration remained 2.1.6, stale-binary marker sequencing before `InstallFiles`, and stale/mismatched NETLOGON artifacts. Current candidate separates TECHI Agent MSI from TECHI Remote Support MSI, keeps normal Agent upgrades on UI/self-update, runs Agent MSI only for first install/explicit repair, validates lifecycle PID against the current SCM service PID, adds per-product NETLOGON locks/logs/1618 guard, uses absolute `%SystemRoot%\System32` command paths, and CI-checks MSI-embedded EXE lineage against the standalone EXE. 2.1.8 remains **not approved for fleet rollout**; Windows packages stay pinned to 2.1.6 until canaries pass and the new 2.1.8 package is explicitly activated. |
| **TECHI Remote Version** | 1.4.6.0 (repo build default in `remote-support.wxs`; now packaged as an independent Remote Support MSI candidate, exact fleet version: needs verification) |
| **Heartbeat Interval** | **250 s** (global UI policy, verified in prod) |
| **Heartbeat Retention** | **7 days** (verified in prod) |
| **Production Server** | Linode VPS `139.162.158.208` (ssh alias `techi-server`), 25 GB disk. Live deploy dir unified to **`/opt/techi/techi-platform`** for **both** frontend + backend as of 2026-07-14 (recovered from a prior split where the frontend ran from `/root` and the backend from `/opt` under a shared compose project — see CHANGELOG `[2026-07-14]`). Deploy guard: `/usr/local/bin/techi-deploy-guard` (source `scripts/deploy-guard.sh`) — run before/after every deploy; fails closed on a split root or any required `FEATURE_` flag off |
| **Platform Feature Flags (prod)** | **Verified 2026-07-14** — the platform-expansion flags are now **ON** in production (they are no longer all OFF; supersedes any earlier "all expansion flags OFF in prod" statement below, which described the 2026-07-07 phase state): `FEATURE_PLATFORM_CORE=true`, `FEATURE_LINUX=true`, `FEATURE_MIKROTIK=true`, `FEATURE_REPORTING=true`, `FEATURE_VAULT=true`, `FEATURE_TERMINAL=true` (`FEATURE_TERMINAL_SCOPE=device`, allowed device `729`). `FEATURE_STORAGE`, `FEATURE_HYPERVISOR`, `FEATURE_NOTIFICATIONS` remain OFF. Safety-critical gates remain OFF/disabled: `NATIVE_BOOTSTRAP_ENABLED=false`, `AGENT_ROLLOUT_MODE=disabled`, `REMOTE_SUPPORT_DIRECT_CONNECT_ENABLED=false`. The authenticated-Agent-heartbeat / RS-credential-generation security changes are **source-only on `stable/phase-2-heartbeat`, not deployed**. Heartbeat auth source now supports `AGENT_HEARTBEAT_AUTH_MODE=disabled|observe|enforce` with default `enforce`; production has **not** deployed this source. See CHANGELOG `[2026-07-14]`. |
| **Documentation Version** | 1.0 (two-document standard, effective 2026-07-04) |

## NATIVE BOOTSTRAP / UPDATE ARCHITECTURE

**Status (2026-07-13, adversarial-remediation worktree): source candidate only.
The standalone recovery CLI, transaction/state core, hardened deterministic RS
bundle, and backend ZIP+manifest upload/activation binding exist locally.
`apply-policy` is report-only. The native GPO publication/local-copy/task path is
incomplete and emits no operational task; `NATIVE_BOOTSTRAP_ENABLED` remains OFF
by default and fails closed if accidentally enabled. Remote Support recovery
permission is independent from Agent rollout and remains disabled in generated
policy. Live Windows execution only cross-compiles and is fake-tested; it is
UNPROVEN on a real device. Nothing was deployed, published, activated, copied to
NETLOGON, or changed in GPO; artifacts remain unsigned.** New cross-platform decision core
`agent/internal/native/` (policy contract with no secrets, deterministic exit
codes, safe-path/staging guards, SHA256 payload gate, redacting logs, Agent +
Remote Support state machines) replaces the decision logic of the ~2,600-line
`enrollment_bootstrap_service.py` → giant `techi-deploy.cmd` generator (which is
left in place as fallback). Two new Agent subcommands `apply-policy` /
`repair-remote-support` wire it in; live probing/mutation is deferred to a
canary-gated Windows executor. Recovery targets the ~30 Agroblend/Drymadess
devices (Agent 2.1.8 healthy, Remote Support EXE missing + stale service). RS
payload is a **native bundle/ZIP**, never MSI repair. Design:
[docs/architecture/native-bootstrap.md](architecture/native-bootstrap.md).
**Still requires a disposable Windows lab before any one-device canary.** Fleet
rollout stays disabled; Windows packages stay pinned to the current active set.

**2026-07-16 Device 11 recovery follow-up:** the interactive-session diagnostics
confirmed that `start_ui` reached Session 1 correctly, but
`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe` did not exist.
The recovery transaction validated the extracted staging tree, then treated a
successful directory rename as a successful promotion without validating the
new final install before config restore, service startup, and UI launch. The
Windows promoter now verifies the complete installed manifest immediately after
the rename, including `TECHI Remote Support.exe`, `flutter_windows.dll`,
`data/app.so`, and Flutter assets. Any missing or changed runtime file returns
the underlying error, stops the sequence before config/service/UI, and rolls
back through the existing transaction. This is source/CI validated only; Device
11 requires an updated Agent package before the RS-only retest. Fleet rollout
remains disabled.

## WINDOWS AGENT CANARY STATUS

**Current status: CANARY FAILED — LIFECYCLE READER FIX REQUIRED / FLEET ROLLOUT ENABLED = NO.**

Real ADPASCUCCI 2.1.8 split-deploy canary evidence showed the generated
NETLOGON/GPO flow still had source defects after package activation: Remote
Support deployment metadata was derived from the Agent version (`2.1.8`) instead
of the active Remote Support MSI version (`1.4.6`), and `techi-deploy.cmd`
misclassified a running `TechiAgent` SCM service as missing because it parsed
human-formatted `sc query` output. A production manifest audit then confirmed
the active `remote_support_msi` artifact filename/SHA were the expected
`TECHI-Remote-Support-1.4.6.msi` /
`cbc4c8828ece949510fbc7f6f6b754c8a7e393a5bdf658ba50ec0fe2c7b51253`, but the
stored package metadata said `version=2.1.8`. The source fix now requires Remote
Support lineage from `remote_support_msi` only, canonicalizes Remote Support MSI
version from its own filename, rejects future mismatched uploads, reports
unavailable rather than inventing Agent-versioned Remote Support files, reads
SCM service state/PID via CIM, and forces all normal skip/success paths through
a terminal `result=done` log line. **Backend redeploy is required for the
generated script fix to take effect; package activation, NETLOGON update,
GPO/task reactivation, canary rerun, and fleet rollout remain blocked until the
fix commit passes CI and is manually validated.**

2026-07-12 follow-up: real Windows then confirmed the CIM helper itself had
invalid PowerShell syntax: `if/else` output was piped directly to `Set-Content`,
which PowerShell rejects with `An empty pipe element is not allowed`. The source
fix rewrites both Agent and Remote Support service readers as `-EncodedCommand`
payloads that assign `$result` before `Set-Content`, and removes the same
invalid if/else pipeline shape from MSI busy detection. Canary status remains
failed until ADPASCUCCI is regenerated/rerun with the redeployed backend output.

2026-07-12 second follow-up: real Windows then confirmed a non-terminating CMD
batch defect in `:classify_remote_support`. The generated block assigned
`RS_VERSION_OUT` and referenced `%RS_VERSION_OUT%` inside the same
parenthesized `if exist "%RS_EXE%" (...)` block; CMD expanded the variable before
the block ran, so the cleanup `del` saw an empty target and prompted from
`C:\Windows\system32`. The source fix moves Remote Support version reading into
a separate `-EncodedCommand` subroutine, adds guarded `del /f /q` cleanup via
`:delete_temp_file`, clears temp output variables after use, normalizes Remote
Support versions to MAJOR.MINOR.PATCH (`1.4.6+64` / `1.4.6.64` / `1.4.6` all
compare as `1.4.6`), and adds a real CMD/Wine regression proving the classifier
exits without prompt, detects `RUNNING` + PID, returns `remote_healthy`, leaves
no temp files, and never invokes MSI. Backend redeploy is required because the
generator changed; MSI bytes are unchanged. Do not update NETLOGON, reactivate
the task, or start rollout until the redeployed backend-generated script is
manually copied/validated for the single ADPASCUCCI canary.

2026-07-12 third follow-up: real Windows then confirmed the remaining lifecycle
reader defect. `:read_lifecycle` still used a complex inline PowerShell
`-Command` with nested CMD quoting and silent `catch{}`. Isolated CMD execution
returned default lifecycle values (`missing` / `config_missing`, blank PID,
`LIFECYCLE_PID_MATCH=0`) even while the real `TechiAgent` service was Running
with SCM PID `6940` and `agent.state.json` was fresh/operational with
`pid=6940`. The source fix converts `:read_lifecycle` to a UTF-16LE
`-EncodedCommand`, keeps the encoded command below the practical CMD length
limit, always writes `STATE_OUT`, and adds `LIFECYCLE_READER_ERROR` so reader
failures become explicit sanitized diagnostics rather than silent defaults.
Regression coverage now includes complete CMD/Wine execution for healthy,
stale timestamp, PID mismatch, and malformed JSON/error cases. Backend redeploy
is required; MSI bytes remain unchanged. Do not update NETLOGON, reactivate the
task, or start rollout until the redeployed backend-generated script is
manually copied/validated for the single ADPASCUCCI canary.

2.1.6 remains the production-safe fallback. Do not describe 2.1.6 as broadly
broken; its core startup, heartbeat, telemetry, Remote Support, self-update,
watchdog, and most GPO deployment behavior remain production-proven.

## CURRENT PRIORITIES

1. ✅ **Reporting Engine v1** — production-ready (2026-07-10): on-demand +
   scheduled per-client PDF/CSV fleet-health and alert-activity reports,
   persistent run history/downloads, client-scope RBAC, audit, scheduler,
   and 365-day artifact retention. `FEATURE_REPORTING` is the rollback switch.
   2026-07-10: added `DELETE /reports/runs/{id}` (Report History delete —
   removes the DB row + stored file, never the parent schedule). Deferred to
   a dedicated follow-up (explicitly scoped out of this session, not
   forgotten): Generate Now section/filter/threshold options, report
   branding/logo config, and a rewritten PDF template — each is roadmap-sized
   on its own, see CHANGELOG-SOLUTIONS 2026-07-10.
2. ✅ **Enterprise Credential Vault upgrade** — production-ready (2026-07-10,
   owner-approved exception to the LIVE VALIDATION "no new features" gate):
   11-type metadata-driven credential registry (SSH/Windows/Winbox/WebFig/API
   token/SMTP/Webhook/SNMP v2c+v3/generic — legacy types still work, zero
   migration), Purpose field, Global/Client/Group/Device scope + a tested-but-
   unwired `resolve_for_context()` scope-resolution service (Device > Group >
   Client > Global), explicit credential↔client/device assignments (extends
   the delete-reference 409 guard), 7 granular `vault_*` permissions (additive
   over the Admin+ floor), real Test Connection for SMTP/Webhook (honest
   "unsupported" for every other type — no SSH/SNMP/RouterOS client exists
   yet), lifecycle status badges (Active/Disabled/Expiring soon/Expired/
   Validation failed). **Vault Integration is now DONE for SSH** (see item 2a
   below) — `resolve_for_context()` itself stays unwired for non-SSH
   integrations (SNMP/RouterOS), which remain future work.
2a. ✅ **Embedded SSH Connect** — code complete (2026-07-10), reusing the
   Web Terminal stack (Phase 5) and the Vault scope-resolution precedence
   completely unchanged: Device Drawer ▸ Connect ▸ SSH now opens an
   **Embedded TECHI Terminal** by default (external OS SSH client stays a
   secondary link) for any device whose Connect Framework entry declares an
   `ssh` method (Linux, MikroTik, and future Storage/Hypervisor platforms —
   no per-platform code). Architecture: the backend itself dials the SSH
   connection (`asyncssh`, new dependency) and attaches as the "agent" leg of
   the same `TerminalRelay` pair the operator's browser already connects to
   via the existing `/ws/terminal/{id}` route — zero changes to the relay,
   the watchdog, or the operator-side WS handler. New `VaultService.
   resolve_ssh_candidates()` reuses the exact Device > Group > Client > Global
   precedence `resolve_for_context()` established, but returns every
   candidate at the first non-empty tier (auto-connect on exactly one,
   selector on multiple, clear "no credential available" + explicit
   Temporary Session option on none — never a silent password prompt).
   `TerminalSession` gained 4 additive columns (`mode`, `vault_credential_id`,
   `ssh_username`, `credential_source`); 4 new granular permissions
   (`terminal_open`/`terminal_view`/`terminal_manage`/`vault_use`, additive
   over the existing admin+ floor, same shape as the 7 `vault_*` permissions);
   6 new audit actions (SSH session started/ended, credential resolved/
   missing, connection/authentication failed). Vault UI now shows "Used by:
   Embedded SSH" + Last Used once a credential actually authenticates a
   connection. Gated by the same `FEATURE_TERMINAL` flag (OFF in prod when
   this was written; ON in prod as of 2026-07-14 — see top "Platform Feature
   Flags (prod)" row) + its existing rollout-scope mechanism — no new flag. 73 new tests
   (backend + frontend), preflight PASSED (contract 15/15, suite 729+4 known
   baseline in both flag modes, tsc/build/agent clean), smoke 8/8 locally.
   **Known limitation**: SSH host-key verification is not enforced yet
   (`known_hosts=None` — no shared per-device trusted-key store exists);
   requires the backend to have network reachability to the device (no NAT
   traversal, same constraint already documented for MikroTik SSH).
2b. ✅ **Vault scope assignment + Connect credential resolution — production
   bug fix** (2026-07-11): fixes a real production 400 (`scope 'device' must
   not set client_id`) — the Vault create/edit form conflated the "filter by
   client" picker used to narrow the Device/Group dropdown with the actual
   submitted `client_id`, so choosing Device scope still sent a `client_id`
   the backend correctly rejects. Also **Group scope had no UI at all**
   (only Global/Client/Device existed in the form). Both fixed, plus new
   searchable Client/Group/Device pickers (`EntitySearchSelect`, new shared
   component) and derived-context display (a Device/Group-scoped
   credential's Client/Group are joined server-side at read time —
   `VaultService.resolve_display_context()` — never stored on the row,
   scope integrity unchanged). **`current_user` (heartbeat's OS-logged-in
   username) investigated and confirmed NEVER used as an SSH/Winbox/WebFig
   credential** — 5 regression tests lock this invariant. Credential
   resolution generalized beyond SSH to Winbox/WebFig
   (`VaultService.resolve_credentials_for_method`, type-matched, WebFig also
   accepts a purpose-marked `generic_username_password`). Connect methods
   now carry live status (`ready`/`credential_required`) + which Vault scope
   tier resolved the credential — surfaced in the Connect menu with an
   "Add credential" action prefilled with device/scope/type. New
   **per-operator default Connect method** (`operator_connect_preferences`,
   new table): device override > platform default > registry priority >
   first Ready method, with an "Always use this method" pin in the Connect
   menu and a "Connect Defaults" section in Settings to view/reset. Fixed
   the Device Catalog Connect button showing permanently grey for every
   non-Windows device (it only ever checked Windows/RustDesk fields) —
   non-Windows rows now open the Drawer's real, credential-aware Connect
   menu instead. 58 new tests (38 backend, 20 frontend); preflight PASSED
   (contract 15/15, backend suite 767+4 known baseline both flag modes,
   full frontend vitest 61/61, tsc/build/agent clean).
2c. ✅ **Connect aligned to the approved V3 mockup** (2026-07-11): split
   Connect button (main click launches the operator's SAVED default when
   Ready; no saved preference → menu opens once; ▾ arrow always opens the
   menu; **never the Drawer**) in the Device Catalog and both Drawers;
   categorized menu ("Connect to <hostname>": Recommended / Available / Web /
   Desktop Applications / Unavailable) with per-row transport/source label +
   status + credential source + unavailable reason; "Always use this option"
   footer checkbox (saves the per-operator platform default) alongside the
   per-method pin. **Winbox restored end-to-end for MikroTik**: always
   visible on every operator OS — Ready on Windows (launches `winbox://<ip>`,
   no credential in the URL, audited), disabled with "Windows only ·
   Unavailable on macOS/Linux" elsewhere; no desktop launcher component
   exists, so after a launch attempt the UI honestly notes "launcher not
   installed" if nothing opens (browser cannot detect protocol handlers).
   MikroTik method order re-encoded to the approved defaults:
   Winbox(10) > Embedded SSH(20) > WebFig(30); `/connect-methods` gained
   `client_os` so OS-impossible methods are excluded from default resolution
   server-side. Linux labels aligned: **Embedded Terminal** (agent tunnel,
   default) + **Embedded SSH** (backend relay + Vault; external SSH stays
   the secondary link in the modal). **Embedded methods are honestly gated**:
   outside FEATURE_TERMINAL's rollout scope they report
   `unavailable — not enabled for this device` (same gate the terminal
   endpoints enforce) instead of failing on click — so in prod (scope =
   device 729) MikroTik-on-macOS defaults to WebFig until the owner widens
   the scope (config-only Manual Approval). New batched
   `GET /connect-status` gives Catalog rows real Ready/Credential
   required/Unavailable button states without N+1; a `techi:connect-refresh`
   event refreshes every Connect surface immediately after credential
   create/edit/delete/disable or default pin/reset. Windows Catalog rows
   byte-identical (RustDesk main click unchanged, single method — mockup's
   own "Opens directly — single option"). No schema change, no new flag.
   Preflight PASSED (contract 15/15, suite 781+4 known baseline both flag
   modes, tsc/build/agent clean).
3. ✅ Documentation Baseline — completed (2026-07-05, this standard)
4. ✅ Mobile UI 2.0 (7 phases) + storage optimization batch — deployed to
   production 2026-07-06 (see RDP TECHI MOBILE UI 2.0 section below)
5. **Platform Expansion — Phase 0 (Platform Core Foundation)** in progress
   (architecture approved & DESIGN LOCKED 2026-07-07 — see PLATFORM EXPANSION
   section below). Dark code only, flags OFF, zero behavior change.
6. Complete Agent **2.1.8** split-deployment canaries with the helper lifecycle
   fix, Agent-vs-Remote-Support MSI separation, per-product NETLOGON locks/logs,
   absolute System32 command paths, and artifact-lineage validation, then
   activate it via the existing package mechanism. Do not republish a different
   2.1.7 SHA; do not roll out 2.1.8 until the real Windows canary proves Agent
   service PID == lifecycle PID, healthy self-update does not trigger Agent MSI
   reinstall merely because ARP registration is older, Remote Support can
   install/update independently, and no parallel TECHI msiexec/1618 hammering
   occurs.
7. ✅ Agent 2.1.6 released to stable (2026-07-09, `1b0ddf3` — lifecycle
   engine shared Windows+Linux, log rotation, cache pruning; SHA-alignment
   via single CI run)
8. Standardize the deployment working directory (decision pending — see
   Known Issues #1)
9. Recreate the postgres container's log-cap benefit was already applied
   as a side effect of the 2026-07-06 deploy (see below) — no longer
   pending.

This document describes the CURRENT state only. History (incidents, fixes,
decisions, deploys) lives exclusively in
[CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md). Together these two files are
the complete, canonical knowledge base — every other document is historical or
deep-dive reference only (see `docs/reference/`, `docs/archive/`).

Facts marked **(verified)** were confirmed by direct inspection of production
on 2026-07-04. Facts marked **(needs verification)** are believed true but not
proven — verify before relying on them.

---

# Përmbledhje

TECHI Platform is a self-hosted RMM/MSP platform: fleet monitoring, remote
command execution, and remote desktop support for **~700 managed Windows
devices** across multiple client Active Directory domains, operated by 5–6
concurrent operators through a realtime web dashboard. Remote desktop is a
branded RustDesk ("TECHI Remote Support") against a self-hosted RustDesk server.

# Arkitektura

| Component | What it is |
|---|---|
| **Backend** | FastAPI (Python 3.12 in the container), SQLAlchemy sync ORM, Alembic, single uvicorn worker. Layers: `api/v1/endpoints` (routers) → `services` (orchestration) → `repositories` (queries) → `models`. WebSocket realtime channel `/ws/devices` via an async publisher queue (750 ms dedupe, maxsize 1000). |
| **Frontend** | React + Vite + TypeScript + Tailwind. Custom dark "premium" design system (`techi-orange #FF553F`, `.premium-*` classes); **no external component libraries**. One WS connection per page, polling fallback 15 s. |
| **Agent** | Go, Windows service `TechiAgent` (LocalSystem, SCM recovery 1m/1m/5m). Heartbeat loop + remote-action dispatcher + script-free self-update (binary swap via one-shot SYSTEM Scheduled Task) + independent watchdog Scheduled Task (5-min cadence). Files split by build tags `_windows.go` / `_other.go`. Cross-compiles from macOS (`GOOS=windows GOARCH=amd64`). |
| **TECHI Remote Support** | Branded RustDesk client (Flutter build, `librustdesk.dll`), packaged as an independently versioned/deployed MSI, runs as Windows service + tray. Agent observes/configures it, but Agent MSI no longer carries or upgrades Remote Support payloads. |
| **RustDesk server** | Self-hosted `rustdesk-server` containers `techi-hbbs`/`techi-hbbr` on the same VPS (`/opt/techi/rustdesk-server`). Identity keys: `data/id_ed25519*` — critical, see Disaster Recovery. |
| **Database** | PostgreSQL 15-alpine in production (Docker volume `techi-platform_postgres_data`); SQLite for local dev with `schema_compat_service.ensure_sqlite_dev_schema` (SQLite-only column guard). |
| **Docker** | Single `docker-compose.yml`: postgres, backend (mem_limit 800m), frontend. RustDesk server and nginx-proxy-manager are separate compose projects on the same host. |
| **Deployment** | Single Linode VPS. git pull + `docker compose build && up -d`. Edge: nginx-proxy-manager terminates TLS for `rdp.techi.com.al` (frontend) and `api-rdp.techi.com.al` (backend). Agents deploy via AD GPO/NETLOGON bootstrap for first install/explicit repair and update via UI self_update; TECHI Remote Support deploys/updates through its own MSI path. |

**Device identity resolution** (heartbeat/enroll): agent_id cache → agent_id →
device_id → rustdesk_id → fingerprint scorer (hostname/IPs/hw/domain/OS
weighted; ≥0.90 auto-reuse, 0.70–0.89 flag `duplicate_candidate`, safety-block
if active device with different RustDesk ID).

# Production (verified 2026-07-04)

| Item | Value |
|---|---|
| Server | Linode VPS `139.162.158.208`, Ubuntu, 25 GB disk (62% used after 2026-07-04 cleanup). SSH alias `techi-server` (root, key `~/.ssh/techi-server`) **(verified)** |
| **Deploy working dir** | **`/root`** — live compose project `techi-platform` (backend/frontend labels) **(verified)**. `/opt/techi/techi-platform` is a SECOND, STALE checkout (postgres container still carries its label). Always confirm with `docker inspect <c> --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'` |
| Containers | `techi-platform-{backend,frontend,postgres}-1`, `techi-hbbs`, `techi-hbbr`, `nginx-proxy-manager` — all healthy **(verified)** |
| Backend code | content of commit `e0df46a` (tip of `stable/phase-2-heartbeat` as pushed) — proven by md5 of files in the running container **(verified)** |
| Heartbeat interval | **250 s** (global policy file `/app/data/agent_policy.json`, volume `backend_data`; set from UI) — measured effective ~246 s across ~417 active devices/hour **(verified)** |
| DB retention | heartbeats/telemetry/activity events **7 days** — proven by `min(created_at)` = exactly the 03:00 UTC boundary **(verified)**. All other tables: no retention yet (fix committed, not deployed — see Pending) |
| DB size | ~1.8 GB; device_heartbeats 972 MB + device_telemetry 710 MB ≈ 91% **(verified 2026-07-04)** |
| Backups | cron `0 3 * * * /root/techi-backup.sh`: `pg_dumpall|gzip` → `/opt/backups/techi/` (~100 MB/day), RustDesk keys tar, config tar; retention 14 days **(verified)**. ⚠️ config tar reads the STALE `/opt` checkout (identical to `/root` as of 2026-07-04) |
| Host housekeeping | NPM logrotate (`/etc/logrotate.d/npm-techi` + hourly cron, 100 MB cap), journald capped 200 MB, weekly `docker builder prune` cron **(verified — installed 2026-07-04)** |
| Postgres container log | **no docker cap** (fix committed, not deployed) **(verified)** |
| Server leftovers awaiting owner decision | orphan 2.0 GB postgres volume `6b7b55…` (unattached since 2026-06-28), `/opt/techi/backups/backup_pre_enrollment_fix.sql` (1.1 GB, outside auto-retention), 34 empty `techi_verify_*` volumes **(verified)** |

# Heartbeat

- Agent POSTs a full JSON snapshot to `POST /api/v1/agent/heartbeat` every
  `heartbeat_interval_seconds`; 3 retries, 5 s gap. Legacy agents use
  `/api/heartbeat` (compat route → same handler).
- **Interval**: global (fleet-wide, NOT per-device), file-backed policy, UI page
  Agent Config → `PUT /api/v1/agent-config` (admin+), bounds 60–600 s. Every
  heartbeat **response** carries the current value; the agent applies it live
  (ticker reset), does not persist it (config file value applies until first
  response after restart). Current prod value: **250 s (verified)**.
- Per beat, backend fast path (blocks the response): resolve device → update
  `devices` row → status transition (+history row if changed) → RustDesk sync
  → trusted-domain assignment → INSERT `device_heartbeats` snapshot →
  collect pending actions. Side effects run in a BackgroundTask: WS events,
  INSERT `device_telemetry`, upsert `device_inventory` (only when the agent
  sends inventory — collect flags default OFF), alert engine, health score.
- Response fields: `pending_actions[]`, `heartbeat_interval_seconds`,
  authenticated desired/applied Remote Support credential generations, `agent_update`,
  device/heartbeat ids.
- Freshness thresholds (fixed constants): Online ≤ 6 min, Stale ≤ 25 min,
  Offline > 25 min. Reconciliation worker (in-process, 30 s) marks stale
  devices offline.
- Load at 1000 devices / 300 s: ~3.3 beats/s steady, ~55 KB/s WS output at 6
  operators (from the 2026-06 scalability audit; still representative).
- **Retention**: 7 days (see Scheduler). Cleanup deletes + `VACUUM ANALYZE`.
- Quirk: per-device `change_heartbeat_interval` action is overridden by the
  global response value within the same cycle — per-device intervals do not stick.

# Update System

- Philosophy: "MSI installs once — everything else from the UI."
- `self_update`: agent downloads the active `agent_binary` exe to
  `%ProgramData%\TechiAgent\cache\techi-agent-<ver>.exe`, verifies SHA256,
  swaps itself via one-shot SYSTEM Scheduled Task (`techi-agent.exe
  swap-binary`) — no PowerShell/scripts anywhere (AV/AMSI-strict domains:
  Symantec, CybeeAI). Rollback to `techi-agent-old.exe` if the service doesn't
  come back.
- Completion verified by the next heartbeat's `agent_sha256`
  (`verify_self_update_for_device`), not by the action callback.
- **NETLOGON native rollout (domain-wide, agent ≥ 2.1.8, SOURCE-READY — no
  rollout activated):** for ~30 domains / ~730 devices the GPO/NETLOGON deploy
  task drives **healthy** older agents to the rollout target via the **same**
  native swap (no MSI). New agent subcommand `netlogon-self-update -source
  <staged.exe> -expected-sha256 <hex> -expected-version <ver>` runs a path+SHA
  identity gate **before** any service stop, then reuses `swapAgentBinary()`.
  Rollout **target** = active `agent_binary` version; rollout **mode** = new
  `AGENT_ROLLOUT_MODE` env (**default `disabled`** — explicit operator switch,
  separate from package activation; `canary`/`enabled` permit it). The DC script
  publishes `TECHI-Agent-<target>.exe` (+`.sha256`), `techi-rollout-version.txt`,
  `techi-rollout-mode.txt` to NETLOGON. Results: `uptodate` /
  `newer_than_rollout_target` (never auto-downgrade) / `rollout_disabled` /
  `netlogon_self_update_completed` / `netlogon_self_update_failed` /
  `package_identity_mismatch` / `installer_busy_retryable`. Damaged/missing
  agents still take the Agent MSI repair/install path; Remote Support MSI
  lifecycle unchanged. See OPERATOR-MANUAL §9b + CHANGELOG 2026-07-12.
- **⚠️ Deploy-lineage status (2026-07-12): the NETLOGON rollout source
  (`bf0bb40`) is NOT live yet.** Production backend runs `aac9ebf` (one commit
  behind) — the backend container deploys from **`/opt/techi/techi-platform`**
  (git `aac9ebf`, `bf0bb40` never fetched there), NOT from `/root` (git
  `862b1bf`); frontend/postgres deploy from `/root`. So a GPO regenerated now
  still produces the pre-rollout script with no `techi-rollout-*.txt` /
  standalone EXE. **Fix = redeploy the backend from `/opt/techi/techi-platform`
  at `bf0bb40`** (see CHANGELOG 2026-07-12 forensic entry): `cd
  /opt/techi/techi-platform && git fetch origin && git merge --ff-only
  origin/stable/phase-2-heartbeat && docker compose -p techi-platform build
  backend && docker compose -p techi-platform up -d backend`. Verify the
  container source greps `AGENT_ROLLOUT_MODE`/`:evaluate_rollout` before
  regenerating GPO. Rollout mode stays `disabled` (default) — no rollout until
  the operator sets it. GPO REGENERATION = NO / CANARY = NO / FLEET = NO until
  redeployed. (Underlying: split-brain deploy dirs, Known Issue #1.)
- Watchdog Scheduled Task (`watchdog-check`, 5 min): restarts TechiAgent
  service; ≥2.1.5 also starts the TECHI Remote Support service if stopped.
- **SHA-alignment rule (critical):** "Needs Agent Update" compares each
  device's `agent_sha256` with the active `agent_binary` package SHA. Go builds
  are NOT reproducible — CI must prove the standalone Agent EXE is byte-for-byte
  identical to the `techi-agent.exe` embedded in the active Agent MSI
  (`msiexec /a <msi> /qn TARGETDIR=…`). Upload/activate only matched artifacts.
  Never rebuild MSIs without need.
- CI: `.github/workflows/build-agent-msi.yml` (windows-latest, WiX v4) builds
  the MSI on pushes touching `agent/`; artifacts in the Actions tab.

# Package System

Three package types in Agent Packages UI, all can be active simultaneously
(manifest-based store, volume `agent_packages`):

| file_type | Contains | Consumed by | Public download endpoint |
|---|---|---|---|
| `msi` | agent + TECHI Remote Support (combined) | GPO/NETLOGON bootstrap, new PCs | `/api/v1/agent-packages/platform/windows-amd64/download` |
| `agent_binary` | techi-agent.exe only | self_update (agents ≥ 2.1.1) | `/api/v1/agent-packages/agent-binary/download` |
| `agent_update_msi` | agent-only "bridge" MSI (no RS) | self_update (agents < 2.1.1) | `/api/v1/agent-packages/agent-update-msi/download` |

# Logging

| Log | Config | State |
|---|---|---|
| Backend `techi.log` | RotatingFileHandler 10 MB × 5, volume `backend_logs` | Rotates ~hourly due to heartbeat access-log noise (filter committed, not deployed) **(verified)** |
| Backend/frontend containers | docker json-file 10m × 5 | OK **(verified)** |
| Postgres container | none | Unbounded (fix committed, not deployed) **(verified)** |
| NPM edge logs | host logrotate hourly, 100 MB cap, 3 gz | OK **(verified)**; heartbeats of the whole fleet hit `proxy-host-2_access.log` |
| Agent `agent.log` (endpoints) | `C:\ProgramData\TechiAgent\logs\agent.log`, append-only | **No rotation ≤ 2.1.5** (~0.5–1.5 MB/day/device); 2.1.6 rotates at 5 MB (keeps `.1`) |
| journald | SystemMaxUse=200M | OK **(verified)** |

# Security

- Operators: JWT auth, roles owner/admin/operator/readonly, teams + team
  permissions, operator scopes (client/group). Role gates on sensitive
  commands (`set_remote_password` is retired; run_powershell owner-only; reboot_pc admin+).
- Per-device Remote Support password: server-generated, encrypted at rest
  (`app/core/secret_cipher.py`, keyed off SECRET_KEY), delivered in every
  heartbeat response; agents ≥2.1.5 apply+persist it. `/connect-url` has a
  version-gated fallback to the legacy shared password for agents <2.1.5
  (retires itself as the fleet upgrades). Password endpoints audited,
  owner/admin only.
- Enrollment: token-based with audit trail; trusted-domain auto-assignment.
- Heartbeat identity is payload-based (agent_id/device_id/rustdesk_id) — the
  heartbeat endpoint itself is not operator-authenticated by design.
- Security headers middleware (nosniff, referrer-policy); CORS configurable.
- Frontend CSP (nginx.conf): fully self-contained since 2026-07-06 —
  JetBrains Mono is self-hosted under `/fonts/` (was Google Fonts CDN,
  which ad blockers routinely blocked); `style-src`/`font-src` no longer
  allow any third-party origin.
- **Open issues**: enrollment token plaintext in `\\DOMAIN\NETLOGON\techi-deploy.cmd`
  (readable by any domain user — ACL restriction pending); code signing declined
  by owner (AMSI-strict domains need first hop via GPO instead).

# Scheduler

One asyncio task inside the backend process (started in `app/main.py`
lifespan), fires daily at **03:00 UTC**: cleanup of heartbeats, telemetry,
activity events (7 days each) + `VACUUM ANALYZE`. No cron/systemd timer does DB
cleanup. The 03:00 host cron is the backup script (separate). The in-process
reconciliation worker (30 s) and the realtime publisher also start with the app.
The flag-gated `ReportWorker` checks due report schedules every 60 s and
prunes generated artifacts after 365 days; it is inert when Reporting is off.

# API

- Prefix `/api/v1` (OpenAPI at `/api/v1/docs`); plus legacy compat routes
  (`/api/heartbeat`, `/api/enroll`) that call the v1 handlers.
- Routers: agent (heartbeat/enroll), devices (+activity, rustdesk health/verify
  /override, notes), clients, groups, teams, operators, operator-scopes, auth,
  alerts, audit, enrollment-tokens, enrollment-bootstrap, trusted-domains,
  agent-commands (bulk/progress/history), agent-config (+heartbeat-script),
  agent-packages, packages, remote-support (incl. per-device password +
  connect-url), deployments (mock data only), actions, bootstrap, reports
  (per-client PDF/CSV generation, schedules, history/download), health.
- WebSocket: `/ws/devices` (scoped events per operator role/scope);
  `/ws/deployments` exists but unused.

# PostgreSQL

- 15-alpine, `max_connections=200`, `shared_buffers` default 128MB, autovacuum
  on (defaults) **(verified)**. pg_wal ~80 MB.
- **Schema gotcha (caused a fleet-wide heartbeat 500 outage once):** nothing
  runs Alembic in prod. Any new column/index on the heartbeat/enrollment fast
  path MUST be applied manually (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`) with the deploy.
  `ensure_sqlite_dev_schema` covers SQLite dev only.
- Alembic has a **pre-existing two-head fork** (`a1b2c3d4e5f7`,
  `e6f7a8b9c0d1`) — never run `alembic upgrade heads` blindly in prod; apply
  SQL by hand, optionally `alembic stamp`.
- Index facts **(verified)**: `ix_device_heartbeats_created_at` exists
  (hand-created); `ix_device_heartbeats_id`/`ix_device_telemetry_id` are exact
  duplicates of PKs (~200 MB); several heartbeat indexes have 0 lifetime scans
  (~165 MB). Any drop requires owner approval.

# Docker

- Compose project `techi-platform` (postgres/backend/frontend); backend
  mem_limit 800m; `agent_packages`, `backend_logs`, `backend_data`,
  `postgres_data` named volumes; `/opt/techi/packages` mounted ro.
- Separate projects: `rustdesk-server` (hbbs/hbbr), `nginx-proxy-manager`.
- NPM caveat: the proxy-host "Cache Assets" toggle strips upstream
  Cache-Control; it was disabled by hand — **UI edits to proxy hosts regenerate
  the conf and re-enable it**; durable fix is keeping "Cache Assets" unticked.

# Branch-et

| Branch | State |
|---|---|
| `stable/phase-2-heartbeat` | THE working + deploy branch. Local has **unpushed `49fce27`** (see Pending) |
| `pending-agent-2.1.6` | **MERGED into stable 2026-07-09** (`cd06f3b`) — historical; do not add new work here |
| `main` | Stale initial commit — not used |

# Versionet

- **Agent fleet target: 2.1.6** (owner-declared production baseline,
  2026-07-09; replaces 2.1.5) — release commit `1b0ddf3` on
  `stable/phase-2-heartbeat` (merge of `pending-agent-2.1.6`). Ships the
  startup lifecycle state machine (ONE engine shared by Windows + Linux),
  agent.log rotation, and cache pruning. Rollout via the existing
  NETLOGON/GPO mechanism (artifact replacement only — no GPO/script
  changes); fleet is mixed during rollout (`agent_version` per device in
  UI). From 2.1.7 on, self_update is the PRIMARY distribution channel;
  NETLOGON/GPO remains bootstrap + recovery. Source constant is
  `0.0.0-dev`; real version set at build. Official Windows artifacts
  (Agent MSI + Remote Support MSI + bridge MSI + standalone exe,
  SHA-aligned where applicable) come from ONE CI run of
  `build-agent-msi.yml`; Linux binaries built with
  `-X main.AgentVersion=2.1.6 -trimpath` (amd64/arm64/armhf).
- **Backend/frontend prod: content of `e0df46a`** (verified by container md5).
- Exact 2.1.6 artifact SHAs come from the single CI run of
  `build-agent-msi.yml` for release commit `1b0ddf3` (SHA-alignment rule);
  Linux binary SHAs in `agent/dist/SHA256SUMS-2.1.6-linux.txt`. Rollout
  wave status: check fleet dashboard (`agent_version` per device).

# Known Issues (real, current — not a backlog)

1. **Split-brain deploy dirs**: `/root` (live) vs `/opt/techi/techi-platform`
   (stale) — highest operational risk; standardization decision pending.
2. Backup config tar reads the stale checkout (currently harmless — identical).
3. Agents ≤ 2.1.5 (shrinking during rollout): `agent.log` unrotated on
   endpoints; stale MSI/exe caches accumulate per version — **fixed in
   2.1.6**, clears as the fleet upgrades.
4. Alembic two-head fork.
5. ~365 MB duplicate/never-used indexes in prod DB (approval needed to drop).
6. `change_heartbeat_interval` per-device is overridden by global policy in the
   same cycle.
7. Enrollment token plaintext in NETLOGON (ACL pending).
8. Orphan 2 GB postgres volume + 1.1 GB stray dump on server (approval pending).
9. Stale docstring in `agent_config.py` (claims interval needs GPO scripts;
    response-driven propagation is the real mechanism).
10. 25 GB disk structurally tight (~14 GB steady baseline).
11. 4 pre-existing test failures in
    `backend/tests/test_enrollment_audit_diagnostics.py` (missing
    `trusted_domains` table in test setup) — not caused by recent work.
12. Deployments page serves mock data (`/deployments/recent` is hardcoded).
13. **Agents ≤ 2.1.5 (shrinking during rollout): a transient startup failure
    silently kills the agent forever behind a RUNNING service** (root-caused
    2026-07-09: one failed read of `agent.config.json` at first service
    start — e.g. AV/EDR `Access is denied` on a freshly formatted domain
    PC — exits the agent loop before the first heartbeat; the service keeps
    reporting RUNNING, so SCM recovery and the watchdog never react and the
    device never appears in the platform). **Fixed in 2.1.6** (startup
    lifecycle state machine, merged to stable in `cd06f3b`/`1b0ddf3`) —
    clears as the fleet upgrades. Workaround on an affected ≤ 2.1.5 device:
    restart the TechiAgent service. See CHANGELOG-SOLUTIONS 2026-07-09 and
    OPERATOR-MANUAL §9a.

# PLATFORM EXPANSION

| | |
|---|---|
| **Status** | Architecture **APPROVED & DESIGN LOCKED** by the owner (2026-07-07). Implementation started: **Phase 0 — Platform Core Foundation** (dark, flags OFF). |
| **Baseline document** | [reference/PLATFORM-EXPANSION-AUDIT.md](reference/PLATFORM-EXPANSION-AUDIT.md) — frozen; architectural changes require an Architecture Amendment. Renamed from `LINUX-AGENT-DESIGN-SPEC.md` on approval. |
| **Objective** | Multi-platform RMM (Linux first; then MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox) by **extending** the existing platform — No Rewrite policy: no UI/backend/platform redesign, Windows remains the reference implementation. |
| **Feature Flags policy** | **(Revised 2026-07-10 — supersedes the original "default OFF" rule below for anything newly built from this date forward; historical entries in this section describing earlier flags as dark/OFF-by-default remain accurate as history.)** New functionality still ships behind an env-driven `FEATURE_*` flag while it's incomplete or intentionally hidden — flags are not going away, they stay the kill switch and the dark-development mechanism. But **a flag that has cleared implementation + automated tests + `preflight.sh` + `smoke.sh` + a production validation window is no longer treated as experimental**: it ships flipped ON (`.env` value only — the code-level flag/if-checks stay in place as a rollback switch, nothing is deleted) as a normal part of closing that work, not as a separate Manual-Approval round-trip. Flags are reserved for work that is genuinely incomplete or deliberately hidden, not for finished, validated features sitting dark indefinitely. Production is the primary validation environment for completed functionality — real usage surfaces real bugs faster than an extended dark period does. Deploy rigor is unchanged (preflight/smoke/rollback plan/CHANGELOG entry every time); what changes is that reaching "done" now defaults to ON instead of defaulting to another approval gate. Applies going forward; does not retroactively flip any flag already sitting OFF in prod without a deliberate decision to do so (see Feature work status for what is on/off today). |
| **Feature work status** | ⏸️ **LIVE VALIDATION (started 2026-07-08)** — NO new features. Operator Manual published (`docs/reference/OPERATOR-MANUAL.md`). **4 flags ENABLED in production for live testing (owner-approved 2026-07-08): `FEATURE_PLATFORM_CORE`, `FEATURE_LINUX`, `FEATURE_VAULT`, `FEATURE_MIKROTIK`.** `FEATURE_TERMINAL` is now **ON but scoped to device #729 only** (`FEATURE_TERMINAL_SCOPE=device`, `FEATURE_TERMINAL_ALLOWED_DEVICE_IDS=729` — owner-directed 2026-07-10 for a live Embedded SSH Connect validation via the real browser UI; every other device stays outside scope). OFF fleet-wide: `FEATURE_STORAGE`, `FEATURE_HYPERVISOR`. **To revert the device-729 SSH validation scope**: `cp /root/.env.bak-ssh-connect-validation-2026-07-10 /root/.env && docker compose -p techi-platform up -d backend` (restores `FEATURE_TERMINAL=false` fleet-wide; does not affect the other 4 flags above, which are set earlier in the same file). **Production is no longer bit-identical to the classic Windows RMM** — Linux/Connect-menu/Vault/MikroTik surfaces are now visible. Only production bug fixes allowed (root-cause → fix that bug → contract+regression+preflight+smoke → deploy → document). Rollback: `cp /root/.env.bak-2026-07-08 /root/.env && docker compose -p techi-platform up -d backend`. Enablement verified: flags loaded True in container; install/linux 200; connect/vault reachable; smoke 7/7; preflight PASSED; 0 real errors. **Prod tip now `07a808b`.** 2026-07-09: **MikroTik Platform Integration initially shipped as deployment + registration, then Connector v1 heartbeat/inventory was implemented** — additive, Windows byte-identical. Platform Registry is the single source: `PlatformDescriptor` gains `deployment_method`/`deployment_template`/versioned deployment templates/`supported_architectures`/`supported_routeros_versions`; MikroTik declares native RouterOS 6.x and 7.x enrollment templates + arches (chr/x86/arm/arm64/mipsbe/mmips/ppc/tile). `GET /install/mikrotik?token=...&routeros_version=6|7` (FEATURE_MIKROTIK-gated, default 7) generates the RouterOS script from the registry (never hardcoded); enrollment reuses the generic pipeline with registry arch-validation (unknown/absent arch → 400); MikroTik auto-lands under Client ▸ Network by platform (non-agent platforms no longer forced into Servers/Client PC). Deployment dialog renders MikroTik as a metadata-driven "script" section with a RouterOS Version selector (RouterOS 6.x / 7.x). Connect (Winbox/WebFig/SSH) metadata-only. Future RouterOS management = only Adapter+Capability+Action+Renderer, no Drawer/Tree/UI change. Was: **Prod tip `a5a9b86`. Step 2 — generic enrollment auto-group shipped.** A token carrying a Client but no Default Group now auto-places the device in the correct standard group (Servers/Client PC) via the Unified Classification Engine — any platform, no manual assignment; explicit Default Group respected; platform identity from the agent. Was: **Registry-driven Device Drawer — Step 1 COMPLETE (1a+1b+1c).** The Action Registry (`platform_core/actions.py`) is the single source of truth for every executable operation; `ACTION_PERMISSION_MAP` now derives from it, and the UI (`/drawer`), execution (queue by action_type == descriptor id) and audit (`ACTION_QUEUED`) all consume the same descriptor. Was: **Steps 1a + 1b shipped.** Capability-reporting devices (Linux + future platforms) now render via the new `GenericDeviceDrawer`, driven entirely by `GET /devices/{id}/drawer` (Platform + Capability + Action + Connect registries): Connect-primary Overview, capability tabs (Services/Docker/Logs/Network/…), Action-Registry Management buttons, Terminal when capable, and **no Remote Support unless the device reports the `remote_support` capability**. Renderer is selected at the render site — devices with no capabilities (every Windows agent) use the classic `DeviceDrawer`, **untouched and byte-identical** (zero edits to DeviceDrawer.tsx). Adding a platform needs no Drawer changes. Was: **Step 1a shipped dark.** The Drawer is being completed into a generic renderer fed by Platform + Capability + **Action** + Connect registries (no Windows/Linux branching; Windows selected as the grandfathered renderer → byte-identical). `platform_core/actions.py` is the single source of truth per executable operation (id/label/permission/required_capability/confirm/audit/target/handler); `effective_capabilities()` uses "absence ⇒ platform's declared capabilities" so the capability-less Windows fleet keeps its full surface with no agent rebuild. New dark `GET /devices/{id}/drawer` (CORE-gated) is the renderer's single feed. Verified live: Linux `rustdesk-srv` (no RS, capability tabs, SSH/terminal) and Windows (full RS surface). UI untouched. Next: Step 1b (frontend generic renderer + Windows renderer selection), Step 1c (permission/label/audit derive from the registry), then Step 2 (platform-neutral enrollment). Earlier 2026-07-09: Deployment dialog is now platform-aware — the token Deployment modal (Deployment ▸ View) renders metadata-driven, feature-flag-gated sections (Windows always; Linux when `FEATURE_LINUX`; macOS/MikroTik/Synology/QNAP/VMware/Hyper-V/Proxmox as reserved placeholders gated by their flags). **One shared token across all platforms** (derived from the Windows bootstrap URL). **Windows block byte-identical**, zero backend changes. Earlier 2026-07-09: Linux agent package chain fixed end-to-end (was shipped dark, never runnable) — upload accepts raw `.bin`, public download supports `linux-amd64/arm64/armhf` and resolves `linux-*` via `file_type=agent_binary`, installer maps armhf; **Windows package path (MSI bootstrap / GPO / self-update / selection) byte-identical** (separate branch). Live: linux-amd64→404 reachable, freebsd→400, windows-amd64→200. First `linux-amd64` binary built (`agent/dist/techi-agent-linux-amd64.bin`, AgentVersion 2.1.5), pending first upload + first live Linux enrollment (3CX/Debian). Earlier 2026-07-08 work: [0] Device Tree click not syncing with Catalog — frontend SWR cache key `deviceTableCacheKey` omitted `category`/`platform` (regression after the tree moved to those filters in e08544d) so selections within a client collided and served stale rows until manual Refresh; fixed by adding both to the key (engine untouched); [1] Device Tree filtering made cumulative (filter==badge, 28/28 clients); [2] heartbeat manual-lock hole closed via single `DeviceAssignmentService.is_manual_locked()`; [3] **Unified Classification Engine SHIPPED** — `app/platform_core/classification.py` is now the ONE source of truth for device Category + Platform, replacing the four duplicated classifiers (C1 resolution / C2 smart_folder / C3 tree-case / C4 write-time). One ordered rule table rendered as SQL (`category_case`/`platform_case`) **and** in-memory (`classify_category`/`classify_platform`), kept identical by a parity contract test and a `preflight.sh` guard that forbids the retired symbols. All consumers (tree badges, overview, catalog/search filters, smart folders, Drawer/resolution, enrollment placement) read it; new additive `Other` tree folder (custom-group devices). Delivered P1–P5, each contract+preflight+smoke then deploy; verified byte-identical on the live fleet (723 devices, 0 custom groups) for both SQL counts (28/28 clients) and resolved category (723/723). Specs: `docs/reference/CLASSIFICATION-ARCHITECTURE-REVIEW.md` + `docs/reference/UNIFIED-CLASSIFICATION-ENGINE-SPEC.md`. |
| **Process** | One phase at a time; hard STOP + explicit owner approval between phases; each phase closes only via the audit's Appendix A (Definition of Done) + Appendix B (Regression Matrix) + Appendix C (Platform Certification). |
| **Constraints** | Agent work lands on `stable/phase-2-heartbeat` again (2.1.6 is the baseline; the 2.1.5-freeze standing order is closed, owner 2026-07-09). Enabling `FEATURE_TERMINAL` + choosing its rollout scope (`FEATURE_TERMINAL_SCOPE` + allowlist, see Embedded Connect entry below) requires separate explicit owner approval — NPM itself needs no change (verified 2026-07-10). Zabbix boundary: TECHI stays a remote-management platform — basic device facts only, no monitoring buildout. |
| **Current Phase** | ✅ Phases 0, 1, 4, **2** deployed & closed 2026-07-07 (prod tip `59a781b`): platform_core + platform_adapters + 7 nullable `devices` columns + Credential Vault (`FEATURE_VAULT`) + **Linux Agent MVP** (`agent/pal.go` + `platform_linux.go`: capabilities, os-release inventory, systemd service management + self-update; backend `GET /install/linux` + `linux-arm64` package type — all `FEATURE_LINUX`). Windows agent NOT rebuilt/redeployed — fleet stays 2.1.5; Linux → **Experimental** (Appendix C). All expansion flags were OFF in prod as of this 2026-07-07 phase (verified then) — **this is no longer current: as of 2026-07-14 the expansion flags are ON in prod; see the "Platform Feature Flags (prod)" row at the top of this document**. **Execution order (owner 2026-07-07): platform before IAM** — Vault Safety ✅ → Linux Agent ✅ → Phase 3 Linux UI ✅ → Phase 5 Web Terminal DARK ✅ (behind `FEATURE_TERMINAL` OFF; NPM WS route + flag-enable = Manual Approval, not done) → **Phase 7 MikroTik Proxy Adapter + Connect Framework DARK ✅** (capability-driven `/connect-methods` + ConnectMenu, MikroTik proxy adapter registered, Network/Storage/Hypervisor auto-classification + tree folders + `category` filter — all flag-gated; launchers/RouterOS API = next phase per boundary) → 8 Storage → 9 Hypervisors → 6 IAM last. (Flag state as of 2026-07-07; current prod flag state is in the top "Platform Feature Flags (prod)" row — CORE/LINUX/MIKROTIK/REPORTING/VAULT/TERMINAL are ON as of 2026-07-14.) **Adding a platform now = adapter + capability mapping + icon + connect methods, no UI change.** Standing implementation authority (manual approval reserved for: architecture changes, breaking DB/API changes, behavior removal, security-model changes, default-ON flags, downtime migrations). Enabling FEATURE_LINUX for a canary = Manual Approval. |
| **Execution roadmap** | [IMPLEMENTATION-ROADMAP.md](IMPLEMENTATION-ROADMAP.md) — single source of truth for implementation **progress** (phases, status, health); updated after every phase. Every phase begins by reading PROJECT_STATE → CHANGELOG-SOLUTIONS → PLATFORM-EXPANSION-AUDIT → IMPLEMENTATION-ROADMAP. |

**MikroTik Connector v1 (2026-07-09, deployed; SIMPLIFIED 2026-07-10):**
MikroTik is a **Connector, not an agent** — TECHI is an RMM, not a Winbox
replacement; advanced RouterOS work happens through Connect (Winbox/WebFig/
SSH). The Platform Registry RouterOS 6/7 templates generate a deliberately
SMALL script (~49 lines / ~4.6 KB; zero `:foreach`, zero RouterOS globals —
reboot-safe self-contained scripts; a size/flatness contract test forbids
growth) that enrolls once and installs two scheduler jobs, `TECHI-Heartbeat`
and `TECHI-Inventory`, with intervals from the Agent Config per-platform
policy (RouterOS defaults: 250 s / 1800 s). Stable identity is
`mikrotik-<serial-or-software-id>` with no hostname/MAC fallback (a bare
`mikrotik-` is rejected). Heartbeat sends only agent_id/hostname/platform/
os_name/os_version/architecture/local_ip/agent_version/`connect` (~250 B);
public IP is inferred server-side from X-Forwarded-For; health is computed
entirely by the backend. Inventory sends only Board/Model/Serial/Firmware/
Uptime/Bridges/Wireless yes-no/DefaultRoute yes-no (packed in os_caption) +
CPU/RAM/storage + 2 static software rows (RouterOS, RouterBOOT) — no
interface/package/route/firewall/DNS enumeration (~450 B). The device reports
only the `connect` capability → the compact Generic Drawer renders
Overview / Management / Notes / Timeline with **no capability tabs**;
Overview shows identity, RouterOS version, board, architecture, Last Seen,
Health, local/public IP, connector version. Connect is Winbox/WebFig/SSH
metadata only; Action Registry exposes Refresh Inventory, Restart Connector,
Re-enroll. Timeline stays lightweight: `heartbeat_received` only on a
transition (first heartbeat / offline→online), `inventory_updated` per
snapshot — never one row per beat. No Windows/Linux/macOS deployment or
enrollment path changed.

**Enterprise completion (2026-07-10, deployed):** four fixes/additions, all
reusing existing registries — no redesign, no MikroTik-specific backend code.
(1) **Enrollment-loss root cause found and closed**: the generic enrollment
pipeline (`AgentEnrollmentService` → `apply_enrollment_assignment`) already
assigns Client/Group from the token correctly and a new regression test
proves it end-to-end (real enroll → heartbeat, same as the router does).
The actual failure mode was that `/tool fetch` on RouterOS does not raise a
script error on a non-2xx HTTP response, so a failed enroll (bad/used token,
network hiccup) let the script silently continue to install the scheduler
and start heartbeating — auto-creating an unassigned device via the existing
stable-identity fast path. Fixed at the connector, not the backend: the
enroll `/tool fetch` is now wrapped in `:do{...}on-error={:error "TECHI
enrollment failed"}`, halting the script (no scheduler install, no
heartbeat) so a device can never appear without its token's Client/Group. A
second regression test documents the prevented failure mode. Script grew
49→62 lines (ceiling raised 60→70, contract test still forbids
loops/globals/enumeration). (2) **Connect launchers implemented**: `GET
/devices/{id}/connect-methods/{method_id}/launch` (new, permission-gated by
the existing `remote_support_connect` permission, audited via the existing
`remote_connect` audit action — same pattern as Windows Remote Support's
`/connect-url`) builds `scheme://<host>` (Winbox, SSH) or
`http://<host><web_path>` (WebFig) from the device's local/public IP;
generic for any platform via new `ConnectMethod.web_path` field, no
per-platform code. Frontend `ConnectMenu` now actually navigates
(`clickProtocolUrl`, exported from the existing RustDesk launch service) or
opens a new tab instead of showing a "coming soon" toast; `remote_support`/
`web_terminal` keep their own existing dedicated flows untouched. RouterOS
API and Terminal remain explicitly out of scope. (3) **Resource cards**:
MikroTik heartbeat/inventory now populate the SAME generic `cpu_percent`/
`ram_percent`/`disk_percent` telemetry fields Windows/Linux already use
(single RouterOS property reads — `cpu-load`, `free-memory`, `free-hdd-space`
— no loops); the Generic Drawer Overview renders them with the existing
`ResourceBar` component, current utilization only, no monitoring graphs.
(4) **Overview/assignment parity with Windows**: added a Device ID row and
an editable Client/Group assignment section reusing the exact
`assignDeviceClient`/`assignDeviceGroup` API calls and `AssignmentSourceBadge`
pattern the classic Windows Drawer uses — zero edits to `DeviceDrawer.tsx`
(Windows stays byte-identical).

**UX/platform-consistency pass (2026-07-10, deployed):** the Generic Device
Drawer is now the standard drawer for every non-Windows platform (Linux,
MikroTik, and every future connector) — a single enterprise layout, not a
prototype. `DeviceDrawer.tsx` (Windows) has zero edits across this pass.
- **Drawer Overview** restructured to exactly 5 sections (Connect, Identity,
  Status, Resources, Assignment — no Capabilities chip list, no long
  lists/oversized cards): Connect as a compact top bar; Identity + Status
  side-by-side (Device ID, hostname, platform, OS, kernel, architecture,
  board, last seen, health, local/public IP, current user); Resources full-
  width (CPU/Memory/Storage bars via the existing `ResourceBar`); Assignment
  (Client/Group/Source + editable selects).
- **Version Service** (`backend/app/services/version_service.py`, new):
  `compare_versions(reported, latest) -> current|outdated|ahead|unknown` and
  `get_active_version(platform)` — Windows/Linux delegate to the existing
  active-`AgentPackage` logic (untouched, byte-identical); connector
  platforms compare against `PlatformDescriptor.latest_connector_version`
  (new registry field; MikroTik's `MIKROTIK_CONNECTOR_VERSION` moved here as
  the single source, so bumping the RouterOS template's version updates
  script generation + every badge together — no more copies to drift). New
  shared `VersionBadge.tsx` (green=current, orange=outdated, blue=ahead —
  "ahead" is net-new, unreachable for Windows in normal operation) renders
  in both the Drawer (`/devices/{id}/drawer` now returns `reported_version`/
  `latest_version`/`version_status`, null for Windows) and the Device List
  (`DeviceFleetOverview.active_connector_versions`; Windows rows resolve to
  the exact prior `activePackageVersion`/`isAgentOutdated` call — zero visual
  change). Root cause of "MikroTik always orange 1.0.0": the list badge
  compared EVERY device, including MikroTik, against the Windows fleet's
  active package version.
- **Assignment "Group empty" fixed** — reused the Unified Classification
  Engine, no MikroTik-specific code: `DeviceAssignmentService.
  resolve_device_assignment` now falls back to the category's display label
  (`classification.category_display_label`: "Network"/"Storage"/
  "Hypervisors") when a device has `client_id` but no real `DeviceGroup` row
  — true for every non-agent/connector platform by design (a standard
  agent group would mis-classify them; confirmed the Device Tree's
  Client▸Network▸MikroTik nesting already worked correctly via the existing
  virtual/computed `count_by_client_category_platform` — no real group row
  needed there, same mechanism as Client▸Servers▸Windows).
- **Connect launchers are now platform-aware**: new `ConnectMethod.
  requires_client_os` (Winbox → `"windows"`, everything else `None`) —
  `ConnectMenu.tsx` detects the OPERATOR's OS (`navigator.platform`, same
  pattern as the existing iOS check in `rustdeskLaunch.ts`) and hides any
  method that can't work there (Winbox hidden on macOS/Linux; WebFig + SSH
  always offered). Backend never filters by operator OS — it only declares
  the requirement; the browser decides visibility.
- **current_user added to MikroTik**, Inventory only (not Heartbeat, per
  RouterOS load discipline): active `/user active` session name, one query,
  packed into the existing generic `current_user` field.
- **Embedded SSH terminal — BUILT 2026-07-10** (see "Embedded SSH Connect"
  entry below and PROJECT_STATE item 2a): the recorded "connector relay"
  recommendation (backend-as-SSH-client, reusing `TerminalRelay`/
  `TerminalSession` + Credential Vault) shipped for real. Connect ▸ SSH now
  opens the Embedded TECHI Terminal by default for any device whose Connect
  Framework entry declares an `ssh` method (Linux, MikroTik, future Storage/
  Hypervisor platforms); the operator's own OS SSH client remains a secondary
  link. Known limitation carried over: the backend must have network
  reachability to the device (no NAT traversal) — same constraint this entry
  originally identified.

**Visual polish pass (2026-07-10, deployed):** the Generic Device Drawer
became the final enterprise-grade standard interface for every non-Windows
platform (reference points: NinjaOne, Datto RMM, Domotz, Linear, GitHub
Enterprise) — frontend-only, zero backend changes, zero edits to
`DeviceDrawer.tsx` (Windows). Verified in a real browser (local backend +
Vite dev server + Playwright, seeded MikroTik + Linux devices) in both dark
and light theme before shipping.
- **Header**: platform icon chip (reused `PlatformIcon`), larger hostname,
  Online/Offline dot + `HealthBadge` (reused, same component Windows uses)
  + hostname inline — device identity and health are visible before opening
  a tab, per the requested information hierarchy (what/healthy/connect/
  resources/assignment).
- **Overview reordered**: Connect is now a prominent top card (icon chip +
  method count + a real primary-styled CTA button, brand-accent tinted) —
  "the primary entry point for device management," not a plain dropdown.
  Identity + Status paired side-by-side below it; Resources full-width;
  Assignment last (lowest priority per the hierarchy). Removed two
  redundant rows (Platform, Health) that duplicated the header.
- **Typography**: row values 11px→12.5px and medium→semibold; section
  titles gained a 20×20 accent icon chip; Device ID and IP rows use
  monospace. Still compact — no added scroll.
- **Color system**: quiet per-section accent (icon chip only, never a
  filled background) — Identity=blue, Status=green, Resources=purple,
  Assignment=orange, Connect=brand accent ("neutral" primary, not a 5th
  hue) — via new `ACCENTS` map in `GenericDeviceDrawer.tsx`. No gradients,
  no colorful chrome.
- **Resources**: new local `ResourceMeter` (icon + bold % + colored fill,
  amber ≥75%, red ≥90%) — visually resembles the requested reference
  design. Deliberately NOT added to the shared `ResourceBar.tsx` (Windows
  also uses that component) — kept local to the Generic Drawer so Windows'
  own Overview is untouched by this pass.
- **Connect menu** (`ConnectMenu.tsx`): trigger restyled as a real primary
  button (brand-accent fill, `Link2` icon); dropdown items switched from
  hardcoded Tailwind `slate-*` colors (which ignored the light theme) to
  theme tokens — a real pre-existing bug fixed, not just a restyle.
- **Live-verified via Playwright** (seeded local devices, not just tsc):
  MikroTik Overview renders Group "Network" (assignment fix confirmed
  visually); Connect dropdown on a Linux-container browser correctly hides
  Winbox and offers only WebFig/SSH (OS-awareness confirmed live, not just
  in tests); Resource meters show purple/amber/red correctly at 63/78/91%;
  light theme renders every card/badge/icon correctly with no hardcoded
  dark-only colors; Management tab actions and tab overflow scroll checked.

**Embedded Connect / Web Terminal — production-ready, code complete
(2026-07-10, deployed dark; FEATURE_TERMINAL stays OFF).** Phase 5's two
documented "Manual Approval" blockers, and the remaining lifecycle gaps, are
now closed:

- **NPM WS route blocker didn't exist.** Live inspection of
  `/root/nginx-proxy-manager/data/nginx/proxy_host/2.conf` on production
  shows `api-rdp.techi.com.al` has a single catch-all `location /` with
  `proxy_set_header Upgrade`/`Connection`/`proxy_http_version 1.1` applied
  host-wide (not scoped to `/ws/devices`) — NPM's websocket toggle is per
  proxy-host, not per-path, so `/ws/terminal/{id}` and
  `/ws/agent/terminal/{id}` are already reachable through the existing
  config. No NPM change was needed.
- **Generic rollout scoping** (`backend/app/platform_core/rollout.py`, new):
  a fleet-wide `FEATURE_*` flag alone has no per-device concept, so this adds
  a second, reusable axis — `{PREFIX}_SCOPE` (`none`/`device`/`group`/
  `client`/`fleet`) plus `{PREFIX}_ALLOWED_DEVICE_IDS`/`_ALLOWED_GROUPS`/
  `_ALLOWED_CLIENTS` — enforced server-side only, default `none` (fail
  closed regardless of the flag). `FEATURE_TERMINAL_*` is the first
  consumer; the mechanism takes the feature prefix as a parameter so future
  features (Remote Actions, an SSH relay, future connector platforms) reuse
  it without inventing their own allowlist shape. Enforced in
  `POST /devices/{id}/terminal/sessions` (403 outside scope, audited both on
  grant and denial via new `AuditAction.TERMINAL_SESSION_*` constants).
- **Lifecycle completed, reusing the existing session/relay architecture**
  (no redesign): `TerminalRelay` (`backend/app/services/terminal_relay.py`)
  now tracks per-pair activity/start time and exposes a read-only
  `idle_and_expired_sessions()` snapshot; a new `TerminalWatchdog`
  (`backend/app/workers/terminal_watchdog.py`, same start/stop pattern as
  `device_reconciliation_worker`) sweeps every 30 s — expires stale PENDING
  tickets and force-closes ACTIVE pairs past the existing
  `IDLE_TIMEOUT_SECONDS` (900 s) / `SESSION_MAX_SECONDS` (3600 s) constants,
  closing the relay, marking the DB session, and writing an audit entry so a
  forgotten tab or a wedged agent connection can never leak an orphan
  session/PTY/websocket. Only started when `FEATURE_TERMINAL` is enabled
  (`main.py` lifespan) — flag OFF stays zero-extra-behavior (no new periodic
  queries). Both WS handlers (`terminal_routes.py`) now log every
  attach/reject/close and write a `terminal_session_closed` audit entry on
  every disconnect (`operator_closed`/`agent_gone`), not just the watchdog
  path. Resize was already implemented (frontend sends a `{t:"resize"}`
  control frame over the data channel; the Linux agent's `pty.Setsize` — no
  change needed). Frontend (`DeviceTerminal.tsx`) gained bounded
  auto-reconnect (up to 2 attempts on an abnormal WS close, i.e.
  `event.code !== 4001/4003`) plus a manual "Reconnect" button — a
  reconnect always opens a **new** backend session/PTY (the architecture is
  one-shot end-to-end; there is no mid-session state to resume), which is
  surfaced to the operator via a `[reconnected — new session]` marker rather
  than pretending continuity.
- **Linux-only, capability-driven, no platform-specific code**: every new
  gate (flag, rollout scope, capability check) is generic; nothing added
  checks `platform == "linux"` anywhere — Linux is the only platform live
  today purely because it's the only agent that reports the `terminal`
  capability.

Preflight PASSED: contract 13/13, backend suite 566 passed + 4 known
baseline (flags off & on, +28 new tests: rollout scope, relay idle/
max-duration sweep, watchdog sweep+audit, endpoint scope enforcement),
tsc/build clean, agent builds. **Deployed to production with
`FEATURE_TERMINAL=false` unchanged** — code is live but inert (flag-off
behavior byte-identical, matching Phase 5's original darkness invariant).
Remaining manual step: owner sets `FEATURE_TERMINAL=true` +
`FEATURE_TERMINAL_SCOPE`/allowlist in prod `.env` and restarts backend —
still Manual Approval, now a config-only change with zero further code work.

**Embedded SSH Connect (2026-07-10, code complete, deployed dark under the
same `FEATURE_TERMINAL` flag — no new flag).** Completes the "connector
relay" architecture this document previously only recommended (see the
now-updated MikroTik entry above): Device Drawer ▸ Connect ▸ SSH opens an
**Embedded TECHI Terminal** by default — the external OS SSH client stays a
secondary link — for any device whose Connect Framework entry declares an
`ssh` method, generically (Linux, MikroTik, future Storage/Hypervisor
platforms; no per-platform code).

- **Transport, fully reused, zero changes**: `app/services/ssh_connector.py`
  (new) has the backend itself dial the SSH connection (`asyncssh`, new
  pinned dependency) and attach as the "agent" leg of the SAME `TerminalRelay`
  pair the operator's browser connects to via the existing
  `/ws/terminal/{id}` route — `TerminalRelay.pump()`/`close()`,
  `TerminalWatchdog`'s idle/max-duration sweep, and the operator-side WS
  handler in `terminal_routes.py` needed no changes at all (a small
  `SSHConnectAdapter` duck-types the WebSocket interface `pump()` uses).
  `terminal_routes.py`'s session-end audit now picks `SSH_SESSION_ENDED` vs
  `TERMINAL_SESSION_CLOSED` based on the session's `mode` column.
- **Credential resolution**: `VaultService.resolve_ssh_candidates()` (new)
  reuses the exact Device > Group > Client > Global precedence
  `resolve_for_context()` established, but returns every ACTIVE SSH-type
  credential (`ssh_password`/`ssh_private_key`/legacy `ssh_key`) at the first
  non-empty tier — `GET /devices/{id}/ssh/credentials` lets the frontend
  auto-connect on exactly one candidate, show a selector on multiple, or show
  a clear "no SSH credential available" message + an explicit **Temporary
  Session** option on none (ad hoc username/password, used once, never
  persisted to the Vault, audited distinctly from a resolved credential).
- **Schema (additive)**: `terminal_sessions` gains 4 nullable columns —
  `mode` (`agent`|`ssh`), `vault_credential_id`, `ssh_username`,
  `credential_source` (`device`|`group`|`client`|`global`|`temporary`).
  `TerminalSessionStatus.FAILED` (previously an unused enum value) is now
  used for a dial failure, with `TerminalService.close()` guarded so a later
  generic close can never clobber a specific failure reason.
- **RBAC**: 4 new granular permissions — `terminal_open`/`terminal_view`/
  `terminal_manage`/`vault_use` — additive over the existing admin+ floor,
  same shape as the 7 `vault_*` permissions (a new shared
  `require_role_or_permission()` in `app/core/auth.py` generalizes vault.py's
  own `_vault_gate` pattern without touching that shipped file). Using a
  *stored* Vault credential additionally requires `vault_use`; a Temporary
  Session never touches the Vault so it doesn't need it.
- **Audit**: 6 new actions — `ssh_session_started`/`ssh_session_ended`,
  `ssh_credential_resolved`/`ssh_credential_missing`,
  `ssh_connection_failed`/`ssh_authentication_failed`.
- **Errors handled distinctly** (`SSHConnectError.reason`, mapped from
  `asyncssh` exceptions): `credential_missing`, `host_unreachable`,
  `authentication_failed`, `timeout`, `host_key_mismatch`,
  `connection_refused`, `network_error` — surfaced to the operator via the
  session-detail endpoint rather than a generic "connection closed".
- **Session info panel**: device, client, operator, username, authentication
  source, start, duration, idle timer (new `TerminalRelay.idle_seconds()`),
  status — `GET /devices/{id}/ssh/sessions/{id}`.
- **Vault UI**: "Used by: Embedded SSH" (new, derived from a real `use`
  usage row — distinct from the static `future_consumers` hint) + Last Used
  now reflect real SSH usage (`VaultService.record_credential_use()`).
- **Known limitation**: SSH host-key verification is not enforced
  (`known_hosts=None` — no shared per-device trusted-key store exists yet);
  the error-mapping path for a mismatch is implemented so enabling
  verification later needs no further change. Reachability constraint
  unchanged from the original recommendation (backend must reach the
  device's IP; no NAT traversal — same as the Linux/MikroTik SSH note).
- **Testing**: 73 new tests (49 backend across 4 new files — credential
  resolution/multiple/missing, session lifecycle, connector error-mapping,
  RBAC; 24 frontend across 4 new/updated files). Preflight PASSED: contract
  15/15, backend suite 729 passed + 4 known baseline (flags off & on), full
  frontend vitest suite 41/41, tsc/build/agent clean, smoke 8/8 (local).
  **Deployed dark — `FEATURE_TERMINAL` unchanged (still off in prod)**, same
  darkness invariant as the rest of this section.

**Notification Engine (2026-07-10, deployed dark; `FEATURE_NOTIFICATIONS`
stays `false`).** New 9th flag, same conventions as the other 8 (env-driven,
default OFF, flag-off = zero behavior change, checked once at the top of
`dispatch()`). Email + generic Webhook channels (a small `NotificationSender`
interface + `CHANNEL_SENDERS` registry — Slack/Teams/Telegram/Discord/
PagerDuty are a new class + one registry line away, no change to dispatch
logic). 3 new tables (`notification_channels`/`notification_rules`/
`notification_deliveries`) — channel secrets (SMTP password / webhook
shared secret) encrypted with the same AES-256-GCM cipher/master key as the
Credential Vault (`vault_cipher.py`, reused directly). Wired into 5 existing
event sources with one small addition each — nothing redesigned: **Alert
Engine** (`device_offline`/`device_online`/`critical_alert`, the last firing
for any CRITICAL-severity alert regardless of kind), **Remote Actions**
(`remote_action_completed/failed`, or `agent_update_completed/failed` for
`self_update` specifically), **Terminal** (`terminal_session_started/ended`,
folded into the existing `mark_active()`/`_audit_session_end()` call sites
so the watchdog's idle/max-duration closes are covered automatically),
**Enrollment** (`enrollment_failed`, hooked once inside the existing
`_record_audit()` helper — covers all 5 existing failure call sites),
**Maintenance** (`maintenance_finished`, both manual clear and scheduled
auto-expiry). Rules support global or per-client scope, severity filtering,
cooldown, and an hourly rate limit; failed sends retry on a fixed backoff
(1/5/15/30 min) via a new `NotificationWorker` (identical start/stop/sweep
pattern to `terminal_watchdog`, only started when the flag is on). New
`/notifications` page (Channels/Rules/Delivery History), `system_settings`
+ flag gated, reusing the exact Credential Vault page pattern
(`premium-card`/`Badge`/`Button`/`ConfirmationModal`). Every channel/rule
mutation is audited. Preflight PASSED: contract 14/14, suite 620+4 baseline
(flags off & on, +54 new tests: service dispatch logic, channel senders,
API CRUD/RBAC/audit, retry worker, and a wiring-regression suite proving
each of the 5 event sources actually calls `dispatch()`). **Remaining
manual step: owner sets `FEATURE_NOTIFICATIONS=true` in prod `.env`,
configures at least one channel + rule in the UI, and restarts backend** —
Manual Approval, config/UI-only, zero further code work.

**Reporting Engine v1 (2026-07-10, production-ready).** New
`FEATURE_REPORTING` rollback flag. Reuses the existing Device Overview service,
Device/Alert repositories, client/team scope, audit service, worker lifecycle,
and TECHI UI components. Operators with `view_devices` plus full-client scope
can generate and download a complete client report; group/device-only scope is
deliberately insufficient because a client report contains the full client
fleet. Admin/Owner can create daily/weekly/monthly UTC schedules. PDF and CSV
contain current fleet health/device inventory plus alert activity for a
validated 1–366 day period. Generated artifacts live under the persistent
`backend_data` volume (`data/reports`), have database-backed run history, and
are retained 365 days. Every generation, failure, download, and schedule
mutation is audited; failed scheduled runs are visible and advance normally
instead of retry-looping. Two additive tables: `report_schedules` and
`report_runs`. Preflight: contract 15/15, backend 635 passed + 4 known baseline
in both flag modes, frontend TypeScript/build clean, agent builds clean.

# RDP TECHI MOBILE UI 2.0

| | |
|---|---|
| **Status** | ✅ DEPLOYED — të 7 fazat live në prodhim (2026-07-06), verifikuar me Playwright kundër https://rdp.techi.com.al. 5 raunde rregullimesh pas deploy-it, gjithashtu live. |
| **Current Phase** | E përfunduar. Punë e ardhshme (Notifications/Web Push, tablet layout, etj.) kërkon amendament të ri të MOBILE-DESIGN-SPEC.md |
| **Progress** | 7/7 faza të commit-uara: Phase 1 → `27f1687`, Phase 2 → `6db4ed9`, Phase 3 → `e3dcdff`, Phase 4 → `259e1fc`, Phase 5 → `d0dd447`, Phase 6 → `1a660aa`, Phase 7 → `a8a35ea`. Push-uar (`origin/stable/phase-2-heartbeat`) dhe deploy-uar në prodhim 2026-07-06. Post-deploy: Raundi 1 (Software lazy-fetch + Sparkline) → `44770fd`, Raundi 2 (Uptime/Latency format) → `7161f73`, Raundi 3 (No Client te FilterSheet + Disk filter te Alerts) → `c1b5f9f`, Raundi 4 (iOS Safari auto-zoom fix te input-et) → `b833138`, Raundi 5 (apple-touch-icon.png i vjetëruar + nginx cache 1-vjeçar) → `3fe523c`. |
| **Current Sprint** | I mbyllur. Shih CHANGELOG-SOLUTIONS.md (2026-07-06) për detajet e deploy-it dhe 5 raundeve të rregullimeve. |
| **Reference Document** | [reference/MOBILE-DESIGN-SPEC.md](reference/MOBILE-DESIGN-SPEC.md) — kontrata zyrtare e dizajnit (design-locked; ndryshimet vetëm me amendament) |
| **Mockup i aprovuar** | https://claude.ai/code/artifact/af146cd9-d000-49d3-b723-35442ee3eaae |

**Current Priorities**: Phase 1 (shell/nav/tokens/shared) → Phase 2 Dashboard →
Phase 3 Devices/Search/Filters → Phase 4 Device Details (faqe `/devices/:id`) →
Phase 5 Alerts → Phase 6 More/Settings/RS → Phase 7 states/a11y/polish.
Commit në fund të çdo faze, vetëm pas aprovimit; pa push, pa merge, pa deploy.

**Documentation**: specifikimi i plotë, wireframes, design tokens, rregullat
a11y/responsive dhe Implementation Notes jetojnë VETËM te
`docs/reference/MOBILE-DESIGN-SPEC.md` (mos e dubliko këtu); progresi i fazave
përditësohet aty (Progress Log) + kjo tabelë (vetëm rreshtat Status/Phase/
Progress).

**Known Risks**: (1) regresion desktop nga ndarjet `md:hidden` në AppShell —
mitigohet duke mos prekur komponentët desktop dhe me `tsc --noEmit` + verifikim
vizual desktop pas çdo faze; (2) Device Details si faqe e re krah drawer-it
desktop — komponentë të ndarë, drawer i paprekur; (3) sjellje browser-i mobile
(pull-to-refresh, keyboard) — testim në pajisje reale në Phase 7.

**Implementation Rules**: vetëm UX/UI mobile (`<768px`); API contracts,
permissions, auth, realtime, business logic — të paprekura; asnjë ngjyrë
hardcoded jashtë tokens; asnjë TODO/FIXME/placeholder; devijimet teknike
regjistrohen si Implementation Notes në spec, jo si ndryshime dizajni.

**Deploy 2026-07-06** (shih CHANGELOG-SOLUTIONS.md për detaje të plota):
push i 9 commits (7 fazat mobile + `49fce27` storage batch + `1fe93de` docs,
aprovuar shprehimisht nga owner-i pas pyetjes për scope-in e push-it); pull
në `/root`; index `ix_device_heartbeats_created_at` (ekzistonte tashmë) i
"stamped" në Alembic; backend+frontend rindërtuar dhe rikrijuar; postgres
u rikrijua **vetë nga Docker Compose** (jo e planifikuar — ndryshimi i
log-cap në docker-compose.yml e detyroi) — u shërua në ~30s, 0 humbje
heartbeat, verifikuar menjëherë me logje. Të tre kontejnerët "healthy";
verifikuar vizualisht me Playwright kundër site-it real (login manual):
Dashboard/Devices/Device Details (`/devices/714`)/Alerts/More/Settings —
0 gabime 4xx/5xx në sweep të pastër të 6 rrugëve kryesore.

# Pending Features (committed/decided but not live)

- ~~Deploy of `49fce27`~~ — **done 2026-07-06**, deployed alongside Mobile
  UI 2.0 (see CHANGELOG-SOLUTIONS.md entry for that date). The
  `ix_device_heartbeats_created_at` index already existed in prod (applied
  by hand previously) and was stamped in Alembic; the postgres log-cap
  took effect as a side effect of an unplanned container recreation
  (Compose auto-recreated postgres when it detected the compose-file
  change) — verified healthy within ~30s, no heartbeat loss.
- Agent 2.1.6 — **RELEASED to stable 2026-07-09** (`pending-agent-2.1.6`
  merged in `cd06f3b`; release commit `1b0ddf3`): log rotation + cache
  pruning + startup lifecycle state machine (LoadingConfig → Enrolling →
  FirstHeartbeat → Operational; config load retried with exponential
  backoff; state mirrored to `agent.state.json` next to the config on every
  platform; Faulted loop crashes the process so SCM/systemd recovery
  applies; watchdog restarts a wedged initializing agent — fixes Known
  Issues 4 + 14). GPO rollout to the Windows fleet in progress; 100% =
  official baseline.
- Heartbeat storage redesign — **proposal only**, awaiting approval:
  [architecture/heartbeat-storage-redesign.md](architecture/heartbeat-storage-redesign.md).
- NPM `access_log off` for heartbeat locations — proposed, awaiting approval.
- Deploy-dir standardization to `/opt/techi/techi-platform` — proposed,
  awaiting decision.
- `techi-backup.sh` config-source fix — follows the standardization decision.

# Roadmap

**High**: complete 2.1.6 rollout (100% fleet = official baseline); push+deploy `49fce27`; deploy-dir
standardization + backup script fix.
**Medium**: cut agent 2.1.6 from the parked branch (SHA-alignment procedure);
NPM heartbeat access_log off; drop duplicate PK indexes (with approval);
NETLOGON token ACL; disk resize decision; archive approved server leftovers.
**Low/Future**: heartbeat storage redesign (per proposal doc); telemetry
downsampling; move binaries out of git history (.git ≈ 183 MB of exe/msi/dll).

# Deploy Process

0. **Deployment Contract Verification (MANDATORY)**: run `scripts/preflight.sh`
   (contract tests + full suite flags off/on + tsc + frontend build + agent
   go build/test). It exits non-zero on any failure — do NOT deploy if it
   fails. After deploy, run `scripts/smoke.sh <base_url>` — a 500 on any
   endpoint = deployment FAILED. See IMPLEMENTATION-ROADMAP.md "Deployment
   Contract Verification".
1. Local: backend tests green (`backend/venv/bin/python -m pytest tests -q`,
   `LOG_DIR=<writable>` env; expect only the 4 known failures in
   test_enrollment_audit_diagnostics), `npx tsc --noEmit` for frontend.
2. Add the CHANGELOG-SOLUTIONS entry (top, standard format).
3. Push `stable/phase-2-heartbeat`.
4. **Schema first** (gotcha): manual `ALTER/CREATE INDEX CONCURRENTLY … IF NOT
   EXISTS` on prod Postgres for anything the fast path reads.
5. `ssh techi-server` → **`cd /root`** → `git pull --ff-only` →
   `docker compose -p techi-platform build <svc>` →
   `docker compose -p techi-platform up -d <svc>`. **The `-p techi-platform`
   is mandatory** — without it compose derives the project name from the
   directory (`root`) and creates a parallel project whose postgres fights
   for port 5432 (discovered 2026-07-07, see CHANGELOG).
6. Verify: `curl localhost:8000/health` → 200; `docker ps` healthy; heartbeats
   flowing (NPM access log / dashboard); no error burst in backend logs.
7. Agent packages changed? Follow the SHA-alignment rule (Update System).
8. Rollback: `git revert` + rebuild; DB rollback SQL lives in the changelog
   entry for that deploy.
9. Update PROJECT_STATE.md if the change altered anything this file describes.

# Disaster Recovery

- **Inputs** (all on the VPS — no offsite copy exists **(verified)**):
  `/opt/backups/techi/postgres-<date>.sql.gz` (daily pg_dumpall, 14-day
  retention), `rustdesk-keys-<date>.tar.gz` (hbbs/hbbr `id_ed25519*` — losing
  these breaks remote support fleet-wide: every endpoint pins the public key),
  `techi-platform-config-<date>.tar.gz` (.env + compose),
  `vault-key-<date>.tar.gz` + `vault-key-<date>.sha256` (Credential Vault
  master key from the `backend_data` volume — **losing it makes every vault
  secret unrecoverable, same disaster class as the RustDesk keys**; added
  2026-07-07, verified end-to-end), git repo (GitHub `Mario700kb/techi-platform`).
  The backup script is versioned at `scripts/techi-backup.sh`.
- **Vault master key recovery** (verified 2026-07-07): extract
  `vault-key-<date>.tar.gz` → `vault_master.key`, confirm `sha256sum` matches
  the sibling `.sha256`, place it at the container's `data/vault_master.key`
  (volume `techi-platform_backend_data`, mode `0400`), restart backend. A
  live-encrypted secret was proven to decrypt with a restored copy of the key.
  The key must exist **before** `FEATURE_VAULT` is enabled.
- **Restore outline**: provision host with Docker → clone repo → restore
  `.env`/compose → `docker compose up -d postgres` → `gunzip -c dump | docker
  exec -i … psql -U techi` → up backend/frontend → restore RustDesk keys into
  `rustdesk-server/data` before starting hbbs/hbbr → NPM proxy hosts + TLS
  certs re-created (NPM data lives in `/root/nginx-proxy-manager/data` — **NOT
  in any backup (verified)**).
- **A full restore has never been rehearsed (needs verification).** Known gaps:
  NPM config unbackuped; backups have no offsite copy; config tar comes from
  the stale checkout. **The vault master key backup + recovery path WAS
  rehearsed end-to-end (2026-07-07)** — the one DR component with a proven
  restore.
- Fleet continuity: agents retry and re-enroll via NETLOGON bootstrap; device
  identity survives via agent_id/fingerprint resolution as long as the DB dump
  is restored.

# PROJECT DOCUMENTATION POLICY

**Permanent rule from the owner (2026-07-04). This project has exactly TWO
canonical documents.**

1. **`docs/PROJECT_STATE.md`** — describes ONLY the current state of the
   project. Any change to: Backend, Frontend, Agent, TECHI Remote Support,
   PostgreSQL, Docker, Deployment, Production, API, Security, Heartbeat,
   Scheduler, Logging, or Architecture **MUST update PROJECT_STATE.md
   immediately, in the same task**.

2. **`docs/CHANGELOG-SOLUTIONS.md`** — contains ONLY the history. Every Bug,
   Incident, Deploy, Technical Decision, Root Cause, Analysis, Hotfix,
   Migration, or Optimization **MUST be recorded there immediately** (entry
   format is defined in its header).

No critical information may exist only in AI chat conversations. Every
technical decision must be documented. State lives here, history lives there —
never duplicated, never mixed. All other documents are reference
(`docs/reference/`) or archive (`docs/archive/`) material — never a source of
current state.

# AI Instructions

**Read this section fully before doing anything.**

1. **Apply the PROJECT DOCUMENTATION POLICY above** — it is the first and
   non-negotiable working rule for every session.
2. **Standing orders** (as of 2026-07-04): do NOT touch agent code, builds, or
   the agent↔backend protocol during an active fleet rollout without owner
   approval. (The 2.1.5-era freeze + `pending-agent-2.1.6` parking branch
   are closed — owner promoted 2.1.6 to baseline 2026-07-09.) No DB deletions,
   volume/backup removal, VACUUM FULL, index drops, or proxy-config changes
   without explicit owner approval. Server hygiene of the pre-approved kind
   (build cache, tmp, journal vacuum, log rotation setup) has precedent.
3. **Never assume production == code.** The owner requires evidence: ssh
   `techi-server` and inspect (docker labels, `docker exec` + md5, psql
   SELECT/SHOW, policy files, crontab). Read-only first; cite the evidence in
   your report. Verify which checkout is live before any deploy (see
   Production).
4. **How to analyze code**: read files before editing; heartbeat fast path
   (`DeviceHeartbeatService.process_heartbeat_core`) is fleet-wide hot — side
   effects belong in `_run_side_effects` (BackgroundTask). Services thin,
   queries in repositories. WS events only via `build_event()` +
   `realtime_publisher.publish_threadsafe()`. Frontend: no new component
   libraries, keep the TECHI design system, one WS connection per page.
5. **Local dev**: backend venv at `backend/venv` (do not recreate); set
   `LOG_DIR` before importing the app; SQLite dev DB; agent: `go vet`,
   `GOOS=windows go build`, `go test ./...`.
6. **Git**: work on `stable/phase-2-heartbeat`; do not auto-commit or push —
   only when asked. The owner communicates in Albanian; code/docs are English.
7. **When uncertain about prod state**: this file first, then the changelog
   (newest first), then verify live. Do not trust pre-standard docs
   (`ai-context/*`, old plans/runbooks) for current state — they are historical.

# Things Never To Change

1. **Heartbeat contract**: request/response of `POST /api/v1/agent/heartbeat`
   (+ legacy `/api/heartbeat`). New response fields must be optional; agents
   from v1.0 onward must keep working.
2. **`pending_actions[]` format** — backward compatible since v1.
3. **Enrollment endpoints** (`POST /api/v1/agent/enroll`, legacy `/api/enroll`).
4. **MSI product lineages**: legacy combined endpoint UpgradeCode
   `E6AD0A88-5F26-5665-9B1F-70B8C5EE8363` is frozen for historical detection
   only. Agent-only MSI uses `4F51EEB8-8B56-43A6-A2F0-684C6653B51F`; never
   merge these lineages or MajorUpgrade the legacy combined package.
5. **Windows service name `TechiAgent`**; agent config path
   `C:\ProgramData\TechiAgent\agent.config.json` (+ legacy
   `C:\ProgramData\TECHI\agent.config.json` migration path).
6. **RustDesk server keys** (`/opt/techi/rustdesk-server/data/id_ed25519*`).
7. **Agent code during an active fleet rollout** (current: 2.1.6 rollout).
8. **SHA-alignment procedure** for agent packages (never upload a
   separately-built exe as agent_binary).
9. **Production NPM proxy config** without approval (and keep "Cache Assets"
   unticked).
10. The two-document documentation standard above.

---

## LAST VERIFIED

| | |
|---|---|
| **Production Verified** | 2026-07-04 — live ssh audit: deploy dir via docker labels, retention via `min(created_at)`, interval via policy file + measured beat rate, backups via cron + script + artifacts |
| **Code Verified** | 2026-07-04 — running container files matched commit `e0df46a` by md5 |
| **Database Verified** | 2026-07-04 — psql: table/index sizes, row counts, min/max timestamps, autovacuum, pg_wal, settings |
| **Docker Verified** | 2026-07-04 — `docker inspect` (labels, LogConfig, restart policies), `docker system df`, volume inventory |
| **Restore / DR rehearsal** | Needs verification — a full restore has never been tested |
| **TECHI Remote Support fleet version** | Needs verification — 1.4.6.0 is the repo build default, not confirmed per device |
| **Verified By** | AI-assisted audit (Claude, Fable 5) under owner supervision; evidence recorded in CHANGELOG-SOLUTIONS.md entries of 2026-07-04 |
