# TECHI Platform — Project State

## 1. Document Contract

**Purpose.** This document is the sole authority for the verified current state of TECHI Platform.

**Authority boundary.** It records present production facts, active release posture, current risks, and links to canonical history and future work. Historical incidents, deploy transcripts, decisions, test runs, and rollback narratives belong only in [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md). Open or proposed work belongs only in [IMPLEMENTATION-ROADMAP.md](IMPLEMENTATION-ROADMAP.md).

**Owner.** Accountable: Principal Platform Architect. Infrastructure facts are co-reviewed by the Production/SRE owner.

**Update triggers.** Update after a verified production baseline change, a runtime/package/feature-flag change, a verified risk-state change, or a canonical roadmap/changelog closure that changes current production posture.

**This document does not contain.** Implementation history, completed phases, deploy transcripts, duplicated test results, roadmaps, detailed runbooks, API router inventories, AI session instructions, or mobile implementation history.

## 2. Documentation Baseline

| Field | Verified value |
|---|---|
| Documentation revision | `DOC-2026-08-05-TERMINALCHANNEL` |
| Production baseline SHA | `e3ef50d` (see §3) — last runtime-affecting head. `d44f354` is ahead of it on the branch but adds only the Linux agent CI workflow and agent test build tags; verified `git diff d73f93c..d44f354 -- backend/` is empty, so it does not change the running system |
| Production branch | `backport/platform-components-92a521c` |
| Verified at | Live production verification dated 2026-08-05 |
| Evidence source | Read-only production baseline audit; reconciliation events in [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md) |
| Release classification | **PRODUCTION BASELINE VERIFIED** |
| Clean immutable release baseline | **NO** |

Current blockers to a clean immutable release baseline:

- no immutable release tag at the verified production SHA;
- restore test has not been performed;
- Remote Support MSI registry/provenance is incomplete or conflicting;
- Remote Support credential hardening remains open.

PC-3A closed the off-host-copy evidence gap through a verified manual operation.
It does not close the separate restore-proof or release-anchoring gaps.

## 3. Current Production Baseline

| Field | Verified value |
|---|---|
| Repository path | `/opt/techi/techi-platform` |
| Production branch | `backport/platform-components-92a521c` |
| Production SHA | `e3ef50d` — `feat(connect): gate Embedded SSH behind FEATURE_SSH, off by default` |
| Working tree | Clean, verified 2026-08-05 |
| Origin alignment | Origin branch is one commit ahead at `d44f354` (CI workflow only, no backend change — see §2) |
| Nearest release anchor | No immutable release tag exists at this SHA |
| `main` | Not the current production branch |

The primary release identity is Git SHA, followed by a future immutable release tag, image ID/hash, and package hash/version. Backend `1.0.0` and frontend `0.1.0` are metadata, not primary release identities.

## 4. Active Release and Package Matrix

| Component | Active version | Release identity | Artifact status | Fleet status | Verification status |
|---|---|---|---|---|---|
| Backend | `1.0.0` metadata | Git SHA `d6be4ef…`; image rebuilt from this SHA on 2026-08-03 | Running backend image; image hash is the secondary runtime identity | Service healthy, zero restarts after deploy | Verified baseline |
| Frontend | `0.1.0` metadata | Git SHA `4aad118…`; build has no embedded Git SHA | Running frontend build | Service healthy | Verified baseline; build provenance gap remains |
| Windows Agent | `2.1.20` | Source version plus package manifest hash/version | MSI/EXE artifacts exist; available hashes match manifest evidence | Production rollout successful; approximately 95% coverage; remaining legacy versions expected | Verified production rollout |
| Endpoint MSI | `2.1.20.0` | Package manifest hash/version | Artifact present and manifest-aligned | Installation count not separately verified | Verified artifact version |
| Agent Update Bridge MSI | `2.1.20.0` | Package manifest hash/version | Artifact present and manifest-aligned | Installation count not separately verified | Verified artifact version |
| Linux ARM64 Agent | `2.1.6` | Package manifest hash/version | Artifact present on disk (6.4 MB) but **`is_active: false` as of 2026-08-05 23:06**, so `/platform/linux-arm64/download` returns 404. It was active in the manifest backup taken at 23:03:55 that same evening. The change was not made by the linux-amd64 registration: that exact upload + `set_active` sequence was replayed against the pre-change manifest in a scratch container from the production image and left arm64 active, because `set_active` only deactivates entries sharing the target's platform key. The manifest was written again at 23:06:15, ~2 minutes later, by something else; the responsible actor could not be identified because the backend container has since been recreated and its logs are gone, and **package activation writes no audit record** | No arm64 Linux devices exist in the fleet, so there is no current operational impact | Artifact version verified; activation state changed by an unidentified writer |
| Linux AMD64 Agent | `2.1.21` | Git SHA `d44f354`; CI build, SHA-256 `08647488…` | Built by [`build-agent-linux.yml`](../.github/workflows/build-agent-linux.yml). **Registered and active** in the package manifest as of 2026-08-05 (package `2aa5a613…`), filling a real gap: no `linux-amd64` package existed at all, so a public download for that platform returned 404. Served at `/api/v1/agent-packages/platform/linux-amd64/download`; verified end-to-end from outside that the bytes returned hash to the CI SHA | **Installed on device 729** (`rustdesk-srv`) on 2026-08-05 01:16 CEST; the device reports `2.1.21` and its command channel is connected. It is the only Linux endpoint in the fleet. Installation is operator-run because 10.5.50.126 is unreachable from the platform host (NAT) and no server-side self-update channel exists (`agent_update` is still `None` in the heartbeat response). Previous binary retained on the host as `/usr/local/bin/techi-agent.bak-2.1.5` | Verified in production: version, channel connection, and channel stability past the idle timeout |
| Remote Support MSI | `1.4.6.0` | Package hash/version | Active artifact exists; provenance conflict remains | 735 devices report semantic `1.4.6`/`1.4.6.0`; 18 report no version | Verified distribution; provenance risk open |

