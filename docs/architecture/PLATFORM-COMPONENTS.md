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

`LifecycleOperation` = `install | update | repair | restart | discover | sync`.
None is mandatory; each component declares which it supports and maps each to an
**existing** action (or `None`):

| Operation | Agent | Remote Support |
|---|---|---|
| `install` | — (GPO/NETLOGON, no queued action) | `deploy_remote_support` |
| `update` | `self_update` | `deploy_remote_support` |
| `repair` | — | `repair_config_rustdesk` |
| `restart` | `restart_agent` | `restart_rustdesk` |
| `sync` | — | `sync_rustdesk` |
| `discover` | — (heartbeat `agent_version`) | — (heartbeat `rustdesk_*`) |

Reinstall stays its own Action-Registry action (`reinstall_rustdesk`); it is **not**
folded into a lifecycle operation to keep the model honest. No new action type is
created to make the model symmetric.

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
- **UI wiring:** in progress (registry-driven grouping of the Agent Packages
  page; existing upload/activate/download/delete/confirm flows unchanged).
- **Production:** not deployed. No claim of production-readiness.
