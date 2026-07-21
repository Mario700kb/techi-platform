# Platform Components — Architecture

**Status:** Backend foundation implemented (dark). UI wiring in progress. **No
production deployment.** This document is canonical for the Platform Components
abstraction; current project state lives in `docs/PROJECT_STATE.md` and history
in `docs/CHANGELOG-SOLUTIONS.md`.

---

## 1. Purpose

TECHI deploys and manages more than one piece of software on a device today (the
**Agent** and **TECHI Remote Support**), and will manage more over time. Those
pieces already exist as `file_type`-tagged entries in the Package Registry, with
their own download URLs, lifecycle actions, and discovery. What was missing is a
single place that says *"these packages/actions/versions belong to the same
component"*.

**Platform Components** is that layer: a registry-driven classification of the
software components TECHI manages, built entirely on top of the existing systems.

## 2. Guiding principle

> **Existing production contracts are classified, not replaced.**

The registry introduces no new `file_type`, no manifest change, no new download
URL, no schema migration, and no change to the heartbeat / enrollment / pending-
actions / bootstrap / NETLOGON contracts. It reads the vocabulary that already
exists and groups it. Removing the registry would leave every production contract
byte-identical.

## 3. `ComponentDescriptor` fields

Defined in `backend/app/platform_core/components.py` (a frozen dataclass, mirroring
`ActionDescriptor` and `PlatformDescriptor` in the same package). Pure domain
layer — imports only sibling registries and schema enums; never FastAPI, a DB
session, settings I/O, services, or repositories.

| Field | Type | Meaning |
|---|---|---|
| `id` | `str` | Stable component id (`agent`, `remote_support`). |
| `display_name` | `str` | UI label. |
| `description` | `str` | One-line UI description. |
| `icon_key` | `str` | Stable key the frontend maps to an icon. |
| `platforms` | `tuple[str, ...]` | Platform ids (from `PLATFORM_REGISTRY`) the component deploys on. |
| `file_types` | `tuple[AgentFileType, ...]` | The **existing** `file_type` values this component owns — unchanged strings. |
| `lifecycle` | `Mapping[LifecycleOperation, Optional[ActionType]]` | Supported operations → the **existing** queued `ActionType` (or `None` when handled outside the queue, e.g. GPO/heartbeat). Frozen (`MappingProxyType`). |
| `capabilities` | `frozenset[str]` | Capability tokens (from `KNOWN_CAPABILITIES`) the component relates to. |

## 4. The two current components

Only the two real components are declared. VPN / Printer Helper / etc. are **not**
present — the structure exists, no speculative components.

### Agent (`id="agent"`)
Platforms: `windows`, `linux`. File types:
- `msi` — historically combined, **currently Agent-only** deployment.
- `agent_binary` — standalone `techi-agent.exe` for binary-swap self-update (≥2.1.1).
- `agent_update_msi` — Agent Update Bridge MSI for legacy msiexec self-update (<2.1.1).

### Remote Support (`id="remote_support"`)
Platforms: `windows`, `darwin` (macOS). File types:
- `remote_support_msi` — Windows first-install/reinstall MSI.
- `remote_support_bundle` — Windows native recovery ZIP (+ manifest sidecar).
- `remote_support_dmg` — macOS application bundle.
- `remote_support_pkg` — macOS updater package.

**Coverage guarantee:** every one of the 7 `AgentFileType` values is owned by
exactly one component (contract-tested; a duplicate claim raises at import).

## 5. Lifecycle operations

`LifecycleOperation` = `install | update | reinstall | repair | restart | discover
| sync`. None is mandatory; each component declares which it supports and maps each
to an **existing** action (or `None`):

| Operation | Agent | Remote Support |
|---|---|---|
| `install` | — (GPO/NETLOGON, no queued action) | `deploy_remote_support` |
| `update` | `self_update` | `deploy_remote_support` |
| `reinstall` | — | `reinstall_rustdesk` |
| `repair` | — | `repair_config_rustdesk` |
| `restart` | `restart_agent` | `restart_rustdesk` |
| `sync` | — | `sync_rustdesk` |
| `discover` | — (heartbeat `agent_version`) | — (heartbeat `rustdesk_*`) |

The Agent's `discover` is the heartbeat itself (it reports `agent_version`); there
is no separate `heartbeat` operation. No new `ActionType` is created — every mapping
reuses an existing one (Phase 4 promoted `reinstall_rustdesk` from an Action-Registry
action to a declared lifecycle operation; superseding the Phase 2 note that had left
reinstall out).

### Lifecycle Registry (Phase 4 — metadata / mapping / validation)