Agent 2.1.20 is the production Agent version. The rollout is successful and the fleet is healthy; it is not asserted to be 100% complete.

## 5. Runtime and Deployment Topology

| Area | Current state |
|---|---|
| Compose project | `techi-platform` |
| Backend | Healthy; zero restarts at audit time; source hash matches production SHA |
| Frontend | Healthy; HTTP 200; zero restarts at audit time |
| PostgreSQL | Healthy; zero restarts at audit time |
| Health verification | `/health` OK; smoke tests 8/8; protected endpoints return 401 without authentication |
| Agent package storage | **Correction (2026-08-05): packages are *not* served from the `/opt/techi/packages` bind mount.** `AGENT_PACKAGE_STORAGE_DIR` is the relative path `agent_packages`, which resolves against the container working directory `/app` — so the live store is `/app/agent_packages`, backed by the named volume `techi-platform_agent_packages` (durable across container recreates) and holding `manifest.json` plus `files/<package-id>/`. The `/opt/techi/packages` read-only bind mount still exists and contains `archive/`, `bootstrap/` and `windows/`, but nothing reads it at runtime; the previous baseline described it as the package mount, which is misleading. Manifest backups are kept alongside as `manifest.json.bak-*` |
| Compose inventory | **Exactly three compose files, one per running project** (consolidated 2026-08-03): `/opt/techi/techi-platform/docker-compose.yml`, `/opt/techi/rustdesk-server/docker-compose.yml`, `/root/nginx-proxy-manager/docker-compose.yml`. Four stale duplicates were renamed to `*.DISABLED-20260803` rather than deleted — `/root/docker-compose.yml`, `/docker-compose.yml`, `/root/techi-canary-rollback-20260711T230221Z/docker-compose.yml` (all three byte-identical and lacking `init: true`) and `/opt/rustdesk/docker-compose.yml` (a duplicate RustDesk stack on the same ports). Hashes recorded in `/root/backups/compose-consolidation/RENAMED-20260803.txt`; reverse with `mv` |
| Compose-label provenance | Backend/frontend label: `/opt/techi/techi-platform/docker-compose.yml`; PostgreSQL label still reads `/root/docker-compose.yml` (now disabled). Metadata only — verified 2026-08-03 that `docker compose up -d --dry-run` from `/opt` reports all three services *Running* with no recreate, so the label mismatch has no functional effect. Correcting it requires recreating the database container and belongs in its own window |
| RustDesk key redundancy | The Docker volume `rustdesk_rustdesk_data` is attached to no container but holds a **second copy of the live RustDesk private key** (`id_ed25519`, public `8B5Z8Vp6…` — the key embedded in every agent config and in the MSI). Verified identical to `/opt/techi/rustdesk-server/data/id_ed25519` on 2026-08-03. **Retained deliberately**; it looks like an orphan and must not be pruned. The nightly backup covers the primary copy |
| Agent command channel | `/ws/agent/commands` — a persistent **outbound** WebSocket the agent dials over 443, on which the server pushes interactive actions. Adds **no listening port, no inbound firewall rule and no NAT requirement**; this was the binding constraint on the design. Registration requires the caller to prove knowledge of the device's 144-bit `agent_id` (`compare_digest`, both sides non-empty). Push is best-effort — actions are persisted first and an unconnected agent is served by the heartbeat path exactly as before, so the channel is an accelerator and never a dependency. **Linux only**, enforced by Go build tag; Windows is untouched and continues on the heartbeat path. Verified through the edge on 2026-08-05: nginx-proxy-manager forwards the upgrade and the backend auth gate rejects a bad `agent_id` with 403. **Live since 2026-08-05 01:16 CEST** — device 729 connected on agent 2.1.21 (`[agent-channel] device #729 connected`) and held the connection past the 180s idle timeout with no disconnect or reconnect logged. Liveness rests on the agent's 60s `{"type":"ping"}` against the server's 180s `receive_text` timeout, a 3× margin; a fired timeout would log `idle past 180s; closing`. 729 is currently the only connected device |
| Edge absorption rule (**not in Git**) | `/root/nginx-proxy-manager/data/nginx/custom/server_proxy.conf` — bind-mounted to `/data/nginx/custom/` in nginx-proxy-manager, picked up by the `server_proxy[.]conf` include already present in both generated proxy hosts. Returns `204` for `/api/heartbeat` and `/api/sysinfo`, absorbing ~40 req/s of RustDesk client telemetry that the backend had always answered `204` anyway (RS-APISERVER-FLOOD-2026-08-03). TECHI agents are unaffected — they use `/api/v1/agent/heartbeat`. Revert by deleting the file and reloading nginx |

