# TECHI Platform — Implementation Roadmap

## 1. Document Contract

**Purpose.** This document is the sole authority for future work that is open, proposed, approved, in progress, blocked, or awaiting a decision.

**Authority boundary.** It contains no production snapshot, deploy history, completed-phase archive, health metric, feature-flag snapshot, or incident narrative. Those facts belong respectively to [PROJECT_STATE.md](PROJECT_STATE.md) and [CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md).

**Owner.** Accountable: Engineering Lead. Priority approval: Product/Business Owner.

**Update triggers.** Update when an initiative is proposed, explicitly approved, starts, becomes blocked, changes scope, or is closed under the closure rules below.

**Closure rule.** A completed initiative is removed from this active portfolio. Its result is recorded in the changelog; Project State is updated only if verified production state changed.

## 2. Planning Rules

- Only open work belongs here.
- Every initiative has a stable ID.
- A status of `APPROVED`, `IN PROGRESS`, or `BLOCKED` requires explicit evidence; otherwise use `PROPOSED`.
- No current production SHA, active package/fleet state, health metric, deployment transcript, completed archive, or feature-flag snapshot is duplicated here.
- Technical debt enters this portfolio only after it is accepted as a planned initiative or a decision-required item.
- An initiative may reference a changelog event or a current-risk ID, but it may not duplicate their facts.

## 3. Current Stabilization Programme

All phases below are **PROPOSED / AWAITING EXPLICIT APPROVAL**. They are planning constructs, not approved work.

### STAB-1 — Release Anchoring and Recovery Proof

| Field | Plan |
|---|---|
| Goal | Establish a recoverable, immutable release baseline. |
| Scope | Immutable tag; finalized release manifest; fresh backup/checksum; approved restore test; image preservation. Verified manual off-host-copy evidence from PC-3A is an input, not open implementation work in this roadmap. |
| Recommended model | GPT-5.6 TERRA |
| Risk | MEDIUM |
| Entry criteria | Explicit approval; verified release target and maintenance window. |
| Checklist | Define tag convention; produce manifest; validate backup/checksum; preserve images; perform approved restore rehearsal. |
| Validation | Tag/manifest consistency; checksum evidence; existing off-host retrieval evidence; restore acceptance evidence. |
| Exit criteria | Immutable release identity and tested recovery evidence are recorded in the changelog and Project State. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | None |

### STAB-2 — Safe Storage and Artifact Cleanup

| Field | Plan |
|---|---|
| Goal | Recover storage safely with traceable artifact retention. |
| Scope | Stateless cleanup; duplicate rollback verification; anonymous PostgreSQL volume investigation; Git maintenance; package retention review. |
| Recommended model | GPT-5.6 TERRA |
| Risk | MEDIUM |
| Entry criteria | STAB-1 approved and completed; exact deletion candidates verified read-only. |
| Checklist | Inventory candidates; classify recoverability; validate rollback artifacts; obtain target-specific approval; execute only approved cleanup. |
| Validation | Post-action capacity evidence; retained release/rollback artifacts verified; no runtime regression. |
| Exit criteria | Approved storage actions are recorded with evidence and remaining candidates are dispositioned. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-1 |

### STAB-3 — Security Hardening

| Field | Plan |
|---|---|
| Goal | Resolve active Remote Support, secret, authentication, and supply-chain exposures. |
| Scope | Remote Support credential rotation; MSI provenance; vault-key protections; secrets review; authentication-rollout review. |
| Recommended model | GPT-5.6 TERRA; Claude Opus for independent security review |
| Risk | HIGH |
| Entry criteria | Explicit security approval, affected-scope definition, rollback plan, and communication plan. |
| Checklist | Define rotation method; reconcile MSI trust/provenance; review secret exposure paths; validate vault-key handling; design auth-control rollout. |
| Validation | Security review, canary evidence where applicable, rollback validation, and audit-trail evidence. |
| Exit criteria | Approved security changes are closed through changelog evidence and current posture is updated. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-1 recommended before any destructive or broad credential action |

### STAB-4 — Repository and Release Governance

| Field | Plan |
|---|---|
| Goal | Establish governed promotion, branching, release tagging, and manifest policy. |
| Scope | Promote verified baseline to `main`; branch protection; branch archive/delete plan; release tagging; release manifests; version policy. |
| Recommended model | GPT-5.6 TERRA |
| Risk | MEDIUM |
| Entry criteria | Product/Business Owner decision on promotion and branch policy. |
| Checklist | Define branch roles; map active/stale branches; define promotion gate; define tag/manifest rules; obtain approval. |
| Validation | Protected-branch and release-policy evidence; branch disposition reviewed before execution. |
| Exit criteria | Governance decision is recorded and any executed promotion/tagging has a changelog closure. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-1 for immutable baseline evidence |

