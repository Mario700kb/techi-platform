# TECHI Platform — Production Readiness Report

| | |
|---|---|
| **Date** | 2026-07-10 |
| **Branch audited** | `stable/phase-2-heartbeat` |
| **Fleet at time of audit** | ~700 devices, single Linode VPS |
| **Method** | Direct source inspection (file:line evidence), 8 parallel research passes across the codebase, cross-checked against PROJECT_STATE.md / IMPLEMENTATION-ROADMAP.md / OPERATOR-MANUAL.md / CHANGELOG-SOLUTIONS.md |
| **Scope** | Critical assessment against a commercial Enterprise MSP/RMM bar capable of managing thousands of endpoints. No redesigns proposed. |
| **Status** | Reference / point-in-time audit — not a living document. Re-run if used to judge progress later. |

This is a snapshot assessment, not part of the two-document standard (`PROJECT_STATE.md` / `CHANGELOG-SOLUTIONS.md`) — it does not get updated as work ships. Treat it as a dated audit, the same way `PLATFORM-EXPANSION-AUDIT.md` is a frozen baseline.

> **Current-status supersession (2026-07-28).** Statements in this report that
> describe a zero off-site copy are accurate only for the 2026-07-10 audit date.
> PC-3A later verified a **manual** off-site copy from Linode to WD My Cloud,
> including SSH-key authentication, rsync pull, lock behavior, incremental
> behavior, off-share state/logging, and gzip validation. Automation remains
> intentionally deferred and a full restore rehearsal remains unperformed. See
> [PROJECT_STATE.md](../PROJECT_STATE.md) and the
> [PC-3A Manual Off-site Backup Runbook](../operations/pc3a-manual-offsite-backup-runbook.md)
> for current posture.

---

## Headline numbers

- **~85%** complete as a Windows fleet remote-management platform — the core loop (enroll → heartbeat → inventory → remote actions → self-update → alerting → RBAC → audit) is genuinely production-hardened at 700 devices.
- **~58%** complete against the "Enterprise MSP/RMM, thousands of endpoints" bar this report was asked to use (see §11 for method).
- **7** Critical production blockers before the v1.0 claim holds.
- **6** flagship RMM features with zero implementation (Discovery, SNMP, Reporting, Notifications, Wake-on-LAN, Patch orchestration).
- **1** process handles every request today — the single-worker ceiling that must be broken before "thousands of endpoints."

---

## 1. Completed modules

Genuinely production-proven — running today against the live 700-device Windows fleet, not just merged.

- **Windows Agent core lifecycle** — startup state machine, self-heal, self-update with automatic rollback, watchdog recovery. Battle-tested at fleet scale.
- **Enrollment** — token model (expiry/max-uses/revocation), full audit trail, per-platform bootstrap, re-enrollment without consuming a use.
- **Heartbeat pipeline** — fast-path/side-effect split, correct under load, 7-day retention, freshness thresholds, reconciliation worker.
- **Remote Actions core** — queue, conflict dedup, timeout, retry, bulk targeting (all/online/client/group/selected), two-step destructive confirm.
- **Unified Classification Engine** — single source of truth for category+platform, SQL/in-memory parity-tested, verified byte-identical on the live fleet.
- **Action / Capability / Platform Registry** — genuinely single-sourced; adding a platform needs no Drawer/UI change. Architecture goal actually achieved.
- **Connect Framework + launchers** — Winbox/SSH/WebFig live and OS-aware; declarative per-platform method catalog.
- **Embedded Terminal (Linux)** — session lifecycle, idle/max-duration watchdog, audit on every path, bounded reconnect. Code-complete, deployed dark.
- **RBAC core** — 4 roles + team-based device/client scoping + a real 18-entry granular permission matrix, actually enforced per-action.
- **Audit logging** — ~35 tracked actions, filterable UI, 180-day retention job wired and running.
- **Credential Vault (storage layer)** — AES-256-GCM envelope encryption, scoped, reveal+audit. Cryptographically sound.
- **Retention & cleanup jobs** — the "5 unbounded tables" gap from July is closed and live in prod — PROJECT_STATE.md's Known Issue #3 is stale, the fix shipped.

---

## 2. Modules still incomplete

Real code exists, but the module can't yet carry its full weight in production.

