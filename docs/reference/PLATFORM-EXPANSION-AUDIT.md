# TECHI PLATFORM EXPANSION — FINAL ARCHITECTURE AUDIT
### The official baseline document for Platform Expansion implementation

==========================================================

**ARCHITECTURE STATUS**

**STATUS: DESIGN LOCKED** (approved by the owner, 2026-07-07)

This document is frozen.

Architectural changes require an **Architecture Amendment**.

Implementation may continue without modifying this document.
(Exceptions by design: the Progress Log and the Appendix C certification
record are living registers and are updated as phases close.)

==========================================================

| | |
|---|---|
| **Status** | ✅ **APPROVED & DESIGN LOCKED** (2026-07-07). Implementation proceeds one phase at a time; each phase closes only via Appendix A (Definition of Done) + Appendix B (Regression Matrix) + Appendix C (Certification), with explicit owner approval between phases. |
| **Role** | The official, frozen implementation baseline for Platform Expansion. Supersedes all earlier drafts in this file (Linux V1/V2, "V3", Expansion contract). |
| **File name** | `PLATFORM-EXPANSION-AUDIT.md` (renamed from `LINUX-AGENT-DESIGN-SPEC.md` on approval, 2026-07-07; drafting history preserved in the Progress Log). |
| **Mission** | ~750 live devices. The objective is **Platform Expansion** — Linux is only the first platform. Every decision below is validated against Windows, Linux, MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox and future platforms. |
| **Sources** | `docs/PROJECT_STATE.md` + `docs/CHANGELOG-SOLUTIONS.md` + `docs/reference/MOBILE-DESIGN-SPEC.md` (read in full, 2026-07-07) + direct code audit. Docs outrank code. |
| **Conflicts found** | None new. The 8 conflicts between earlier drafts and the documentation (agent has no WS channel; heartbeat is a 250 s global policy; no `agent/` work during the 2.1.5 rollout; "V3" framing; monitoring scope; vault vs `secret_cipher`; terminal is a brand-new feature; docs in English) were reported to the owner on 2026-07-07 and are resolved in this audit. Two items require **explicit owner approval** when their phase arrives: (a) the NPM WS route for the terminal channel (frozen proxy config), (b) the start date of any `agent/` work (rollout standing order). |

---

## 1. REUSED COMPONENTS — disposition of every existing module

Verdicts: **REUSE** (as-is) · **EXTEND** (additive only) · **REFACTOR**
(internal restructuring, behavior identical) · **REPLACE** (nothing qualifies).

| Module | Verdict | Reason |
|---|---|---|
| **Backend core** (FastAPI, router→service→repository→model, single worker, in-process scheduler/workers/publisher) | REUSE + EXTEND | Sound layering; expansion adds routers/services/tables in the same style. No new backend, no new framework. |
| **Frontend shell** (React/Vite/TS, tokens `--th-*`, premium classes, no component libs, one WS per page) | REUSE + EXTEND | Design language is a frozen asset; expansion adds capability-gated elements inside existing components only. |
| **Database** (PostgreSQL 15 prod, SQLite dev + `schema_compat_service`, manual SQL in prod) | EXTEND | Additive nullable columns + new tables only; no engine change, no restructuring of existing tables; manual-SQL discipline preserved (a fleet outage already taught this lesson). |
| **Windows Agent** (Go service, heartbeat loop, action dispatcher, script-free self-update, watchdog) | REUSE, later REFACTOR (internal) | Bit-identical during the 2.1.5 rollout (standing order). Afterwards: build-tag stubs (`_other.go`) formalized into PAL interfaces with the Windows path wrapping existing code verbatim — a compile-time restructuring, zero behavior change, verified by `go test` + SHA discipline (Windows binaries are not rebuilt outside a planned release anyway). |
| **Enrollment** (token model: hash/expiry/max_uses/client/group; audit; trusted domains; `/api/v1/agent/enroll` + legacy) | REUSE + EXTEND | Platform-agnostic already; `EnrollmentBootstrap.tsx` even has a `linux` platform option in code. Extension = per-platform generated commands + auto-placement. Endpoints frozen. |
| **Deployment** (GPO/NETLOGON bootstrap, combined MSI, UpgradeCode, CI MSI build) | REUSE | Windows deployment is untouched — it is the reference workflow. Other platforms get their own bootstrap (installer script / adapter), never modifying the Windows path. (Deployments *page* serves mock data today — noted, out of scope.) |
| **Packages** (manifest store, 3 file types, SHA-alignment, download endpoints) | EXTEND | Store and rules platform-neutral; `linux-amd64` already in the platform list. Extension = new file types/arches + platform tab. SHA-alignment stays law for every platform. |
| **Heartbeat** (250 s global policy, fast path + `_run_side_effects`, freshness 6/25 min, `pending_actions[]`) | REUSE + EXTEND | The universal device pipeline for all platforms. New request fields optional; response untouched; new parsing lives in side effects. The fast-path latency budget is a hard constraint. |
| **Remote Support** (branded RustDesk, per-device password via `secret_cipher`, self-healing, hbbs/hbbr keys) | REUSE | Untouched, including the password system. On non-Windows platforms it simply doesn't apply unless a GUI capability exists. RustDesk keys are disaster-critical. |
| **Dashboard** | EXTEND | Layout frozen; one added platform-distribution card + conditional KPI tiles in the existing quick-access pattern, only when a platform has devices. |
| **Device Tree** (flat `DeviceGroup` per client + presentation tree) | EXTEND | Structure frozen; platform sub-folders are presentation-level grouping first (no schema change); auto-grouping rules in §6/§13 of this doc. |
| **Device Drawer** (Overview, Remote Support, Management, Notes, Timeline) | EXTEND | The central device workspace for every platform; capability-gated tabs added beside the existing five; layout never forked per platform. |
| **Device Catalog** (DevicesTable, fixed columns) | EXTEND | No new columns; platform icon + per-platform cell content + a `platform` filter param. One table for all platforms — never per-platform tables. |
| **Device Details (mobile page)** | REUSE | Out of scope; changes require a MOBILE-DESIGN-SPEC amendment. |
| **Teams** | EXTEND | Teams + team-permissions become the substrate of the granular permission matrix; semantics of existing teams preserved. |
| **Permissions** (roles owner/admin/operator/readonly, operator scopes, `permission_service`) | EXTEND | Same enforcement surface; matrix adds granularity; existing roles map 1:1; Owner unrestricted by construction. |
| **Audit** (`audit_log` + enrollment audit) | EXTEND | Already the system of record; gains new event categories (vault use, terminal sessions, permission changes). Append-only discipline formalized. |
| **Authentication** (operator JWT; agent HMAC callback tokens; payload-based heartbeat identity) | REUSE + EXTEND | Operator auth unchanged. Heartbeat identity stays payload-based (documented design). New surfaces (terminal, vault) get *stricter* additive auth (tickets, per-device secret) without touching existing flows. |
| **WebSocket realtime** (`/ws/devices`, publisher, `build_event()`) | REUSE + EXTEND | Operator events for new platforms flow through the same publisher. The terminal's `/ws/agent` is a NEW parallel route, not a change to this one. |
| **Command Center / agent-commands** (bulk, progress, history) | EXTEND | Target-platform + engine params are additive; delivery stays `pending_actions[]`. |
| **Alert engine** | EXTEND (minimally) | Only basic availability/disk/critical-service rules for new platforms — the Zabbix boundary (§5) caps this. |
| **REPLACE** | — | **Nothing.** No existing module is replaced. |