### STAB-5 — CI/CD Hardening

| Field | Plan |
|---|---|
| Goal | Make build, test, and artifact provenance reproducible and enforceable. |
| Scope | Backend CI; frontend CI; PR gates; artifact provenance; signed/reproducible releases; embedded build identity. |
| Recommended model | GPT-5.6 SOL for implementation; GPT-5.6 TERRA for review |
| Risk | MEDIUM |
| Entry criteria | Approved CI policy and release-governance requirements. |
| Checklist | Inventory workflows; define required checks; add provenance outputs; define signing/reproducibility standard; validate PR gates. |
| Validation | CI evidence from controlled test runs and artifact-to-manifest traceability. |
| Exit criteria | Approved CI gates and provenance evidence are documented in the changelog. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-4 recommended |

### STAB-6 — Database Governance

| Field | Plan |
|---|---|
| Goal | Establish safe migration, residue, retention, and recovery governance. |
| Scope | Two-head Alembic strategy; schema residue; retention; backup/restore automation; migration policy. |
| Recommended model | GPT-5.6 TERRA; Claude Opus for migration-risk review |
| Risk | HIGH |
| Entry criteria | Explicit database-owner approval and current schema/backup evidence. |
| Checklist | Decide head strategy; classify residue; define migration policy; validate retention; design recovery automation. |
| Validation | Migration-risk review, schema verification, and approved restore evidence. |
| Exit criteria | Adopted governance decision and any schema action are recorded with rollback evidence. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-1 recommended; STAB-3 if secret-bearing recovery paths change |

### STAB-7 — Documentation Finalisation

| Field | Plan |
|---|---|
| Goal | Confirm stable canonical documentation after governance work. |
| Scope | Final drift review; stable anchors; canonical links; owner/cadence review. |
| Recommended model | GPT-5.6 TERRA |
| Risk | LOW |
| Entry criteria | Approved documentation review and latest verified baseline. |
| Checklist | Validate authority boundaries; validate links/anchors; verify ownership/cadence; reconcile closed initiatives. |
| Validation | Cross-document audit with no duplicate source of truth. |
| Exit criteria | Documentation review is recorded as a changelog event. |
| Approval status | PROPOSED — Awaiting explicit approval |
| Dependencies | STAB-1 through STAB-6 decisions as applicable |

## 4. Initiative Register

All initiatives are `PROPOSED` unless and until explicit approval is recorded. “Related changelog IDs” are references only; they do not make an initiative approved.