`app/platform_core/lifecycle.py` is a thin, registry-driven layer over the
declarations above. It does **not** duplicate them or execute anything:

- **Metadata** — `LifecycleEntry{operation, label, action_type, kind}` per supported
  operation. `LIFECYCLE_LABELS` gives display labels; `kind` is `action` (backed by a
  queued `ActionType`) or `out_of_band` (handler `None` — GPO/heartbeat).
- **Mapping** — `lifecycle_for(component_id)`, `operations_for(component_id)`,
  `action_for(component_id, operation)`, and the reverse
  `component_operation_for_action(action_type)` (`ACTION_TO_LIFECYCLE`).
- **Validation** — `validate_lifecycle_registry()` runs at import (fail-closed):
  every mapped handler is a real, registered action whose id matches its `ActionType`;
  every supported operation has a label; a cross-component action collision raises.

Consumers query these helpers — never `if component == "agent"`. The `GET
/platform/components` lifecycle entries now carry `label` + `kind` (additive,
backward-compatible). No endpoint executes lifecycle in this phase.

## 6. `ComponentHealth` and `derive_health` rules

Desired-state is **model only** — no policy engine, no auto-update, not wired.
`ComponentHealth` = `current | outdated | missing | unknown`. `derive_health`
(pure, self-contained, no I/O):

| Installed | Desired | Result |
|---|---|---|
| absent | absent | `unknown` (nothing to compare) |
| absent | present | `missing` (expected but absent) |
| present | absent | `unknown` (nothing to compare against) |
| present | present, either unparseable | `unknown` (fail-closed, never guessed) |
| present | present, installed < desired | `outdated` |
| present | present, installed == desired | `current` |
| present | present, installed > desired ("ahead") | `current` |

**`installed > desired` decision:** deliberately folded to `current` — a device
running a newer build is not "behind"; there is no `ahead` state at this
foundation phase. This is documented, not accidental.

### Per-device Desired-State resolution (Phase 3 foundation, read-only)

`ComponentStateService` (`app/services/component_state_service.py`) resolves, for a
device, the per-component **Installed / Desired / Health / Status** — purely
observational, no writes, no migration, no enforcement:

- **Installed Version** — read from the heartbeat-filled device columns
  (`agent_version` for the Agent, `rustdesk_version` for Remote Support). Nothing
  is written; heartbeat/enrollment/action-queue/agent are untouched.
- **Desired Version** — the active package version for the component on the
  device's platform, resolved via the existing `AgentPackageService.latest_active`
  in a preference order (Agent: `agent_binary` → `msi`; Remote Support:
  `remote_support_msi` → `remote_support_pkg` → `remote_support_dmg`; the platform
  filter makes the non-matching file_types no-ops).
- **Health** — the registry's pure `derive_health`. **Status** — its capitalized
  display label (`Current` / `Outdated` / `Missing` / `Unknown`) via `status_label`.

Devices on platforms with no managed components (e.g. MikroTik connectors) resolve
to an empty list. Exposed read-only at `GET /devices/{id}/component-states`
(auth + operator scope, versioned `schema_version`, stable strings). The service
imports `platform_core` through the reviewed wiring-boundary allowlist.

### Deployment Policy (Phase 5 — declarative model only)

`app/platform_core/policy.py` NAMES how each component's desired state is governed.
It is model only — **no** auto-update, scheduler, rollout, canary, enforcement,
Action-Queue change, agent change, or migration; nothing consults it, so behavior is
unchanged. Three declared concepts per component:

- **Desired Source** (`DesiredSource`) — where the desired version is read from:
  `active_package` (today) · `manual` · `none` (placeholders).
- **Policy** (`ComponentPolicy`) — governance mode: `active_package` (track the active
  package, today) · `manual` (operator-pinned, future) · `future` (policy-engine
  placeholder).
- **Strategy** (`DeploymentStrategy`) — how it would be reached: `manual` (operator
  triggers the existing lifecycle actions, today) · `future` (rollout/canary/scheduler
  placeholder — NOT built).

Both current components declare `active_package` / `active_package` / `manual` — an
honest name for today's behavior (Phase 3 resolves desired from the active package;
deployment is an operator manually triggering lifecycle actions). `manual`/`future`
enum values are declared placeholders assigned to no component yet.
`COMPONENT_POLICY_REGISTRY` + `policy_for()` expose it; a 1:1 coverage guard runs at
import. `/platform/components` now includes a `policy` object per component (additive,
backward-compatible). No UI surface, no button.

## 7. What the registry does NOT do

