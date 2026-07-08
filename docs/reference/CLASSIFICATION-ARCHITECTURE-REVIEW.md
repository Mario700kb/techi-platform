# TECHI Platform — Classification Architecture Review

> **Status:** Review only (no code changed). Produced 2026-07-08 on owner request,
> after the tree cumulative-filter fix `e08544d`, to determine whether the current
> implementation has diverged from the original Windows production architecture
> **before** proposing a unified classification engine.
>
> **Reading rule honored:** PROJECT_STATE → CHANGELOG-SOLUTIONS →
> PLATFORM-EXPANSION-AUDIT → this review. Windows is the reference implementation;
> nothing below proposes changing Windows behavior — only unifying around it.

---

## 0. Method — what was actually read

Backend: `agent_enrollment_service.py`, `device_assignment_service.py`,
`device_heartbeat_service.py`, `device_repository.py`
(`_apply_smart_folder_filter`, `_apply_category_filter`, `_apply_platform_filter`,
`_tree_category_case`, `_platform_class_case`, `count_by_client_category_platform`,
`get_overview_inputs`, `get_multi`, `count`), `device_service.py` (manual move),
`trusted_domain_service.py` (referenced). Frontend: `DeviceTree.tsx`, `Devices.tsx`.
Git history: pre-expansion `get_overview_inputs` (commit `5bfe101~1`).

---

## 1. Source of Truth — Client assignment

**Persisted `Device.client_id`, with `Device.assignment_source` recording provenance.**
Provenance precedence (highest wins, `AUTHORITATIVE_SOURCES`):

1. `manual` — set by operator move (`device_service.py:254/281/303`, `auto_assigned=False`).
2. `legacy_manual` — a device with `client_id`/`group_id` but a NULL `assignment_source` (pre-provenance data) is treated as manual.
3. `enrollment_token` — client/group carried by the enrollment token.
4. `trusted_domain` — derived from the Windows domain (auto, follows the domain).
5. `auto_os` / `system_auto` / `unassigned` — weakest.

Auto client derivation (only when not authoritative and `client_id is None`):
`DeviceAssignmentService._detect_client()` → **the Windows domain** is the signal.
`_get_client_for_domain()` resolves domain → client by, in order: (a) explicit
`trusted_domains` mapping `mapped_client_id`, (b) mapping `mapped_client_name`,
(c) `_normalize_domain_to_client_name()` (first DNS label, humanized) creating the
client. Workgroup / empty / hostname-echo domains are rejected
(`_is_domain_managed`, `is_likely_fake_auto_client_name`, `INVALID_*`).

**→ Client = Domain, else Enrollment Token, else Manual. Manual/enrollment are locked.**

## 2. Source of Truth — Server vs Client PC

**Two layers, and they are not the same classifier:**

- **Write-time (authoritative, durable):** at enrollment/trusted-domain assignment,
  `_detect_group()` (and `TrustedDomainService.detect_group_name()`) place the device
  into a **named group `"Servers"` or `"Client PC"`** using
  `device_type==SERVER OR windows_product_type in {2,3} OR "server" in os_text`.
  The **group name is the persisted server/client fact.**
- **Read-time (resolution):** `resolve_device_assignment()` →
  `_category_from_group()` **first** (group name `Servers`→`servers`,
  `Client PC`/`workstation`→`clientpc`), and **only if there is no group** falls back
  to `_category_from_os()` (same OS/product-type heuristic). A device in a *custom*
  group (e.g. "Domain Controllers") resolves to category **`other`**; no client/group
  at all → **`unassigned`**.

**→ Server-vs-Client = group placement first; OS/product-type only as a fallback for
ungrouped devices. Manual placement into Servers/Client PC is respected.**

## 3. How Smart Groups are generated today

There is **no free-form "smart grouping" engine**. Groups are created deterministically:

- On trusted-domain / auto assignment, `_ensure_standard_groups()` guarantees a
  `"Servers"` and a `"Client PC"` group per client, and the device is placed into one
  of them by `_detect_group()`.
- `_get_or_create_group(client_id, name)` is idempotent by (client, name).
- The **tree "folders"** (Servers / Client PC / Network / Storage / Hypervisors) are
  **not stored groups** — they are *computed categories* rendered by
  `_tree_category_case()` counts. Platform sub-folders (Windows/Linux/…) are computed
  by `_platform_class_case()`. Only Servers/Client PC correspond to real DB groups.

## 4. How domains are handled today

- Reported in the heartbeat/enrollment payload as `Device.domain`.
- `trusted_domains` table + `TrustedDomainService` decides which domains auto-enroll
  **without a token** (`is_trusted_domain`) and can map a domain → explicit client.
- A domain is "managed" if non-empty and not `workgroup` (`_is_domain_managed`).
- Domain → client name = first DNS label, humanized (`agroblend.local` → `Agroblend`),
  unless an explicit mapping overrides it.
- Workgroup/empty domain ⇒ **not** auto-assigned; device stays `unassigned`.

## 5. What happens when a completely new Windows domain appears