- **Credential Vault (usage layer)** — encrypted storage works, but nothing consumes it. No SSH/WinRM/RDP connection in the platform actually authenticates with a vault credential today; it's a password manager with no plug into Connect or Terminal.
- **Linux Agent** — no watchdog (crashed agent stays dead), no RustDesk/remote-support parity, shallow inventory. Correctly labeled Experimental; not fleet-ready.
- **MikroTik Connector** — heartbeat/inventory/Connect work as designed (deliberately minimal scope), but this is by definition not a management surface — no config push capability exists or is planned short-term.
- **Device Inventory** — one row per device, hard-overwritten every snapshot (a DB `unique` constraint enforces this). No history, no software-change diffing, no license or warranty tracking.
- **Telemetry / resource history** — time-series storage exists and is queried, but only the mobile UI renders it (a 20-point sparkline). Desktop — the primary tech surface — shows current values only.
- **Device Drawer "Logs" tab (Linux capability)** — registered and shown in the UI, renders a placeholder with no actual log content. Will read as a bug in any hands-on demo.
- **Package / self-update rollout** — one global "active" package per platform, no staged/canary targeting. A bad build ships to the entire fleet simultaneously.
- **Terminal session recording** — the DB column (`recording_path`) exists with a comment that says "not written yet." Dead schema until built.

---

## 3. Missing enterprise features

Confirmed by direct code search — not partially built, not hidden behind a flag. Absent.

- **Notifications** — zero outbound channels — no email, Slack, webhook, SMS, PagerDuty. An offline device or critical alert generates no signal outside the web UI.
- **Reporting** — no scheduled reports, no PDF/CSV export, no client-facing deliverable of any kind. The core MSP "proof of value" workflow doesn't exist.
- **Discovery / Network Scan** — no subnet scan, ping sweep, or unmanaged-device detection. Every device must be manually enrolled via token.
- **SNMP** — exists only as a vault credential-type label. No polling, no trap receiver, no MIBs. Switches/printers/UPS units are entirely unmanageable.
- **Wake-on-LAN** — mentioned only in onboarding copy as a caveat ("use WoL to avoid this problem"). No magic-packet sender exists anywhere.
- **Patch orchestration** — agents report patch status read-only. Nothing can trigger, schedule, or enforce an OS update from the platform.
- **Policy engine** — "policy" today means one global JSON file (heartbeat/inventory interval). No per-client compliance/security baseline concept.
- **MFA / 2FA** — zero references anywhere in the codebase. Password + JWT only.
- **API keys / service accounts** — no integration-grade auth mode — third-party access requires holding an interactive operator's short-lived JWT.
- **Multi-tenant isolation** — "Client" is a grouping label inside one shared tenant. No isolated data model — cannot host multiple independent MSP businesses on one deployment.

---

## 4. Technical debt

- **Two divergent action vocabularies.** `ActionType` (single-device queue) and `BULK_COMMAND_TYPES` (batch) are separate, partially-overlapping enums. `run_powershell`, `reboot_pc`, and others exist in one but not the other — a real capability gap disguised as a naming inconsistency.
- **Alembic two-head fork.** Migrations haven't run cleanly in production for a long time; every schema change is a hand-written `ALTER TABLE` applied before deploy. This has already caused one fleet-wide outage. It is debt with a proven blast radius, not theoretical risk.
- **`secret_cipher.py` uses a custom HMAC-authenticated XOR keystream**, not a standard AEAD cipher, for the Remote Support password — while the newer Vault correctly uses AES-256-GCM. Two secret-handling standards in one codebase.
- **Documentation drift.** PROJECT_STATE.md's Known Issue #3 (unbounded tables) is stale — the fix (`49fce27`) is confirmed live in production. Low-severity but indicates the two-doc standard isn't being kept perfectly current, which compounds as the codebase grows.
- **Dead schema/UI surfaces.** `terminal_sessions.recording_path`, the Logs capability tab, and the `CATEGORY_PRINTERS`/`CATEGORY_IOT` classification buckets are all wired into the type system or UI with no backing implementation — each is either a trap for a future contributor or a user-visible dead end.
- **Package manifest is a flat JSON file, not a DB table.** No transactional integrity under concurrent uploads; works today at low upload frequency, won't hold under a busier release cadence.