The compose-label provenance drift is an operational governance risk, not evidence of a runtime outage: all three audited containers were healthy.

The edge absorption rule lives outside version control by necessity — nginx-proxy-manager owns its own config tree. It is recorded here because an NPM rebuild or volume restore would silently drop it and return ~40 req/s to a single-vCPU backend. It is a containment measure; the cure is the agent/MSI change that stops writing `api-server` into the Remote Support TOML.

## 6. Database State

| Field | Current state |
|---|---|
| Engine | PostgreSQL `15.18` |
| Database | `techi` |
| Production Alembic heads | `mrg8b3f1c2a9` — single head since 2026-08-03 (mergepoint over `d8e9f0a1b2c3` and `hb1x7k9n2q4d`) |
| Repository heads | Match production head |
| Schema residue | `device_repair_count_reset_20260702` |
| Logical database size | `techi` 1496 MB (measured 2026-08-03, after the index removal and vacuum below; was 1623 MB on 2026-07-29) |
| Volume size | Root filesystem 25 GB, **65% used, 8.1 GB free** (measured 2026-08-03 after the volume cleanup below) |
| Largest tables | `device_heartbeats` 1,139,147 rows / 1035 MB; `device_telemetry` 1,138,897 / 437 MB; `device_alerts` 70 MB; `device_status_history` 46 MB; `enrollment_audit` 40 MB (measured 2026-08-03) |
| Heartbeat retention | 7 days, enforced by `cleanup_old_heartbeats` / `cleanup_old_telemetry` (`app/tasks/cleanup.py`, `days=7`); oldest row in both tables 2026-07-27 at measurement — a seven-day steady state, not a growth curve |
| Index posture | Eight redundant indexes removed on 2026-08-03 under one rule: an index that only shadows a PK/UNIQUE constraint, or that is a strict prefix of an existing composite, is dropped. `devices` 14 → 11 (`ix_devices_id`, `ix_devices_agent_id`, `ix_devices_rustdesk_id`). `device_heartbeats` and `device_telemetry` lost `ix_*_id` (PK shadows), `ix_*_device_id` (prefixes of the `(device_id, created_at)` composites) and `ix_device_heartbeats_rustdesk_status` (the column is written but never filtered — verified in code). Index footprint on the two hot tables 544 MB → **380 MB**; five fewer index writes per heartbeat cycle. The planner moved to the surviving indexes immediately in every case. Retained deliberately: both PKs, both composites, and `ix_*_created_at` (required by the retention DELETE). Rollback script: `/root/backups/db-index/restore-dropped-indexes-20260803.sql` |
| Autovacuum posture | `device_heartbeats` and `device_telemetry` carry `autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_analyze_scale_factor = 0.05` (2026-08-03). At the 0.2 default the threshold was ~228k dead tuples while retention deletes ~160k rows/day, so both tables sat at ~145k dead for 36+ hours and then paid one large vacuum — an I/O spike on a single-vCPU host. The new thresholds (~23k) fired immediately and cleared 290k dead tuples to **zero** on both tables |
| Restore posture | Restore test has not been performed |

Detailed migration history and SQL procedures are historical/reference material, not current-state content.

## 7. Active Components and Feature Flags

**Snapshot source:** verified production audit associated with the 2026-07-26 baseline. These are runtime facts, not source-code defaults.

### Enabled product features

- Platform Core
- Linux
- MikroTik
- Reporting
- Terminal
- Vault

### Disabled product features

- Embedded SSH (`FEATURE_SSH`) — off by decision, 2026-08-05; see RISK-SSH-001
- Storage
- Hypervisor
- Notifications

### Rollout and migration controls

