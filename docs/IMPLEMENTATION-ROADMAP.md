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

## Project Status

| | |
|---|---|
| **Overall Progress** | `████░░░░░░░░░░░░░░░░` **20%** (Phases 0–1 COMPLETED — deployed + validated in production) |
| **Current Phase** | **Phase 4 — Credential Vault** (status: IN PROGRESS). Phases 2–3 skipped for now: Phase 2 BLOCKED on the 2.1.5 rollout, Phase 3 depends on Phase 2; phases develop independently per the deployment policy. |
| **Current Milestone** | Phase 4: vault tables + AES-256-GCM envelope cipher + API + usage audit (flag-gated, RS-password system untouched) |
| **Next Milestone** | Phase 2/3 when the owner declares the 2.1.5 rollout complete; otherwise Phase 6 (IAM) after Phase 4 |
| **Estimated Remaining Phases** | 8 (Phases 2–9) |
| **Feature Flags status** | 7 flags in production, **all OFF** (re-verified in the prod container after the Phase 1 deploy) |
| **Deployment status** | Phase 1 deployed 2026-07-07: prod tip `a1c323e`; schema-first SQL applied (7 columns on `devices`, verified via information_schema); backend-only rebuild |
| **Production status** | Healthy: `/health` 200, container healthy, 392 heartbeats/3min post-deploy, zero real errors in logs, adapters loadable in container, `FEATURE_PLATFORM_CORE=False` verified |
| **Risks (top)** | Vault key management (R7 — master key outside DB/repo, in backup tar); 2.1.5 rollout in progress (blocks Phase 2); single-VPS/25 GB disk (watch at every phase gate) |
| **Last Update** | 2026-07-07 (Phase 1 closed) |

## Phase Table

| Phase | Name | Status | Commit | Deploy | Validation |
|------|------|--------|--------|---------|------------|
| 0 | Platform Core Foundation (flags, registries) | **COMPLETED** (2026-07-07) | `f1975ed` (+docs `d19f5d9`, `c60ff62`) | ✅ 2026-07-07 (`-p techi-platform`, backend only) | unit 17/17 ✅ · suite 390✅+4 known · prod: health 200, 740 hb/5min, flags OFF verified ✅ |
| 1 | Platform Core Integration (dark wiring + DB) | **COMPLETED** (2026-07-07) | `a1c323e` | ✅ 2026-07-07 (SQL schema-first + backend rebuild) | suite 403✅+4 known, **flag OFF & ON** · golden corpus 10/10 · prod: health 200, 392 hb/3min, flags OFF verified ✅ |
| 2 | Linux Agent MVP | **BLOCKED** (2.1.5 rollout must complete) | — | — | — |
| 3 | Linux UI Integration | NOT STARTED | — | — | — |
| 4 | Credential Vault | NOT STARTED | — | — | — |
| 5 | Embedded Web Terminal | NOT STARTED (NPM WS route needs separate owner approval) | — | — | — |
| 6 | IAM Evolution (permission matrix, sessions) | NOT STARTED | — | — | — |
| 7 | MikroTik Pilot (proxy adapter pattern) | NOT STARTED | — | — | — |
| 8 | Storage Platforms (Synology, QNAP) | NOT STARTED | — | — | — |
| 9 | Hypervisor Platforms (VMware, Hyper-V, Proxmox) | NOT STARTED | — | — | — |

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

## Phase 2 — Linux Agent MVP  ⛔ gated

| | |
|---|---|
| **Objective** | First Linux device managed end-to-end: enroll (token one-liner), heartbeat, basic facts, action subset, systemd unit, self-update. |
| **Gate** | **Starts ONLY after the owner declares the Windows Agent 2.1.5 rollout officially completed** (standing order — no `agent/` work before that). |
| **Deliverables** | `pal/` interfaces + `platform_linux.go`; installer endpoint `/install/linux`; `agent_binary_linux_{amd64,arm64}` package type; canary on 2–3 internal hosts ≥1 week |
| **Feature Flags affected** | `FEATURE_LINUX` |
| **DB / API impact** | None beyond Phase 1 columns; enroll/heartbeat optional fields only |
| **Frontend impact** | None (UI comes in Phase 3) |
| **Backend impact** | Linux adapter in registry; installer endpoint |
| **Testing / Regression / Rollback** | `go vet` + `go test ./...` both GOOS; Windows binaries never rebuilt (SHA-alignment); rollback = uninstall canaries + flag OFF |
| **Certification** | Linux enters **Experimental** (Appendix C) at phase start |
| **Completion date / Commit** | — |

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

Objective: enterprise secrets, fully separate from the RS-password system.
Deliverables: `vault_credentials` + `vault_credential_usage` tables (+inverse
SQL), `core/vault_cipher.py` (AES-256-GCM envelope; master key file 0400
outside repo/DB, added to config backup), CRUD + `/reveal` API, minimal UI,
usage audit. Flags: `FEATURE_VAULT`. Rollback: flag OFF (tables inert).
Testing: crypto round-trip, permission tests, reveal-audit verification.
**Constraint: `secret_cipher.py` and the RS-password flow untouched.**

## Phase 5 — Embedded Web Terminal

Objective: terminal in the Device Drawer via a NEW optional agent WS channel.
Deliverables: `/ws/agent` + ticket endpoint + in-backend relay; agent PTY
(Linux first); xterm.js Drawer tab; session audit + idle timeout + recording.
Flags: `FEATURE_TERMINAL` (needs CORE+LINUX+VAULT). **Gate: NPM WS route
requires separate explicit owner approval (frozen edge config).** Load test
the relay on staging (single-worker cap documented in audit R5). Rollback:
flag OFF (channel refuses connections) + NPM route removal.

## Phase 6 — IAM Evolution

Objective: granular permission matrix + custom roles + session manager on the
existing operators/teams/scopes tables. Flags: `FEATURE_IAM_V2` *(flag added
to config when the phase starts — Architecture Amendment not required; audit
§11 lists it)*. Migration: existing roles map 1:1; dual-read until GA;
no-lockout invariant (Owner bypass) tested. Rollback: flag OFF → legacy checks.

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
