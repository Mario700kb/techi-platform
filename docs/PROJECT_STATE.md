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
| Documentation revision | `DOC-2026-07-28-PC3A` |
| Production baseline SHA | `4aad118` (see §3) |
| Production branch | `backport/platform-components-92a521c` |
| Verified at | Production audit dated 2026-07-26 |
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
| Production SHA | `4aad11873b3ebc9006dad1316e4dcbbd1683f98d` |
| Working tree | Clean at audit time |
| Origin alignment | Origin branch matched the production SHA at audit time |
| Nearest release anchor | No immutable release tag exists at this SHA |
| `main` | Not the current production branch |

The primary release identity is Git SHA, followed by a future immutable release tag, image ID/hash, and package hash/version. Backend `1.0.0` and frontend `0.1.0` are metadata, not primary release identities.

## 4. Active Release and Package Matrix

| Component | Active version | Release identity | Artifact status | Fleet status | Verification status |
|---|---|---|---|---|---|
| Backend | `1.0.0` metadata | Git SHA `4aad118…`; backend source hash matches | Running backend image; image hash is the secondary runtime identity | Service healthy | Verified baseline |
| Frontend | `0.1.0` metadata | Git SHA `4aad118…`; build has no embedded Git SHA | Running frontend build | Service healthy | Verified baseline; build provenance gap remains |
| Windows Agent | `2.1.20` | Source version plus package manifest hash/version | MSI/EXE artifacts exist; available hashes match manifest evidence | Production rollout successful; approximately 95% coverage; remaining legacy versions expected | Verified production rollout |
| Endpoint MSI | `2.1.20.0` | Package manifest hash/version | Artifact present and manifest-aligned | Installation count not separately verified | Verified artifact version |
| Agent Update Bridge MSI | `2.1.20.0` | Package manifest hash/version | Artifact present and manifest-aligned | Installation count not separately verified | Verified artifact version |
| Linux ARM64 Agent | `2.1.6` | Package manifest hash/version | Artifact version verified | Fleet count not supplied by the baseline | Verified artifact version |
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
| Important package bind mount | Repository compose definition mounts `/opt/techi/packages` read-only into the backend at `/opt/techi/packages`; runtime mount state was not separately re-audited in this baseline |
| Compose-label provenance | Backend/frontend label: `/opt/techi/techi-platform/docker-compose.yml`; PostgreSQL label: `/root/docker-compose.yml` |

The compose-label provenance drift is an operational governance risk, not evidence of a runtime outage: all three audited containers were healthy.

## 6. Database State

| Field | Current state |
|---|---|
| Engine | PostgreSQL `15.18` |
| Database | `techi` |
| Production Alembic heads | `d8e9f0a1b2c3`, `hb1x7k9n2q4d` |
| Repository heads | Match production heads |
| Schema residue | `device_repair_count_reset_20260702` |
| Logical database size | `techi` 1623 MB (measured 2026-07-29) |
| Volume size | Root filesystem 25 GB, 73% used, 6.4 GB free (measured 2026-07-29) |
| Largest tables | `device_heartbeats` 1,732,154 rows / 1028 MB; `device_telemetry` 1,728,964 / 436 MB; `device_alerts` 290,592 / 58 MB; `enrollment_audit` 121,246 / 38 MB; `device_status_history` 201,873 / 31 MB (measured 2026-07-29) |
| Heartbeat retention | 7 days, enforced by the nightly cleanup task; oldest row 2026-07-22 at measurement |
| Index posture | `device_heartbeats` carries the `(device_id, created_at DESC)` composite as of `hb1x7k9n2q4d`; three zero-scan indexes removed. `ix_device_heartbeats_id` duplicates the primary key but is planner-preferred (2,366,196 scans vs 3) and is intentionally retained |
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

- Storage
- Hypervisor
- Notifications

### Rollout and migration controls