## 2. EXPANDED COMPONENTS — current → expanded shape

| Module | Current | Expanded (capability-gated, flag-gated) |
|---|---|---|
| **Device Drawer** | Overview · Remote Support · Management · Notes · Timeline | same five **+** per capability: Services · Packages · Docker · Storage · Network/Interfaces · Logs · SSH/Terminal (tab absent when capability absent; Remote Support absent when no GUI) |
| **Device model** | Windows-centric columns, `platform` string | + nullable: fqdn, kernel_version, architecture, mac_address, timezone, last_boot_at, capabilities JSON; `platform` value set (absent ⇒ windows) |
| **Device Tree** | Client → groups → devices | Client → groups → **platform sub-folders** → devices (Servers▸Windows/Linux; Network▸MikroTik; Storage▸Synology/QNAP; Hypervisors▸VMware/Hyper-V/Proxmox; Client PCs▸Windows/Linux) |
| **Device Catalog** | fixed columns, Windows rows | same columns; rows of any platform (OS cell: distro+kernel / RouterOS+model / DSM+model; Domain "—" where N/A) |
| **Enrollment** | token CRUD + Windows GPO target + (dormant) platform select | platform select active: per-platform generated command (curl/wget one-liner, future .deb/.rpm repos) + automatic Client→Group→platform-folder placement |
| **Packages** | msi / agent_binary / agent_update_msi | + `agent_binary_linux_{amd64,arm64,…}` (tar.gz + SHA + signature), platform tabs, channel metadata (canary/stable/pinned) on the existing manifest |
| **Agent Config** | global heartbeat policy + Windows rollout script | + platform selector; shared policy unchanged; platform sections render from the registry (Windows: PowerShell/Registry/Winget · Linux: systemd/APT/Docker/critical services · MikroTik: RouterOS/interfaces) |
| **Command Center** | bulk commands to Windows agents | + Target (All/Windows/Linux/Selected) + Engine (Auto/PowerShell/CMD/Bash/BusyBox/Python), Auto resolved per device from capabilities; devices lacking the forced engine are skipped with a reason |
| **Dashboard** | fleet KPIs, quick access, fleet health | + Infrastructure Overview card (platform distribution, rows appear from registry) + per-platform KPI tiles (only when devices exist) |
| **Alerts** | Windows-derived rules | + platform icon on rows; + basic rules per platform (offline, disk, critical service). Nothing deeper (Zabbix boundary) |
| **Teams/Permissions** | roles + teams + scopes | + permission matrix (granular, per-domain: devices/connect/packages/vault/audit/settings…), custom roles, session listing; existing roles are seed data |
| **Audit** | operator actions, enrollment audit | + vault usage, terminal sessions (start/end/duration), permission changes, per-platform device actions — same tables/pattern, new event types |

## 3. NEW MODULES

| Module | Purpose | Dependencies | Owner (layer/branch) | Risk |
|---|---|---|---|---|
| **Platform Core** (adapter contract + capability gating) | The only shared platform code: defines the adapter interface backend-side and the PAL interfaces agent-side; everything platform-specific plugs into it | none (Phase 1, dark) | backend `services/platform_adapters/`; agent `pal/` (post-rollout) | LOW dark / HIGH if extraction changes Windows behavior → golden tests |
| **Platform Registry** | Data: known platforms, mode (native/proxy), icon, connect methods, config sections | Platform Core | backend seed table + small service | LOW |
| **Capability Registry** | Controlled vocabulary of capabilities + per-device reported set (JSON on device) | Platform Core; heartbeat side-effects | backend | LOW–M (wrong capability ⇒ wrong tab — refresh each heartbeat, show "last verified") |
| **Linux Agent** | First native non-Windows agent: enroll, heartbeat, inventory, commands, updates, terminal endpoint | Platform Core (agent PAL); packages store; enrollment | `agent/` on a dedicated branch; **build/merge only after 2.1.5 rollout closes** | M — new fleet member; canary-first |
| **Credential Vault** | Encrypted secrets (password/SSH key/API token/SNMP/Winbox/cert), scopes Global→Client→Group→Device, use-vs-reveal, rotation, usage audit | new `vault_cipher` (AES-256-GCM envelope); IAM permissions; audit | backend + minimal UI | HIGH value target → key outside DB/repo, audit every access; **fully separate from the RS-password system** |
| **Terminal Gateway** | Relay operator xterm.js ↔ agent PTY over a NEW optional agent WS channel (`/ws/agent`); tickets, idle timeout, audit, recording | Linux Agent; Vault (for SSH mode); NPM WS route (**owner approval**) | backend (in-process, flagged) | HIGH — new realtime surface on a single-worker backend → connection caps, backpressure, documented extraction path |
| **SSH Connector** | SSH client capability used by the gateway (device SSH via tunnel) and by future adapters; credentials referenced from Vault only | Terminal Gateway; Vault | backend | M — host-key pinning (TOFU), never credentials in browser |
| **MikroTik Adapter** (future) | Proxy agent speaking RouterOS API → same enroll/heartbeat contract | Platform Core; Vault; Registry | new small Go service (customer-side) | M — adapter host is a per-client dependency; alert when proxy offline |
| **Storage Adapter — Synology/QNAP** (future) | DSM/QTS APIs → contract (volumes, SMART basics, packages) | same as above | proxy adapter | M |
| **Hypervisor Adapter — VMware/Hyper-V/Proxmox** (future) | vCenter/WMI/PVE APIs → contract (hosts, VMs inventory) | same as above | proxy adapter | M |

