# TECHI PLATFORM
## PLATFORM EXPANSION ROADMAP

> **Role**: The single source of truth for the **implementation progress** of
> Platform Expansion. Not an architecture document (that is the DESIGN-LOCKED
> [reference/PLATFORM-EXPANSION-AUDIT.md](reference/PLATFORM-EXPANSION-AUDIT.md)),
> not a changelog (that is [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md)).
> **Updated after every completed phase — never skipped.**
>
> **Implementation rule**: every phase MUST begin by reading, in order:
> `PROJECT_STATE.md` → `CHANGELOG-SOLUTIONS.md` →
> `reference/PLATFORM-EXPANSION-AUDIT.md` → this roadmap. After each completed
> phase, update all four documents where required.
>
> **Phase-gate rule (from the locked audit, Appendix A)**: a phase is closed
> only when its Definition of Done is fully satisfied and **the owner declares
> closure**. No phase starts before the previous one is closed here.

## 🚦 Deployment Contract Verification (PERMANENT — mandatory before EVERY deploy)

Introduced 2026-07-08 after the Device Catalog 500 regression (a service
forwarded a filter the repository did not accept — an interface mismatch that
tests didn't catch because they exercised the repository directly, not the
service). This milestone is **mandatory before every production deployment** and
before closing any phase.

**Gate 1 — Preflight (`scripts/preflight.sh`), run locally before pushing:**
1. **Contract tests** (`tests/test_service_repository_contracts.py` +
   `tests/test_device_service_filter_contract.py`) — ZERO tolerance. Every public
   service is verified against its repository: (a) signature contract — the kwargs
   a service forwards MUST be a subset of what the repository accepts; (b)
   end-to-end — each service's read path runs through to SQL. A collection error
   or any failure aborts the deploy.
