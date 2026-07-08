# Unified Classification Engine — Specification

> **Status:** DESIGN — awaiting owner approval. **No code written yet.**
> Supersedes the four duplicated classifiers (C1 resolution, C2 smart_folder,
> C3 tree-case, C4 write-time placement) documented in
> [CLASSIFICATION-ARCHITECTURE-REVIEW.md](CLASSIFICATION-ARCHITECTURE-REVIEW.md).
>
> **Mandate (owner, 2026-07-08):** build ONE new engine that preserves 100% of
> existing Windows production behaviour and eliminates duplicated logic. Windows
> is the reference. `Client → Category → Platform`. SQL result == in-memory
> result. Tree badges == catalog filters == overview counts, always.

---

## 1. Design principle — one definition, two renderers

A single module `app/platform_core/classification.py` owns **all** category and
platform logic. It exports, from the **same** ordered rules and the **same**
shared constants:

- **SQL renderer** — SQLAlchemy `case()` expressions for set operations
  (counts, filters, tree aggregation): `category_case()`, `platform_case()`.
- **In-memory renderer** — pure Python over a device-like object (resolution,
  Drawer, enrollment, tests): `classify_category(d)`, `classify_platform(d)`.

Both renderers are generated from one ordered rule table and one set of
constants (group-name vocabulary, server-OS patterns, platform-class patterns).
They **cannot drift** because there is only one source; a parity contract test
(§6) proves it on every build.

No consumer may write its own `case()` or heuristic again. Grep guard in
preflight: `_tree_category_case|_category_from_os|_apply_smart_folder_filter`
must not reappear outside the engine module after migration.

---

## 2. The Client axis (already single-sourced — keep, do not rebuild)

`DeviceAssignmentService` already owns Client resolution. Precedence (unchanged):

1. **Manual** (`assignment_source=manual`)
2. **Legacy manual** (`client_id`/`group_id` set, source NULL)
3. **Enrollment token** (`assignment_source=enrollment_token`)
4. **Trusted domain** (`assignment_source=trusted_domain`, auto, follows domain)
5. **Automatic** (domain-derived / unassigned)

Locked set = `is_manual_locked()` (manual, legacy_manual, enrollment_token) — the
predicate just introduced (commit `96020cd`). Manual override is a **Client-axis**
concept and MUST NEVER be re-derived by the Category engine. Category answers
*what a device is*; Client answers *who owns it*. The engine touches only Category
and Platform.

Future "Proxy Enrollment" slots in as a Client source (a labelled
`assignment_source`), no engine change.

---

## 3. The Platform axis (derived exactly once)

`classify_platform(platform_string)` / `platform_case()` — the single mapping:

| platform contains | class |
|---|---|
| (null / anything else) | `windows` *(audit §8: absence ⇒ Windows)* |
| linux | `linux` |
| darwin/macos | `macos` |
| mikrotik / routeros | `mikrotik` |
| synology | `synology` |
| qnap | `qnap` |
| vmware / esxi | `vmware` |
| proxmox | `proxmox` |
| hyperv | `hyperv` |
| unifi | `unifi` |
| cisco | `cisco` |

Adding a platform = one row here + its adapter. Nothing else changes. This
replaces `_platform_class_case` and `_apply_platform_filter`'s ad-hoc lists.

---

## 4. The Category axis — the one ordered rule (resolves every edge case)

Category vocabulary: `servers, clientpc, network, storage, hypervisors, printers,
iot, other, unassigned`.

Each platform class declares whether it is an **agent platform** (Windows, Linux,
macOS — enrolled, live in Servers/Client PC) or a **non-agent platform**
(MikroTik→network, Synology/QNAP→storage, VMware/Proxmox/Hyper-V→hypervisors,
UniFi/Cisco→network, printers→printers, iot→iot). This mapping lives once, beside
the platform table.

**Ordered resolution (identical in SQL and Python):**

| # | Rule | Result | Maps to owner precedence |
|---|------|--------|--------------------------|
| 0 | No `client_id` **and** no `group_id` | `unassigned` | (pre-guard) |
| 1 | Platform class is **non-agent** | its fixed category (network/storage/hypervisors/printers/iot) | "Existing Windows production behaviour" (structural, platform-intrinsic) |
| 2 | Device is in a **standard DB group** (`Servers`/`Server` → servers; `Client PC(s)`/`Workstation(s)` → clientpc) | that category | **1. Existing DB Group** |
| 3 | Agent platform, **OS heuristic** (`device_type==SERVER` OR `windows_product_type∈{2,3}` OR os text contains `windows server`) | `servers` | **3. OS heuristic** |
| 4 | Agent platform, recognizably a workstation (`windows`/`linux`/`macos` and not server) | `clientpc` | **2. Existing Windows production behaviour** (the pre-expansion `else→clientpc`, but now explicit) |
| 5 | In a **custom (non-standard) group**, no signal above matched | `other` | **4. Other** *(restores the bucket the tree currently erases)* |
| 6 | Fallback | `clientpc` | preserves today's Windows default |

**Why this preserves Windows 100%:**
- A Windows device in `Servers`/`Client PC` → rule 2 → identical to C1/C2/C3 today.
- An ungrouped Windows Server (product-type only) → rule 3 → `servers` (matches the
  current overview/badge and the `e08544d` filter fix).