## 4. NEVER CHANGE — the definitive list, with reasons

| # | Frozen item | Why |
|---|---|---|
| 1 | **Device identity chain** (agent_id → device_id → rustdesk_id → fingerprint scorer) and existing device IDs | Identity survives re-enrollment and disasters; every history table hangs off `device_id`. Breaking it orphans 750 devices' history. |
| 2 | **Enrollment endpoints** (`/api/v1/agent/enroll` + legacy `/api/enroll`) and token semantics | Burned into NETLOGON scripts and MSI properties on customer domains; unreachable to fix quickly if broken. |
| 3 | **Windows deployment chain** (GPO/NETLOGON bootstrap, combined MSI, **UpgradeCode**, SHA-alignment) | The changelog documents weeks of incident-driven hardening (AV/AMSI, WS2016, 1603s, the 253-device outage). It works; it is not to be re-litigated. |
| 4 | **Heartbeat API** (request/response contract, `pending_actions[]` format, optional-only additions) | Fleet-wide hot path; v1.0 agents must keep working; the response drives interval/password/update — a break is a fleet outage. |
| 5 | **Windows Agent** behavior, service name `TechiAgent`, config path; **no `agent/` edits during the active 2.1.5 rollout** | Standing order; mixed-version fleet mid-rollout is maximally fragile. |
| 6 | **Remote Support system** — RustDesk server keys, per-device password flow, `secret_cipher` usage | Keys: losing them breaks remote support fleet-wide (every endpoint pins the pubkey). Password system: live security feature mid-rollout; the new Vault is fully separate by design. |
| 7 | **Device Tree structure & operator workflows** | Operators' daily muscle memory across ~750 devices; expansion adds folders, never moves anything. |
| 8 | **Dashboard layout** | Same reason; additions only, in existing card patterns. |
| 9 | **Authentication** (operator JWT, role semantics owner/admin/operator/readonly, scopes) | Every operator session and permission gate depends on it; IAM matrix builds on top, mapping 1:1. |
| 10 | **Current API** — no breaking change to any existing endpoint's request/response; no `/api/v2` | Agents, NETLOGON scripts, and the frontend all pin v1 paths; additive evolution is sufficient (see §9). |
| 11 | **Current database** — no column drops/renames/type changes, no index drops without owner approval, no engine change; retention (7d) unchanged | Manual-SQL prod + Alembic fork make destructive changes maximally dangerous; a missing column already caused a fleet-wide 500 outage once. |
| 12 | **Current UI with flags off** — bit-identical rendering, zero new requests | The core promise of this whole program: 750-device production must not feel the expansion until each flag is deliberately turned on. |
| 13 | **Packages SHA-alignment procedure** | Go builds are not reproducible; violating it breaks "Needs Agent Update" fleet-wide. |
| 14 | **NPM proxy config** (and "Cache Assets" unticked) without explicit approval | Frozen by standing order; UI edits regenerate the conf. |
| 15 | **Freshness thresholds** (6/25 min), **heartbeat fast-path latency budget**, **global interval policy mechanism** | Scale-tested constants and mechanics (the 60 s CPU incident is the precedent). |
| 16 | **Two-document documentation standard** | Owner's permanent rule; this audit itself will generate its entries upon approval. |
| 17 | **MOBILE-DESIGN-SPEC locks** (mobile UI untouched by this program) | Design-locked contract; amendments only. |

## 5. LINUX AGENT BOUNDARY