| Control | Verified state |
|---|---|
| Terminal rollout scope | `FEATURE_TERMINAL_SCOPE=fleet` since 2026-08-05 (was `device` with allowlist `729`). Widened because the device allowlist had to be edited by hand for every new Linux install — device 812 (`debian3xc`) enrolled correctly and then showed "Embedded terminal is not enabled for this device yet". Verified structurally safe for Windows before the change: `methods_for("windows")` returns `['remote_support']` only, so Windows declares neither `web_terminal` nor `ssh` and a fleet-wide terminal scope adds nothing to it. MikroTik declares `winbox`/`webfig`. `web_terminal` is a Linux-only method, so the widened scope reaches exactly the two Linux devices. `.env` backed up as `.env.bak-terminal-scope-20260805-161934` |
| Heartbeat auth | **none** — the endpoint is unauthenticated. The Remote Support password is gated on a matching `agent_id` (SEC-002-GATE-2026-07-29), which is a knowledge barrier, not authentication. `observe` mode does not exist in production; that code is on the unmerged `rollback/remote-support-2026-07-18` branch |
| Agent rollout | disabled |
| Agent auth migration | disabled |
| Native bootstrap | OFF |
| Remote Support auto-repair | disabled |
| Remote Support direct connect | OFF |
| Managed Remote Support password | ON |
| Resolver | OFF |

## 8. Fleet Posture

| Field | Current verified state |
|---|---|
| Production Agent Version | `2.1.20` |
| Registered devices | 791 active (non-archived), verified 2026-08-03 — includes device 800, created by the DEVICE-SPLIT-774 remediation; zero duplicate `rustdesk_id` fleet-wide |
| Fleet Status | Production rollout successful |
| Deployment Coverage | Approximately 95% |
| Operational Status | Healthy |
| Remaining Legacy Versions | Expected during rollout convergence |
| Fleet State | Mixed; not an open rollout incident or production blocker |
| Remote Support distribution | 735 devices report semantic `1.4.6`/`1.4.6.0`; 18 report no version |

The rollout is production-successful but not declared 100% complete. Post-rollout convergence is tracked as future operational work in the roadmap, not as a production recovery programme.

## 9. Security Posture

Current exposures and positive controls:

- **Remote Support credential hardening remains open.** Treat the default-credential concern as active until a governed rotation/remediation decision is closed.
- **Remote Support MSI provenance is conflicting.** Multiple 1.4.6 MSI artifacts have different hashes; disposition requires a controlled supply-chain decision.
- **Environment-file permissions were positive** in the audit; exact permission modes are not repeated here.
- **Vault-key file mode was positive** in the audit; the vault key ignore/build-context gap remains open.
- **`/api/v1/agent/heartbeat` is public and unauthenticated; credential enumeration is closed, authentication is not.** `agent.py:25` still declares the router with no `dependencies=`, an end-to-end probe returns HTTP 400 rather than 401/403, and no rate limit exists at nginx-proxy-manager. Firewalling cannot mitigate this — the endpoint must stay public for agents. As of SEC-002-GATE and SEC-002B-ACTIONS-GATE (2026-07-29) both attacker-usable fields — the Remote Support password and the pending remote actions — are released only to a caller that proves knowledge of the device's 144-bit `agent_id`, and destructive pending-action delivery does not run for an unauthenticated caller. This closes the fleet-wide enumeration and action-theft paths but is a knowledge barrier, not authentication: `agent_id` is a non-expiring bearer secret with no replay protection. Remaining remediation is deliberately staged because this path caused the July crisis; see RISK-SEC-002.
- **Correction to the previous baseline: heartbeat authentication is _not_ in observe mode.** No heartbeat authentication of any kind exists in production. `resolve_heartbeat_trust` and its limiters exist only on the unmerged `rollback/remote-support-2026-07-18` branch. The earlier statement described intent, not deployed state.
- **Agent rollout and auth migration remain disabled**, and enabled/disabled product controls are listed in the verified snapshot above.
- **Network exposure is correctly controlled.** A `TECHI-SEC1A` chain hooked into `DOCKER-USER` restricts 5432/8000/3000/81 to a single administrative IP, with `-P INPUT DROP` default. This holds despite `ufw` permitting 8000 and `docker-proxy` binding `0.0.0.0:5432`, which read as exposures from the compose file alone.
- **Agent transport is TLS-enforced.** `config.go:134-135` force-upgrades the production API URL to HTTPS and no `InsecureSkipVerify` exists in the agent.
- **A shared default Remote Support password (`Durres.12`) remains in `config.py:42` and `installer.wxs:59`**, therefore in Git history and in every distributed MSI. Per-device passwords supersede it for agents ≥ 2.1.5; at measurement 43 devices predate that, most of them inactive.

RCA, incidents, and historical remediation evidence are recorded in [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md).

## 10. Backup and Recovery Posture