---

## 5. Security improvements

- **No MFA/2FA** on any account, including Owner. The single highest-leverage account compromise vector on the platform.
- **No distributed brute-force protection.** Login rate limiting exists but is in-process memory — resets on restart and won't hold once the backend runs more than one instance.
- **No session revocation.** A stolen JWT is valid until natural expiry (60 min default); the only kill switch is deactivating the entire operator account, and there's no session listing ("log out this device") at all.
- **Missing security headers** — no CSP, no HSTS, no X-Frame-Options. Only `X-Content-Type-Options` and `Referrer-Policy` are set today. Cheap to add, meaningfully closes clickjacking/XSS surface.
- **CORS can be fully opened via a single env flag** (`BACKEND_CORS_ALLOW_ALL`) with `allow_credentials=True` — the comment warns not to use it in prod, but the capability itself is a footgun worth removing or hard-gating.
- **Weak password policy** — 8-character minimum only, no complexity, no reuse history, no expiry.
- **OpenAPI docs (`/api/v1/docs`) are unauthenticated** and reachable by anyone who can hit the API — low risk alone, but it's a reconnaissance gift for an attacker and should be disabled or gated in production.
- **Enrollment token plaintext sits in NETLOGON**, readable by any domain user (already a known, tracked issue — ACL restriction still pending).

---

## 6. Operational improvements

- **Offsite backups.** Every backup — Postgres dump, RustDesk keys, vault master key, config — lands on the same VPS as production. A single host failure is a total-loss event regardless of fleet size.
- **Nobody watches the watcher.** No external uptime check on TECHI itself. If the backend or VPS goes down, the only signal is a human noticing the dashboard stopped updating — which requires the dashboard to be up.
- **No CI gate.** The one GitHub Actions workflow builds the agent MSI; nothing runs the 566-test backend suite or a frontend build/typecheck automatically on push or PR. Regressions only get caught by remembering to run `preflight.sh` by hand.
- **No frontend automated tests at all** — no Jest/Vitest/Playwright in the toolchain. Every frontend change is verified by `tsc` and, at best, a manual browser pass.
- **DR has never been rehearsed end-to-end** (except the vault-key recovery, which was tested). A documented procedure that's never been executed is a plan, not a capability.
- **Server provisioning is undocumented-outside-markdown** — no Terraform/Ansible. Rebuilding the host from scratch depends on institutional memory.
- **25 GB disk on the production VPS is already described as "structurally tight."** Retention windows scale linearly with fleet size; this needs a resize decision before onboarding meaningfully more devices, independent of any feature work.

---

## 7. Performance improvements

- **Single uvicorn worker, single process.** Every heartbeat, WebSocket connection, terminal relay byte, and background job runs on one event loop. This has already caused one fleet-wide heartbeat 500 outage under load.
- **In-memory, per-process state** in the realtime publisher and the Terminal relay — both explicitly documented in their own code comments as the thing that has to move out-of-process before scaling further. You cannot add a second backend worker today without breaking WebSocket/terminal session affinity.
- **No cache layer, no job queue.** No Redis, no Celery/arq/RQ anywhere. All "background" work is `asyncio.create_task` inside the one process.
- **`device_heartbeats` / `device_telemetry` are unpartitioned** at ~1.8 GB combined today. A nightly full-table `VACUUM ANALYZE` against a 10x-larger table on a single-worker host will start colliding with live traffic.
- **Postgres container has no memory limit** — the only two other containers do (backend 800 MB), but a DB memory spike can still starve the whole host.

---

## 8. Architecture improvements

Not redesigns — the registries and framework pattern are sound and should be reused exactly as-is. These are structural finishing moves within that architecture.

- **Wire the Vault into an actual connection.** The architecture recommendation for this already exists in the roadmap (a "connector relay" mode of the existing `TerminalRelay`, backend-as-SSH-client, vault-sourced credential) — it just hasn't been built. This single piece of work turns the Vault from a password manager into the thing that makes SSH/WinRM connect actions real.
- **Extend the Connect Framework's method catalog**, not its architecture — add an `rdp://` entry for Windows and VNC entries where relevant. The registry already supports this trivially; it's a data-table addition, not new code.
- **Move terminal/session state out of process** using the exact seam already documented in `terminal_relay.py`'s own comments — this is planned debt, not a surprise, and should be sequenced before the next big fleet-size jump.
- **Give inventory a history table** instead of the current unique-per-device overwrite row — this is additive (new table + a write path), not a rework of the existing snapshot model.
- **Unify the two action-type vocabularies** (§4) into the single `platform_core/actions.py` registry that already exists for everything else — this is consolidation onto an existing pattern, not a new one.