2. Full backend suite, **flags OFF and ON** — no new failures beyond the known
   baseline (currently 4, PROJECT_STATE Known Issue #12).
3. Frontend `tsc --noEmit`.
4. Frontend production build.
5. Agent `go build` (windows + linux) + `go test`.

Preflight **exits non-zero on any failure** → do not deploy.

**Gate 2 — Smoke (`scripts/smoke.sh <base_url> [token]`), run immediately after deploy:**
verifies `/health`, `/api/v1/devices/`, `/api/v1/platform/features`,
`/api/v1/auth/me`, `/api/v1/devices/overview`, `/api/v1/enrollment-tokens`,
`/api/v1/agent-packages`. A **500 on any endpoint = deployment FAILED**; protected
endpoints must be 401 (no token) or 200 (with token), never 500. Exits non-zero
on any unexpected response.

**Coverage of public services** (grows with each new service — never skip a new one):
DeviceService ✅, DeviceOverviewService ✅, VaultService ✅, EnrollmentTokenService ✅,
TerminalService ✅, ConnectService (platform_core.connect) ✅, AgentPackageService ✅,
RemoteActionService ✅, NotificationService ✅ (2026-07-10). Future MikroTikService /
StorageService adapters MUST add a contract test when built. Reporting repositories
and end-to-end generation path ✅ (2026-07-10).

## Production Validation Checklist

**Official validation guide for the 2026-07-08 window (24–48h). No feature work.**
Legend: ✅ verified now (evidence noted) · 🖥 needs an operator browser walkthrough
(cannot be clicked from here) · ⚪ N/A in production because its FEATURE flag is
OFF (validated instead by the preflight test suite with flags ON; live validation
would require enabling the flag = Manual Approval, out of scope for this window).

**Last checked:** 2026-07-08. **LIVE VALIDATION: 4 flags ENABLED in production**
(owner-approved) — `FEATURE_PLATFORM_CORE`, `FEATURE_LINUX`, `FEATURE_VAULT`,
`FEATURE_MIKROTIK` ON; `FEATURE_TERMINAL`/`FEATURE_STORAGE`/`FEATURE_HYPERVISOR`
OFF. Operator Manual: `docs/reference/OPERATOR-MANUAL.md`. Production is no longer
bit-identical to the classic Windows RMM — Linux/Connect/Vault/MikroTik surfaces
are live for operator testing. The ⚪ items below are now ACTIVE (no longer flag-
off) except Terminal/Storage/Hypervisor. Rollback: restore `.env.bak-2026-07-08`.

### SYSTEM HEALTH
- [x] ✅ Backend healthy — `/health` 200, response 2–8 ms, container "Up (healthy)"
- [x] ✅ Frontend healthy — `:80` 200, container "Up (healthy)"
- [x] ✅ Database healthy — postgres "Up (healthy)", 2010 MB, 7-day retention OK (oldest hb 2026-07-01)
- [x] ✅ Containers healthy — backend/frontend/postgres/hbbs/hbbr/nginx all up
- [x] ✅ Heartbeat stable — 163,619 heartbeats/24h from 660 devices; ~142/min steady
- [x] ✅ No unexpected errors — 0 real errors/30min, 0 × 5xx in access log/1h

### DEVICE MANAGEMENT  (backend/API verified; UI interaction = operator walkthrough)
- [x] ✅ Device Catalog — `/api/v1/devices/` serves (get_devices verified against real DB: 723 rows); regression fixed & guarded
- [x] ✅ Dashboard — `/api/v1/devices/overview` 200 (no 5xx)
- [x] ✅ Device Tree — `/api/v1/devices/tree` + overview counts serve
- [ ] 🖥 Search — operator browser walkthrough
- [ ] 🖥 Filters — operator browser walkthrough
- [ ] 🖥 Device Drawer — operator browser walkthrough
- [ ] 🖥 Notes — operator browser walkthrough
- [ ] 🖥 Timeline — operator browser walkthrough
- [x] ✅ Alerts — `/api/v1/alerts` serves; alert engine running

### WINDOWS  (the reference implementation — live in production)
- [x] ✅ Enrollment — 8 devices enrolled in the last 24h; `/agent/enroll` live
- [x] ✅ Heartbeat — 163,619/24h across 660 devices, 0 errors
- [x] ✅ Packages — `/api/v1/agent-packages` serves; SHA-alignment intact
- [x] ✅ Updates — self_update path unchanged (Windows agent NOT rebuilt; fleet 2.1.5)
- [ ] 🖥 Remote Support — operator: Connect from a device row (RustDesk)
- [ ] 🖥 Command Center — operator: run a bulk command, check progress/history
- [ ] 🖥 Device Details — operator: open drawer, verify tabs/actions
- [ ] 🖥 Connect — operator: existing RustDesk Connect button (unchanged)

### LINUX  (FEATURE_LINUX OFF in production)
- [ ] ⚪ Enrollment — validated via test suite (flags ON); not live (flag OFF)
- [ ] ⚪ Inventory — validated via agent build + Ubuntu smoke; not live
- [ ] ⚪ Heartbeat — validated via test suite; not live
- [ ] ⚪ Auto Classification — validated via `test_tree_platform_aggregation`; not live
- [ ] ⚪ Device Drawer (capability tabs) — validated via tsc/build; not live
- [ ] ⚪ Packages — `linux-*` types validated via tests; not live
- [ ] ⚪ Connect metadata — validated via `test_connect_framework`; not live
> Live Linux validation requires enabling FEATURE_LINUX for a canary (Manual Approval) — out of scope for this validation window.

### CONNECT FRAMEWORK  (FEATURE_PLATFORM_CORE OFF in production)
- [ ] ⚪ Connect button / dynamic Connect Menu — endpoint 404 & menu not rendered while flag OFF; validated via `test_connect_framework` + tsc/build
- [x] ✅ Platform Registry — 8 platforms load in the prod container (verified: `resolve_platform`, adapters)
- [x] ✅ Capability Registry — vocabulary + normalize covered by tests; loads in container
- [x] ✅ Platform Icons — `PlatformIcon` in bundle (rendered only when a flag is on)

### PERMISSIONS  (current model only — owner/admin/operator; no IAM)
- [x] ✅ Model live — operators authenticate daily; role gating covered by `test_permission_enforcement`, `test_team_scope`, `test_device_scope`
- [ ] 🖥 Owner — operator spot-check (full access)
- [ ] 🖥 Admin — operator spot-check (admin-gated commands)
- [ ] 🖥 Operator — operator spot-check (scoped devices, no security config)

### PERFORMANCE
- [x] ✅ Memory — backend 247 MB/800 MB (31%); postgres 247 MB/1.9 GB
- [x] ✅ CPU — backend 11.6%, postgres 4% (idle-normal)
- [x] ✅ Database — 2010 MB, autovacuum on, 7-day retention healthy
- [x] ✅ Response time — `/health` 2–8 ms
- [x] ✅ Heartbeats — ~142/min steady, no backlog
- [x] ✅ Logs — techi.log 7.4 MB (< 10 MB rotation cap); no error bursts

### Production bugs found (this window)
1. **[2026-07-08] Tree filter not cumulative — Client→Servers→Windows returned
   all Windows devices** (FIXED, commit `e08544d`). Root cause: the tree count
   badge classified servers via `_tree_category_case()` (device_type SERVER **OR**
   `windows_product_type in (2,3)` OR "windows server" caption) while the leaf
   filter used `device_type=server + platform`, so product-type servers were
   counted but excluded by the filter. Fix: `category=servers/clientpc` now reuses
   `_tree_category_case()` in `_apply_category_filter`, and the frontend tree node
   sends `category + platform` (not `device_type`). Verified live: filter == tree
   count for all 28 clients with Windows devices, 0 mismatches. Contract 13/13,
   suite 458+4 (flags off & on), tsc/build/agent OK, smoke 7/7. Full entry in
   CHANGELOG-SOLUTIONS.md.
2. **[2026-07-08] Heartbeat could undo a manual assignment on `device_type` flip**
   (FIXED, `96020cd`). Single `DeviceAssignmentService.is_manual_locked()` gates
   the re-group; manual/legacy_manual/enrollment are never overwritten.
3. **[2026-07-08] Unified Classification Engine** (SHIPPED P1–P5, prod tip
   `d543b70`). Architecture hardening from the tree-filter review: replaced the
   four duplicated category classifiers (C1–C4) with one engine
   (`platform_core/classification.py`) rendered as SQL + in-memory, kept identical
   by a parity test + preflight guard. Verified byte-identical on the live fleet
   (SQL counts 28/28 clients, resolved category 723/723). Additive `Other` tree
   folder. Specs: `CLASSIFICATION-ARCHITECTURE-REVIEW.md`,
   `UNIFIED-CLASSIFICATION-ENGINE-SPEC.md`.

4. **[2026-07-08] Device Tree click not syncing with Device Catalog** (FIXED,
   `dd976af`). Frontend SWR cache key `deviceTableCacheKey` omitted
   `category`/`platform`; after the tree moved onto those filters (e08544d),
   selections within a client collided → `loadTableData` served a fresh cached
   entry and sent no request, so the catalog kept stale rows until manual Refresh
   (which invalidates the prefix). Fix: add category + platform to the key
   (classification engine proven NOT the cause). Contract 13/13, suite 463+4,
   tsc/build OK, smoke 7/7. Residual documented risk: `device_type` /
   `assignment_source` (mobile FilterSheet) are also absent from the key.

5. **[2026-07-09] Linux agent package chain broken end-to-end** (FIXED,
   `c80a621`). Phase 2's Linux enrollment shipped dark and was never runnable:
   upload rejected raw binaries, public download excluded `linux-*` (400), and it
   hard-coded `file_type="msi"` (404 for a Linux agent binary). Fix: allow `.bin`,
   add `linux-amd64/arm64/armhf` to the public allow-list, resolve `linux-*` via
   `agent_binary`, map armhf in the installer — **Windows path byte-identical**
   (separate branch; MSI/GPO/self-update untouched). Regression tests added
   (Windows + Linux download, unsupported platform, missing package, active
   selection, upload validation). Contract 13/13, suite 472+4, smoke 7/7. Live:
   linux-amd64→404 reachable, freebsd→400, windows-amd64→200. First `linux-amd64`
   binary built; first upload + first live Linux enrollment (3CX/Debian) next.

### Registry-driven Device Drawer (owner-directed after first live Linux enroll)
Complete the generic, registry-rendered Device Drawer **before** the enrollment
work. Goal: a new platform (Synology/QNAP/TrueNAS/Proxmox/VMware/MikroTik/Docker
Host/Kubernetes Node…) requires ONLY — Platform Adapter · Capability Mapping ·
Connect Methods · Action Registry entries · (optional) Capability Renderers — with
**no Drawer/Management/Tree/UI-branching changes**. Windows is the grandfathered
renderer (Appendix C) selected by the registry → byte-identical, no agent rebuild
("absence of reported capabilities ⇒ the platform's declared capabilities").

- **Step 1a — Action Registry + dark Drawer feed** ✅ (`14f7103`). `platform_core/
  actions.py` single source (id/label/permission/required_capability/confirm/audit/
  target/handler); `effective_capabilities`/`actions_for`; `capability_tabs`; dark
  CORE-gated `GET /devices/{id}/drawer`. Contract locks `permission_map()` ==
  `ACTION_PERMISSION_MAP`, labels == `ACTION_LABELS`. Live-verified Linux + Windows.
- **Step 1b — Generic renderer (frontend)** ✅ (`7d405c8`). New
  `GenericDeviceDrawer` renders from `/drawer` for capability-reporting devices
  (Connect-primary Overview, capability tabs, Action-Registry Management, Terminal,
  Notes, Timeline; Remote Support only when the `remote_support` capability is
  reported). Renderer selected at the render site; Windows (no capabilities) keeps
  the classic `DeviceDrawer` unchanged (zero edits). tsc/build/preflight/smoke OK.
  Live: Linux `rustdesk-srv` → generic Drawer, no RS; Windows → classic. (Desktop
  first; mobile Device Details still uses the classic drawer — follow-up.)
- **Step 1c — Unify enforcement** ✅ (`53854c5`). `ACTION_PERMISSION_MAP` now
  derives from `platform_core.actions.permission_map()` — the permission layer,
  UI (`/drawer`), execution (queue by action_type == descriptor id) and audit
  (`ACTION_QUEUED`) all consume the same ActionDescriptor. Values unchanged (13
  entries), concrete lock test added. Labels stay in `schemas.remote_action`
  (ActionType enum-cycle), contract-locked to the registry. **Step 1 complete.**
- **Step 2 — Platform-neutral enrollment pipeline** ✅ (`a5a9b86`). Tokens stay
  platform-neutral (Client + optional Default Group + assignment source + policy;
  platform identity from the agent). When a token gives a Client but no Default
  Group, `apply_enrollment_assignment` auto-resolves the standard group from the
  agent signal via the Unified Classification Engine (`_detect_group` →
  Servers/Client PC) and auto-creates the standard groups — any platform lands in
  the correct Client ▸ Group with no manual step. Explicit Default Group respected.
  Regression tests (Linux server/workstation, explicit group, Windows product-type).
  **Registry-driven Drawer + generic enrollment: both COMPLETE.**

### MikroTik Platform Integration — Connector v1 ✅ (2026-07-09)
MikroTik remains a Connector/Proxy platform (no Windows/Linux agent, no RouterOS
API, no Winbox/WebFig/SSH launcher execution). **Platform Registry is the single
source** for RouterOS 6.x and 7.x deployment templates, supported arches
(chr/x86/arm/arm64/mipsbe/mmips/ppc/tile), and MikroTik capabilities. The
generated RouterOS script now registers once through `/agent/enroll`, installs
two RouterOS scheduler items (`TECHI-Heartbeat` and `TECHI-Inventory`), and
embeds the current Agent Config values for MikroTik heartbeat and inventory
intervals. Enrollment remains the generic token pipeline; the deterministic
`mikrotik-<serial-or-software-id>` agent id lets heartbeat resolve the same
device without parsing the enrollment response in RouterOS or falling back to
hostname/MAC matching.

**SIMPLIFIED 2026-07-10 (owner directive: Connector, NOT an agent).** The
RouterOS script was cut from 97 lines / 7.6 KB (2 `:foreach` loops, 15
on-error blocks, RouterOS globals) to **~49 lines / ~4.6 KB, zero loops,
zero globals** (scheduled scripts are self-contained → survive reboot); a
contract test forbids regrowth (≤60 lines, no `:foreach`/`:global`, no
enumeration commands). Connector v1 separates a minimal heartbeat (~250 B:
agent_id/hostname/platform/os_name/os_version/architecture/local_ip/
agent_version/`connect`; public IP inferred from X-Forwarded-For; health
computed server-side) from lightweight inventory (default 1800 s, ~450 B:
Board/Model/Serial/Firmware/Uptime/Bridges/Wireless yes-no/DefaultRoute
yes-no in os_caption + CPU/RAM/storage + 2 static software rows — no
interface/package/route/firewall/DNS enumeration). MikroTik reports ONLY the
`connect` capability → Generic Drawer renders Overview / Management / Notes /
Timeline with no capability tabs; Remote Support/Web Terminal absent; Connect
shows Winbox/WebFig/SSH metadata only; Action Registry exposes Refresh
Inventory / Restart Connector / Re-enroll. Timeline is transition-gated
(`heartbeat_received` only on first heartbeat or offline→online recovery;
`inventory_updated` per snapshot — never per beat). Windows/Linux/macOS
deployment and enrollment paths unchanged. **Future RouterOS management =
RouterOS API/adapter action execution + capability renderers, no Drawer/Tree
redesign.**

**ENTERPRISE COMPLETION 2026-07-10.** Owner audit of a real enrollment found a
device that enrolled but landed with no Client/Group. Root-cause: the generic
pipeline (`AgentEnrollmentService`/`DeviceAssignmentService`) was already
correct — a new test (`test_mikrotik_real_enroll_then_heartbeat_keeps_token_
assignment`) proves enroll→heartbeat preserves the token's assignment exactly
like every platform. The real gap is that RouterOS `/tool fetch` does not
raise a script error on a non-2xx HTTP response, so a failed `/agent/enroll`
(bad/used token, network hiccup) let the script fall through to installing
the scheduler anyway, and the stable-identity heartbeat auto-create path then
created an unassigned device (`test_mikrotik_heartbeat_without_enrollment_
stays_unassigned` documents this). Fix is connector-side only: the enroll
fetch is now wrapped in `:do{...}on-error={:error "TECHI enrollment failed"}`
so a failed enroll halts the whole script — no scheduler, no heartbeat, no
orphan device. Script grew 49→62 lines; ceiling raised 60→70 (still zero
loops/globals/enumeration, contract-tested). Three more completions, all
registry-reuse, zero redesign: (1) **Connect launchers** — new `GET
/devices/{id}/connect-methods/{method_id}/launch` (permission `remote_support_
connect`, audit `remote_connect`, same pattern as Windows `/connect-url`)
builds `scheme://<host>` or `http://<host><web_path>` from the device's IP;
`ConnectMenu` now calls it and actually navigates/opens instead of showing a
stub toast. RouterOS API and Terminal stay out of scope. (2) **Resource
cards** — MikroTik now populates the existing generic `cpu_percent`/
`ram_percent`/`disk_percent` telemetry fields (single-property RouterOS
reads, no loops); Overview renders them with the existing `ResourceBar`
component (current utilization only). (3) **Overview/assignment parity** —
Device ID row + editable Client/Group assignment reusing
`assignDeviceClient`/`assignDeviceGroup` and `AssignmentSourceBadge` exactly
as the classic Windows Drawer does. `DeviceDrawer.tsx` (Windows) has zero
edits across this whole work item.

### END OF VALIDATION
On the owner's confirmation of 24–48h stability, mark **Production Validation
PASSED** here + in PROJECT_STATE.md + CHANGELOG-SOLUTIONS.md, then resume the
roadmap. Until then: no new features.

## Project Status

| | |
|---|---|
| **Overall Progress** | `████████████████░░░░` **80%** (Phases 0–5, 7 code-complete; 5+7 dark-deployed) |
| **Current Phase** | ⏸️ **PRODUCTION VALIDATION window (started 2026-07-08, 24–48h)** — feature work PAUSED. Phase 7 (MikroTik + Connect Framework) was the last dark deploy. |
| **Current Milestone** | Stabilization: production runs 24–48h, only bug fixes (full contract+regression+preflight+smoke each), resume roadmap on owner confirmation |
| **Next Milestone** | (paused) Owner's choice after validation: Phase 8 Storage, connection launchers, or Phase 5 enablement |
| **Estimated Remaining Phases** | 3 (8, 9, 6) + connection launchers + Phase 5 enablement |
| **Execution order** | Vault Safety ✅ → 2 Linux Agent ✅ → 3 Linux UI ✅ → 5 Web Terminal (dark ✅) → **7 MikroTik + Connect Framework (dark ✅)** → 8 Storage → 9 Hypervisors → 6 IAM (last) |
| **Feature Flags status** | 8 flags in production, **all OFF** (verified: FEATURE_MIKROTIK + CORE False) |
| **Deployment status** | Prod tip `7df3cba`; backend+frontend rebuilt; connect-methods 404 with flag off, MikroTik adapter registered |
| **Production status** | Healthy: `/health` 200, frontend 200, 131 heartbeats/min, 0 real errors; flag-off UI+behavior identical |
| **Risks (top)** | Connection launchers (Winbox/WebFig/SSH) + RouterOS API = next phase; Phase 5 production-ready (2026-07-10) — only remaining step is the owner enabling `FEATURE_TERMINAL` + rollout scope (Manual Approval, config-only) |
| **Last Update** | 2026-07-08 (Phase 7 dark complete) |

## Phase Table (in execution order)

| Phase | Name | Status | Commit | Deploy | Validation |
|------|------|--------|--------|---------|------------|
| 0 | Platform Core Foundation (flags, registries) | **COMPLETED** (2026-07-07) | `f1975ed` (+docs `d19f5d9`, `c60ff62`) | ✅ 2026-07-07 (`-p techi-platform`, backend only) | unit 17/17 ✅ · suite 390✅+4 known · prod: health 200, 740 hb/5min, flags OFF ✅ |
| 1 | Platform Core Integration (dark wiring + DB) | **COMPLETED** (2026-07-07) | `a1c323e` | ✅ 2026-07-07 (SQL schema-first + backend rebuild) | suite 403✅+4, **flag OFF & ON** · golden 10/10 · prod: 392 hb/3min ✅ |
| 4 | Credential Vault | **COMPLETED** (2026-07-07) | `9a119a7` | ✅ 2026-07-07 (vault tables SQL + backend/frontend rebuild) | 22 vault tests + suite 414✅+4 · tsc/build clean · prod: vault 404 flag-off ✅ |
| — | **Vault Operational Safety** (hardening) | **COMPLETED** (2026-07-07) | `scripts/techi-backup.sh` | ✅ on-server (no app change) | backup sha `e7bcd67f…` · integrity + end-to-end recovery rehearsed ✅ |
| 2 | Linux Agent MVP | **COMPLETED** (2026-07-07) | `59a781b` (agent+backend, 7 commits) | ✅ 2026-07-07 (backend, flag off) | Go builds all 4 targets · Windows-payload test PASS · smoke-tested on Ubuntu · install 404 flag-off · 206 hb/min ✅ |
| 3 | Linux Platform Integration (UI / Drawer / Catalog) | **COMPLETED** (2026-07-07) | `dfd601b` | ✅ 2026-07-07 (backend+frontend, flag off = identical) | PlatformIcon, Packages Linux (armhf), Enrollment one-liner, Drawer capabilities/kernel/arch, platform filter, tree auto-classification sub-folders, Command Center run_command engine (bash/sh/python). Suite 424✅+4 (flag off & on), all-4 agent builds, tsc/build clean, prod healthy |
| 5 | Embedded Connect (Web Terminal) | **PRODUCTION READY, DEPLOYED DARK** (2026-07-10) | `991ae07` + completion commit | ✅ deployed 2026-07-10 (`FEATURE_TERMINAL` left `false`) | Session model+service, endpoint+WS relay, agent PTY channel, Drawer terminal tab (lazy xterm) — original Phase 5. Completed 2026-07-10: generic rollout framework (`platform_core/rollout.py`, none/device/group/client/fleet, reusable by future features), `TerminalWatchdog` idle/max-duration/expired sweep (no orphan sessions), close-audit + logging on every disconnect path, frontend bounded auto-reconnect. Suite 566✅+4 (flag off & on, +28 new tests), agent 4 targets, tsc/build clean. NPM route blocker resolved 2026-07-10 (no infra change needed — verified live). **Remaining: owner sets `FEATURE_TERMINAL=true` + rollout scope in prod `.env` — config-only, zero code work left** |
| 7 | MikroTik Proxy Adapter + Connect Framework | **DARK COMPLETE** (2026-07-08) | `7df3cba` | ✅ 2026-07-08 (dark, flags off) | Connect Framework (metadata + `/connect-methods` + ConnectMenu), MikroTik proxy adapter, Network/Storage/Hypervisor auto-classification + tree folders + `category` filter. Suite 444✅+4 (flag off & on), agent 4 targets, tsc/build clean. **Launchers/RouterOS API = next phase (per boundary)** |
| 8 | Storage Platforms (Synology, QNAP) | NOT STARTED | — | — | — |
| 9 | Hypervisor Platforms (VMware, Hyper-V, Proxmox) | NOT STARTED | — | — | — |
| 6 | Enterprise IAM (permission matrix, sessions) | NOT STARTED (**moved last** — security-model change, needs separate approval) | — | — | — |
| — | Notification Engine (Email/Webhook, event-driven) | **PRODUCTION READY, DEPLOYED DARK** (2026-07-10) | completion commit | ✅ deployed 2026-07-10 (`FEATURE_NOTIFICATIONS` left `false`) | Not part of the original 8-flag Platform Expansion program — new 9th flag, same conventions. Channel registry (Email/Webhook now; Slack/Teams/Telegram/Discord/PagerDuty = new class + registry line later), 3 tables, wired into Alert Engine/Remote Actions/Terminal/Enrollment/Maintenance, retry worker, `/notifications` UI. Suite 620✅+4 (flag off & on, +54 new tests). **Remaining: owner sets `FEATURE_NOTIFICATIONS=true` + configures a channel/rule in the UI — config/UI-only, zero code work left** |
| — | Reporting Engine v1 | **PRODUCTION READY** (2026-07-10) | this release | schema-first deploy in this release; `FEATURE_REPORTING` rollback flag | Per-client on-demand + scheduled PDF/CSV, Device Overview + Alert data reuse, complete-client scope enforcement, audit, run history/download, 365-day artifact retention, responsive dark/light UI. Contract 15/15; suite 635✅+4 flags off/on; tsc/build/agent clean. |

Status values: NOT STARTED · IN PROGRESS · TESTING · DEPLOYED · COMPLETED · BLOCKED

---

## Phase 0 — Platform Core Foundation

| | |
|---|---|
| **Objective** | Dark foundation: feature-flag infrastructure + Platform Registry + Capability Registry. Zero behavior change; flags OFF ⇒ bit-identical production. |
| **Deliverables** | `backend/app/platform_core/` (flags.py, registry.py, capabilities.py); 7 `FEATURE_*` settings; 17 unit tests incl. darkness invariant |
| **Feature Flags affected** | All 7 defined (`FEATURE_PLATFORM_CORE`, `FEATURE_LINUX`, `FEATURE_VAULT`, `FEATURE_TERMINAL`, `FEATURE_MIKROTIK`, `FEATURE_STORAGE`, `FEATURE_HYPERVISOR`) — created, default OFF, nothing reads them yet |
| **Database impact** | None (no schema changes, no SQL) |
| **API impact** | None (no endpoints touched) |
| **Frontend impact** | None (untouched) |
| **Backend impact** | `core/config.py` +7 unused settings; new dark package `app/platform_core/` imported by nothing (test-enforced) |
| **Testing** | `tests/test_platform_core.py` 17/17 ✅; full suite 390 passed + only the 4 known pre-existing failures (`test_enrollment_audit_diagnostics.py`, Known Issue #12) |
| **Regression** | Appendix B rows #15 (API) and #21 (flag-off bit-identity) ✅ locally; rows needing prod/Windows device run at deploy |
| **Rollback** | `git revert f1975ed` (self-contained); no SQL to reverse; flags OFF makes code inert regardless |
| **Deployment checklist** | ✅ standing authority granted (owner, 2026-07-07) · ✅ pushed `stable/phase-2-heartbeat` (`9644634→c60ff62`) · ✅ no schema step needed · ✅ `/root` pull + backend rebuild **with `-p techi-platform`** (gotcha discovered & documented) · ✅ containers healthy |
| **Validation checklist** | ✅ `/health` 200 · ✅ 740 heartbeats/5min (normal for ~750 devices @ 250 s) · ✅ no error burst in logs · ✅ operators reconnected to `/ws/devices` · ✅ flags verified OFF inside prod container (8 platforms in registry, `feature_enabled`=False) · ✅ closed under standing implementation authority |
| **Completion date** | **2026-07-07** |
| **Git commit** | `f1975ed` (code) + `d19f5d9` (docs) + `c60ff62` (roadmap) |

## Phase 1 — Platform Core Integration (dark wiring + DB)

| | |
|---|---|
| **Objective** | Make the foundation usable without changing behavior: additive DB columns + Windows adapter extraction (verbatim) + capability parsing in heartbeat side-effects, all gated by `FEATURE_PLATFORM_CORE`. |
| **Deliverables** | Manual SQL block (nullable `devices` columns: fqdn, kernel_version, architecture, mac_address, timezone, last_boot_at, capabilities JSONB) + inverse SQL; `services/platform_adapters/` registry with Windows adapter (logic moved verbatim); flag-gated capability normalization in `_run_side_effects`; `ensure_sqlite_dev_schema` parity; golden request/response tests |
| **Feature Flags affected** | `FEATURE_PLATFORM_CORE` (first real consumer) |
| **Database impact** | 7 nullable columns on `devices` (manual `ALTER … IF NOT EXISTS`, applied before deploy; zero backfill) |
| **API impact** | None visible; heartbeat accepts optional fields it already ignores today |
| **Frontend impact** | None |
| **Backend impact** | Adapter extraction (highest-care step — golden tests before/after); side-effects-only parsing (fast path untouched) |
| **Testing** | ✅ 13 adapter tests (golden corpus w/ pre-extraction expectations, adapter↔legacy equivalence, fallbacks, capability filtering, flag-gated side effect); full suite **twice** (flag OFF and `FEATURE_PLATFORM_CORE=true`): both 403 passed + 4 known |
| **Regression** | ✅ Appendix B #15 API (no shape changes), #21 flag-off bit-identity (suite + dispatch fallback tests); prod rows via post-deploy validation (health/heartbeats/WS/logs) |
| **Rollback** | Flag OFF (instant); `git revert a1c323e`; inverse SQL in the changelog entry (column drops need owner approval) |
| **Deployment / Validation** | ✅ 2026-07-07: SQL applied schema-first + verified via information_schema → push `a1c323e` → pull + backend rebuild (`-p techi-platform`) → health 200, healthy, 392 hb/3min, zero real errors, adapters loadable, flag verified OFF in container |
| **Completion date / Commit** | **2026-07-07** · `a1c323e` |

## Phase 2 — Linux Agent MVP  ✅ COMPLETED 2026-07-07

**Delivered** (owner declared the 2.1.5 rollout CLOSED, 2026-07-07). 7 milestones,
small commits, prod tip `59a781b`:
`agent/pal.go` (Platform contract) + `platform_{windows,linux,other}.go`;
7 additive omitempty inventory/payload fields wired from `currentPlatform()`
(`pal_test.go` proves the non-Linux payload is unchanged); Linux `collectOSInfo`
(os-release + kernel); Linux actions (systemd restart/reboot); Linux service
management (systemd install/uninstall/start/stop/status) + self-update (download
→ SHA256 → atomic swap → `systemctl restart`); backend `GET /install/linux`
(flag-gated) + `linux-arm64` package type. Builds all 4 targets; Windows agent
NOT rebuilt/redeployed (fleet stays 2.1.5); smoke-tested on the Ubuntu server.
FEATURE_LINUX remains OFF (enabling it for a canary = Manual Approval).
Certification: Linux → **Experimental**. The original plan is retained below for
traceability.

<details><summary>Original Phase 2 plan (executed)</summary>

| | |
|---|---|
| **Objective** | First Linux device managed end-to-end with the SAME contract as Windows: token enroll → heartbeat (250 s global policy) → basic inventory → remote command subset → self-update. No new platform-specific paths where the Platform/Capability Registry already serves. |
| **Gate** | Start ONLY after the owner declares the 2.1.5 rollout officially completed. |
| **Feature Flags affected** | `FEATURE_LINUX` (+ its dep `FEATURE_PLATFORM_CORE`), default OFF. |
| **Certification** | Linux enters **Experimental** (Appendix C) at phase start; → Internal after Phase 3 on TECHI's own hosts. |

### A. Reuse audit — Windows components (what the Linux agent inherits)

| Component | Verdict | How Linux reuses it |
|---|---|---|
| `agent/config.go` (+`config_other.go`) | **REUSE** | Config struct is OS-neutral; `_other.go` already compiles on Linux. Same `agent.config.json` shape at `/etc/techi-agent/`. |
| `agent/enrollment.go` | **REUSE** | Enroll handshake + `/api/v1/agent/enroll` are platform-neutral; sends `platform="linux"` + optional Phase-1 fields (kernel, arch…). |
| `agent/heartbeat.go` | **REUSE (extend payload)** | Same POST, same retry loop, same response handling (interval/pending_actions). Adds optional fields the backend already accepts. |
| `agent/update.go` (+`update_other.go`) | **REUSE (adapt swap)** | Download→SHA256 verify→swap→restart philosophy is identical; Linux swap is atomic rename + `systemctl restart` (no Scheduled Task). |
| `agent/paths.go` / identity cache | **REUSE** | Path resolution already build-tagged; Linux paths under `/etc` + `/var/lib/techi-agent`. |
| Backend enroll/heartbeat/packages/commands services | **REUSE UNCHANGED** | Linux is just another `platform` value through the existing pipeline (Phases 0–1 already dispatch by adapter). |
| `platform_adapters/linux.py` | **DONE (Phase 1)** | Classification skeleton already merged; extend if needed. |

### B. Windows-specific code (must NOT be reused / must stay isolated)

`actions_windows.go`, `service_windows.go` (SCM), `bootstrap_windows.go`,
`watchdog_windows.go`, `power_policy_windows.go`, `swap_windows.go`,
`inventory_windows.go`, RustDesk/`rustdesk*` management, registry/WMI reads,
Scheduled-Task self-update, MSI/GPO deployment. Linux equivalents live in new
`*_linux.go` files behind build tags; the Windows files are never compiled into
the Linux binary (compile-time isolation, audit §7).

### C. New Linux-only deliverables

- `agent/pal/` interfaces (formalize the split): `Collector, Actioner,
  ServiceManager, PackageManager, Updater, Watchdog, Capabilities()`.
- `agent/*_linux.go`: inventory (procfs, `os-release`, `systemctl`, `dpkg`/`rpm`
  presence, docker.sock detection, interfaces/MAC), actions (restart_agent,
  service restart, reboot [admin-gated], execute command [flag-gated]),
  systemd service manager, updater (atomic swap + `systemctl restart`),
  watchdog (systemd `Restart=always` + internal).
- `platform_windows.go` wrapper: existing Windows code wrapped in the PAL
  interfaces **verbatim** (behavior byte-identical; `go test` proves it).
- Installer: backend endpoint `GET /install/linux` serving a signed
  `curl -fsSL … | sudo bash -s -- --token …` script → detect distro/arch →
  download binary → create `techi-agent` user + narrow sudoers allowlist →
  install+start `techi-agent.service` → enroll → print device URL.
- Packages: new file types `agent_binary_linux_amd64` / `_arm64` in the
  existing manifest store (SHA-alignment rule applies).
- Capabilities: Linux agent reports `{terminal,bash,systemd,docker?,packages,
  services,interfaces,logs}` — normalized by the Phase-1 side-effect path.

### D. Implementation checklist (execute top-to-bottom once unblocked)

1. Branch `pending-linux-agent` off `stable/phase-2-heartbeat` (never build/merge Windows binaries).
2. Introduce `pal/` interfaces; wrap Windows impl verbatim; `GOOS=windows go build` + `go test ./...` green (bit-identical proof).
3. Implement `*_linux.go` (inventory → heartbeat → actions → updater → watchdog); `GOOS=linux GOARCH=amd64/arm64 go build` static (CGO off).
4. systemd unit + installer script; backend `/install/linux` endpoint (flag-gated).
5. New Linux package types in the store; upload canary binaries (SHA-aligned).
6. Backend: confirm adapter dispatch + capability persistence for real Linux payloads (extend `platform_adapters/linux.py` if classification gaps appear).
7. Tests: `go test ./...` both GOOS; backend heartbeat/enroll tests with `platform="linux"` payloads; flag-off invisibility.
8. Canary: 2–3 internal Linux hosts ≥1 week; watch heartbeat cadence, dedupe, no Windows-fleet impact.
9. Deploy behind `FEATURE_LINUX=OFF`; enable only for the canary devices; Appendix A DoD + Appendix B regression.
10. Docs (all four) + owner closure.

### E. Risks / Rollback

`go build` both GOOS in CI; Windows binary never rebuilt as a side effect
(SHA-alignment); branch isolation until rollout closes; rollback = uninstall
canaries + `FEATURE_LINUX` OFF (Windows fleet mathematically untouched — it
shares no compiled code and no changed endpoint).

</details>

**Follow-ups before Linux → Internal**: build+upload the Linux binaries as
`linux-amd64`/`linux-arm64` packages (SHA-recorded); add a CI job to
cross-build the Linux agent; enable FEATURE_LINUX for an internal canary
(Manual Approval); run Appendix B on a real Linux enroll.

## Phase 3 — Linux UI Integration

Objective: Linux feels native in the existing UI. Deliverables: `PlatformIcon`,
tree platform sub-folders + auto-grouping, OS cells, Drawer capability tabs,
Enrollment Linux generator, Packages Linux tab, Command Center target/engine.
Flags: `FEATURE_LINUX` (UI reads flags via one additive endpoint). DB: none.
API: flags endpoint + optional params. Frontend: extension points only, zero
with flag off (snapshot-diff empty). Testing: `tsc --noEmit`, Playwright sweep
desktop, flag-off snapshots. Rollback: flag OFF. Certification: Linux →
**Internal** when TECHI's own devices run it through this UI.

## Phase 4 — Credential Vault

**COMPLETED 2026-07-07 (`9a119a7`).** Delivered: `vault_credentials` +
`vault_credential_usage`, `core/vault_cipher.py` (AES-256-GCM envelope, master
key 0400 outside repo/DB), CRUD + `/reveal` (reason+audit) API, `/platform/
features`, minimal `CredentialVault.tsx` + flag-gated route/sidebar, usage
audit, 22 tests. `secret_cipher.py`/RS-password untouched (verified separate).
Turning FEATURE_VAULT on is itself a Manual-Approval action (owner).

**Enterprise Vault upgrade — COMPLETED 2026-07-10 (owner-approved exception to
the LIVE VALIDATION "no new features" gate — architecture/schema/RBAC changes
explicitly authorized for this release).** Upgrades the same storage/crypto
layer into a full enterprise secret manager — no rewrite, no new secret store,
no crypto change:
- **Credential-type registry** (`app/platform_core/vault_credential_types.py`,
  new — same registry pattern as `platform_core/actions.py`/`flags.py`): 11
  types (SSH password/private-key, Windows admin, Winbox, WebFig, API token,
  SMTP, Webhook, SNMP v2c/v3, generic username/password) plus the 4 original
  types kept as `legacy=True` entries — one metadata-driven frontend form
  (`GET /vault/types`), not per-type hardcoded forms. A type with several
  secret fields (SSH key + passphrase, SNMPv3 auth+privacy secrets) is
  JSON-encoded, then encrypted as ONE ciphertext blob through the *same*
  `vault_cipher.encrypt_secret`/`decrypt_secret` — reveal falls back to
  treating non-JSON ciphertext as a legacy single secret, so **every
  pre-2026-07-10 credential keeps revealing correctly with zero
  re-encryption**.
- **Schema** (additive, migration `d8e9f0a1b2c3`, applied schema-first):
  `vault_credentials` gains nullable `purpose`/`status`/`expires_at`/
  `rotation_due_at`/`last_tested_at`/`last_test_status`/`metadata_json`
  (non-secret type fields only, e.g. port/TLS mode — validated against the
  registry, never a secret value); new table `vault_credential_assignments`
  (credential → client/device, `ON DELETE CASCADE` from the credential side)
  for explicit "also used by" links beyond the primary scope.
- **Scope-resolution service** (`VaultService.resolve_for_context`): Device →
  Group (legacy) → Client → Global precedence, ACTIVE-only, optional Purpose
  filter — built and tested as the single future source of truth for
  SSH/SNMP/Connect integrations; **not wired into any live connection path in
  this release**, per explicit scope boundary.
- **Delete-reference guard extended**: `blocking_references()` now also
  checks `vault_credential_assignments`, not just the primary scope target —
  same 409 + force-override contract as the 2026-07-10 delete-safety fix.
- **RBAC**: 7 new granular permissions (`vault_view/create/edit/reveal/
  delete/test/assign`) addable per-Team, implemented as a pure OR on top of
  the existing Admin+ role floor (`_vault_gate` in `vault.py`) — never
  restricts what Admin/Owner already have, only extends who else can act.
- **Test Connection**: real for SMTP (live `smtplib` connect+STARTTLS+auth,
  no email sent) and Webhook (reuses the Notification Engine's own
  `send_via_channel("webhook", ...)`); every other type returns `"unsupported"`
  honestly rather than faking success — no SSH/SNMP/RouterOS client exists in
  this codebase yet.
- **Frontend**: `CredentialVault.tsx` rebuilt in place (same file, same route)
  into summary cards + filterable/view-tabbed table + metadata-driven create/
  edit form + assignments panel + status toggle + test-connection button —
  reuses existing `Badge`/`Button`/`ConfirmationModal`/theme tokens, no new
  design system.
- **Tests**: 46 backend (`test_vault.py`) + 6 frontend (`CredentialVault.test.tsx`)
  covering type-registry validation, scope precedence, RBAC additive-OR,
  assignment-blocks-delete, expiry/lifecycle badges, plaintext-never-in-list/
  audit, and the metadata-driven UI's loading/error/filter/permission states.

## Vault Operational Safety  (hardening — COMPLETED 2026-07-07)

Not a platform feature — operational DR hardening; no behavior change, no flag
enabled. Delivered: `scripts/techi-backup.sh` extended to back up the vault
master key from the `backend_data` volume (dynamic mountpoint resolution,
`chmod 600` archive + `.sha256` integrity file, 14-day retention); restore +
DR procedure documented in PROJECT_STATE › Disaster Recovery. **Verified
end-to-end**: backup sha `e7bcd67f…710b` = live = recorded; a live-encrypted
secret decrypted with a RESTORED copy of the key (`recovery-canary-42`). This
is the one DR component with a rehearsed restore. Closes the pre-enable gate
for FEATURE_VAULT.

## Phase 5 — Embedded Connect (Web Terminal)

**DARK COMPLETE 2026-07-08 (`991ae07`).** Delivered behind FEATURE_TERMINAL
(off): `TerminalSession` model + lifecycle service (two hashed one-time tickets,
TTL/idle/max caps, recording_path prepared); `POST /devices/{id}/terminal/
sessions` (admin+, capability-gated, audited) enqueuing an `open_terminal`
action; in-memory `TerminalRelay` + operator/agent WS routes (`/ws/terminal/{id}`,
`/ws/agent/terminal/{id}`, accept-close 4003 when off); Linux agent PTY channel
(gorilla/websocket + creack/pty, isolated goroutine); Drawer Terminal tab
(lazy xterm.js, only when FEATURE_TERMINAL + terminal capability). Session
recording NOT implemented (architecture prepared). Suite 434+4 flag off & on;
agent 4 targets; tsc/build clean (xterm code-split); prod dark-deployed.

**PRODUCTION READY 2026-07-10 (completion commit, deployed dark).** Closed
every remaining gap without redesigning the above:
- **NPM WS route resolved** — live inspection of production NPM config
  showed `api-rdp.techi.com.al` already applies websocket upgrade headers
  host-wide (not path-scoped), so no NPM change was needed.
- **Generic rollout framework** replaces the never-shipped device-only
  canary idea: `app/platform_core/rollout.py` — `FEATURE_TERMINAL_SCOPE`
  (`none`/`device`/`group`/`client`/`fleet`) + `_ALLOWED_DEVICE_IDS`/
  `_ALLOWED_GROUPS`/`_ALLOWED_CLIENTS`, server-side only, fail-closed
  default, prefix-parameterized so Remote Actions / SSH Relay / future
  connector platforms reuse it verbatim.
- **Cleanup/timeout enforced**: new `TerminalWatchdog`
  (`app/workers/terminal_watchdog.py`) sweeps every 30 s — expires stale
  PENDING tickets, force-closes ACTIVE relay pairs past
  `IDLE_TIMEOUT_SECONDS` (900 s) / `SESSION_MAX_SECONDS` (3600 s), audits
  every closure. Only runs when `FEATURE_TERMINAL` is on (flag-off stays
  zero-extra-behavior). No orphan session/PTY/websocket can leak
  indefinitely — covers both a forgotten browser tab and a half-attached
  pair where the agent never dials in (device offline).
- **Audit + logging completed**: session open AND deny (`outside_rollout_
  scope`) audited; every WS disconnect (`operator_closed`/`agent_gone`)
  audited and logged; watchdog closures audited and logged.
- **Reconnect** added to `DeviceTerminal.tsx` — bounded auto-retry (2
  attempts) on an abnormal close plus a manual button; always opens a new
  session (one-shot architecture, no mid-session state to resume — the
  agent tears down its PTY per connection).
- **Resize** was already implemented (frontend control frame → agent
  `pty.Setsize`) — verified, no change needed.
- Suite 566✅+4 (flags off & on, +28 net new tests: rollout scope, relay
  idle/max-duration, watchdog sweep+audit, endpoint scope enforcement),
  agent 4 targets, tsc/build clean. Deployed with `FEATURE_TERMINAL=false`
  unchanged in prod `.env` — code live, fully inert.

**Remaining (Manual Approval — NOT done, config-only now): owner sets
`FEATURE_TERMINAL=true` + `FEATURE_TERMINAL_SCOPE` + the matching allowlist
in prod `.env` and restarts backend.** Enablement notes unchanged: terminal
wake latency = 1 heartbeat (reuses pending_actions — lower the interval for
terminal-enabled devices or add a faster signal before real use); relay is
per-worker in-memory (audit R5 — move out-of-process if enabled at fleet
scale).

### Embedded SSH Connect — BUILT (2026-07-10)

**Status: code complete, deployed dark under the existing `FEATURE_TERMINAL`
flag (no new flag).** The "connector relay" approach recommended below was
implemented exactly as designed, generically for every platform whose Connect
Framework entry declares an `ssh` method (Linux, MikroTik, future Storage/
Hypervisor) — not MikroTik-specific. Device Drawer ▸ Connect ▸ SSH now opens
an **Embedded TECHI Terminal** by default (external OS SSH client stays a
secondary link). Delivered:

- `app/services/ssh_connector.py` (new): `asyncssh` (pinned dependency) dials
  `ssh://<device.local_ip or public_ip>:<port>` and attaches as the agent leg
  of the SAME `TerminalRelay` pair via a duck-typed `SSHConnectAdapter` — zero
  changes to `TerminalRelay`, `TerminalWatchdog`, or the operator-side
  `/ws/terminal/{id}` handler (only its session-end audit action now branches
  on the session's `mode` column).
- `VaultService.resolve_ssh_candidates()` (new): reuses `resolve_for_context`'s
  exact Device > Group > Client > Global precedence, returning every
  candidate at the first non-empty tier (`GET /devices/{id}/ssh/credentials`)
  so the frontend can auto-connect / show a selector / show "no credential
  available" + an explicit Temporary Session option — never a silent
  password prompt.
- `terminal_sessions` gained 4 additive nullable columns (`mode`,
  `vault_credential_id`, `ssh_username`, `credential_source`); the previously
  unused `TerminalSessionStatus.FAILED` now carries a specific
  `SSHConnectError.reason` (`credential_missing`/`host_unreachable`/
  `authentication_failed`/`timeout`/`host_key_mismatch`/`connection_refused`/
  `network_error`).
- 4 new RBAC permissions (`terminal_open`/`terminal_view`/`terminal_manage`/
  `vault_use`, additive over admin+, same shape as the 7 `vault_*`
  permissions) via a new shared `require_role_or_permission()` in
  `app/core/auth.py` (generalizes vault.py's own `_vault_gate`, which is left
  untouched). 6 new audit actions.
- Vault UI: "Used by: Embedded SSH" + Last Used now reflect a credential's
  real usage (`VaultService.record_credential_use()`), not just its static
  scope/assignment.
- 73 new tests (49 backend, 24 frontend). Preflight PASSED: contract 15/15,
  backend suite 729+4 known baseline (flags off & on), full frontend vitest
  suite 41/41, tsc/build/agent clean, smoke 8/8 (local).
- **Known limitation carried over unchanged**: host-key verification is not
  enforced (`known_hosts=None`); the backend must have network reachability
  to the device (no NAT traversal) — the same constraint identified below
  before this was built.

Original investigation and design (preserved for context):

Investigated whether MikroTik's Connect ▸ SSH could open inside the Drawer
(embedded xterm) instead of the operator's own OS. **Finding: the existing
terminal architecture cannot be reused as-is.** `TerminalRelay` +
`TerminalSession` assume a persistent process that DIALS OUT to the relay WS
and holds a live PTY (`agent/terminal_linux.go`: `pty.Start` + a continuous
gorilla/websocket read/write loop). MikroTik is a Connector, not an agent —
it only speaks periodic HTTP heartbeats (`/tool fetch`, no persistent
process, no WebSocket client) and cannot dial the relay.

**Recommended approach when this is prioritized: a "connector relay" mode of
the SAME `TerminalRelay`.** Today one leg of the relay is the operator's
browser WS, the other is the agent's WS. For a connector platform, replace
the second leg with the **backend itself acting as an SSH client** —
`asyncssh` (or similar) opening `ssh://<device.local_ip or public_ip>:22`
using a credential resolved from the **Credential Vault** (already built,
`FEATURE_VAULT`, scoped per-device/client — the natural source for RouterOS
SSH credentials, not a new secret store), then piping bytes between that SSH
session and the SAME operator WS route, ticket model, and `DeviceTerminal.tsx`
frontend used today — zero changes to the operator-facing session/audit
model, only a new relay-side connector. This reuses Connect Framework (the
same `ssh` `ConnectMethod` already declared) to trigger it, and Credential
Vault for the secret — no new registries, no MikroTik-specific terminal code
(any future SSH-capable connector platform gets this for free).

**Known limitation to disclose before building:** this requires the backend
server to have network reachability to the device's IP (works for LAN-
adjacent or VPN'd routers; fails for a NAT'd router with no forwarded SSH
port and no VPN — a real constraint the Linux PTY-relay model doesn't have,
since there the AGENT dials out, so NAT is never a problem for Linux/Windows
devices). This limitation should be surfaced to the operator as "SSH keys/
credentials not configured or device unreachable" rather than a silent
failure. **Built 2026-07-10** (see the entry above) — Connect ▸ SSH now opens
the Embedded TECHI Terminal by default; the operator's own OS SSH client via
`ssh://<ip>` (Section "Connect launchers" above, no reachability requirement
since the OPERATOR's machine dials the router) remains available as a
secondary option inside the same modal.

## Phase 6 — Enterprise IAM  (MOVED LAST — 2026-07-07)

**Re-prioritized after all platform work** (owner, 2026-07-07): IAM is
important but not the primary objective; it must not delay multi-platform
support. Also a **security-model change** → separate Manual Approval before it
starts. Objective: granular permission matrix + custom roles + session manager
on the existing operators/teams/scopes tables. Flags: `FEATURE_IAM_V2`
*(added to config when the phase starts; audit §11 lists it)*. Migration:
existing roles map 1:1; dual-read until GA; no-lockout invariant (Owner bypass)
tested. Rollback: flag OFF → legacy checks.

## Phase 7 — MikroTik Pilot

Objective: prove the proxy-adapter pattern. Deliverables: RouterOS proxy
agent (customer-side), registry activation, Winbox/SSH connect via Vault, one
pilot client. Flags: `FEATURE_MIKROTIK`. Certification: MikroTik enters
Experimental → Internal → Pilot per Appendix C. Rollback: stop adapter + flag OFF.

## Phase 8 — Storage Platforms (Synology, QNAP)

Adapter pattern from Phase 7; volumes/SMART basics; DSM/QTS + SSH connect.
Flags: `FEATURE_STORAGE`. Demand-driven; one platform at a time.

## Phase 9 — Hypervisor Platforms (VMware, Hyper-V, Proxmox)

Adapter pattern; hosts/VMs inventory; Hyper-V via the existing Windows agent
on the host. Flags: `FEATURE_HYPERVISOR`. Demand-driven.

---

## Notification Engine — Email/Webhook, event-driven

**PRODUCTION READY 2026-07-10 (deployed dark, `FEATURE_NOTIFICATIONS=false`).**
Not part of the original Platform Expansion 8-flag program (Phases 0–9
above) — a separate, general-purpose subsystem identified as a Critical
production blocker by the 2026-07-10 Production Readiness audit. Follows
the exact same flag conventions (env-driven, default OFF, `dispatch()`
checks `feature_enabled("FEATURE_NOTIFICATIONS")` once and returns
immediately when off).

- **Architecture**: `NotificationSender` interface + `CHANNEL_SENDERS`
  registry (`app/services/notification_channels.py`) — Email (SMTP,
  STARTTLS, HTML+plain-text) and generic Webhook (POST JSON, custom
  headers, shared-secret header) today; Slack/Teams/Telegram/Discord/
  PagerDuty are a new sender class + one registry entry away, no change to
  `NotificationService.dispatch()`.
- **Data**: `notification_channels` / `notification_rules` /
  `notification_deliveries` (3 new tables — see CHANGELOG-SOLUTIONS
  2026-07-10 for the exact DDL). Channel secrets encrypted with the same
  AES-256-GCM cipher/master key as the Credential Vault
  (`app/core/vault_cipher.py`), not a new key.
- **Rules**: global or per-client scope, severity filter, cooldown,
  hourly rate limit. **Retry**: fixed backoff (1/5/15/30 min, 5 attempts)
  via `NotificationWorker` — identical start/stop/sweep pattern to
  `terminal_watchdog`, only started when the flag is on.
- **Event sources wired** (one small addition per service, nothing
  redesigned): Alert Engine (`device_offline`/`device_online`/
  `critical_alert`), Remote Actions (`remote_action_completed/failed`,
  `agent_update_completed/failed` for self_update specifically), Terminal
  (`terminal_session_started/ended`), Enrollment (`enrollment_failed`),
  Maintenance (`maintenance_finished`).
- **UI**: `/notifications` (Channels/Rules/Delivery History), `system_settings`
  + `FEATURE_NOTIFICATIONS` gated, same page pattern as Credential Vault.
- **Testing**: 620 backend tests passing (+54 net new: service dispatch
  logic, channel senders mocked, API CRUD/RBAC/audit, retry worker, and a
  dedicated wiring-regression suite proving each of the 5 event sources
  calls `dispatch()` with the correct `event_type`).

**Remaining (Manual Approval, config/UI-only): owner sets
`FEATURE_NOTIFICATIONS=true` in prod `.env`, restarts backend, then
configures at least one channel + rule in the new UI.** No further code
work — this is the same "code complete, flip a flag" shape as the
Embedded Connect completion above.

Full history: CHANGELOG-SOLUTIONS.md 2026-07-10, "FEATURE: Notification
Engine — email/webhook, event-driven, reused across Alert Engine/Remote
Actions/Terminal/Enrollment/Maintenance".

---

## Reporting Engine v1 — per-client PDF/CSV proof of value

**PRODUCTION READY 2026-07-10.** This closes the Reporting blocker from the
2026-07-10 Production Readiness audit without new collection or architecture.

- **Reuse:** `DeviceOverviewService` supplies the same fleet-health numbers as
  Dashboard; `DeviceRepository` supplies client devices; `AlertRepository`
  supplies period alert activity; existing `AllowedScope`, `view_devices`,
  audit service, worker lifecycle, feature flags, and TECHI UI components are
  reused directly.
- **Exports:** PDF (dependency-free, valid PDF 1.4, selectable text,
  pagination) and UTF-8 CSV. Both contain client/period metadata, current
  online/stale/offline + health/update totals, device inventory, and alert
  activity for a validated 1–366 day period.
- **Security:** every route is authenticated and feature-gated. Generation,
  history, and download require `view_devices`; restricted operators must have
  full-client scope. Group/device-only scope cannot elevate into a full-client
  deliverable. Schedule management is Admin/Owner only. Generation/failure,
  download, and every schedule mutation are audited.
- **Scheduling/lifecycle:** daily/weekly/monthly UTC schedules; worker sweep
  every 60 s; failures become visible failed runs and advance to the next
  cadence (no minute retry loop). Files persist in `backend_data/data/reports`,
  run metadata in `report_runs`, schedules in `report_schedules`, retention
  365 days.
- **UI:** `/reports`, sidebar/route flag-gated, responsive across mobile and
  desktop, all colors use existing theme tokens, existing Button/Badge/
  ConfirmationModal reused.
- **Validation:** 15 contract tests; 635 backend passed + the 4 documented
  baseline failures in both flag modes; TypeScript + production build clean;
  Windows/Linux agent builds clean; PDF identified as PDF 1.4.

---

## NEXT ACTIONS

**Current priorities**
1. Reporting Engine v1 schema-first production deploy + runtime validation.
2. ✅ Vault Integration — **DONE for SSH** (Embedded SSH Connect, 2026-07-10):
   `resolve_ssh_candidates()` now wires the Vault into the Connect/Terminal
   path for real. `resolve_for_context()` itself remains unwired for
   non-SSH integrations (SNMP/RouterOS) — future work if prioritized.
3. MFA, then Session Management, following the production-readiness order.

**Current blockers**
- Phase 0 closure: waiting on owner-approved deploy.
- Phase 2: Windows Agent 2.1.5 rollout not yet officially completed.
- Phase 5: code deployed 2026-07-10, production ready (Embedded SSH Connect
  added 2026-07-10, same flag). Only remaining step is owner approval to set
  `FEATURE_TERMINAL=true` + `FEATURE_TERMINAL_SCOPE` + allowlist in prod
  `.env` (config-only; NPM route approval no longer needed — resolved
  2026-07-10). Once enabled, Embedded SSH Connect goes live at the same time
  as the Linux Web Terminal — one flag, one rollout scope, both transports.

**Known risks** (full analysis: audit §7/§13)
- R1 Windows regression — mitigated by dark code + darkness test + golden tests in Phase 1.
- Single VPS / 25 GB disk — size check at every phase gate.
- Manual-SQL prod discipline — every phase ships SQL + inverse in its changelog entry.

**Technical debt** (pre-existing, tracked in PROJECT_STATE Known Issues — not created by this program)
- 4 known test failures in `test_enrollment_audit_diagnostics.py`; Alembic two-head fork; split-brain deploy dirs; Deployments page mock data. (agent.log rotation shipped in Agent 2.1.6, 2026-07-09.)
- Program-created debt: none yet. `TestPhase0Darkness` must be removed/adjusted in the phase that first wires `platform_core` (expected: Phase 1) — intentional.

**Future improvements** (post-expansion, need separate approval)
- Heartbeat storage redesign (proposal exists, unimplemented); offsite backups + DR rehearsal; multi-worker backend (needed before ~10k devices); Future Platform SDK docs.

## 🚚 Agent 2.1.6 — Production Release (2026-07-09)

Owner-declared new production baseline (replaces 2.1.5). Contents: **startup
lifecycle state machine** (one engine shared by Windows + Linux — LoadingConfig
→ Enrolling → FirstHeartbeat → Operational; exponential-backoff config retry;
`agent.state.json` next to the config; Faulted = crash-and-restart via SCM /
systemd; watchdog distinguishes Initializing/Operational/Faulted), plus the
parked 2.1.6 items (agent.log rotation, cache pruning). Release commit
`1b0ddf3` (merge `cd06f3b`); preflight PASSED at baseline (contract 13/13,
backend 488+4, tsc/frontend, agent builds), local smoke 7/7. Windows artifacts
(combined MSI, bridge MSI, standalone exe — SHA-aligned) from ONE CI run of
`build-agent-msi.yml`; Linux binaries amd64/arm64/armhf. Deployment: NETLOGON
artifact replacement only (`TECHI-Agent-2.1.6.msi` + `techi-version.txt`), the
existing GPO Scheduled Task upgrades the fleet — no GPO/script changes. After
100%: 2.1.7+ distribute primarily via TECHI self_update; NETLOGON/GPO stays
bootstrap + recovery. Full entry: CHANGELOG-SOLUTIONS 2026-07-09.

## PROJECT HEALTH

| Area | Status | Note |
|---|---|---|
| Architecture | 🟢 Healthy | DESIGN LOCKED baseline; amendments only |
| Documentation | 🟢 Healthy | Two-Doc standard live; audit + roadmap current |
| Backend | 🟢 Healthy | Prod verified 2026-07-06; storage batch deployed |
| Frontend | 🟢 Healthy | Mobile UI 2.0 live; no known regressions |
| Windows Agent | 🟡 Attention | **2.1.6 released 2026-07-09** (startup lifecycle state machine + log rotation + cache pruning; commit `1b0ddf3`); GPO rollout in progress — 100% fleet = official baseline, then 2.1.7+ primarily via self_update |
| Linux Agent | 🟡 Attention | MVP delivered (Phase 2, 2026-07-07); shares the 2.1.6 lifecycle engine (identical state machine/retry/recovery — systemd Restart=always); FEATURE_LINUX canary pending |
| Mobile UI | 🟢 Healthy | Deployed + 5 post-deploy fix rounds verified |
| Deployment | 🟡 Attention | Split-brain deploy dirs (`/root` vs stale `/opt`); DR never rehearsed; no offsite backup |
| Security | 🟡 Attention | NETLOGON token plaintext (ACL pending); vault not yet built (Phase 4) |
| Testing | 🟡 Attention | 4 known failures; no automated Playwright suite in CI (manual sweeps) |
| Infrastructure | 🟡 Attention | Single VPS, 25 GB disk structurally tight, single uvicorn worker |
