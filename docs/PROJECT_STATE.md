# TECHI Platform — Project State

## 1. Document Contract

**Purpose.** The verified current state of TECHI Platform, and nothing else.

**Rules.**

- One fact, one place. A value that changes with every deploy (SHA, rollback tag, dump) appears once, in §3.
- No history. Previous SHAs, deploy transcripts, incidents and test runs belong in [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md). Every value here names the changelog entry that proves it.
- No plans. Open work belongs in [IMPLEMENTATION-ROADMAP.md](IMPLEMENTATION-ROADMAP.md).
- A risk that is resolved leaves §10; its closure is recorded in the changelog.
- Every measured value carries its date. A value older than 30 days is re-measured or marked stale.

**Update trigger.** Every production deploy, package activation, configuration change or risk-state change updates the affected row in the same commit as its changelog entry.

## 2. Release Posture

| Field | Value |
|---|---|
| Clean immutable release baseline | **No** — no release tag; production runs from `backport/platform-components-92a521c`, not `main` |
| Last verified deploy | 2026-10-23 22:06, `PS-PROMPT-2026-10-23` |
| Authenticated browser smoke in production | Not automated; done by hand after UI deploys |

## 3. Production Baseline

| Component | Running | Since | Rollback | Evidence |
|---|---|---|---|---|
| Backend | `dc4a2ad` | 2026-10-23 21:51 | image `pre-ps-command-mode-2545bde`; dump `pre-ps-command-mode-20261023-214629.sql.gz` | `PS-COMMAND-MODE-2026-10-23` |
| Frontend | `11997f8` | 2026-10-23 22:06 | image `pre-ps-prompt-dc4a2ad` | `PS-PROMPT-2026-10-23` |
| Database schema | Alembic `x2y3z4a5b6c7` (single head; repository head matches) | 2026-10-23 20:26 | `alembic downgrade w1x2y3z4a5b6` | `ALERT-SLA-2026-10-23` |
| Repository path | `/opt/techi/techi-platform` | — | — | — |

Release identity is the Git SHA. Backend `1.0.0` and frontend `0.1.0` are package metadata only.

## 4. Agent Packages

Activating a package updates no device; only a `self_update` command (single or bulk "Update agent") does. Domain PCs installed by GPO move to a new Endpoint MSI only when their deployment script is re-run.

| Package | Active | Since | Kept inactive | Evidence |
|---|---|---|---|---|
| Windows agent binary | `2.1.40` (`38048c97…`) | 2026-10-24 19:06 | 2.1.35 | `PACKAGES-2.1.40-2026-10-24` |
| Windows Endpoint MSI | `2.1.40` (`9054f8d9…`) | 2026-10-24 19:06 | 2.1.35 | `PACKAGES-2.1.40-2026-10-24` |
| Agent Update Bridge MSI (agents < 2.1.1 only) | `2.1.40` (`814dcb1f…`) | 2026-10-24 19:06 | 2.1.35 | `PACKAGES-2.1.40-2026-10-24` |
| Linux amd64 / arm64 / armhf | `2.1.39` | 2026-10-23 13:22 | 2.1.33 (amd64), 2.1.38 (armhf) | `LINUX-2139-PACKAGES-2026-10-23` |
| Remote Support MSI | `1.4.6.0` | — | — | Provenance conflict, see RISK-SUPPLY-001 |

## 5. Fleet

Measured 2026-10-22 (`SELFUPDATE-AUDIT-2026-10-22`).

| Field | Value |
|---|---|
| Devices | ~930 (929 reporting patch status on 2026-10-17) |
| Windows agent | 792 devices received `self_update` to 2.1.35 on 2026-10-22; 779 came back |
| Still on 2.1.20 | ~150: 136 never sent an update (dormant), 12 dead after the update (all at Adpascucci, see RISK-UPDATE-001), the rest at Adpascucci not yet updated |
| Heartbeat interval / jitter | 300 s, ±10% from agent 2.1.24 — in effect on every device past 2.1.24 |
| Live command channel | `/ws/agent/commands` on Windows from 2.1.27 and Linux; push is an accelerator, the heartbeat path stays the fallback |
| Linux devices | Raspberry Pi (armhf) and amd64 servers; 2.1.37–2.1.39 |

## 6. Runtime and Topology