---

## 9. Production blockers

These are the items that specifically prevent calling TECHI a production-ready *Enterprise* MSP/RMM — not bugs, but absences with real commercial or operational consequences.

1. **No outbound notifications.** A 24/7 managed-services product that can't page anyone when a client's server goes down is not sellable as one.
2. **No client-facing reporting.** MSPs sell proof of value monthly. There is currently no way to produce it from TECHI.
3. **At the 2026-07-10 audit: no offsite backup / unrehearsed DR.** The later
   PC-3A manual off-site copy reduces the single-host risk, but full recovery
   remains untested; see the current-status supersession above.
4. **Single-process architecture with no path to add a second worker today.** Fine at 700 devices; actively dangerous at "thousands," which is the explicit bar this report was asked to assess against.
5. **Alembic drift + hand-applied schema changes** is an operational landmine that has already detonated once (a fleet-wide 500 outage). It will detonate again under more contributors or velocity.
6. **No CI gate and zero frontend test coverage.** Every deploy currently depends on someone remembering to run preflight by hand. That does not hold as the team or codebase grows.
7. **No MFA and no session revocation.** For a product holding remote-command execution rights over thousands of endpoints, an account-takeover vector with no mid-session kill switch is not an enterprise-defensible security posture.

---

## 10. Recommended implementation order

Sequenced for blast-radius reduction first, then commercial viability, then scale. Each phase assumes the existing "one phase at a time, preflight+smoke+document" discipline already in use.

1. **Stop the bleeding — backup & schema safety.** Offsite backup destination (S3 or a second host) added to the existing script; reconcile the Alembic two-head fork and get real migrations running in prod again. Days of work, removes the two scariest single points of failure.
2. **CI gate + frontend tests.** Wire `preflight.sh` into GitHub Actions on every push; add a minimal Vitest/Playwright smoke layer to the frontend. Protects every subsequent phase from regressing silently.
3. **Notifications.** One dispatch service, wired into the existing alert engine's publish points — start with email + a generic webhook (covers Slack/Teams/PagerDuty via their own webhook intake). Reuses the alert engine entirely; no new detection logic.
4. **Reporting v1.** Scheduled PDF/CSV export of the existing Fleet Dashboard + Alerts data, per-client. Doesn't need new data collection — everything it needs already exists in `device_overview_service.py` and the alert/audit tables.
5. **MFA + session revocation + security headers.** TOTP on the existing JWT auth flow, a `jti` blacklist for revocation, CSP/HSTS added to the existing middleware. Contained to `core/auth.py` and `main.py` — no architecture change.
6. **Staged rollout for self-update/packages.** Add client/group targeting to the existing "active package" model before the fleet grows further — the exact same rollout-scope pattern just built for the Embedded Terminal (`platform_core/rollout.py`) is directly reusable here.
7. **Wire the Vault + finish Connect.** Build the documented "connector relay" SSH mode, add RDP to the Connect method catalog for Windows. Turns two already-built-but-inert systems into real functionality.
8. **Wake-on-LAN + patch orchestration.** WoL is a small, contained agent action. Patch orchestration is larger — start with a single "trigger pending updates" remote action reusing the existing patch-status read path before building scheduling/compliance on top.
9. **Discovery + SNMP.** The biggest net-new subsystem in this list. Sequence last among the v1.0-critical items because it's genuinely new surface area (a scanner, an SNMP poller) rather than finishing existing plumbing.
10. **Break the single-process ceiling.** Move the realtime publisher and Terminal relay to Redis pub/sub, add a second uvicorn worker, partition `device_heartbeats`/`device_telemetry`. Sequence this once fleet growth is actually imminent — it's necessary before "thousands of endpoints," not before the next 1,000.

---

## 11. Estimated percentage of project completion