- **Trusted, tokenless:** `is_trusted_domain` true → `_enroll_trusted_domain` →
  `apply_trusted_domain_assignment`: get-or-create the client from the domain name,
  `_ensure_standard_groups`, place into Servers/Client PC, `assignment_source=trusted_domain`,
  `auto_assigned=True`.
- **Untrusted:** a valid `enrollment_token` is **required**; client/group come from the
  token. Without a token → enrollment rejected (`token_required`).
- **Auto path (`apply_auto_assignment`) when domain managed:** creates the client and
  standard groups the same way. So **yes — a brand-new domain can auto-create a Client
  and its Servers/Client PC groups**, but only via the trusted-domain path or a token.

## 6. Does production already auto-create Clients and Smart Groups?

**Yes.** `_get_or_create_client()` (domain-derived, slug-deduplicated) and
`_ensure_standard_groups()` + `_get_or_create_group()` already create Clients and the
Servers/Client PC groups automatically at enrollment/heartbeat time. This is
long-standing Windows production behavior, **not** a Platform-Expansion addition.

## 7. Parts that MUST NEVER CHANGE (production depends on them)

1. **Manual-override lock.** `manual`/`legacy_manual`/`enrollment_token` client/group is
   never overwritten by enrollment (`agent_enrollment_service.py:287-296`), heartbeat
   (`device_heartbeat_service.py:154-159`, `471-476`), or reconcile
   (`device_assignment_service.py:161`).
2. **Domain → Client derivation** and the invalid-domain guards
   (`_is_domain_managed`, `INVALID_CLIENT_LABELS`, `INVALID_HOST_PREFIXES`,
   `_is_valid_org_domain`). Changing these re-buckets the whole fleet.
3. **Group-first server/client resolution** (`_category_from_group` before
   `_category_from_os`) and the `Servers`/`Client PC` **group-name vocabulary**.
4. **The overview classifier** (`get_overview_inputs`, group→OS→else clientpc) — these
   are the fleet numbers operators have watched for months. Verified identical in
   structure to `_tree_category_case` with platform flags off (see §8).
5. **Two-query overview hot path** and heartbeat throughput.
6. **`_apply_platform_filter` treating NULL platform as Windows** (audit §8: absence ⇒ Windows).

## 8. What can safely be generalized for Linux/MikroTik/Storage/Hypervisors

- **Platform axis** is already cleanly separable: `_platform_class_case()` +
  `_apply_platform_filter()` + `platform_adapters`. Adding a platform = one branch, no
  UI change. This generalization is sound.
- **Category prefix for non-agent platforms** (Network/Storage/Hypervisors by platform
  class) is additive and inert when no such device exists — confirmed: with flags off,
  `_tree_category_case` reduces **exactly** to the pre-expansion overview `case`
  (platform branches never match). **The overview counters did NOT diverge.**
- The **write-time group placement** (`_detect_group`) can be generalized to a
  capability/adapter-driven category without touching Windows, provided Servers/Client
  PC stay the Windows outcome.

---

## 9. DIVERGENCE ANALYSIS — there is not one classifier, there are four

The same "which category is this device" question is answered by **four** independent
code paths, which agree for the common case but disagree on edge cases:

| # | Location | Order of truth | Custom-group device | "other" category? |
|---|----------|----------------|---------------------|-------------------|
| **C1** | `resolve_device_assignment` → `_category_from_group`/`_category_from_os` (Drawer, frontend maintenance index) | group-name → (if ungrouped) OS | → **`other`** | **yes** |
| **C2** | `_apply_smart_folder_filter` `windows_server`/`windows_workstation` (original catalog click) | group-name → **(ungrouped only)** OS | matches **neither** folder | n/a |
| **C3** | `_tree_category_case` — tree badges, overview counters, **and now the catalog category filter** | platform → group-name → OS (all devices) → **else `clientpc`** | forced into `servers`/`clientpc` | **no** |
| **C4** | `_detect_group` / `detect_group_name` (write-time placement) | OS/product-type only | n/a (creates Servers/Client PC) | n/a |

**Where they disagree (the real divergence):**

- **Custom-named groups.** A device in a group that is *not* Servers/Client PC (e.g.
  "Domain Controllers", "Kiosks", "Laptops"):
  - **C3** forces it into `servers` (by OS) or `clientpc` (else) → it **is counted** in
    the Servers/Client PC badge.
  - **C2** (the original folder click) matches **neither** smart folder → clicking
    Servers/Client PC **did not** return it.
  - **C1** (Drawer) calls it **`other`**.
  So for a client with custom groups, the **badge (C3) has always been able to exceed
  the folder's filtered rows (C2)** — the same class of inconsistency as the leaf bug,
  and it predates the leaf fix.

- **The leaf bug `e08544d` (this week).** Root cause was C2-vs-C3: the badge used C3,
  the leaf/parent filter used C2. The fix aligned the **catalog filter onto C3**
  (`_apply_category_filter` now reuses `_tree_category_case`; the frontend sends
  `category` not `device_type`/`smart_folder`). This made **filter == badge** for all
  clients (verified live, 28/28). **But it also means the "Servers" folder click no
  longer uses the original C2 smart-folder semantics** — for custom-group devices its
  result changed (they now appear under the OS-derived folder, matching their badge).
  This is consistent with the dashboard numbers (C3 == pre-expansion overview) but is a
  behavioral change worth the owner's explicit blessing.