| ID | Outcome and scope | Owner role | Status / Priority / Risk | Recommended model | Dependencies | Acceptance criteria and evidence required | Related risks | Related changelog IDs |
|---|---|---|---|---|---|---|---|---|
| INIT-REL-001 | Immutable release baseline: tag convention, release manifest, image/package identities. | Release Governance Lead | PROPOSED / High / Medium | GPT-5.6 TERRA | None | Immutable tag and manifest resolve to one verified SHA; evidence is recorded. | RISK-REL-001, RISK-DOC-001 | REL-BASELINE-2026-07-26 |
| INIT-BKP-002 | Restore rehearsal: approved end-to-end recovery proof. | Production/SRE Owner | PROPOSED / High / High | GPT-5.6 TERRA | Verified PC-3A manual off-host copy | Restore acceptance criteria are passed and evidence is retained. | RISK-BKP-002 | PC-3A-MANUAL-OFFSITE-2026-07-28 |
| INIT-SEC-001 | Remote Support credential rotation and related authentication hardening. | Security Lead | PROPOSED / High / High | GPT-5.6 TERRA; Claude Opus review | INIT-REL-001 recommended | Approved method, scoped rollout, rollback, and security evidence exist. | RISK-SEC-001 | AGENT-2.1.20-RECONCILIATION |
| INIT-SUPPLY-001 | Resolve Remote Support MSI provenance and conflicting artifact disposition. | Release Governance Lead | PROPOSED / High / High | GPT-5.6 TERRA | INIT-REL-001 recommended | One approved provenance policy and manifest evidence for retained artifacts. | RISK-SUPPLY-001 | REL-BASELINE-2026-07-26 |
| INIT-DB-001 | Decide and implement Alembic two-head governance. | Database Owner | PROPOSED / High / High | GPT-5.6 TERRA; Claude Opus review | INIT-BKP-002 recommended | Written strategy, migration safeguards, and rollback policy are approved. | RISK-DB-001 | REL-BASELINE-2026-07-26 |
| INIT-CI-001 | Establish backend CI and required backend checks. | Engineering Lead | PROPOSED / Medium / Medium | GPT-5.6 SOL; GPT-5.6 TERRA review | INIT-GIT-001 recommended | Approved required checks run reliably on proposed change paths. | RISK-REL-001 | None yet — closure event required |
| INIT-CI-002 | Establish frontend CI and required frontend checks. | Engineering Lead | PROPOSED / Medium / Medium | GPT-5.6 SOL; GPT-5.6 TERRA review | INIT-GIT-001 recommended | Approved required checks run reliably on proposed change paths. | RISK-REL-001 | None yet — closure event required |
| INIT-CI-003 | Artifact provenance, embedded build identity, and reproducible/signed release policy. | Release Governance Lead | PROPOSED / Medium / Medium | GPT-5.6 SOL; GPT-5.6 TERRA review | INIT-REL-001, INIT-CI-001, INIT-CI-002 | Release artifact can be traced to source, workflow, manifest, and package hash. | RISK-SUPPLY-001, RISK-REL-001 | REL-BASELINE-2026-07-26 |
| INIT-GIT-001 | `main` promotion strategy, branch policy, and branch disposition plan. | Release Governance Lead | PROPOSED / High / Medium | GPT-5.6 TERRA | INIT-REL-001 | Explicit policy decides branch roles, protection, promotion, archive/delete criteria. | RISK-DEPLOY-001, RISK-REL-001 | DOC-ARCH-2026-07-27 |
| INIT-STORAGE-001 | Safe production storage recovery after read-only capacity remeasurement. | Production/SRE Owner | PROPOSED / Medium / Medium | GPT-5.6 TERRA | INIT-REL-001, INIT-BKP-002 recommended | Candidate inventory, retention decision, approved target list, and post-action capacity evidence. | RISK-STORAGE-001 | REL-BASELINE-2026-07-26 |
| INIT-FLEET-001 | Fleet convergence after the successful Agent 2.1.20 rollout: migrate remaining devices, retire legacy versions, and perform approved post-rollout cleanup. | Engineering Lead | PROPOSED / Low / Low | GPT-5.6 TERRA | INIT-REL-001 recommended | Approved convergence target, residual-device migration plan, legacy-retirement criteria, cleanup boundaries, and final evidence. | RISK-FLEET-001 | AGENT-2.1.20-PRODUCTION-ROLLOUT |
| INIT-FLAG-001 | Controlled review of enabled, disabled, and rollout/migration controls. | Engineering Lead | PROPOSED / Medium / Medium | GPT-5.6 TERRA | INIT-REL-001 recommended | Approved scope per control, validation criteria, and rollback path. | RISK-FLEET-001, RISK-DOC-001 | PROD-VALIDATION-RECONCILIATION-2026-07-26; TERMINAL-729-EVIDENCE-GAP |
| INIT-NOTIFY-001 | Decide notification activation scope, channel/rule prerequisites, and rollout controls. | Product/Business Owner | PROPOSED / Medium / Medium | GPT-5.6 TERRA | INIT-FLAG-001 | Explicit activation scope, security review, validation, and rollback plan. | RISK-SEC-001 | None yet — closure event required |
| INIT-IAM-001 | Enterprise IAM development decision and scoped implementation plan. | Product/Business Owner | PROPOSED / Medium / High | GPT-5.6 TERRA | INIT-SEC-001 review recommended | Approved security model, scope, migration strategy, and no-lockout acceptance criteria. | RISK-SEC-001 | None yet — closure event required |
| INIT-STORAGE-PLATFORM-001 | Storage-platform module discovery and approval. | Product/Business Owner | PROPOSED / Low / Medium | GPT-5.6 TERRA | INIT-FLAG-001 | Approved product scope, architecture review, validation, and rollback criteria. | RISK-REL-001 | None yet — closure event required |
| INIT-HYPERVISOR-001 | Hypervisor-platform module discovery and approval. | Product/Business Owner | PROPOSED / Low / Medium | GPT-5.6 TERRA | INIT-FLAG-001 | Approved product scope, architecture review, validation, and rollback criteria. | RISK-REL-001 | None yet — closure event required |
| INIT-RT-001 | Real-time agent channel: push commands to every agent (Windows included) over a persistent WebSocket, live telemetry only for devices being viewed, inventory lists only on change, lighter heartbeat path. Phases and rules in [architecture/realtime-agent-channel.md](architecture/realtime-agent-channel.md). | Product/Business Owner | PROPOSED (deferred by owner 2026-10-12) / Medium / High | Claude Opus | Enforced agent identity (RISK-SEC-002) before phase 2; agent release via MSI/GPO | Pilot of ~10 PCs: command latency < 1 s, server CPU/memory measured within budget, heartbeat fallback proven; then fleet rollout with rollback. | RISK-CAP-001, RISK-CAP-003, RISK-SEC-002, RISK-FLEET-003 | — |
| INIT-CLIENT-003 | Client profile phase 3: HubSpot through a Private App token in the server `.env` (read scopes: companies, contacts, tickets); each client linked to one HubSpot company from its profile with a name-based suggestion; the Tickets tab fills from it. | Product/Business Owner | APPROVED (owner 2026-10-13), not started / Medium / Medium | Claude Opus | The token, requested from the owner when work starts; never in the repository | Linked company per client, tickets and contacts read-only on the profile, token only in `.env`, audit of link changes. | RISK-SEC-001 | CLIENT-PROFILE-1-2026-10-13 |
| INIT-LOC-001 | Client locations phase 3: one site-outage alert ("<client> <site> offline, N devices") instead of one alert per device when a site's devices drop together, using the locations and the existing site-outage analysis. | Product/Business Owner | PROPOSED / Medium / Medium | Claude Opus | Locations in use (CLIENT-LOCATIONS-2026-10-15) | A whole site going offline yields one alert with its devices listed, resolved when the site returns; per-device alerts for that event suppressed; tests and a production observation. | RISK-CAP-001 | CLIENT-LOCATIONS-2026-10-15 |
| INIT-LOC-002 | Locations code and coverage: queries into a `LocationRepository` (the rules ask for queries in repositories), one shared Explorer branch for client and site categories, IPv6 rules accepted by the form as the API already does. | Engineering Lead | PROPOSED / Low / Low | Claude Opus | None | No behaviour change; tests unchanged and green. | — | CLIENT-LOCATIONS-2026-10-15 |
| INIT-AGENT-002 | Agent reports the CPU model (registry `ProcessorNameString`) and core/thread counts instead of `PROCESSOR_IDENTIFIER`; the drawer then names the exact processor. | Engineering Lead | PROPOSED / Low / Low | Claude Opus | Next agent release and its rollout | The drawer shows e.g. "Intel Xeon Gold 6130" for upgraded agents and falls back to the decoded microarchitecture for older ones. | RISK-FLEET-001 | DRAWER-CONNECT-2026-10-15 |
| INIT-DB-003 | Database integrity and sizing follow-ups from the 2026-10-15 review: CHECK constraints for enum-like varchar columns (`location_source`, `kind`, `assignment_source`, …); remaining variable-length `IN` lists on hot paths moved to `id_in()`; request pool (30 + 50) sized from measured peaks before `max_connections` goes below 100. | Database Owner | PROPOSED / Low / Low | Claude Opus | None | Constraints added without rejecting existing rows (checked first); pg_stat_statements stays small; pool peak measured. | — | DB-HYGIENE-2026-10-15; PG-RESTART-2026-10-15 |
| INIT-BKP-003 | Automate the WD off-site pull and run the restore test weekly (`scripts/db/restore-test.sh`, run once on 2026-10-12), with the result visible on the System status panel. | Production/SRE Owner | PROPOSED / Medium / Medium | Claude Opus | INIT-BKP-002 | Seven days of automatic pulls and one passed scheduled restore test, with alerts on failure. | RISK-BKP-001, RISK-BKP-002 | DB-ENTERPRISE-A; DB-HYGIENE-2026-10-15 |