- Does not change `manifest.json` (format or contents).
- Does not replace or rename any `file_type` string.
- Does not change any download URL.
- Does not create a policy engine.
- Does not perform auto-update.
- Does not change the Action Queue / pending-actions contract.
- Does not require a DB migration (no DB involvement at all).
- Does not touch the Agent, heartbeat, enrollment, bootstrap, or NETLOGON.

## 8. Backward-compatibility guarantees

1. All 7 existing `file_type` strings keep working unchanged; the registry only
   classifies them (`component_for_file_type`).
2. Package upload/activate/download/delete behavior is untouched.
3. Every lifecycle handler is an action that already exists in the Action
   Registry (contract-tested) — no new execution path is invented.
4. The read API is additive and versioned (`schema_version`); the frontend has a
   **local fallback** to the existing 7-`file_type` mapping if the endpoint is
   unavailable (critical while prod may still run an older backend commit).

## 9. Extension rule (future components)

Adding a component later (e.g. VPN, Printer Helper) is **one registry entry**:
declare its `id`, `file_types` (reusing existing or a newly-added `AgentFileType`
value), `lifecycle` mapped to existing actions, `capabilities`, and `icon_key`.
No Drawer/UI branching, no per-component `if`. If a new `file_type` is added, the
coverage contract test forces it to be claimed by exactly one component. Do **not**
invent generic `component_install`/`component_update` actions to force symmetry —
reuse the actions that exist, or expose the operation as metadata only.

## 10. Diagram

```
        Component Registry  (components.py — pure domain)
                 │ classifies (does not replace)
                 ▼
     Existing file_types  ·  Existing ActionTypeS  ·  Capability tokens
                 │ used by
                 ▼
   Package Registry   Action Registry / Queue        UI (registry-driven,
   (manifest.json)    (pending_actions contract)      with local fallback)
```

## 11. Status

- **Backend foundation:** implemented (`components.py`, read API `GET
  /platform/components`, contract tests). Dark — not wired into package/action
  execution behavior.
- **Desired-State foundation (Phase 3):** per-device resolver
  (`component_state_service.py`) + read API `GET /devices/{id}/component-states`
  (Installed/Desired/Health/Status). Model + reporting only — NO auto-update,
  policy engine, rollout, canary, deployment rules, scheduler, or enforcement.
- **Lifecycle Registry (Phase 4):** `lifecycle.py` — metadata (label + kind),
  mapping (operation↔existing ActionType, both directions), and import-time
  validation over the declared lifecycles. No new ActionType, no execution
  endpoint, no migration. `/platform/components` lifecycle entries gained
  `label` + `kind`.
- **Deployment Policy (Phase 5):** `policy.py` — declarative Desired
  Source / Policy / Strategy per component (model only, no logic, nothing
  consults it). `/platform/components` gained an additive `policy` object.
  No auto-update / scheduler / rollout / canary / enforcement / migration.
- **UI:** registry-driven grouping of the Agent Packages page (existing
  upload/activate/download/delete/confirm flows unchanged); each component group
  shows its Desired (active) version as **information only** — no new buttons, no
  UX change.
- **Device Drawer integration (feature):** `ComponentStatesPanel.tsx` — a read-only
  panel in BOTH drawers (Windows classic `DeviceDrawer` and `GenericDeviceDrawer`)
  showing per component: Installed version, Desired version, Health **Status** badge,
  and supported **lifecycle operations** (labels) as metadata. Consumes the foundation
  endpoints (`GET /devices/{id}/component-states` + `GET /platform/components`); renders
  nothing on failure or for devices with no managed components. No buttons, triggers
  nothing. This is the first per-device UI consumer of the desired-state + lifecycle
  foundation.
- **Features assessed, intentionally not refactored:** Command Center, the Remote
  Support deployment flow, and Batch operations already execute through the existing
  Action Queue using existing ActionTypes that the Lifecycle Registry maps — no
  duplication. Their execution paths were NOT refactored to be "registry-driven":
  the value is modest and they are production-critical / July-incident-adjacent, and
  deeper integration would drift toward orchestration (rollout/enforcement), which is
  out of scope. The registry is consumed at the read-only metadata level (the drawer
  panel).
- **Production:** not deployed. No claim of production-readiness. **Deploy of the
  branch tip is BLOCKED** — `stable/phase-2-heartbeat` is 99 commits ahead of the
  production commit `92a521c` (the 2026-07-18 total rollback); a `git pull` deploy
  would reintroduce the rolled-back code and risk re-triggering the storm. Shipping
  Platform Components to prod requires a deliberate owner decision (e.g. cherry-pick
  onto `92a521c`), not a branch deploy.