**~85% complete as a Windows fleet remote-management platform.** The core loop — enroll, heartbeat, inventory, remote support, remote actions, self-update, alerting, RBAC, audit — is genuinely production-proven at 700 devices with real hardening (conflict dedup, retry, rollback, watchdog recovery).

**~58% complete against the "Enterprise MSP/RMM, thousands of endpoints" bar this report was asked to use.** That number is lower because six flagship category features (Notifications, Reporting, Discovery, SNMP, Patch orchestration, offsite DR) are at zero, several already-built systems are inert or dark (Vault, Terminal, Linux/MikroTik), and the current single-process architecture has a known, documented ceiling below "thousands."

These two numbers aren't in tension — they describe different products. TECHI today is a very solid, production-hardened Windows RMM with early multi-platform extensions. It is not yet the commercial multi-platform Enterprise MSP suite the mission brief measures it against. The gap is almost entirely additive work reusing the existing registries (Action/Capability/Platform/Connect), not architectural rework — which is the good news in this assessment.

---

## 12. Definition of v1.0

The minimum bar to sell TECHI as a production Enterprise MSP/RMM without a caveat.

- All 7 items in §9 Production Blockers closed.
- **Notifications** — at minimum email + generic webhook on every alert.
- **Reporting** — scheduled, per-client PDF/CSV export of fleet health.
- **Offsite, tested backups** with at least one full rehearsed restore.
- **CI gate** running preflight + a frontend smoke layer on every push.
- **MFA** available for Owner/Admin roles at minimum.
- **Staged package/self-update rollout** (client/group targeting) — required before onboarding any second large client onto the same active-package model.
- **Vault wired to at least one real connection type** (SSH via the documented connector-relay pattern) — otherwise the Vault is a UI feature with no operational function.
- **Wake-on-LAN** — small effort, expected-by-default RMM feature; its absence undermines the v1.0 claim disproportionately to its build cost.
- Linux and MikroTik remain explicitly labeled **Experimental/Connector-scope** in v1.0 — that's an honest, already-documented scope line, not a blocker to ship Windows-primary v1.0.

---

## 13. Definition of v2.0

Real, valuable work — deliberately deferred because it's either large net-new surface area or contingent on v1.0 commercial traction.

- **Discovery + SNMP** — the largest net-new subsystem identified in this audit; unlocks managing switches/printers/UPS/unmanaged devices.
- **Patch orchestration** — full scheduling/compliance/approval workflow on top of the v1.0 "trigger update" action.
- **Full policy engine** — per-client compliance/security baselines, beyond the single global heartbeat/inventory config that exists today.
- **Custom IAM roles** (Phase 6, already deprioritized on the existing roadmap — this report agrees with that call).
- **True multi-tenant SaaS architecture** — only relevant if TECHI is ever sold as hosted-by-us rather than self-hosted-per-MSP; a genuinely different product decision, not a technical afterthought.
- **Storage & Hypervisor connectors** (Synology/QNAP/VMware/Hyper-V/Proxmox) — already Phase 8/9 on the existing roadmap; sequence after Discovery/SNMP since those affect a much larger share of a typical MSP's fleet.
- **RouterOS API** for MikroTik config push — deliberately out of scope per the existing "Connector, not an agent" design decision; revisit only if customer demand outweighs the added attack surface of managing router configs remotely.
- **Terminal session recording** — the schema is already there waiting.
- **Horizontal scaling** beyond the single second-worker step in §10 — full multi-region/multi-host if TECHI ever needs to host a materially larger single deployment than "thousands."

---

## Full area-by-area matrix

Every area named in the mission brief. Priority: **Critical** / **High** / **Medium** / **Future** / **Done**. Effort is rough order-of-magnitude, not a committed estimate (XS < 1 day · S ≈ days · M ≈ 1–3 weeks · L ≈ 3–6 weeks · XL = quarter-scale initiative or a product decision).