| Area | Value |
|---|---|
| Host | Linode, 1 vCPU, 2 GB RAM, 25 GB disk. Owner decision: the host stays this size |
| Disk | 2.6 GB free (89%) on 2026-10-23 after the PS-PROMPT build. Each frontend build needs ~0.3 GB and stalls the host for minutes |
| Compose | Three projects, one compose file each: `/opt/techi/techi-platform`, `/opt/techi/rustdesk-server`, `/root/nginx-proxy-manager` |
| Backend process | uvicorn, 1 worker; `HeartbeatGuard` sheds heartbeats with 503 above 24 in flight; ws ping 20 s / 20 s |
| PostgreSQL | 15, loopback only; `max_connections` 100, `jit` off, `shared_buffers` 256 MB, `pg_stat_statements`; must stay UTC |
| Connection pools | Request pool 30 + 50 overflow, statement timeout 60 s, idle-in-transaction 120 s; maintenance pool 2 + 2 |
| Application role | Backend connects as `techi_app` (not superuser); `techi` is superuser for backups and enum `ALTER TYPE` |
| Heartbeat timeout | `HEARTBEAT_TIMEOUT_SECONDS=600` (2× interval) |
| Timezones | Host and app containers `Europe/Tirane`; PostgreSQL UTC |
| Edge rules **not in Git** | In `/root/nginx-proxy-manager/data/nginx/custom/`: `server_proxy.conf` answers 204 to RustDesk `/api/heartbeat` and `/api/sysinfo`; `events.conf` (`worker_connections 8192`) and `root_top.conf` (`worker_rlimit_nofile 20000`). An NPM rebuild drops them silently |
| External firewall | In front of the host since 2026-10-16. Inbound needed: 22 (admin IPs), 80, 443, 21115/TCP, 21116/TCP+UDP, 21117/TCP. If SSH times out while 443 answers, check this first |
| Host firewall | `TECHI-SEC1A` chain in `DOCKER-USER` limits 5432/8000/3000/81 to one admin IP |
| RustDesk server | OSS hbbs/hbbr 1.1.15, image pinned by digest; hbbs peer export read by the backend every 5 min (`HBBS-SYNC-2026-10-19`) |
| RustDesk key copies | Primary `/opt/techi/rustdesk-server/data/id_ed25519`; second copy in volume `rustdesk_rustdesk_data` — attached to no container, **kept deliberately, do not prune** |
| Agent package store | Named volume `techi-platform_agent_packages` at `/app/agent_packages` (`manifest.json` + `files/`). The `/opt/techi/packages` bind mount is not read at runtime |

## 7. Database

| Field | Value |
|---|---|
| Engine | PostgreSQL 15 |
| Telemetry | Daily-partitioned samples with 5-minute and hourly rollups |
| `device_heartbeats` | Not written since 2026-10-19 (`BACKEND-PERF`); truncated 2026-10-20 |
| Retention | Nightly cleanup at 03:00 (`app/tasks/cleanup.py`); trash purged after 30 days |
| Restore | Tested once, 2026-10-12: nightly dump restored in 177 s, 0 errors, configuration tables identical (`DB-ENTERPRISE-A`). Not automated |

## 8. Feature Flags

Verified 2026-10-01; flags change only by `.env` and recreate.

| Enabled | Disabled |
|---|---|
| Platform Core, Linux, MikroTik, Reporting, Terminal (`FEATURE_TERMINAL_SCOPE=fleet`), Vault, Managed Remote Support password | Embedded SSH (owner decision 2026-08-05, RISK-SSH-001), Storage, Hypervisor, Notifications, agent auth migration, native bootstrap, Remote Support auto-repair / direct connect, resolver |

AI analysis in the alert center is off until `ANTHROPIC_API_KEY` is set.

## 9. Security and Backup Posture

**In place:** two-factor sign-in for owner/admin/operator; cookie sessions with refresh rotation; strict CSP, HSTS, COOP; administrator PowerShell and Linux root terminal need a current two-factor code and are recorded; audit entries carry the real client IP; per-device Remote Support passwords rotate every 30 days (≤150 a night) and on demand; agent traffic is TLS-only; revoked agents get 410.

**Open:** see RISK-SEC-001, RISK-SEC-002, RISK-SUPPLY-001 in §10.

| Backup | Value |
|---|---|
| Nightly | 03:00 `pg_dump`, gzip-validated, 7-day retention, same filesystem as production |
| Pre-deploy | One dump per deploy in `/opt/backups/techi` |
| Off-site | WD My Cloud pull, run by hand ([runbook](operations/pc3a-manual-offsite-backup-runbook.md)) |

## 10. Open Risks