- An ungrouped Windows workstation → rule 4 → `clientpc` (unchanged).
- **The only behavioural change is intentional and owner-mandated:** a device in a
  *custom* group is now `other` (rules 5) instead of being force-collapsed into
  `clientpc` (today's C3 `else`). This is additive — it creates a real "Other"
  tree folder that today does not exist, and does not move any Servers/Client PC
  device. **This is the one point to confirm** (§8, Decision D1).

**Write-time placement** (`_detect_group` / `detect_group_name`, C4) becomes a thin
consumer: it asks the engine for the category of the enrollment signal and maps
`servers→"Servers"`, `clientpc→"Client PC"`. Same names, same outcome, one rule.

---

## 5. Consumers — all read the one engine (nothing computes its own)

| Consumer | Today | After |
|---|---|---|
| Tree badges / counts | `count_by_client_category_platform` → `_tree_category_case` + `_platform_class_case` | `category_case()` + `platform_case()` |
| Overview counters | `get_overview_inputs` → `_tree_category_case` | `category_case()` |
| Catalog filter (category) | `_apply_category_filter` → `_tree_category_case` | `category_case() == cat` |
| Catalog/Tree filter (smart_folder) | `_apply_smart_folder_filter` (C2, separate heuristic) | `windows_server`→`category_case()=='servers'`, `windows_workstation`→`=='clientpc'` (keys kept for back-compat; logic via engine). Non-category smart folders (domain/workgroup/laptop/offline/rustdesk_missing) stay as-is. |
| Platform filter | `_apply_platform_filter` (ad-hoc list) | `platform_case() == plat` (windows still matches NULL) |
| Drawer / resolution | `resolve_device_assignment` → `_category_from_group`/`_category_from_os` (C1) | `classify_category(device)` |
| Search | shares `get_multi`/`count` params | inherits the above — no separate change |
| Enrollment placement | `_detect_group` / `detect_group_name` (C4) | `classify_category(signal)` → standard group name |
| Command Center / Packages | gate on category/platform | read engine outputs (no own logic) |
| WebSocket / frontend | `resolved_device_category` from C1; badges from C3 (`treeCounts`) | both now from the engine → badge, drawer, maintenance-dot agree |

Result: **Tree folders == Device Catalog** (same `category_case`), **badges ==
filters** (same expression on both sides), **overview == tree** (same expression),
and **Drawer == badges** (in-memory renderer == SQL renderer, proven by §6).

---

## 6. Correctness contract — SQL must equal in-memory

A dedicated contract test `test_classification_engine_parity.py`:

1. Builds a **matrix of synthetic devices** covering every rule branch and edge:
   each platform class × {no group, Servers group, Client PC group, custom group}
   × {product_type 1/2/3/null, server caption, workstation caption} ×
   {client_id set/null}.
2. For each device asserts `classify_category(d)` (Python) **==** the value the
   `category_case()` SQL returns for the same row (SQLite), and likewise for
   platform. Any divergence fails the build.
3. **Golden Windows snapshot:** a fixture of representative real Windows rows
   (the Agroblend0 / Eugreen product-type-server cases, standard-group devices,
   custom-group devices) with expected categories locked in, so a future change
   that alters a Windows outcome fails loudly.

Added to `preflight.sh` as a first-class gate. This is the mechanical guarantee
behind "SQL result == in-memory result."

---

## 7. Phased rollout (behind verification, Windows never dark-broken)

- **P1 — Engine module + parity test, zero consumers wired.** Pure addition; suite
  green; grep guard armed but not enforced. No behaviour change (dead code).
- **P2 — Migrate SQL consumers** (tree counts, overview, category/platform/smart
  folder filters) to the engine. Assert, against the **live prod DB** (read-only),
  that every client's category/platform counts are **byte-identical** to the
  current `count_by_client_category_platform` for all agent-platform devices, and
  that the only diffs are custom-group devices moving to the new `other` bucket
  (Decision D1). Deploy backend. smoke.
- **P3 — Migrate in-memory consumers** (resolution/Drawer, enrollment placement).
  Parity test guarantees identical results; deploy.
- **P4 — Frontend:** add the `Other` tree folder (only shows when non-empty, like
  Network/Storage today); point badge + drawer + maintenance index at the one
  category. Deploy frontend.
- **P5 — Delete C1–C4.** Remove `_tree_category_case`, `_platform_class_case`,
  `_category_from_os`, the smart_folder server/client heuristic body, `_detect_group`
  body — replaced by engine calls. Enforce the grep guard in preflight.

Each phase: contract + regression + preflight + smoke, then deploy, then the
Regression Matrix (Appendix B) Windows rows. Flags unaffected (this is not
gated — it is the core Windows path — so every phase must be behaviourally
identical for Windows except the additive `Other` folder).

---

## 8. Decisions needed before P1

- **D1 — the `Other` bucket.** Confirm that a device in a *custom-named* group
  (not Servers/Client PC) should surface under a new **Other** tree folder rather
  than being force-collapsed into Client PC (today's behaviour). This is the single
  intentional behavioural change; everything else is byte-identical for Windows.
  *Recommendation: yes* — it is additive, truthful, and eliminates the C1/C3
  disagreement. If declined, rule 5 becomes `clientpc` and behaviour is 100%
  identical (but the C1 Drawer "other" must then also fold to clientpc).
- **D2 — smart_folder keys.** Keep `windows_server`/`windows_workstation` as
  accepted filter keys (routed through the engine) for any saved views / API
  callers? *Recommendation: keep the keys, swap the implementation* (no external
  contract break).

On approval of §4 and D1/D2, I proceed P1→P5 under the standing implementation
authority, one phase at a time, verified and deployed per the roadmap.