### Agents & delivery

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Windows Agent | Done | Self-heal, self-update+rollback, watchdog, startup lifecycle, remote command set. | No patch install, no script library, `run_command`/`open_terminal` stubbed. | S–M per item | — |
| Linux Agent | High | systemd install, self-update, thin inventory, real terminal PTY. | No watchdog, no RustDesk parity, no auto-recovery on crash. | M | — |
| MikroTik Connector | Future | Heartbeat/inventory/Connect, deliberately minimal by design. | No RouterOS config-push API (scoped out intentionally). | L | Vault SSH wiring |
| Self-Update | High | SHA-verified swap, heartbeat-confirmed rollout, agent-side rollback. | No staged/canary targeting — one global "active" build per platform. | M | Rollout framework (built for Terminal) |
| Package Management | Medium | Upload/activate/delete, SHA-alignment, audit. | Flat-file manifest not a DB table; no per-client version pinning. | S–M | — |
| Version Management | Done | Generic version comparison + badge, platform-neutral. | — | — | — |

### Network management

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Discovery | High | Does not exist. | No subnet/IP-range scan, no unmanaged-device detection at all. | L | SNMP (shares infra) |
| SNMP | High | A credential-type label in the Vault only. | No polling, no trap receiver, no MIB support. | L | Vault wiring |
| Network Scan | High | Does not exist. | Same gap as Discovery — one feature, listed twice in the brief. | — | Discovery |
| Wake-on-LAN | High | Mentioned only as onboarding-copy caveat text. | No magic-packet sender, no action, no UI entry point. | S | — |
| Patch Management | High | Read-only status collection per OS (Win/macOS/Linux). | No install/apply/schedule/compliance orchestration. | L | Notifications, Reporting |

### Core device pipeline

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Enrollment | Done | Token model, audit trail, per-platform bootstrap. | No bulk token generation, no expiry-soon warning. | S | — |
| Heartbeat | Done | Fast-path/side-effect split, correct at fleet scale. | No per-client interval override; alerting is state-only, no escalation ladder. | S–M | Notifications |
| Inventory | High | Latest-only snapshot (processes/services/software/patch). | No history/diffing, no license or warranty tracking, unstructured hardware specs. | M | — |
| Telemetry | Medium | Time-series table exists, queried by mobile sparkline only. | No desktop trend chart — the primary tech surface shows current values only. | S | — |
| Assignment Engine | Medium | Manual lock, token-driven, trusted-domain, auto-reclassify. | No bulk reassignment endpoint, no rule engine beyond token defaults. | S | — |
| Unified Classification | Done | Single source of truth, SQL/in-memory parity-tested. | Printer/IoT categories defined but unused (dead code). | XS | — |

### Actions, connect, terminal, vault

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Remote Actions | Medium | Queue, dedup, timeout, retry, batch/progress. | No scheduling/recurring actions, no script library, two divergent type vocabularies. | M | — |
| Connect Framework | Medium | Declarative registry, live launchers (Winbox/SSH/WebFig), OS-aware. | No RDP/VNC entries for Windows — single point of failure if RustDesk is blocked. | S | — |
| Embedded Terminal | High | Linux: code-complete, lifecycle-hardened, deployed dark. | Windows has no terminal at all (`not supported on Windows`); recording unwritten. | M | — |
| Credential Vault | High | AES-256-GCM storage, scoping, reveal+audit — cryptographically solid. | Not wired to any real connection; no rotation automation; "test connection" is a stub. | M | — |
| Action Registry | Done | Single source of truth, contract-tested against the permission map. | Flat per-action permission only, no role-tiering within a permission. | — | IAM (v2.0) |
| Capability Registry | Done | Normalizes reported capabilities, drives Drawer tabs. | Capability versioning exists in data but nothing gates on it yet. | S | — |
| Platform Registry | Done | Single source for 11 platforms' deployment/capability metadata. | — | — | — |

### Fleet UX & awareness

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Device Tree | Done | Navigation-only, fully auto-classified. | No custom folders beyond "Other," no saved per-operator views. | S | — |
| Fleet Dashboard | Medium | Live-refreshed tiles, health score, recent activity. | No historical trend charts, no exportable report (→ Reporting). | S | Reporting |
| Alerts | High | 9 fixed rule kinds, cooldowns, maintenance-mode suppression. | No per-client thresholds, no escalation, no outbound routing (→ Notifications). | M | Notifications |
| Monitoring | Future | Deliberately out of scope — "Zabbix boundary" is a documented, intentional line. | No SLA/uptime/port/URL monitoring by design, not oversight. | — | Scope decision, not backlog |
| Maintenance Mode | Medium | Device-level, one-shot with optional auto-expiry. | No recurring/scheduled windows, no bulk entry point. | S | — |
| Search | Medium | Broad field coverage, quick filters, shareable URL state. | No saved/named smart filters. | S | — |
| Bulk Actions | Medium | Full targeting model, RBAC-gated, two-step confirm. | No bulk tagging (no tag model at all), no bulk client reassignment. | M | — |