## 5. Blocked / Decision Required

| Decision | Why it is required | Related initiative |
|---|---|---|
| Release tag naming and immutable release convention | A verified SHA exists, but no immutable release baseline does. | INIT-REL-001 |
| Promotion strategy for `main` | `main` is not the current production branch; promotion must be explicitly governed. | INIT-GIT-001 |
| Remote Support credential rotation method | Credential exposure and rollout risk require an approved method and rollback. | INIT-SEC-001 |
| Conflicting Remote Support MSI disposition | Retention, trust, and active-artifact policy are not yet resolved. | INIT-SUPPLY-001 |
| Alembic two-head strategy | Any migration work requires an approved topology and rollback policy. | INIT-DB-001 |
| Post-rollout fleet convergence policy | Decide residual-device migration, legacy-version retirement, and cleanup boundaries. This does not block production. | INIT-FLEET-001 |
| Notification activation scope | Notification feature activation requires explicit business and security scope. | INIT-NOTIFY-001 |
| Mobile lifecycle gate | **NOT REQUIRED**: mobile remains part of the primary frontend lifecycle. | None |

## 6. Closure Rules

When an initiative completes:

1. Create a changelog entry with scope, evidence, result, rollback posture, and any decision made.
2. Update [PROJECT_STATE.md](PROJECT_STATE.md) only if verified production state changed.
3. Remove the initiative from this active roadmap; Git and the changelog retain history.
4. Do not create a completed-phase archive inside this document.
5. Re-run canonical authority validation before declaring the documentation lifecycle closed.