| ID | Risk | Severity | Current state | Next step |
|---|---|---|---|---|
| RISK-SEC-002 | `/api/v1/agent/heartbeat` has no authentication | High | Password and pending actions are released only to a caller that knows the device's 144-bit `agent_id`; that is a non-expiring bearer secret with no replay protection, and the endpoint has no rate limit | Roadmap Phase 2 |
| RISK-SEC-001 | Shared default Remote Support password | High | Removed from scripts and code (2026-10-12); still in Git history and `installer.wxs`; served only to agents < 2.1.5 | Roadmap Phase 2 |
| RISK-SUPPLY-001 | Remote Support MSI provenance | High | Several 1.4.6 MSIs with different hashes; package activation writes no audit record | Roadmap Phase 2 |
| RISK-UPDATE-001 | Windows self-update can leave a PC without an agent | High | 12 of 792 updates on 2026-10-22, all at Adpascucci. Backup EXE deleted after a 30 s service check without waiting for a heartbeat; watchdog runs the EXE it protects; no restore from the download cache; MSI fails 1920→1603 on a service marked for deletion. Fixed in 2.1.40, active since 2026-10-24 19:06; pilot 12, 781, 983, 985 on 2.1.40 since 19:14 | Roadmap Phase 1: 24 h observation, then waves |
| RISK-CAP-001 | Single vCPU is the capacity ceiling | High | ~900 devices at 300 s use the budget; a 180 s interval collapsed the host on 2026-08-03. Jitter now spreads the burst; not re-measured since the 2.1.35 rollout | Roadmap Phase 3: re-measure, then decide |
| RISK-CAP-003 | Windows interval floor near the online ceiling | Medium | Floor = devices ÷ 3.0 req/s; at ~940 Windows devices it passes the 313 s ceiling and the policy editor has no valid value | Re-measure peak after jitter; raise the budget only on evidence |
| RISK-STORAGE-001 | Disk at ~89% | Medium | Every deploy adds a rollback image set and builds on the host | Roadmap Phase 3: build images in CI |
| RISK-EDGE-001 | Edge rules live outside Git | Medium | See §6 | Roadmap Phase 4 |
| RISK-REL-001 | No immutable release tag; production not on `main` | Medium | See §2 | Roadmap Phase 4 |
| RISK-BKP-001 | Off-site copy and restore test depend on manual runs | Medium | See §7, §9 | Roadmap Phase 4 |
| RISK-IDENT-001 | Re-enrollment matching by hostname + public IP merges cloned machines behind NAT | Medium | Since 2026-10-16 a heartbeat without the stored `agent_id` cannot move identity, Remote Support ID or client; descriptive fields still follow the last writer | Roadmap Phase 5 |
| RISK-ENROL-002 | A Linux server enrolled by token lands in Client PC and stays there | Medium | Server heuristic is Windows-only; enrollment payload has no `device_type` | Roadmap Phase 5 |
| RISK-FLEET-004 | 13 legacy Windows agents (< 2.1.1) cannot upgrade | Low | MSI 1714/1612 via GPO; bridge MSI installs but does not swap the binary | Case by case |
| RISK-ENROL-001 | An agent without an enrollment token retries `/agent/enroll` every 60 s and never appears in the UI | Low | Seen from 77.242.26.80 (2026-08-05); a 403 leaves no device to show | When enrollment UX is next touched |
| RISK-FLEET-002 | Per-platform inventory interval is saved but applied only to RouterOS | Low | `get_inventory_interval` is called only with `"mikrotik"`; the agent has no inventory-interval setting | Hide the field or wire it in an agent release |
| RISK-SUPPLY-002 | RustDesk clients post heartbeat/sysinfo to the platform every ~15 s | Accepted | Answered 204 at the edge; kept because the same setting delivers `/api/audit/conn` session reports (owner decision 2026-10-16) | — |

Resolved and closed risks (RISK-AGENT-002 jitter, RISK-RS-001 identity lock, RISK-MSI-002 MSI guards, RISK-FLEET-003 Windows push, RISK-BKP-002 first restore test, RISK-DB-001/002, RISK-DEPLOY-001, RISK-INSTALL-001, RISK-CAP-002, RISK-SSH-001; RISK-FLEET-001 and RISK-DOC-001 superseded) are recorded in `DOC-CLEANUP-2026-10-24` in the changelog.

## 11. Related Documents

- [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md) — history and evidence
- [IMPLEMENTATION-ROADMAP.md](IMPLEMENTATION-ROADMAP.md) — open work
- [TECHI-PLATFORM-RUNBOOK.md](TECHI-PLATFORM-RUNBOOK.md) — operations
- [reference/OPERATOR-MANUAL.md](reference/OPERATOR-MANUAL.md), [reference/MOBILE-DESIGN-SPEC.md](reference/MOBILE-DESIGN-SPEC.md)
- [ai-context/](ai-context/) — architecture for code work