- **C1 vs C3 in the tree UI.** Badges render from C3 (`treeCounts`), but the maintenance
  indicator dot is indexed by C1 (`resolved_device_category`, `DeviceTree.tsx:81`). A
  custom-group device is `other` in C1 but `servers`/`clientpc` in C3 → the maintenance
  dot can land on a different folder than the count. Cosmetic today, latent.

- **Heartbeat can undo a manual placement on `device_type` flip.**
  `device_heartbeat_service.py:162-168`: if the reported `device_type` changes
  (CLIENT→SERVER), the code clears `client_id/group_id/assignment_source/auto_assigned`
  **and forces `assignment_source = trusted_domain`**, then `reconcile` re-groups. Because
  the source was just overwritten, the `manual`/`legacy_manual` guard inside `reconcile`
  no longer sees it. This **violates the stated invariant** "heartbeat must never undo a
  manual assignment" for the narrow case of a manual device whose product type flips.

---

## 10. Comparison to the Platform Expansion model

The audit's intent — Client → Category → Platform, capability-driven, Windows as
reference — is **consistent** with production. The expansion did **not** rewrite the
Windows truth: domain→client, group-first server/client, auto client/group creation,
and manual lock are all intact, and `_tree_category_case`/overview are a faithful
generalization of the pre-expansion classifier. **The divergence is not Windows-vs-new;
it is that the category question was implemented four times and the copies drifted at
the edges** (custom groups, `other`, ungrouped-gating, and the heartbeat device_type
path). The Platform Expansion added the *platform* axis cleanly but inherited the
pre-existing C1/C2/C3 category split rather than collapsing it.

**Verdict:** the original Windows logic (group-authoritative, OS-fallback,
`other`/`unassigned` explicit) is the *superior* model and should be **preserved and
made the single engine**; the tree's forced `else=clientpc` (C3) is the weakest link
because it erases the `other` bucket that C1 and the real group model support.

---

## 11. Proposed unified classification engine (single source of truth)

**One module, consumed everywhere.** Proposed: a `classification` engine (backend) that
exposes both an ORM-column expression (for SQL: counts, filters, tree) and a
per-device function (for resolution/Drawer), guaranteeing SQL and Python agree by
construction.

**Client** (unchanged, already single-sourced in `DeviceAssignmentService`):
`Domain → Enrollment Token → Manual → (future) Proxy Enrollment`. Manual/enrollment
locked. This layer needs **no redesign**, only the heartbeat `device_type`-flip hole
(§9) closed so it never overrides `manual`/`legacy_manual`.

**Category** (the part to unify) — one ordered rule for every consumer:

```
1. Non-agent platform class  → network | storage | hypervisors | printers | iot
                               (from platform/capability adapter)
2. Explicit group name       → servers | clientpc        (Servers / Client PC)
3. Custom group (has group,  → other                      ← PRESERVE this bucket
   not standard)
4. Ungrouped + OS heuristic  → servers | clientpc          (device_type/wpt/os)
5. Otherwise                 → unknown/unassigned
```

This is **C1's semantics** (which already has `other`/`unassigned`) expressed as a
single `case()` so C2, C3 and the Drawer all return the identical value. It preserves
Windows behavior exactly for grouped Servers/Client PC devices, restores the `other`
bucket the tree currently erases, and keeps OS-fallback only for ungrouped devices.

**Platform** (already single-sourced): keep `_platform_class_case()` /
`_apply_platform_filter()` / adapters; extend the enum
(Windows, Linux, macOS, MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox, UniFi,
Cisco) one branch at a time. NULL ⇒ Windows.

**Consumers that must read the one engine:** tree badges, tree node filter, Device
Catalog filter, Search, Drawer context, Overview counters, Enrollment placement,
Packages, Command Center, and every future platform.

**Manual override:** must remain the top precedence in the Client layer and must not be
re-derived by Category — Category describes *what a device is*, never *who owns it*.

---

## 12. Open decision for the owner (before any implementation)

The `e08544d` fix unified catalog filters onto **C3** (badge/overview semantics). Two
coherent end states exist; they must not both persist:

- **(A) Standardize on the overview/badge semantics (C3-lineage) everywhere** — closest
  to the numbers operators already see; requires *adding back* the `other` bucket so
  custom groups are not force-collapsed, and pointing the Drawer at the same engine.
- **(B) Standardize on the group-authoritative resolution semantics (C1) everywhere** —
  richest (has `other`/`unassigned`), strictly respects manual/custom group placement;
  requires the tree badges + overview to adopt it (a change to long-standing counts).

**Recommendation: (A) extended with the `other` bucket** — it keeps the historical
fleet counts stable, preserves 100% of Windows Servers/Client PC behavior, restores the
`other` category, and yields exactly one engine. Then close the heartbeat
`device_type`-flip manual hole (§9) as a small, separate, well-tested fix.

**No code will be written until the owner picks (A) or (B) and approves.**
