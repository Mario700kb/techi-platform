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

## 10a. Operational layer (Platform Components — Operational)

The foundation above (Registry / Lifecycle / Policy / Desired State) is **STABLE
and frozen**. The *Operational* work builds strictly on top of it to make the
declared operations actually triggerable — reusing the existing Action Queue, not
replacing it.

### Milestone 1 — Component Action Resolver (`action_resolver.py`)

The single seam that turns a `(component, lifecycle operation)` request into a
concrete queueable device action:

```
Component  →  LifecycleOperation  →  ActionType  →  payload  →  Device Action
```

Pure domain layer (like the rest of `platform_core`): imports only sibling
registries + schema enums — never FastAPI, a DB session, services, or the queue.
It creates **no** new `ActionType`, **no** parallel queue, **no** source of
truth. It consults the existing Component + Lifecycle registries and returns the
**existing** `ActionType` plus a base payload (the operator-supplied parameters,
copied). Component branching lives **only** here — consumers call
`resolve_component_action(component, operation)`.

Outcomes are explicit and structured (no `if component == ...` at call sites):

| Outcome | Result |
|---|---|
| resolvable operation | `ResolvedComponentAction(component_id, operation, action_type, label, payload)` |
| no such component | `ComponentActionError(UNKNOWN_COMPONENT)` |
| not a lifecycle operation | `ComponentActionError(UNKNOWN_OPERATION)` |
| component doesn't declare it | `ComponentActionError(UNSUPPORTED_OPERATION)` |
| supported but out-of-band (GPO install, heartbeat discover — `action_type is None`) | `ComponentActionError(NOT_EXECUTABLE)` |

`ComponentActionErrorCode` values are contract (the API layer maps each to a
precise HTTP status + machine-readable `code`). `can_resolve()` is the
never-raising yes/no convenience for UI availability. Fails **closed**: an
out-of-band operation is never silently turned into a fabricated action.

### Milestone 2 — Component Action API (`component_actions.py` + `component_action_service.py`)

One registry-driven endpoint for **every** component lifecycle operation:

```
POST /devices/{device_id}/components/{component_id}/actions
body: { "operation": "install|update|reinstall|repair|restart|discover|sync",
        "parameters": { ... optional ... } }
```

No per-operation route, no per-component branching. Flow:

1. scope-check the device (404 out of scope, same as the generic action endpoint);
2. `ComponentActionService.resolve_for_device()` — resolves via Milestone 1 **and**
   verifies the resolved `ActionType` is actually available for this device's
   platform + effective capabilities (reusing `actions_for()`, the same source the
   Device Drawer uses) → `UNAVAILABLE_FOR_DEVICE` otherwise;
3. enforce the **same** permission gate as `queue_device_action`
   (`ACTION_PERMISSION_MAP[action_type]`);
4. queue through the **unchanged** `RemoteActionService.queue_action` — an ordinary
   `RemoteAction` of an existing `ActionType`, delivered on the next heartbeat.
   No parallel queue, no new execution path.

Errors carry a stable machine-readable `code` in the JSON body, mapped to HTTP
status:

| code | HTTP |
|---|---|
| `unknown_component` | 404 |
| `unknown_operation` | 400 |
| `unsupported_operation` | 422 |
| `not_executable` (out-of-band) | 422 |
| `unavailable_for_device` | 422 |
| queue conflict / duplicate | 409 |

Success returns `ComponentActionAccepted` (component_id, operation, action_type,
label, and the queued `RemoteActionResponse`). Audited as `action_queued` with the
component/operation context. Deeper validation (policy, desired-state, package/
version) is layered on in Milestone 3; execution formalized in Milestone 4.

### Milestone 3 — Validation Layer (`component_action_validator.py`)

Every decision of *whether a component action may be queued* lives in one ordered
validator — no `if component == …` / `if operation == …` scattered across the
endpoint and service. `ComponentActionService.resolve_for_device()` delegates to
it. Checks, in order, each raising a `ComponentActionError` with a stable `code`:

1. **component / operation / executability** — the pure resolver (M1);
2. **device capability** — resolved `ActionType` available for the device's
   platform + effective capabilities (`actions_for`), else `unavailable_for_device`;
3. **policy present** — the component must have a declared deployment policy
   (`policy_for`), else `no_policy`;
4. **version format** — a supplied `version` parameter must be dotted-numeric,
   else `invalid_version` (400).

Deliberately **not** here (own milestones; would couple this layer to the
file-based package manifest and make it non-deterministic): package availability /
desired-version resolution / outdated detection → **M11**; policy *enforcement*
beyond "a policy exists" (rollout/canary/override) → **M10**. Those milestones
extend this validator — they add checks, never a parallel gate.

### Milestone 4 — Execution Layer

The resolver is wired to the **existing** device-action mechanism — there is no
parallel system and the Action Queue is not redesigned. A component action queued
via `ComponentActionService.execute()` becomes an ordinary `RemoteAction` of an
existing `ActionType` in the one `remote_actions` table, and flows through the
**same** pipeline as every other action: `collect_pending_for_delivery` (heartbeat
delivery) → `acknowledge` → `mark_running` → `complete`/`fail`, all driven by the
unchanged `RemoteActionService`. The existing conflict/duplicate guard applies
unchanged.

`ComponentActionService.attribute(action_type)` is the reverse seam: it maps any
queued `RemoteAction` back to the `(component_id, operation)` it implements, via
the Lifecycle Registry's existing reverse index (`component_operation_for_action`)
— so History (M7) and Telemetry (M13) can attribute *any* action to a component
regardless of how it was queued (this endpoint, Command Center, the RS flow). No
new store; a shared action folds to its first declared operation. An integration
test drives a component action through the full lifecycle to prove the single
pipeline.

### Milestone 5 — Frontend Wiring (`ComponentStatesPanel.tsx`)

The existing read-only panel is wired to the new endpoint **without a UI redesign**.
Each lifecycle operation chip whose `kind === "action"` becomes a triggerable
button (same chip look); out-of-band operations (`kind === "out_of_band"` — GPO
install, heartbeat discover) stay as static, dimmed labels. On click the panel:

* POSTs via `queueComponentAction(deviceId, componentId, operation)`;
* shows a spinner on the running op and **disables every op on that component**
  while one is in flight (`busy` key `component:operation`);
* on success shows "<Label> queued" and refetches the desired-state row;
* on failure surfaces the structured backend message (`client.ts` now reads
  `detail.detail` from the structured error body) in a red note.

No new page, no layout change, no new dependency (uses `fireEvent`-testable plain
buttons). Frontend gate: tsc clean, vitest 75 passed (6 for this panel incl.
trigger / error / out-of-band-not-a-button), production build green.

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