| Control | Verified state |
|---|---|
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
- **`/api/v1/agent/heartbeat` is public and unauthenticated; credential enumeration is closed, authentication is not.** `agent.py:25` still declares the router with no `dependencies=`, an end-to-end probe returns HTTP 400 rather than 401/403, and no rate limit exists at nginx-proxy-manager. Firewalling cannot mitigate this — the endpoint must stay public for agents. As of SEC-002-GATE-2026-07-29 the Remote Support password is released only to a caller that proves knowledge of the device's 144-bit `agent_id`, which closes the fleet-wide enumeration path but is a knowledge barrier, not authentication: `agent_id` is a non-expiring bearer secret with no replay protection. Remaining remediation is deliberately staged because this path caused the July crisis; see RISK-SEC-002.
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
| Retention | 7 days, name-scoped so manual rollback artifacts are preserved |
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
| RISK-REL-001 | No immutable production tag | High | Production SHA cannot yet be referenced as a durable release object | Verified SHA has no immutable tag | Release Governance Lead | Before next release approval | INIT-REL-001 |
| RISK-BKP-001 | Off-site copy depends on manual operation | Medium | A skipped manual WD pull can leave the off-site copy behind the daily local backup | PC-3A verified manual runbook; automation intentionally deferred | Production/SRE Owner | Before any backup-automation decision | None — PC-3A complete |
| RISK-BKP-002 | Restore not tested | High | Recovery time and completeness are unproven | Verified audit posture | Production/SRE Owner | Before next release approval | INIT-BKP-002 |
| RISK-SEC-001 | Remote Support credential hardening | High | Credential exposure/remediation posture remains open | Verified security baseline | Security Lead | Before any credential rollout | INIT-SEC-001 |
| RISK-SEC-002 | Heartbeat endpoint has no authentication | **High** (reduced from Critical) | Credential enumeration is closed: the Remote Support password is released only to a caller proving knowledge of the device's 144-bit `agent_id`. The endpoint itself remains unauthenticated and rate-limit-free, and `agent_id` is a non-expiring bearer secret readable by a local administrator, so this is a knowledge barrier rather than authentication. Three MikroTik devices use guessable `mikrotik-<serial>` IDs (negligible impact — no Remote Support on routers) | SEC-002-GATE-2026-07-29; `tests/test_heartbeat_password_gate.py` 18 cases | Security Lead | Before observe-mode trust rollout | INIT-SEC-001 |
| RISK-FLEET-002 | Inventory interval is inert for all platforms except RouterOS | Low | Operators can edit and save per-platform inventory intervals that are never applied; the agent has no inventory-interval code | `get_inventory_interval()` called only with a hardcoded `"mikrotik"` | Engineering Lead | With the next agent release | INIT-FLEET-001 |
| RISK-SUPPLY-001 | Conflicting Remote Support MSI provenance | High | Multiple 1.4.6 artifacts with different hashes obstruct trusted package selection | Verified package audit | Release Governance Lead | Before package activation/change | INIT-SUPPLY-001 |
| RISK-DB-001 | Two-head Alembic topology | High | Migration governance is ambiguous | Production/repository heads verified | Database Owner | Before any schema change | INIT-DB-001 |
| RISK-DB-002 | Unmanaged schema residue | Medium | Ownership and lifecycle of residual schema are unclear | `device_repair_count_reset_20260702` | Database Owner | Before schema-governance work | INIT-DB-002 |
| RISK-STORAGE-001 | Production filesystem capacity posture | Medium | Exact current size evidence is stale/not in this baseline; capacity work must remeasure first | Baseline omits refreshed size metrics | Production/SRE Owner | Before cleanup or capacity action | INIT-STORAGE-001 |
| RISK-DEPLOY-001 | Docker compose provenance drift | Medium | Container provenance is split across `/opt` and `/root` compose labels | Verified compose labels | Production/SRE Owner | Before next deployment | INIT-GIT-001 |
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