### Accountability & commercial

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Audit | Medium | ~35 tracked actions, filterable UI, 180-day retention live. | No export/SIEM forwarding, not tamper-evident, silent write failures. | S–M | — |
| Reporting | Critical | Does not exist. | No scheduled or on-demand client-facing report of any kind. | M | Fleet Dashboard, Alerts data |
| Policies | Future | One global config file (heartbeat/inventory interval only). | No per-client compliance/security policy engine. | L | — |
| Notification System | Critical | Does not exist — in-app bell only, requires being logged in. | No email/Slack/webhook/SMS outbound channel anywhere. | M | Alert engine (already built) |
| Logs (platform-operational) | Medium | Backend logs to stdout only; Drawer's Logs tab is a placeholder. | No in-app troubleshooting view; Linux Logs tab shows nothing real. | S | — |

### Platform, access & multi-tenancy

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| API | Medium | 29 routers, OpenAPI docs, resource-oriented. | No API keys/service accounts, unauthenticated docs endpoint, no general rate limiting. | S–M | — |
| Permissions | Done | 18-entry granular matrix, genuinely enforced per-action. | Static per-role, no per-operator override outside team membership. | — | IAM (v2.0) |
| Roles | Future | Fixed 4 roles (owner/admin/operator/readonly). | No custom roles — already correctly deprioritized on the existing roadmap. | L | — |
| Multi-tenant | Future | Not multi-tenant — "Client" is a label within one shared tenant. | No isolated data model; only relevant if TECHI becomes hosted SaaS. | XL | Product decision |

### Scale & infrastructure

| Area | Priority | Current state | Missing / gap | Effort | Depends on |
|---|---|---|---|---|---|
| Performance | Critical | Single uvicorn worker; has already caused one outage under load. | No path to a second worker without moving WS/terminal state out of process. | L | Redis |
| Scalability | Critical | Same root cause as Performance — in-memory relay/publisher, no job queue. | Documented ceiling below "thousands of endpoints." | L | Performance work |
| Database | High | Pooled connections, tuned for single-worker today. | No partitioning on the two largest tables; Alembic two-head fork unresolved. | M | — |
| Retention | Done | Full coverage live — heartbeats/telemetry/audit/alerts/actions/status-history all purge on schedule. | Windows scale linearly with fleet size; disk headroom needs periodic re-check. | — | — |
| Cleanup Jobs | Done | Nightly scheduler, VACUUM ANALYZE included. | Full-table vacuum will get slower as tables grow without partitioning. | — | Database partitioning |
| Backups | Critical | Postgres + RustDesk keys + vault key + config, all covered. | At audit time: zero offsite copy — single-VPS failure was total data loss. Superseded in part by PC-3A manual off-site copy; restore proof remains open. | S | — |
| Docker | Medium | Compose-based, healthchecks on postgres/backend, auto-restart. | No resource limits on postgres/frontend; no healthcheck-triggered recovery. | S | — |
| Security | Critical | Strong Vault crypto, PBKDF2 password hashing, per-device secrets. | No MFA, no session revocation, missing CSP/HSTS, wildcard-capable CORS. | M | — |
| Documentation | Done | Disciplined two-doc standard, consistently followed for months. | Occasional staleness (one confirmed example, §4) — needs periodic audit, not a rewrite. | XS | — |
| Testing | Critical | 566 backend tests, disciplined preflight/smoke gates. | Zero frontend automated tests; no CI enforcement of any of it. | M | — |
| Operations | High | Detailed manual runbooks in CHANGELOG-SOLUTIONS.md. | No external uptime watch on TECHI itself; no IaC for server rebuild. | S–M | — |

---

*Compiled from direct source inspection across 8 parallel research passes over `/Users/mario.lika/techi-platform` (branch `stable/phase-2-heartbeat`). No code was changed, deployed, or committed in the production of this report.*