| Area | Current state |
|---|---|
| PC-3A status | **COMPLETE — Manual Operation** |
| Schedule | Daily local backup at 03:00 UTC on Linode (`0 3 * * * /root/techi-backup.sh`) |
| Retention | `find -mtime +7`, name-scoped so manual rollback artifacts are preserved. Effective retention is 8–9 daily sets, not exactly 7: the sweep runs at ~03:01 but dumps are written at ~03:02, so an 8-day-old set is one minute short of `-mtime +7` and is removed the following night instead. This errs toward keeping one extra set, never fewer — verified 2026-07-30 (the 07-22 set survived the 07-30 sweep by design) |
| Script provenance | `/root/techi-backup.sh` is installed from `scripts/techi-backup.sh` as of 2026-07-29; the previous deployed copy had drifted from the repository and is retained as `/root/techi-backup.sh.pre-2026-07-29` |
| Dump integrity controls | `set -euo pipefail`; dump written to `.partial`, validated with `gzip -t` and a 10 MB floor, promoted only when verified; retention gated on a verified dump; non-zero exit when no dump lands. Covered by `scripts/test-techi-backup.sh` (3/3) |
| Latest audited backup | Gzip-valid; 2026-07-29 manual run produced a verified 140 MB dump |
| Storage location | Same filesystem as production |
| Off-host replication | **Verified manual operation.** WD My Cloud stores an off-site copy pulled from `/opt/backups/techi/`; SSH-key authentication, rsync pull, lock handling, incremental behavior, logging/state, and gzip validation of the newest PostgreSQL dump were verified. |
| Off-host automation | **Intentionally deferred.** The WD pull script is run manually; no cron or vendor scheduler job is configured. |
| Restore test | Not performed |
| Release snapshot retention | Not yet proven by an immutable release/tag and preserved image manifest |
| Rollback anchors | Historical/operational anchors may exist, but this baseline is not itself immutable-release anchored |

The manual operating procedure and deferred-automation constraints are in
[PC-3A Manual Off-site Backup Runbook](operations/pc3a-manual-offsite-backup-runbook.md).
Recovery procedures belong in their technical runbook; this section records only current recovery posture.

## 11. Current Known Issues and Risks