**The Linux Agent DOES** (and this list defines *every* future platform's scope):
enrollment (token, automatic) · heartbeat (250 s global policy; basic facts:
hostname, distro/version, kernel, arch, CPU, RAM, disk, IPs, MAC, uptime,
users, basic services, docker presence) · inventory (on-demand/interval
sections, collect flags default OFF) · commands (`pending_actions[]`, bash
engine) · self-updates (SHA-verified, package store) · terminal endpoint
(PTY over the new optional channel, flagged) · deployment (installer
one-liner).

**The Linux Agent DOES NOT** (stays in Zabbix): continuous monitoring ·
alerting beyond basic offline/disk/critical-service · fine-grained metrics ·
performance analytics · long-term history · dashboards of metric series.
Concretely: no new time-series tables, no sub-heartbeat sampling, no
threshold engine growth beyond the basic rule set. TECHI answers *"what is
this device and let me manage it now"* — not *"how has it behaved over time."*

## 6. PLATFORM MATRIX

| Platform | Native Agent | Bootstrap Script | Adapter | Remote Method | Deployment | Inventory | Commands | Terminal |
|---|---|---|---|---|---|---|---|---|
| **Windows** | ✅ TechiAgent (live) | GPO/NETLOGON + MSI | — | TECHI Remote Support | GPO (live) | ✅ (live) | ✅ PowerShell/CMD (live) | ❌ today; optional later via same gateway |
| **Linux** | ✅ techi-agent (new) | `curl\|bash` / `wget\|bash` + token | — | Web Terminal · Desktop SSH · (RustDesk if GUI) | installer script → systemd | ✅ basic + docker/services | ✅ Bash/BusyBox | ✅ PTY via agent channel |
| **MikroTik** | ❌ | — | ✅ proxy (RouterOS API) | Winbox · WebFig · SSH · console | adapter config | interfaces/firewall basics | RouterOS scripts (gated) | ✅ via adapter |
| **Synology** | ❌ (possible later) | — | ✅ proxy (DSM API) | DSM web · SSH | adapter config | volumes/SMART basics | limited (gated) | SSH via adapter |
| **QNAP** | ❌ | — | ✅ proxy (QTS API) | QTS web · SSH | adapter config | volumes basics | limited | SSH via adapter |
| **VMware** | ❌ | — | ✅ proxy (vCenter API) | vSphere UI (link) · SSH (ESXi, gated) | adapter config | hosts/VMs list | restricted | limited |
| **Hyper-V** | ⚠ via Windows agent on host | GPO (host is Windows) | optional WMI adapter | Remote Support (host) | existing GPO | VMs list via host agent | PowerShell (existing) | n/a |
| **Proxmox** | ❌ (Debian host: Linux agent possible) | Linux one-liner on host | ✅ PVE API adapter | Web UI (link) · SSH | Linux path or adapter | nodes/VMs list | Bash on host | ✅ (Linux path) |
| **Future** | per platform | per platform | default path | from registry | from registry | contract-defined | capability-gated | capability-gated |

## 7. PLATFORM ISOLATION

**Rule**: no platform may depend on another. Windows never depends on Linux;
Linux never on MikroTik; MikroTik never on Synology; etc. **Only Platform
Core is shared** (contract, registry, capability gating, the generic
enroll/heartbeat/packages/commands pipeline).

**Does the current architecture support this? Yes, with one Phase-1 action:**

- **Agent (compile-time)**: Go build tags already give hard isolation — a
  Windows binary contains zero Linux code and vice versa. The PAL refactor
  preserves this (interfaces in a shared `pal/` package = Platform Core;
  implementations per build tag). ✅ supported today.
- **Backend (runtime)**: today platform-specific behavior is implicit
  ("everything is Windows") inside shared services — that is the one place
  isolation does not exist yet. The Phase-1 adapter extraction creates it:
  services call the adapter registry; the Windows adapter is existing logic
  moved verbatim; a Linux adapter bug cannot alter the Windows path because
  dispatch is by the device's platform value. ⚠ created in Phase 1.
- **Frontend**: capability-gating means no platform knows about another;
  removing a platform's flag removes its UI without a trace. ✅ by design.
- **Proxy adapters**: separate processes per platform family — process-level
  isolation; one adapter down affects only its devices (alert on adapter
  offline). ✅ by design.
- **Shared-fate caveat (honest)**: all platforms share one backend, one DB,
  one VPS. Isolation is at the code/dispatch level, not infrastructure level
  — a backend outage affects every platform. That is today's reality for
  Windows alone and is unchanged by the expansion (see §14).

## 8. DATABASE IMPACT

**No big migrations. No restructuring. Additive only.**

| Category | Detail |
|---|---|
| New tables | `platform_registry` (small, seeded) · `vault_credentials` + `vault_credential_usage` · `terminal_sessions` · `iam_permissions` + `iam_role_permissions`. All outside the heartbeat fast path; narrow indexes from day one. |
| New columns (nullable, on `devices`) | `fqdn`, `kernel_version`, `architecture`, `mac_address`, `timezone`, `last_boot_at`, `capabilities` (JSONB). Absence of `platform` value ⇒ windows (no backfill). |
| Untouched | every existing table's existing columns; heartbeats/telemetry retention; all existing indexes (no drops without approval — pre-existing rule); `device_inventory` schema (new JSON sections ride the existing payload column). |
| Migration strategy | per phase: hand-written SQL block (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS`) recorded in the phase's changelog entry, applied **before** deploy (Deploy Process step 4); matching `ensure_sqlite_dev_schema` additions in the same commit; inverse SQL recorded alongside; Alembic optionally `stamp`-ed, never `upgrade heads` (two-head fork). |
| Growth control | Linux inventory JSON capped/summarized; vault and terminal tables are low-volume; monitor DB size at each phase gate (25 GB disk is structurally tight). |

## 9. API IMPACT

- **Existing endpoints**: zero breaking changes. Optional request fields on
  enroll/heartbeat; no response shape changes anywhere; legacy compat routes
  untouched.
- **New endpoints** (same `/api/v1` style, each flag-gated):
  `GET /install/linux` (installer script) · `GET /agent-packages/platform/
  linux-{arch}/download` (existing pattern) · vault CRUD + `POST …/reveal` ·
  `POST /devices/{id}/terminal/sessions` (ticket) · registry/capability
  reads folded into existing device responses · optional `target_platform`/
  `engine` params on existing agent-commands.
- **New WS route** `/ws/agent` (Phase 4) — parallel to `/ws/devices`, never a
  modification of it.
- **Versioning**: stay on v1, additive-only. No `/api/v2` — nothing justifies
  it, and dual-version maintenance is a cost with no consumer. If a future
  platform ever requires an incompatible shape, that is a new endpoint, not a
  new version tree.
- **Windows guarantee**: Windows agents call exactly the same endpoints with
  exactly the same payloads before and after every phase.

## 10. SECURITY IMPACT

| Area | Position |
|---|---|
| **RS Password system** | **Untouched, by contract.** `secret_cipher.py`, delivery in heartbeat responses, version-gated fallback — all frozen. |
| **Credential Vault** | Fully separate new subsystem: new tables, new `vault_cipher` (AES-256-GCM envelope: master key file outside repo/DB, 0400, in the existing config-backup tar; DEK per credential). Scopes Global→Client→Group→Device; `use` vs `reveal` as distinct permissions; reveal requires reason + is audited + notifies admins; rotation via key re-wrap; connection testing with host-key pinning (TOFU). |
| **SSH** | Credentials only ever referenced from the Vault; never stored on the device row, never sent to the browser; SSH traffic flows through the agent tunnel/gateway — zero inbound ports on customer networks. |
| **API tokens** (adapters, future) | Vault-stored, scoped, rotated; adapters authenticate to vendor APIs locally, never proxying raw secrets through the browser. |
| **Enrollment tokens** | Existing model reused (hashed at rest, expiry, max_uses, audit). Linux guidance: short-lived low-max-use tokens (the NETLOGON plaintext-token lesson). |
| **Terminal sessions** | One-time tickets (TTL 60 s) minted by authenticated operators holding the terminal permission; agent side authenticates with a per-device secret issued at enroll (additive optional field); idle timeout; kill switch; every session audited (operator, device, start/end, duration) + optional recording per client policy. |
| **Audit trail** | New event categories on the existing audit spine; append-only (no UPDATE/DELETE paths); export permission separate from view. |
| **Session logging** | Operator session listing (IP, agent, last activity) + terminate — built on existing JWT infrastructure. |
| **Heartbeat identity** | Stays payload-based (documented design decision) — unchanged for all platforms; stricter auth applies only to the *new* surfaces. |

## 11. FEATURE FLAGS

Env-driven booleans in `core/config.py`, set via `.env`. **Default OFF. Flag
OFF ⇒ the system behaves BIT-IDENTICAL to today** — enforced by flag-off
snapshot/behavior tests (no new DOM, no new requests, no new SQL) at every
phase gate.

| Flag | Gates | Depends on |
|---|---|---|
| `FEATURE_PLATFORM_CORE` | adapter registry dispatch, capabilities parsing (dark plumbing) | — |
| `FEATURE_LINUX` | Linux enrollment generator, Linux UI surfaces, Linux packages tab | PLATFORM_CORE |
| `FEATURE_VAULT` | vault API + UI | PLATFORM_CORE |
| `FEATURE_TERMINAL` | `/ws/agent` route, ticket endpoint, drawer terminal tab | LINUX (first consumer), VAULT (SSH mode) |
| `FEATURE_MIKROTIK` | MikroTik adapter acceptance + UI surfaces | PLATFORM_CORE, VAULT |
| `FEATURE_STORAGE` | Synology/QNAP adapters + surfaces | PLATFORM_CORE, VAULT |
| `FEATURE_HYPERVISOR` | VMware/Hyper-V/Proxmox adapters + surfaces | PLATFORM_CORE |

Frontend reads flags via one additive read-only endpoint; UI renders nothing
for OFF flags. Flags are env-only (no DB flags) — consistent with the
file-backed-policy precedent and single-server topology. A flag is retired
only after its feature reaches GA with owner approval.

## 12. IMPLEMENTATION ORDER

Every phase: owner approval to start → build → tests → canary → deploy per
the existing Deploy Process (schema-first SQL) → PROJECT_STATE +
CHANGELOG-SOLUTIONS entries in the same task → owner approval to close.
**No two phases in parallel.**

| Phase | Objective | Deliverables | Rollback | Testing | Deployment |
|---|---|---|---|---|---|
| **0** | Approve this audit as baseline | this doc approved; two-doc entries; flags scaffold decision | n/a | n/a | none |
| **1 — Platform Core (dark)** | Backend isolation layer with zero behavior change | adapter registry + Windows adapter (logic moved verbatim); `platform`/`capabilities` columns; flag plumbing; SQL block applied | flag off (inert by construction) + revert; inverse SQL recorded | golden request/response tests on heartbeat/devices before vs after; full suite; flag-off snapshots | normal deploy; no agent, no UI change |
| **2 — Linux Agent MVP** | First Linux device managed end-to-end | `pal/` interfaces + `platform_linux.go`; systemd unit; installer endpoint; linux package type | remove Linux packages + disable FEATURE_LINUX; Windows untouched by construction | `go test ./...` both GOOS; canary: 2–3 internal Linux hosts for ≥1 week | **starts only after 2.1.5 rollout closes (owner confirms)**; Windows binaries not rebuilt |
| **3 — Linux UI integration** | Linux feels native in existing UI | PlatformIcon; tree sub-folders + auto-grouping; OS cells; drawer capability tabs; enrollment generator; packages tab; command engine | FEATURE_LINUX off → UI reverts to today | `tsc --noEmit`; flag-off snapshot diff = empty; Playwright sweep desktop (mobile untouched) | frontend-only deploy |
| **4 — Credential Vault** | Enterprise secrets, fully separate from RS password | vault tables + `vault_cipher` + API + minimal UI; usage audit | FEATURE_VAULT off; tables inert; inverse SQL | crypto round-trip + permission tests; reveal audit verified | schema-first SQL; backend deploy |
| **5 — Terminal** | Web terminal in the drawer via new agent channel | `/ws/agent` + ticket endpoint + relay; agent PTY (agent change → after rollout, with Phase 2 branch); xterm tab; session audit | FEATURE_TERMINAL off; NPM route removable; agents ignore absent channel | load test WS relay on staging (connection cap); security review of ticket flow | **NPM WS route needs explicit owner approval**; backend + agent deploy |
| **6 — IAM matrix** | Granular permissions, sessions | matrix tables + service + Access page tabs; 1:1 role migration; session manager | FEATURE_IAM_V2 off → legacy checks (dual-read kept until GA) | permission-matrix test grid; no-lockout invariant (owner bypass) | backend + frontend deploy |
| **7 — MikroTik pilot** | Prove the proxy-adapter pattern | RouterOS proxy adapter; registry entry; Winbox/SSH connect via vault | FEATURE_MIKROTIK off; adapter stopped | adapter contract tests; 1 client pilot | adapter runs customer-side; backend flag deploy |
| **8+** | Storage → Hypervisors → future | one platform per phase, adapter pattern, demand-driven | per-flag | per-pattern | per-pattern |

## 13. RISK ANALYSIS (per phase)

| Phase | Risk | P | Impact | Mitigation | Rollback |
|---|---|---|---|---|---|
| 1 | Adapter extraction subtly changes Windows behavior | M | CRITICAL | logic moved verbatim; golden tests on live-shaped payloads; canary client watch | revert commit; flag off; inverse SQL |
| 1 | New columns slow the heartbeat fast path | L | HIGH | columns nullable & unread on fast path; parsing in side effects; timing before/after | revert; columns remain inert (no drop needed) |
| 2 | Linux agent misbehaves (beat storms, bad payloads) | M | M | client-side backoff exists in pattern; server clamps; canary cap (≤3 devices); payload validation | uninstall canaries; flag off |
| 2 | Shared `agent/` repo work destabilizes Windows source | M | HIGH | separate branch until rollout closes; Windows binary never rebuilt as side effect (SHA-alignment); `go build` both GOOS in CI | branch isolation |
| 3 | UI regressions on desktop for Windows operators | M | HIGH | flag-off snapshot equality; capability-gating renders nothing for Windows-only fleets until Linux devices exist | flag off |
| 4 | Vault key loss / compromise | L | CRITICAL | key in config-backup tar (existing DR path); re-wrap rotation; reveal audit + notify | secrets re-enterable; system inert when off |
| 5 | WS relay overloads single-worker backend | M | HIGH | connection cap + backpressure; idle timeout; staging load test; documented extraction option (separate process) pre-approved as fallback | flag off — channel refuses connections |
| 5 | NPM change breaks frozen edge config | M | HIGH | explicit owner approval; change scripted + reversible; verify heartbeat locations untouched | restore NPM conf |
| 6 | Permission migration locks out operators | M | HIGH | 1:1 mapping; dual-read; owner-bypass invariant tested | flag off → legacy checks |
| 7 | Customer-side adapter becomes unmonitored SPOF | M | M | adapter heartbeats like a device; offline alert | adapter is per-client; stop process |
| all | Disk pressure on 25 GB VPS | M | M | size gate at every phase close; caps on inventory JSON; existing retention untouched | prune new data (new tables only) |
| all | Scope creep toward monitoring | H | M | §5 boundary is contractual; any metric-series request → Zabbix | n/a |

## 14. FINAL VALIDATION — Architecture Readiness

| Question | Verdict | Honest justification |
|---|---|---|
| **Scalable?** | ✅ architecturally / ⚠ infrastructurally | The pipeline (stateless-ish beat processing, additive columns, adapter dispatch) scales by design. The *deployment* is one VPS, one uvicorn worker, one Postgres — that is today's constraint for Windows alone; the expansion adds no new bottleneck (terminal is the only stateful addition, capped + extractable). |
| **Maintainable?** | ✅ | One codebase, one UI, one contract; platform code isolated by build tags (agent), adapter registry (backend), capability gating (frontend). Adding a platform touches a bounded, known set of places. |
| **Enterprise-ready?** | ✅ after Phases 4–6 | Vault (real AES-GCM, scoped, audited), granular IAM, session management, immutable audit are exactly the enterprise gaps; they are in the plan as isolated, flagged subsystems. |
| **Backward compatible?** | ✅ by construction | Frozen contracts (§4), optional-only fields, flag-off bit-identity, v1-only API, Windows agents untouched. This is the strongest property of the plan. |
| **Suitable for the next 5+ years?** | ✅ | The capability/adapter contract is platform-count-agnostic; new platforms are data + adapters, not redesigns. The two decisions that would age badly (per-platform UIs, `if platform ==` branching) are explicitly banned. |
| **Suitable for 10,000+ devices?** | ⚠ not on today's infrastructure — but the architecture does not block it | 10k × 250 s ≈ 40 beats/s vs ~3 today. Required steps are infrastructure, not redesign: bigger host / managed Postgres, multiple workers (needs the publisher/scheduler to move out-of-process — a known, bounded change), heartbeat storage redesign (proposal already exists, unimplemented). Nothing in this expansion makes that harder; the adapter/capability model is unaffected by fleet size. |
| **Suitable for many platforms?** | ✅ | §6 matrix + §7 isolation: native agents where justified (Windows, Linux, Mac), proxy adapters everywhere else, one shared contract. MikroTik pilot (Phase 7) is the proof gate before scaling the pattern. |
| **Suitable for MSP enterprise?** | ✅ direction, with two honest gaps | Multi-client scoping, RBAC, audit, vault and per-client policies fit MSP needs. Gaps to state plainly: (a) single-tenant single-server topology (no per-MSP isolation) — acceptable for TECHI's own operation, a future decision if the platform is ever sold to other MSPs; (b) DR has never been rehearsed and backups have no offsite copy (pre-existing, documented in PROJECT_STATE) — worth fixing independently of this program. |

**Bottom line**: the architecture is ready. The platform is closer to
multi-platform than it appears — `Device.platform`, the enrollment platform
selector, `linux-amd64` in packages, and agent build-tag stubs already exist.
The expansion is disciplined wiring plus three isolated new subsystems
(Vault, Terminal channel, IAM matrix), all dark-launched behind default-off
flags, sequenced so that the Windows fleet is mathematically untouched until
each flag is turned on. Recommended: approve Phase 0 and 1; hold Phase 2
until the 2.1.5 rollout formally closes.

---

## Progress Log

| Date | Event |
|---|---|
| 2026-07-06 | Draft V1 (Linux Support) + mockups v1; superseded |
| 2026-07-06 | Mockups v2 rebuilt against the real frontend; superseded in part |
| 2026-07-07 | Draft "V3" + mockups v3 (17 screens); framing superseded |
| 2026-07-07 | Full documentation read before code conclusions (owner's order); 8 draft-vs-docs conflicts reported and corrected; file rewritten as the Platform Expansion contract |
| 2026-07-07 | **This FINAL ARCHITECTURE AUDIT** — 14 chapters per owner's specification (component disposition, expansions, new modules, never-change list, Linux boundary, platform matrix, isolation analysis, DB/API/security impact, feature flags, phased roadmap with rollback/testing/deployment, per-phase risks, Architecture Readiness). No new conflicts with documentation or the LIVE platform found; two explicit owner-approval gates flagged (NPM WS route; `agent/` work start). |
| 2026-07-07 | ✅ **APPROVED by the owner** as the official implementation baseline. Per owner's instruction, no section was modified; Appendices A–C (Definition of Done, Regression Matrix, Platform Certification) appended below as enterprise standards for every implementation phase. |
| 2026-07-07 | 🔒 **DESIGN LOCKED** by the owner. File renamed `LINUX-AGENT-DESIGN-SPEC.md` → `PLATFORM-EXPANSION-AUDIT.md`; ARCHITECTURE STATUS banner added; Two-Doc entries written (PROJECT_STATE.md + CHANGELOG-SOLUTIONS.md). Implementation strategy: one phase at a time, hard stop + owner approval between phases. **Phase 0 (Platform Core Foundation: feature flags infrastructure, Platform Registry, Capability Registry — dark, flags OFF = bit-identical) started.** Linux implementation (any `agent/` work) remains postponed until the Windows Agent 2.1.5 rollout is officially completed. |

---

# APPENDIX A — DEFINITION OF DONE

The standard Definition of Done for **every** implementation phase of the
Platform Expansion. A phase is **COMPLETE** only when every item below is
true, with evidence. If any item fails or is skipped, the phase remains
**OPEN** — no exceptions, no partial closes, and the next phase cannot start
(§12 rule: no two phases in parallel).

| # | Criterion | What counts as evidence |
|---|---|---|
| 1 | **Architecture approved** | The phase's scope matches this audit; any deviation was approved by the owner in writing *before* implementation |
| 2 | **Implementation completed** | All deliverables of the phase (§12 table) exist; no TODO/FIXME/placeholder in shipped code |
| 3 | **Unit tests passed** | Backend: `pytest` green (only the 4 known pre-existing failures in `test_enrollment_audit_diagnostics.py` allowed); Agent: `go vet` + `go test ./...` green for **both** GOOS targets |
| 4 | **Integration tests passed** | Endpoint-level tests of the new/extended API paths green, including flag-ON and flag-OFF runs |
| 5 | **Playwright tests passed** | UI sweep of the touched routes green against a production build; zero 4xx/5xx in a clean sweep (Mobile UI 2.0 deploy precedent) |
| 6 | **Manual verification passed** | The phase's feature exercised end-to-end by a human on canary device(s)/client, documented with what was clicked and what was observed |
| 7 | **Windows regression passed** | Full Appendix B matrix executed and green |
| 8 | **No performance regression** | Heartbeat fast-path timing measured before/after on like-for-like load: no measurable degradation; DB size delta reviewed against the 25 GB budget |
| 9 | **Documentation updated** | This document's Progress Log + any affected reference doc updated in the same task |
| 10 | **PROJECT_STATE updated** | Current-state changes recorded in `docs/PROJECT_STATE.md` in the same task (two-doc standard) |
| 11 | **CHANGELOG updated** | `docs/CHANGELOG-SOLUTIONS.md` entry in the standard format (Problemi/Analiza/Shkaku/Zgjidhja/Ndryshimet/Rezultati/Mësimet), including the phase's applied SQL **and its inverse** |
| 12 | **Rollback procedure verified** | The phase's rollback (flag off / revert / inverse SQL) actually executed once on a non-prod environment and confirmed to restore prior behavior |
| 13 | **Production deployment successful** | Deploy Process steps 1–9 followed (schema-first SQL, `/root`, `--ff-only`, health checks); all containers healthy |
| 14 | **Production smoke test passed** | Post-deploy: `/health` 200, heartbeats flowing at normal rate, no error burst in backend logs, one full operator login → Dashboard → Devices → Drawer walk-through clean |

Phase closure is declared by the owner, not by the implementer.

# APPENDIX B — REGRESSION MATRIX

The official regression checklist executed **before every production
deployment** of the Platform Expansion (and re-verified after deploy where
marked ↺). Windows behavior is the reference implementation — any ❌ blocks
the deploy. Copy this table into the phase's changelog entry and fill it in;
Status: ☐ pending / ✅ pass / ❌ fail.

| # | Area | What is verified | Status | Owner | Result | Notes |
|---|---|---|---|---|---|---|
| 1 | Windows Enrollment | Token enroll of a fresh device lands in the right Client/Group; enrollment audit row written | ☐ | | | |
| 2 | Windows Deployment | GPO/NETLOGON bootstrap on a test domain machine installs/repairs correctly; MSI download endpoint serves the active package | ☐ | | | |
| 3 | Windows Heartbeat ↺ | Beats accepted at the policy interval; response carries interval/password/pending_actions; freshness transitions correct | ☐ | | | |
| 4 | Windows Commands | A bulk command executes; progress/history/output visible; role gates enforced (run_powershell owner-only) | ☐ | | | |
| 5 | Windows Packages | SHA-alignment intact: "Needs Agent Update" count unchanged; self_update on one canary works | ☐ | | | |
| 6 | Remote Support ↺ | Connect from a device row works; per-device password flow intact; RustDesk self-heal untouched | ☐ | | | |
| 7 | Dashboard | KPIs, quick access, fleet health render with live data; no new cards with flags off | ☐ | | | |
| 8 | Devices (Catalog + Tree) | Tree groups, filters, search, table columns unchanged; row click opens drawer | ☐ | | | |
| 9 | Device Details (Drawer + mobile page) | Desktop drawer tabs (Overview/RS/Management/Notes/Timeline) intact; mobile `/devices/:id` untouched | ☐ | | | |
| 10 | Alerts | Alert list/counts consistent (single number everywhere); dismiss with UNDO works | ☐ | | | |
| 11 | Notifications | NotificationCenter renders; WS-driven updates arrive | ☐ | | | |
| 12 | Authentication | Login/logout, JWT expiry, change password; role visibility (sidebar items per permission) | ☐ | | | |
| 13 | Permissions | Operator scopes (client/group) filter devices; team permissions enforced; readonly cannot act | ☐ | | | |
| 14 | Audit | New actions appear in Audit Log; enrollment audit intact | ☐ | | | |
| 15 | API | `/api/v1/docs` loads; legacy compat routes (`/api/heartbeat`, `/api/enroll`) respond; no response-shape diffs on existing endpoints (contract tests) | ☐ | | | |
| 16 | Agent Config | Policy read/write (admin+); interval propagates on next beat; rollout script endpoint serves | ☐ | | | |
| 17 | Command Center | Panel loads, confirmation gate works, live progress renders | ☐ | | | |
| 18 | Packages (page) | Upload/activate/download per file_type; manifest consistent | ☐ | | | |
| 19 | WebSocket realtime ↺ | `/ws/devices` connects; events scoped per role; polling fallback engages when WS blocked | ☐ | | | |
| 20 | Mobile UI smoke | BottomNav 4 tabs, Dashboard/Devices/Alerts/More render <768px (design-locked — must be untouched) | ☐ | | | |
| 21 | Flag-off bit-identity | With all expansion flags OFF: UI snapshot diff empty, no new network calls, no new SQL on the hot path | ☐ | | | |
| 22 | Infrastructure ↺ | Containers healthy, DB size within budget, backend log free of new error patterns, backup cron intact | ☐ | | | |

Rows 1–6 require a real Windows test device; rows marked ↺ are re-checked
post-deploy as part of the production smoke test (DoD #14).

# APPENDIX C — PLATFORM CERTIFICATION

The official maturity model and certification process for **every** platform
(Linux, MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox, and all future
platforms). A platform advances one stage at a time; each promotion requires
**all mandatory requirements** of the target stage plus owner sign-off.
Demotion is always allowed (a Stable platform with a critical defect returns
to Pilot; its flag scope shrinks accordingly).

## Stages

```
Experimental → Internal → Pilot → Stable → LTS
```

| Stage | Meaning | Flag scope | Devices allowed |
|---|---|---|---|
| **Experimental** | Code exists behind its flag; contract compliance in dev only | dev/staging only | 0 production |
| **Internal** | Runs on TECHI's own infrastructure | prod flag ON for internal client only | internal devices only |
| **Pilot** | One consenting customer, bounded fleet | prod flag ON for named pilot client(s) | agreed pilot cap |
| **Stable** | General availability for all clients | prod flag ON globally | unlimited |
| **LTS** | Committed long-term support; protocol/fields of this platform join the frozen-contract discipline | flag retired (code permanent) | unlimited |

## Mandatory requirements (the certification checklist)

A platform must satisfy every row before promotion to the stage indicated
(✔ = must be true from that stage onward).

| Requirement | Verified as | Internal | Pilot | Stable | LTS |
|---|---|---|---|---|---|
| **Auto Enrollment** | token one-liner/adapter registers the device with zero manual backend steps | ✔ | ✔ | ✔ | ✔ |
| **Auto Classification** | platform + server/desktop role detected from reported facts, no operator input | ✔ | ✔ | ✔ | ✔ |
| **Auto Grouping** | device lands in Client → Group → platform folder automatically (never "No client") | ✔ | ✔ | ✔ | ✔ |
| **Inventory** | Mission-scope facts reported and rendered in the existing Catalog/Drawer | ✔ | ✔ | ✔ | ✔ |
| **Remote Access** | at least one connect method working end-to-end via Vault (no plaintext credentials) | — | ✔ | ✔ | ✔ |
| **Command Center** | platform's engine executes with live output, exit code, history, role gates | — | ✔ | ✔ | ✔ |
| **Deployment** | install/update path documented + rollback proven (agent self-update or adapter redeploy) | — | ✔ | ✔ | ✔ |
| **Audit** | every platform action (enroll, command, connect, credential use) produces audit rows | ✔ | ✔ | ✔ | ✔ |
| **Permissions** | platform surfaces respect roles/scopes/matrix; no bypass paths | — | ✔ | ✔ | ✔ |
| **Feature Flags** | platform fully dark when its flag is OFF (bit-identity test green) | ✔ | ✔ | ✔ | ✔ |
| **Production Validation** | Appendix A DoD closed + Appendix B matrix green for the promoting deploy; for Stable: ≥ 30 days at Pilot with no Sev-1; for LTS: ≥ 90 days at Stable + DR/restore path documented | — | ✔ | ✔ | ✔ |

## Certification record

Each promotion is recorded in CHANGELOG-SOLUTIONS.md (standard entry format)
and reflected in PROJECT_STATE.md (platform + stage), plus one row here:

| Platform | Current stage | Promoted on | Approved by | Evidence (changelog entry) |
|---|---|---|---|---|
| Windows | **LTS** (reference implementation, grandfathered) | 2026-07-07 (baseline) | owner | this audit, §1 |
| Linux | Experimental (upon Phase 2 start) | — | — | — |
| MikroTik | — (pre-Experimental) | — | — | — |
| Synology / QNAP | — | — | — | — |
| VMware / Hyper-V / Proxmox | — | — | — | — |
