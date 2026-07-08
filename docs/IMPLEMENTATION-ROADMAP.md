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
RemoteActionService ✅. Future MikroTikService / StorageService adapters MUST add a
contract test when built.

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
| **Risks (top)** | Connection launchers (Winbox/WebFig/SSH) + RouterOS API = next phase; Phase 5 NPM route + FEATURE_TERMINAL = Manual Approval |
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
| 5 | Embedded Web Terminal | **DARK COMPLETE** (2026-07-08) | `991ae07` | ✅ 2026-07-08 (dark, FEATURE_TERMINAL off) | Session model+service, endpoint+WS relay, agent PTY channel, Drawer terminal tab (lazy xterm). Suite 434✅+4 (flag off & on), agent 4 targets, tsc/build clean. **Remaining: NPM WS route + flag enable (Manual Approval)** |
| 7 | MikroTik Proxy Adapter + Connect Framework | **DARK COMPLETE** (2026-07-08) | `7df3cba` | ✅ 2026-07-08 (dark, flags off) | Connect Framework (metadata + `/connect-methods` + ConnectMenu), MikroTik proxy adapter, Network/Storage/Hypervisor auto-classification + tree folders + `category` filter. Suite 444✅+4 (flag off & on), agent 4 targets, tsc/build clean. **Launchers/RouterOS API = next phase (per boundary)** |
| 8 | Storage Platforms (Synology, QNAP) | NOT STARTED | — | — | — |
| 9 | Hypervisor Platforms (VMware, Hyper-V, Proxmox) | NOT STARTED | — | — | — |
| 6 | Enterprise IAM (permission matrix, sessions) | NOT STARTED (**moved last** — security-model change, needs separate approval) | — | — | — |

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

## Phase 5 — Embedded Web Terminal

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
**Remaining (Manual Approval — NOT done): (1) NPM WS route for
`/ws/terminal/*` + `/ws/agent/terminal/*`; (2) enable FEATURE_TERMINAL for a
canary.** Enablement notes: terminal wake latency = 1 heartbeat (reuses
pending_actions — lower the interval for terminal-enabled devices or add a
faster signal before real use); relay is per-worker in-memory (audit R5 — move
out-of-process if enabled at fleet scale).

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

## NEXT ACTIONS

**Current priorities**
1. Owner decision: approve push + deploy of Phase 0 (`d19f5d9` + `f1975ed`; zero SQL needed).
2. After deploy: production validation checklist + Appendix B prod rows → owner declares Phase 0 CLOSED here.
3. Then: owner approval to start Phase 1.

**Current blockers**
- Phase 0 closure: waiting on owner-approved deploy.
- Phase 2: Windows Agent 2.1.5 rollout not yet officially completed.
- Phase 5 (future): NPM WS route approval.

**Known risks** (full analysis: audit §7/§13)
- R1 Windows regression — mitigated by dark code + darkness test + golden tests in Phase 1.
- Single VPS / 25 GB disk — size check at every phase gate.
- Manual-SQL prod discipline — every phase ships SQL + inverse in its changelog entry.

**Technical debt** (pre-existing, tracked in PROJECT_STATE Known Issues — not created by this program)
- 4 known test failures in `test_enrollment_audit_diagnostics.py`; Alembic two-head fork; split-brain deploy dirs; agent.log rotation parked in `pending-agent-2.1.6`; Deployments page mock data.
- Program-created debt: none yet. `TestPhase0Darkness` must be removed/adjusted in the phase that first wires `platform_core` (expected: Phase 1) — intentional.

**Future improvements** (post-expansion, need separate approval)
- Heartbeat storage redesign (proposal exists, unimplemented); offsite backups + DR rehearsal; multi-worker backend (needed before ~10k devices); Future Platform SDK docs.

## PROJECT HEALTH

| Area | Status | Note |
|---|---|---|
| Architecture | 🟢 Healthy | DESIGN LOCKED baseline; amendments only |
| Documentation | 🟢 Healthy | Two-Doc standard live; audit + roadmap current |
| Backend | 🟢 Healthy | Prod verified 2026-07-06; storage batch deployed |
| Frontend | 🟢 Healthy | Mobile UI 2.0 live; no known regressions |
| Windows Agent | 🟡 Attention | 2.1.5 rollout in progress (mixed fleet); agent.log unrotated until 2.1.6 |
| Linux Agent | 🟡 Attention | Does not exist yet — by plan (Phase 2, gated); yellow until first canary is green |
| Mobile UI | 🟢 Healthy | Deployed + 5 post-deploy fix rounds verified |
| Deployment | 🟡 Attention | Split-brain deploy dirs (`/root` vs stale `/opt`); DR never rehearsed; no offsite backup |
| Security | 🟡 Attention | NETLOGON token plaintext (ACL pending); vault not yet built (Phase 4) |
| Testing | 🟡 Attention | 4 known failures; no automated Playwright suite in CI (manual sweeps) |
| Infrastructure | 🟡 Attention | Single VPS, 25 GB disk structurally tight, single uvicorn worker |