| ID | Title | Severity | Current impact | Evidence | Owner | Next review | Related roadmap ID |
|---|---|---|---|---|---|---|---|
| RISK-CAP-001 | Single-vCPU host is the binding capacity constraint | **High** | The production host has `nproc` = 1 and 2 GB RAM for 790 endpoints. At the 300s heartbeat interval this is ~2.6 requests/s and load ~0.6. On 2026-08-03 an interval change to 180s (~4.4 requests/s) produced total collapse: 0% idle, load 9.5, `/api/v1/health` returning `000`, and a backend container failure. There is no headroom for fleet growth and none for lowering the interval | HB-INTERVAL-COLLAPSE-2026-08-03 | Production/SRE Owner | Before any fleet growth or interval change | None yet |
| RISK-CAP-002 | Heartbeat interval floor is not capacity-aware | **Mitigated** (was High) | Closed on 2026-08-03. The floor is now derived — `ceil(fleet / HEARTBEAT_RATE_BUDGET_PER_SEC)`, clamped to `[MIN, MAX]`, budget configurable and defaulting to 3.0 req/s — and enforced on both the flat field and the per-platform map. Verified live at 791 devices: floor 264s, 300s allowed, **180s and 60s rejected** with the projected rate stated. `GET`/`PUT` now return the fleet size, projected rate and floor so the cost is visible before saving. **Corrected 2026-08-05:** the first implementation charged the entire fleet against *every* platform, so it would have refused `linux: 60` — a setting whose real cost is 0.02 req/s against a 3.0 req/s budget. The guard now counts devices per platform, so each platform is judged on the load it actually generates. Residual: the budget is a static number an operator can raise without adding capacity, so it remains a judgement call rather than a hard physical limit | GUARDRAILS-2026-08-03, TERMINAL-CHANNEL-2026-08-05; `tests/test_heartbeat_capacity_guard.py` 24 cases | Engineering Lead | If host capacity changes | None yet |
| RISK-AGENT-002 | No heartbeat jitter; the fleet fires in a synchronised burst | **High** (raised from Medium once measured) | The per-device interval is correct — mean 1.01 heartbeats per device per 5 minutes — but the whole fleet arrives inside a ~90s window every 300s: 223 heartbeats in one 30s bucket against a trough of 1–3, i.e. **peak 7.4 req/s against a 1.8 req/s mean and a ~150× peak-to-trough ratio**. With the legacy flood now absorbed at the edge this burst is the dominant remaining load and the binding limit on any interval change. A per-agent ±10% spread flattens it to the mean | RS-APISERVER-FLOOD-2026-08-03, 30s-bucket measurement | Engineering Lead | With the next agent release | None yet |
| RISK-SUPPLY-002 | The MSI points every RustDesk client at the platform as its `api-server` | **High** | `installer.wxs` passes `[API_URL]` to `EpCustomActDll`, which writes it as `api-server` into the Remote Support TOML on every install and upgrade. RustDesk clients then post their own telemetry to `/api/heartbeat` and `/api/sysinfo` every ~10-15s — 1,338,852 requests in the retained log history, of which **zero were ever processed successfully**. This was ~94% of all backend traffic and the standing load behind the 2026-08-03 collapse. Contained at the edge on 2026-08-03; the source is untouched, so every new install still creates another emitter, and any endpoint bypassing the edge rule still reaches the backend | RS-APISERVER-FLOOD-2026-08-03 | Engineering Lead | Before the next MSI build | None yet |
| RISK-IDENT-001 | Device de-duplication collapses cloned machines behind NAT | **High** | `find_reenrollment_match` falls back to `hostname+local_ip` and `hostname+public_ip`; behind NAT the latter identifies a site, not a machine. Two cloned endpoints sharing hostname `DESKTOP-UKPKR96` merged onto device 774 and fought over it, flipping `rustdesk_id` every ~5 minutes so Connect opened the wrong PC. Compounding: the heartbeat trusts `payload.device_id` without verifying `agent_id`, and overwrites `agent_id`/`hostname`/`local_ip` on the resolved row, so identity belongs to whichever machine wrote last. The `_RECENTLY_SEEN_HOURS = 24` guard written to prevent exactly this lives in `_resolve_via_fingerprint` and never runs. Resolved for this pair by a server-side split (device 800); **the defect itself is untouched**. As of 2026-08-03 the `device_id`-without-`agent_id` path is instrumented (observation only, one warning per device per hour): refusing that path is the obvious fix but would silently stop resolving every device currently relying on it, and that population was unmeasured. The instrumentation exists to size it before the change is made — at three minutes after deploy the count was zero, far too short a window to conclude from | DEVICE-SPLIT-774-2026-08-03, GUARDRAILS-2026-08-03; `.order_by(Device.id.desc()).first()` in `device_repository.py:53-69` | Engineering Lead | Once a full week of instrumentation data exists | None yet |
| RISK-SSH-001 | Embedded SSH cannot reach any device in the fleet | **Mitigated** (was High) | Gated OFF behind `FEATURE_SSH` on 2026-08-05 and verified off in production. The defect is unchanged: `terminal.py:371` picks `host = device.local_ip or device.public_ip` and the backend dials the device itself ("Backend relay · Vault"), which no NAT'd endpoint can satisfy — device 729 failed with `ssh connect failed: reason=timeout` — while the `public_ip` fallback would require port 22 exposed on customer servers, which the owner has ruled out. Gated rather than deleted because the code is correct for hosts the platform can route to directly. The flag depends on PLATFORM_CORE/LINUX/VAULT/TERMINAL so it can never exceed them, and is enforced in three places: the Connect menu now reports SSH "unavailable" with the real reason instead of a button that times out, and both the credential-candidates and session-creation routes return 404. Embedded Terminal is unaffected and remains the working path. **Owner decision 2026-08-05: not building the agent tunnel; Embedded SSH stays off.** The design was assessed and is viable — carry SSH over the agent as a TCP forward, keeping asyncssh and the vault credential server-side (`asyncssh 2.14.2` accepts `sock=`), and the agent has no TCP-forwarding code today so it would need a new release. It was declined because Embedded Terminal already covers the operational need with a root shell, and because the security margin depends entirely on the agent hard-coding its destination to `127.0.0.1:22`: accepting `host:port` from the server would turn every agent into a general TCP proxy into the customer LAN, reaching neighbours that have no agent and localhost-only services that are unauthenticated precisely because they are localhost-only. Do not revive this without that constraint | TERMINAL-CHANNEL-2026-08-05; `tests/test_feature_ssh_flag.py` 7 cases | Engineering Lead | Before Embedded SSH is offered again | None yet |
| RISK-INSTALL-001 | The Linux install generator could not run on a host that already had the agent | **Resolved** (was Medium) | Closed 2026-08-05. `install.py` downloaded straight over `/usr/local/bin/techi-agent`, which the kernel refuses while that binary runs (`ETXTBSY`), so curl exited 23 and the script aborted — and an unconditional `cat > agent.config.json` would have wiped `agent_id`/`device_id`, forcing a re-enrolment through the RISK-IDENT-001 dedup path. The generated script now downloads to a temp file before stopping anything, verifies the per-architecture SHA-256 embedded from the package manifest and refuses on mismatch, stops the service and backs up the binary with restore-on-failure, keeps an existing configuration untouched, and passes the enrollment token only when the host still has to enrol — which also strips a previously baked-in token from the systemd unit. Verified by executing the generated script in a sandbox across all three paths plus a tampered checksum, then **on the real endpoint**: an operator ran it on device 729 (`rustdesk-srv`) on 2026-08-05 15:30 CEST — checksum verified, service stopped, existing configuration kept, installed without a token because the host was already enrolled, previous binary retained. Confirmed server-side afterwards: 729 still reports 2.1.21 with its `agent_id` intact, the fleet count is unchanged at 802 (no duplicate device), and the command channel reconnected within the same second | TERMINAL-CHANNEL-2026-08-05; `tests/test_install_linux.py` 11 cases | Engineering Lead | If the Linux install layout changes | None yet |
| RISK-ENROL-001 | An agent is stuck in a permanent enrolment retry loop and is invisible to the platform | Medium | A Go agent at `77.242.26.80` has been posting `POST /api/v1/agent/enroll` **every 60 seconds and receiving 403** — 1,365 rejections against 7 successes since midnight on 2026-08-05, and the loop predates the retained log window. Cause per `agent.py:101-102`: the request carries no enrollment token. Because a failed enrolment creates no device row, the machine **never appears in the UI** — the same symptom as the "new endpoint not visible" incident in the 2026-08-03 brief. Load impact is negligible (1 req/min); the real cost is an unmanaged endpoint and an operator with no feedback about why. Two devices sit behind that public IP (464 `MAGAZINA1`, healthy; 470 `kasa1-monch`, last seen 2026-07-02), so the loop is plausibly 470 but is **not confirmed** — a 403 leaves no device attribution. Device 729 is not affected | TERMINAL-CHANNEL-2026-08-05; NPM `proxy-host-2_access.log` | Engineering Lead | When the enrolment UX is next touched | None yet |
| RISK-MSI-002 | `KillTechiRS*` MSI custom actions are no-ops since 2.1.19 | Medium | `[KillTechiRSBeforeInstall]` inside a `{ }` block of an MSI *Formatted* `ExeCommand` is read as an undefined property, so Windows Installer drops the whole braced group and PowerShell fails to parse. Confirmed on two machines from the post-format `CustomActionSchedule` line and from the total absence of the action's own log lines. Remote Support is therefore never stopped before `InstallFiles`, which is the guard whose absence produces 1603 when RS holds its DLLs locked. `Return="ignore"` hides it entirely. Separately `BackupAgentConfigBeforeLegacyRemove` fails to launch with 1721 on every install (working directory does not exist yet), so `device_id` preservation for v1.0.4 migrations never runs | MSI-KILLRS-NOOP-2026-08-03 | Engineering Lead | Before the next MSI build | None yet |
| RISK-REL-001 | No immutable production tag | High | Production SHA cannot yet be referenced as a durable release object | Verified SHA has no immutable tag | Release Governance Lead | Before next release approval | INIT-REL-001 |
| RISK-BKP-001 | Off-site copy depends on manual operation | Medium | A skipped manual WD pull can leave the off-site copy behind the daily local backup | PC-3A verified manual runbook; automation intentionally deferred | Production/SRE Owner | Before any backup-automation decision | None — PC-3A complete |
| RISK-BKP-002 | Restore not tested | High | Recovery time and completeness are unproven | Verified audit posture | Production/SRE Owner | Before next release approval | INIT-BKP-002 |
| RISK-SEC-001 | Remote Support credential hardening | High | Credential exposure/remediation posture remains open | Verified security baseline | Security Lead | Before any credential rollout | INIT-SEC-001 |
| RISK-SEC-002 | Heartbeat endpoint has no authentication | **High** (reduced from Critical) | Both attacker-usable fields are now closed: the Remote Support password and the pending remote actions are released only to a caller proving knowledge of the device's 144-bit `agent_id`, and pending-action delivery (which marks actions SENT) does not run for an unauthenticated caller. The endpoint itself remains unauthenticated and rate-limit-free, and `agent_id` is a non-expiring bearer secret readable by a local administrator, so this is a knowledge barrier rather than authentication. Three MikroTik devices use guessable `mikrotik-<serial>` IDs (negligible impact — no Remote Support on routers) | SEC-002-GATE and SEC-002B-ACTIONS-GATE 2026-07-29; `tests/test_heartbeat_password_gate.py` 19 cases | Security Lead | Before observe-mode trust rollout | INIT-SEC-001 |
| RISK-FLEET-002 | Inventory interval is inert for all platforms except RouterOS | Low | Operators can edit and save per-platform inventory intervals that are never applied; the agent has no inventory-interval code | `get_inventory_interval()` called only with a hardcoded `"mikrotik"` | Engineering Lead | With the next agent release | INIT-FLEET-001 |
| RISK-SUPPLY-001 | Conflicting Remote Support MSI provenance | High | Multiple 1.4.6 artifacts with different hashes obstruct trusted package selection | Verified package audit | Release Governance Lead | Before package activation/change | INIT-SUPPLY-001 |
| RISK-DB-001 | Two-head Alembic topology | **Resolved** (was High) | Closed 2026-08-03. The fork at `z1a2b3c4d5e6` was collapsed by the empty mergepoint `mrg8b3f1c2a9`; `alembic_version` now holds a single row and `alembic upgrade head` has one unambiguous answer, so the next feature migration has exactly one place to attach. The schema was proven untouched: schema-only `pg_dump` before and after are byte-identical (SHA-256 `9800ace2…`, 3,313 lines). A second `alembic upgrade head` runs zero migrations, confirming idempotence | DB-HEAD-MERGE-2026-08-03; `/root/backups/alembic-merge/schema-{BEFORE,AFTER}.sql` | Database Owner | On the next schema change | INIT-DB-001 |
| RISK-DB-002 | Unmanaged schema residue | Medium | Ownership and lifecycle of residual schema are unclear | `device_repair_count_reset_20260702` | Database Owner | Before schema-governance work | INIT-DB-002 |
| RISK-STORAGE-001 | Production filesystem capacity posture | Medium | Exact current size evidence is stale/not in this baseline; capacity work must remeasure first | Baseline omits refreshed size metrics | Production/SRE Owner | Before cleanup or capacity action | INIT-STORAGE-001 |
| RISK-DEPLOY-001 | Docker compose provenance drift | **Mitigated** (was Medium) | Closed 2026-08-03. The real hazard was larger than the label drift: `/root` held a complete stale checkout on branch `stable/phase-2-heartbeat` (`862b1bf`) with its own `.env` and a compose file whose `build: context: ./backend` pointed at that stale source — a `docker compose up -d --build` from `/root` would have built and deployed old code from the wrong branch. All four duplicate compose files are now disabled (see §5), leaving exactly one per running project. `docker compose up -d --dry-run` from `/opt` reports no recreate. Residual: the PostgreSQL container still carries the old compose label, which is metadata and is corrected only by recreating it | DEPLOY-CONSOLIDATION-2026-08-03 | Production/SRE Owner | When the database container is next recreated | INIT-GIT-001 |
| RISK-FLEET-001 | Residual mixed fleet | Low | 687 of 773 devices run 2.1.20; 8 run 2.0.0 and 3 run 1.0.0. Maintenance, not a blocker. Any claim that ~480 devices are stuck on 2.0.0 is stale and was retracted on 2026-07-29 evidence | Production `devices` query, 2026-07-29 | Engineering Lead | During post-rollout convergence review | INIT-FLEET-001 |
| RISK-DOC-001 | Historical evidence gaps | Medium | Some historical lifecycle details cannot be reconstructed safely; they do not make the current 2.1.20 rollout uncertain | Terminal #729 and non-blocking Agent 2.1.20 canary-detail gaps | Technical Documentation Maintainer | Before release-governance closure | INIT-REL-001 |

## 12. Mobile Surface

Mobile is a responsive/PWA surface of the primary frontend. It has no independent release lifecycle, release cadence, owner, or distribution model; its current baseline follows the frontend baseline. Mobile-specific history is in [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md), and the design reference is [MOBILE-DESIGN-SPEC.md](reference/MOBILE-DESIGN-SPEC.md). `MOBILE_PROJECT_STATE.md` is **not required** at this time.

## 13. Active Priorities

Current priorities are intentionally represented only by roadmap IDs:

- [INIT-REL-001 and INIT-BKP-002](IMPLEMENTATION-ROADMAP.md#4-initiative-register)
- [INIT-SEC-001 and INIT-SUPPLY-001](IMPLEMENTATION-ROADMAP.md#4-initiative-register)
- [INIT-DB-001 and INIT-DB-002](IMPLEMENTATION-ROADMAP.md#4-initiative-register)
- [INIT-FLEET-001 and INIT-FLAG-001](IMPLEMENTATION-ROADMAP.md#4-initiative-register)

Priority, approval status, scope, and acceptance criteria live only in the roadmap.

## 14. Verification Evidence

The verified production baseline includes:

- backend, frontend, and PostgreSQL health with zero restarts at audit time;
- `/health` OK and frontend HTTP 200;
- smoke tests 8/8 passed;
- protected endpoints returning HTTP 401 without authentication;
- package-manifest verification for available Agent artifacts;
- backend source hash matching Git SHA `4aad11873b3ebc9006dad1316e4dcbbd1683f98d`;
- pre-deployment verification of that SHA: `tsc --noEmit` clean, frontend 80/80,
  backend 986 passed, Alembic heads `d8e9f0a1b2c3` + `hb1x7k9n2q4d`;
- production measurement of fleet agent versions, table sizes, index scan counts,
  firewall chains, and `max_connections` on 2026-07-29;
- production/repository Alembic-head verification;
- gzip validation of the latest audited backup;
- PC-3A manual off-site replication: SSH-key authentication, rsync pull without
  deletion, lock behavior, incremental behavior, off-share log/state, and gzip
  validation of the newest PostgreSQL backup.

The corresponding historical reconciliation events are at the top of [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md).

## 15. Related Canonical Documents

- [Technical history and reconciliation events](CHANGELOG-SOLUTIONS.md)
- [Open and proposed work](IMPLEMENTATION-ROADMAP.md)
- [Platform Expansion reference](reference/PLATFORM-EXPANSION-AUDIT.md)
- [Mobile design reference](reference/MOBILE-DESIGN-SPEC.md)
- [Operator reference](reference/OPERATOR-MANUAL.md)
