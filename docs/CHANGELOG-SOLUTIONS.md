# TECHI Platform Changes and Solutions

> **IMPORTANT**
> Ky dokument përmban vetëm HISTORINË e projektit.
> Për gjendjen aktuale lexoni vetëm: [docs/PROJECT_STATE.md](PROJECT_STATE.md).
> Mos vendosni gjendjen aktuale këtu.

## [2026-10-05] SYSTEM-STATUS-2026-10-05 — Dashboard "System status" panel replaces "Recent deployments" (owner/admin only)

Owner: replace the Recent deployments card with the real state of the
application's services, with animated icons; visible to owner and admin
only. The design was agreed on a preview first (claude.ai artifact
`1NG7B2t9ddcpNPtFMYJF8k`).

`GET /api/v1/system/status` (`require_min_role(admin)`; operators and
readonly get 403) plus two browser-side tiles. Every value is live; unknowns
are shown as unknown:
- API ↔ Web (browser): round trip of the status call every 30 s, with a
  sparkline of the last 30 checks. 1.5 s or more = Slow; no answer = Down.
- Realtime (browser): the existing realtime WebSocket state (connected /
  connecting / polling fallback / offline).
- Database: `SELECT 1` latency, and `alembic_version` against the code head
  ("migration pending" if they differ).
- Agents: devices with `last_seen` inside `HEARTBEAT_TIMEOUT_SECONDS`
  against online. Down if the newest heartbeat is older than 2 min while
  devices are online (ingest stalled).
- Agent versions: share of the Windows fleet on the active agent
  (`version_service`). At least 85% = Synced, below that = Rolling out.
- Workers: new in-process registry `app/core/worker_health.py`. Realtime
  publisher, reconciliation, reports, notifications and terminal watchdog
  register on start; the periodic ones beat each pass. A worker is down if
  its task stopped or it missed 3 beats + 30 s.
- Nightly cleanup: running flag while it executes. Each run now writes an
  audit row `nightly_cleanup` (rows deleted, failed tasks, duration), so the
  result survives restarts. It shows "Pending" until the first run after
  deploy. It still runs at 03:00 UTC (05:00/04:00 Tirana), deliberately 2 h
  after the 03:00 Tirana backup so the two do not compete for the single
  vCPU.
- Nightly backup: the newest `postgres-YYYY-MM-DD_HH-MM.sql.gz` in
  `/opt/backups/techi`, mounted read-only at `/backups` (docker-compose).
  The backup script only gives a dump that name after `gzip -t` and the size
  floor pass, so its presence means it was verified. More than 26 h old =
  Late. Manual `pre-*` dumps are ignored.

Frontend: `SystemStatusCard` (animations in index.css `sys-*`, still under
`prefers-reduced-motion`). The Dashboard no longer loads recent deployments
(client code removed; the `/deployments/recent` endpoint stays and is still
smoke-checked). Smoke now also checks `/system/status`. Tests:
`tests/test_system_status.py` (12: roles, each tile's states),
`SystemStatusCard.test.tsx` (3).

Deployed the same day (`cf7e946` → `1f5556e`): preflight passed (backend
1178 with flags off/on, tsc, build, agent). Guard passed; rollback images
`techi-platform-{backend,frontend}:pre-sysstatus-cf7e946`; both rebuilt and
recreated, healthy. `/backups` is mounted read-only (a write attempt was
refused). Guard and smoke passed, including `/system/status` → 401 without
a token. Load peaked at 2.4 and fell back to 1.4. One-off evaluation inside
the backend container gave: database Live (79.6 ms on a cold connection,
schema `e1f2a3b4c5d6`); agents Live (560 reporting of 564 online, last
heartbeat 0 s ago); agent versions Synced (864/887 on 2.1.20, 97%); cleanup
Pending (first audited run at the next 03:00 UTC); backup Done (145 MB, 8
daily copies). The workers tile is only meaningful inside the app process
and was not evaluated here. Authenticated browser view not verified.

## [2026-10-05] ONLINE-GREEN-2026-10-05 — "Online" green made vivid at the owner's request

Owner: the green for ONLINE, the agent version badge and "Last seen" looked
too faded and should glow like the "Synced" badge. Measured from
screenshots: the ONLINE number rendered `#8BAE96` (`text-emerald-300` =
70% `#5E8F6C` + 30% ink); "Synced" (`.premium-status-online`) is `#8FD8B2`.
Friday's OK tone `#5E8F6C` is too grey to carry a lively green. Changed
`--th-status-online` dark `#5E8F6C` → `#5BD096` (300 shade `#89DBB3` ≈
"Synced"; 9:1 on cards) and light `#4D7559` → `#1B7F4E` (5.0:1 on white,
4.6:1 on page). `.premium-status-online` tint follows the new hue.

Deployed the same day (frontend only): preflight passed (backend 1166 with
flags off/on, tsc, build, agent). Guard passed; rollback image
`techi-platform-frontend:pre-green-f19b4ff`; `git pull` → `cf7e946`; frontend
rebuilt and recreated, healthy; guard and smoke passed. The live CSS served
at rdp.techi.com.al contains `--th-status-online: #5BD096` (dark) and
`#1B7F4E` (light).

## [2026-10-05] DEPLOY-TIRANA-2026-10-05 — Tirana time system-wide + top bar clock deployed (`f3416f7` → `f19b4ff`), host timezone set to Europe/Tirane

The owner approved both the deploy and the host timezone change ("po, po").

1. Local preflight passed at `56109b9`: backend 1166 passed with flags
   off/on, tsc, build, agent. The clock commit `f19b4ff` adds frontend only
   (vitest 89/89, build OK).
2. Guard passed. Load before the deploy was 1.0.
3. Full dump `/opt/backups/techi/pre-tirana-global-2026-10-05_15-02.sql.gz`:
   148,553,437 bytes, `gzip -t` OK, ends with "PostgreSQL database dump
   complete", 35 `CREATE TABLE`. It is smaller than the 2026-10-01 dump
   (175 MB), consistent with the 7-day heartbeat/telemetry retention.
4. Rollback images were tagged `techi-platform-{backend,frontend}:pre-tirana-f3416f7`
   (`1f08c476dfeb` / `27ecaf00fbd1`).
5. `git pull --ff-only` → `f19b4ff`; built backend and frontend. In
   throwaway containers, the backend clock with `TZ` read 17:06 CEST,
   `format_display` gave `2026-10-05 16:44 CEST`, and the frontend `date`
   read 17:06 CEST.
6. `docker compose run --rm backend alembic upgrade head` ran
   `d8e4f6a1b2c3 → e1f2a3b4c5d6`. `report_schedules` was empty before and
   after, so there was nothing to convert. Then
   `up -d --no-deps backend frontend`.
7. Both containers healthy; backend `date` = CEST; guard passed; smoke
   passed. Load peaked at 3.3 and fell to 1.2 within ~1.5 minutes. Public
   frontend and API both returned 200.
8. Host: `timedatectl set-timezone Europe/Tirane` (was `Etc/UTC`),
   `systemctl restart cron`, NTP synchronized. The only owned timed job,
   root cron `0 3 * * * /root/techi-backup.sh`, now runs at 03:00 Tirana
   (01:00/02:00 UTC). Other entries are Debian system jobs.
9. The PostgreSQL server timezone was confirmed to still be `UTC`. 361
   devices had `last_seen` within the 3 minutes after the deploy.

Not verified: authenticated browser check of the clock, inputs and
schedules. Rollback: retag the `pre-tirana-f3416f7` images to `:latest`,
`alembic downgrade d8e4f6a1b2c3` (reversible; it converts hours back), and
`up -d --no-deps backend frontend`. Host: `timedatectl set-timezone Etc/UTC`.

## [2026-10-05] TIRANA-GLOBAL-2026-10-05 — Tirana time across the whole system (display, inputs, schedules, logs)

Owner: "Tirana time must be global for the whole system" (reference: 16:44
CEST). This follows TIRANA-TIME-2026-10-05, which fixed the 2-hour-behind
parsing but still formatted in the viewer's device timezone and left report
schedules, inputs and logs on UTC.

- Display: `APP_TIME_ZONE = "Europe/Tirane"` (frontend/src/utils/time.ts).
  All 23 `toLocale*String` date calls plus `formatLocalDateTime` pass it, so
  a device set to another timezone still shows Tirana time. A guard test
  (`src/utils/__tests__/time.test.ts`) fails on any new call without it.
- Inputs: the Audit from/to filters, enrollment token expiry
  (Deployment, EnrollmentBootstrap), vault credential expiry and the custom
  report range are read as Tirana wall time (`tiranaInputToUtcIso`) and
  prefilled from UTC (`utcToTiranaInput`). Bug fixed on the way: the
  Deployment token-edit dialog prefilled the UTC wall time but saved it as
  device-local time, so every save of a token moved its expiry 2 hours
  earlier. The Audit filters had the same prefill mismatch.
- Scheduled reports: `hour_utc` → `hour_local` (model, API, UI "Hour
  (Tirana)"). `next_schedule_time` computes in Tirana wall time and returns
  UTC, so 08:00 stays 08:00 across summer and winter time. Migration
  `e1f2a3b4c5d6` renames the column and converts each schedule from its own
  `next_run_at`; its next run is unchanged, and weekly/monthly days move with
  the hour. Monthly days are clamped to 28. Downgrade converts back. Tests:
  `test_migration_report_hour_local.py`, a DST case in
  `test_report_service.py`.
- Logs: backend container `TZ=Europe/Tirane` (docker-compose). Audit:
  backend code only uses `utcnow()`/`datetime.utcnow()`, which ignore TZ;
  there is no naive `datetime.now()`/`date.today()`. Frontend nginx image
  gains `tzdata` and `TZ`.
- Unchanged on purpose: PostgreSQL server timezone stays UTC. It controls
  how timestamps are cast into the naive UTC columns; changing it would
  corrupt stored times.
- Top bar clock (owner request): a live Tirana clock sits centred in the
  desktop top bar (`TopbarClock`, e.g. `16:44:12  Mon 5 Oct · Tirana`). It
  ticks on the second boundary and is hidden below the `sm` width.

## [2026-10-05] DEPLOY-2026-10-05 — Friday palette, real recent deployments and Tirana time deployed (`672f751` → `f3416f7`)

Three commits went to production together: `d1b8d8b` (Friday palette, whole
frontend), `dc12f4e` (Dashboard recent deployments from real command batches)
and `f3416f7` (Tirana display time in UI and reports). The palette had been
committed earlier the same day but had not reached the server. Production
was still on `672f751` (code = `dbf46c8`), so all three shipped in this
deploy.

Sequence on `/opt/techi/techi-platform`:
1. Local `scripts/preflight.sh` passed at `f3416f7`: contract 15/15, backend
   1163 passed with flags off and on, tsc, build, agent build.
2. `techi-deploy-guard` passed (single root/compose file, all required
   `FEATURE_` flags effective).
3. Rollback images were tagged `techi-platform-{backend,frontend}:pre-palette-672f751`
   (`bfac9f9cbee7` / `1dc89f30b47a`).
4. `git pull --ff-only` → `f3416f7`; `docker compose build backend frontend`.
5. In a throwaway container from the new backend image, `Europe/Tirane`
   resolved correctly (`2026-10-05 14:52:00+02:00`), confirming `tzdata`.
6. `docker compose up -d --no-deps backend frontend`: both healthy; guard
   passed again; `scripts/smoke.sh` passed (9/9, including the new
   `/deployments/recent` check).
7. Load peaked at 4.9 as the fleet reconnected, then fell back to 1.4 within
   ~2.5 minutes. No traceback or 500 appeared in the backend log excerpt.
   Public frontend and API `/health` both returned 200.

No DB migration (schema stays `d8e4f6a1b2c3`); no `.env` change.
Not verified: authenticated browser check (dark/light, desktop/mobile) and a
direct heartbeat-ingest count after restart. Reading backend logs and the DB
from the session was not permitted.

Rollback: `docker tag techi-platform-{backend,frontend}:pre-palette-672f751`
back to `:latest`, then `docker compose up -d --no-deps backend frontend`
(code: `git checkout 672f751`).

## [2026-10-05] TIRANA-TIME-2026-10-05 — Some times showed 2 hours behind; UI and reports now show Tirana time

Owner report: the system time looked 2 hours behind Tirana. Every DB datetime
column is a naive `DateTime` holding UTC, so the API emits ISO strings with no
offset. `parseUTC()` (frontend/src/utils/time.ts) exists to read those as UTC,
but 9 call sites used `new Date(iso)`. Browsers read such strings as local
time, so in Tirana (UTC+2 in summer) they were 2 hours behind. Five of them
fed calculations as well as display: device age from `last_seen`
(DevicesTable RS-state + offline summary, DeviceMobileCard, Devices
"hide offline older than"), SSH session duration. Display-only: DeviceDrawer
snapshot time, Dashboard operator last-active, Deployment and Reports dates.
All nine now use `parseUTC`. The operator's machine itself was correct
(Europe/Tirane, CEST).

Reports (PDF/CSV) printed raw UTC, and the client PDF tables printed it with
no zone label. Added `DISPLAY_TIMEZONE = "Europe/Tirane"` (config) with
`to_display` / `format_display` (app/core/time.py, DST-aware: CEST in summer,
CET in winter). PDF cover, footer and tables now read e.g.
`2026-10-05 14:52 CEST`. CSV uses ISO with offset
(`2026-10-05T14:52:00+02:00`), and file names use Tirana time. "Created UTC"
headers became "Created". `tzdata` was added to requirements because
`python:3.12-slim` may lack the system zoneinfo. Tests:
`tests/test_display_time.py`.

Unchanged on purpose: storage and API stay UTC; agent/server logs stay UTC.
Scheduled reports keep their "Hour UTC" field: the hour is stored per
schedule, and changing its meaning would move existing schedules. Converting
that to Tirana time is a separate decision.

## [2026-10-05] DEPLOYMENTS-REAL-2026-10-05 — Dashboard "Latest activity" showed four invented rows; now reads the real fleet command batches

The Dashboard card "Recent Deployments / Latest activity" (badge "API driven")
was fed by `GET /api/v1/deployments/recent`, which returned four hardcoded
rows since V1.0 RC (`07d50a5`): "TECHI Remote Support agent update" success,
"Client onboarding batch" Staging warning, "Server configuration push"
success, "Policy sync failed" QA failed. Timestamps were `now - N hours`, so
the rows always looked fresh. TECHI has no Staging/QA environments; the
warning/failed rows reflected nothing real. This broke the "No fake/mock data"
rule. The owner asked to keep the card but with correct values.

Fix: a TECHI "deployment" is a fleet command batch (bulk command to many
devices: agent self-update, remote password, PowerShell, …), already persisted
in `agent_command_batches` + `remote_actions`. The endpoint now returns the
latest batches via `AgentCommandService.get_history` (same data as the Agent
Commands history), still gated by the DEPLOYMENT team permission, `limit`
1–20 (default 5). Status: `running` while devices are pending; `success` when
every device completed; `failed` when none did; `warning` otherwise. Expired
or cancelled actions count as "no response". The card shows command, target,
`completed/total ok · N failed · N no response`, operator and time, and
"No fleet commands yet" when there are none. Smoke now checks the endpoint.
Tests: `backend/tests/test_recent_deployments.py` (empty DB returns no rows,
status rules, expired devices, ordering/limit).

Note: reading history lazily expires overdue actions (existing
`get_history` behaviour, also used by `/agent/commands/history`).

## [2026-10-05] PALETTE-FRIDAY-2026-10-05 — UI palette aligned to the Friday chat palette (dark + derived light)

Owner decision: take the colour palette of the Friday chat audit
(claude.ai artifact `Jr34TUAn2u4nPW6mXWLbWj`) for TECHI, update the docs and
`frontend/src/index.css`, adopt Friday's semantic status tones, and derive a
light theme from it (the source is dark-only).

- Dark: surfaces/text/coral were already Friday; changed `--th-bg-shell`
  `#0B0C0F`, `--th-bg-card-hover` `#22222A`, danger buttons to Friday critical.
- Status (`--th-status-*`) moved off Tailwind: online `#5E8F6C` (Friday OK
  `#5C8C6A`, +2% lightness because it measured 4.47:1 on `--th-bg-card`),
  stale/warning `#C8A000`, offline `#A0A0AA`, critical `#F04A2A`, info
  `#7C9CBF`, maint `#4E8E86`, agent `#8E7CC3`. `--danger/--warning/--success/--info`
  now alias these tokens; `.premium-status-online/offline` use Friday tints.
- Light: slate-blue tint dropped for Friday's neutral greys (page `#F4F4F6`,
  text `#131316`); accent `#C75E49` → `#B6432B` because the old value was only
  4.10:1 on white. Every light status tone was darkened to ≥4.5:1 on `#FFFFFF`
  and `#F4F4F6`.
- Docs: MOBILE-DESIGN-SPEC Colors table rewritten; `docs/ai-context`
  architecture/rules still listed the pre-coral `#FF553F/#FF3F32` and now match
  `tailwind.config.js`.

- Components (second pass, same day): every hardcoded status hex/rgba literal
  in `DevicesTable`, `DeviceDrawer`, `Dashboard`, `DeviceTerminal`,
  `NotificationSettings`, `ComponentStatesPanel`, `EmbeddedSSHModal` and
  `GenericDeviceDrawer` now reads a token (red→critical, amber→warning,
  green→online, blue→info, sky→maint, violet→agent, slate→offline,
  orange→`--th-accent`); alpha variants use
  `color-mix(in srgb, var(--token) N%, transparent)`. Two undefined vars that
  always fell back were fixed: `var(--techi-orange, #f59e0b)` (the RS "Set"
  button rendered amber) → `--th-accent`, and `var(--th-danger, …)` →
  `--th-status-critical`. The status dots next to those glows moved from
  `bg-emerald-400/amber-300/red-400` to `bg-[var(--th-status-*)]`.

- Whole app (third pass, owner: "the whole application must follow this
  palette"): `tailwind.config.js` now maps every Tailwind hue and the slate
  family onto `--th-*` tokens (scale 50–950 built with `color-mix`, opacity
  modifiers preserved), and `techi-*` resolves to tokens instead of fixed
  dark hexes. This moves ~1,580 existing utility-class usages onto Friday without
  touching the class names. The now-redundant `html.light` text overrides for
  hue/slate classes and the dark `.premium-page .text-slate-*` overrides were
  removed; the remaining light overrides, metric/op-pill classes and danger
  text use tokens. The remaining ~240 hex/rgba literals in 21 more
  components were moved onto tokens; inline `rgba(255,255,255,x)` became
  `--th-text-primary` at x%, so it shows in light mode as well. An undefined
  `var(--th-accent-orange, #ff553f)` (the old orange, 6 places in
  AgentCommandsPanel/AgentConfig) → `--th-accent`. The default ring colour
  (Tailwind blue) is reset to the accent. Team colour presets are persisted
  hex values, so only the presets for new picks changed (Friday hexes);
  saved team colours are untouched.

Deliberate literals kept: Login (already Friday hexes, dark-only by design),
PlatformIcon neutrals/coral (already Friday), xterm theme (xterm cannot read
CSS vars), black shadows/backdrops. Requires `color-mix()` (Chrome 111+,
Safari 16.2+, Firefox 113+); older browsers lose these colours. Critical
`#F04A2A` sits close to the coral accent by Friday's own design. Typecheck,
build and vitest (84/84) passed. Deployed 2026-10-05 (see `DEPLOY-2026-10-05`).

## [2026-10-01] REPORTS-PRODUCTION-2026-10-01 — Client and Device Reports deployed

Commit `dbf46c86b80f41baa068dd661a59c27155e2f214` was deployed from the
previous production runtime commit `9c284d4dad89244c733e714d24919a11598ac30f`.
Alembic advanced from `c7n1t8h5p2r6` to `d8e4f6a1b2c3`. A pre-deploy
PostgreSQL dump was stored at
`/opt/backups/techi/pre-reports-deploy-2026-10-01_08-46.sql.gz` (175,961,158
bytes; `gzip -t` passed). Backend and frontend builds passed and both services,
with PostgreSQL, were healthy with zero restarts after rollout.

Five service-level production exports using an existing client and device
passed: Client Full PDF/CSV, Device Full PDF, and Device Alerts PDF/CSV. Their
stored files had the expected names, formats, nonzero sizes, history entries,
repeat reads, and audit entries. Protected Reports history and download routes
returned 401 without authentication. The browser runtime had no available
session, so operator login, UI interactions, and secondary-operator scope were
not live-tested. No recurring backend errors were seen in the post-deploy logs.

Full Device Report is PDF only. Device category reports support PDF and CSV.
Historical sections reflect the retained source data; software history is
snapshot-limited. The frontend build reported 14 dependency audit findings
(including five high severity) without failing the build; no dependency
changes were made during this release. Exact rollback images from `9c284d4`
were rebuilt and tagged `pre-reports-9c284d4` for backend and frontend. The
database migration is additive; its downgrade intentionally refuses to run
while device report rows exist.

## [2026-08-06] CONNECT-CREDENTIAL-2026-08-06 — Connect credential handover: built, shipped, then REMOVED the same day at the owner's request

**STATUS: REVERTED.** Shipped as `41d3f65`, removed by revert a few hours later.
Production never depended on it. This entry is kept so the decision is on the
record and the feature is not proposed again without the reason being weighed.

**Why it was removed.** The owner's goal was never "a credential on the
clipboard" — it was *click once and be logged in*: **"une dua qe te shkoj direk
user pass tek logini dhe une te klikoj vec login"**. Copying cannot deliver
that, and it cannot be made to: the WebFig login form is served by the router,
on a different origin, and the browser's same-origin policy absolutely forbids
one page from writing into another origin's fields. The only two designs that
would work are a server-side WebFig proxy or a local helper app.

Weighed against that, the feature was paying a real cost for a partial result:
it moved plaintext router passwords out of the Vault and onto an operator's
clipboard on every connect. When the owner then ruled out the remaining path on
exposure grounds — **"nuk me intereson te jemi te eksopuzuar ne sulme"** — the
clipboard step had no destination it was leading to, so it came out.

**What was NOT reverted:** the WebFig TLS work and the port-precedence decision
(see the entry below). Those stand on their own.

**If it is ever revisited**, the security reasoning below is the part worth
keeping: the handover must never be served from the launch endpoint, and it is
a Vault *reveal*, not a machine *use*.

---

Original entry follows.

Operator request: *"me duhet te mari dhe user pas nga vault"*. WebFig and Winbox
have no automated login, so the operator types the credential; until now the
Vault held it but nothing ever delivered it — `resolve_credentials_for_method`
was consulted only to decide whether a method showed "ready", and the launch
endpoint never touched it.

### The design question that mattered

The obvious implementation — return the secret from the launch endpoint — would
have been a back door. Launch is gated on `remote_support_connect`; the Vault
gates plaintext on `vault_reveal` (ADMIN role or the team permission) with a
reason and an audit record. Returning secrets from launch would have let every
operator who can click Connect extract stored passwords **without** the reveal
permission and **without** a reveal record, quietly hollowing out that control.

So it is a separate endpoint, `POST /devices/{id}/connect-methods/{id}/credential`,
requiring **both** permissions. The codebase already distinguishes
`get_secret_fields_for_use()` (a live connection consumes a secret; used by
Embedded SSH) from `reveal()` (a human reads plaintext). A human pasting a
password into WebFig is unambiguously the second, so `reveal()` is what runs —
writing the `reveal` usage row, the VAULT REVEAL warning log, and an audit entry
mirroring `POST /vault/{id}/reveal`. Classifying it as a machine "use" would
have understated the audit trail.

The reason is generated (`Connect: webfig on device #733`) rather than prompted.
Free text typed on every connect adds friction and yields worse evidence than a
line that names the method and device and cannot be left blank.

The Vault gate itself is **imported** from the vault endpoints rather than
re-implemented — duplicating a security check is how two copies drift apart.

### Frontend

Opening WebFig, or Winbox on macOS/Windows, now also copies the credential:
`user\tpassword`, so one paste can fill both fields in forms that advance focus
on Tab. Failure is silent by design — the session is already open, and a
missing credential (403 without `vault_reveal`, 409 when none is stored) must
never look like a failed connect.

One ordering bug was caught while writing it: the credential note and the
plaintext-HTTP warning were separate `showNote` calls, so the second overwrote
the first and the security warning could vanish. They are now one message, with
the warning first because it is the part an operator may want to act on before
typing anything.

### Checks

- Backend **1128 passed, 0 failed, 0 errors** in both flag states; 5 new tests
  including the one that matters most — `remote_support_connect` alone returns
  403, so Connect cannot be used as a route around `vault_reveal` — plus proof
  the handover is recorded as a `reveal`, not a `use`.
- `tsc --noEmit`, frontend build, agent build clean.

## [2026-08-06] WEBFIG-TLS-2026-08-06 — The WebFig link was hardcoded to http://, so a router password crossed the internet in the clear; and two places could set a port

Found while answering whether the Vault could supply WebFig's user/password.
Wiring credentials into a link that is always plaintext would have automated
the transmission of a router password in the clear, so this had to come first.

### Root cause

`device_connect_launch` built browser URLs as `f"http://{authority}{web_path}"`
— the scheme was a literal, with no way to ask for TLS at all. With the Connect
target now resolving to a router's **public** address, every WebFig login sent
the RouterOS password across the internet unencrypted.

### Fix

- Port **443 selects `https`**, which is RouterOS's `www-ssl` port. http stays
  the fallback rather than the default being flipped: RouterOS ships `www-ssl`
  **disabled**, so defaulting to https would break every router that has not
  enabled it. What changed is that an encrypted WebFig is now reachable at all.
- `ConnectLaunchResponse.insecure` reports when the URL is plain http. The
  Connect menu shows an explicit warning on open, and the `remote_connect`
  audit record carries the flag — so a plaintext session is stated, not
  silently handed over.
- The default port is no longer repeated in the URL (`:80` on http, `:443` on
  https), which keeps the common case clean.

### Port precedence, decided

Two places can now express a port: `devices.connect_port` and the Vault
credential's `metadata_json.port` (the `webfig` type defines one, default 80).
Left undecided this would have become two competing settings with no stated
winner.

**The device's `connect_port` wins; the credential's port is the fallback.**
The device field is the operator's explicit statement about *this* device,
while a credential may be scoped to a whole client or the entire fleet — the
narrower, more specific setting should win.

`credential_port()` reads `metadata_json` only. That column is non-secret by
construction, so the fallback needs no reveal, no decryption and no audit
event, and a credential lookup failure can never break a launch.

### Not done

The Vault still does not supply WebFig's username/password — that was the
question that started this, and it stays open by choice. The two prerequisites
it needed are now in place: TLS is reachable, and the port has one owner.

### Checks

- Backend **1123 passed, 0 failed, 0 errors** in both flag states; 5 new tests
  covering http default + insecure flag, 443→https, default-port omission,
  non-default port, and desktop schemes never being flagged.
- Two existing tests compared the whole launch payload and needed the new
  `insecure` field; the URLs they assert are unchanged.
- `tsc --noEmit`, frontend build, agent build clean.

## [2026-08-06] MIKROTIK-CONNECT-2026-08-06 — All three MikroTik Connect methods were dialling the LAN address; no tunnel was needed, the launcher was pointed at the wrong IP

Operator report: *"lidhja e connect kemi 3 menyra por asnjera nuk funksionon"* —
Winbox, Embedded SSH and WebFig all fail. The operator's actual workflow, which
turned out to be the decisive input: Winbox on **both Windows and macOS**,
reaching routers **by public IP**, or **by LAN IP over the office VPN** when
there is no public IP, and often on **non-standard ports (8292, 8293)**.

### Root cause

[connect.py:355](../backend/app/api/v1/endpoints/connect.py#L355) built the
target as `device.local_ip or device.public_ip`. For device 733 (`Mario Home`)
that is `192.168.88.1`, so the launcher produced `winbox://192.168.88.1` and the
reachable public address `79.98.113.14` was discarded — `local_ip` is truthy and
came first. Device 735 (`Main Router`) got `winbox://10.126.1.1` the same way.
Line 359 then appended no port, ever, so 8292/8293 were inexpressible.

Three symptoms, one cause: Winbox and WebFig were both handed an unreachable LAN
address, and Embedded SSH is switched off entirely (`FEATURE_SSH` is not in the
production `.env` — RISK-SSH-001, owner decision 2026-08-05).

**An initial reading of this as the NAT problem was wrong and was corrected.**
For a PC, `public_ip` is the customer's edge router and is useless. For a
router, *the device IS the NAT box* — the address its heartbeat was observed
arriving from is the router itself, and it is directly reachable. So MikroTik
needed no tunnel, no proxy and no agent: it was already reachable and was simply
being given the wrong address.

### Fix

- `resolve_connect_host(device, platform_id)`: an operator-set `connect_host`
  wins; otherwise **network gear prefers `public_ip`**, and **everything else
  keeps `local_ip` first, unchanged**. The public-IP preference deliberately
  does not generalise — for a PC or a NAS the observed public IP is the edge,
  not the device. "Network gear" is decided by the Unified Classification
  Engine, never by a platform list at the call site, so it cannot disagree with
  the tree or the counters.
- New nullable `devices.connect_host` / `devices.connect_port`
  (migration `c7n1t8h5p2r6`), settable through the existing admin-gated
  `PUT /devices/{id}`, surfaced as an editable **Connect target** row in the
  generic device drawer. This covers the office-VPN case (pin the LAN address)
  and the non-default-port case. NULL keeps the reported-address behaviour, so
  the migration alone changes no device.
- Winbox no longer declares `requires_client_os="windows"`. Winbox 4 ships a
  native macOS build; the gate was disabling a method that works. The frontend
  gate reads that field straight from the backend, so macOS unlocks with no
  frontend change.

### Two design decisions reversed

Both had tests encoding them, updated with the reason recorded in place:
`test_winbox_uses_scheme_and_local_ip` asserted `winbox://192.168.88.1` — the
exact broken URL — and `test_winbox_visible_but_unavailable_on_macos_operator`
asserted the macOS block. Renamed to `test_network_gear_prefers_public_ip` and
`test_winbox_is_not_blocked_on_a_macos_operator`. The V3 mockup rule "never
silently hide a method" is untouched.

### Checks

- Backend **1118 passed, 0 failed, 0 errors** in both flag states. Note: the
  first preflight run after this change reported PASSED while carrying 2
  failures, because its `KNOWN_BACKEND_FAILURES=4` baseline masked them. The
  baseline is stale — the suite is at zero. The two failures were found and
  fixed rather than accepted; a green gate with tolerated failures is not a
  green gate.
- 6 new launch tests: public-IP preference, the non-generalisation guard across
  windows/linux/synology/qnap, `connect_host` override, and port appending for
  both scheme and browser methods.
- `tsc --noEmit`, frontend production build, agent build (windows+linux) clean.
- Migration validated offline with `alembic upgrade --sql`: two nullable
  `ADD COLUMN`s, reversible by `downgrade`.

### Not done

Embedded SSH stays off — unchanged owner decision. The MikroTik connector
remains one-way telemetry: the RouterOS scheduler posts with
`/tool fetch … output=none`, so the response is discarded by construction and no
action can ever reach a router. That is the Phase 7 boundary ("Registration
only — no RouterOS management"), not a defect, but it means Connect is the only
management surface these devices have.

## [2026-08-06] ENROLL-PLACEMENT-2026-08-06 — Non-Windows platforms now enroll hands-free into their own group, and the token group picker stopped fighting the feature that already existed

Operator report: nga faqja Deployment, tokeni lidhej me klientin pa problem, por
te zgjedhja e grupit dilte një mur "Client PC" i përsëritur pafundësisht, pa
asnjë mënyrë për të dalluar cilin i përkiste klientit të duhur. Kërkesa:
pajisjet jo-Windows (Linux, MikroTik, QNAP, Synology) të ulen vetë te grupi i
duhur, i krijuar nën klient nëse mungon. Windows-i të mos preket — *"eshte
super ok"*.

### The feature already existed; the UI disabled it

`apply_enrollment_assignment` vendos prej kohësh pajisjen te `Servers` ose
`Client PC` kur tokeni mban **Client pa Group**, duke i krijuar grupet sipas
nevojës. Dega është `if client_id and not group_id` — pra **zgjedhja e një
grupi e çaktivizon auto-caktimin**. Hapi manual që operatori detyrohej të bënte
ishte pikërisht ai që fikte sjelljen e kërkuar.

Shkaku i detyrimit: [Deployment.tsx:141](../frontend/src/pages/Deployment.tsx#L141)
thërriste `getGroups()` pa filtër klienti — ndonëse edhe klienti API
([clients.ts:121](../frontend/src/api/clients.ts#L121)) edhe backend-i
(`GET /api/v1/groups?client_id=`) e mbështesnin prej fillimi — dhe select-i
shfaqte vetëm `g.name`, pra një "Client PC" për çdo klient në sistem.

**Fix (frontend).** Grupet filtrohen sipas klientit të zgjedhur (`DeviceGroup`
mban `client_id`, ndaj filtrimi është lokal; thirrja e pafiltruar mbetet sepse
tabela e përdor për emrat e grupeve të çdo tokeni), ndërrimi i klientit pastron
grupin, select-i çaktivizohet pa klient, dhe opsioni bosh u riemërtua nga
"No group" në **"Auto by device type (Servers / Client PC)"** — emri i vjetër e
paraqiste rrugën e saktë si mungesë grupi.

### Placement extended to non-agent platforms

[device_assignment_service.py:101-120](../backend/app/services/device_assignment_service.py#L101-L120):
grupi tani emërtohet sipas etiketës së kategorisë dhe krijohet nën klient sipas
nevojës — MikroTik/UniFi/Cisco ▸ `Network`, QNAP/Synology ▸ `Storage`,
VMware/Proxmox/Hyper-V ▸ `Hypervisors`. Windows ndjek rrugën identike si më parë
(kategoria e tij del gjithmonë `servers`/`clientpc`).

**Pse është e sigurt.** Te `_CATEGORY_RULES` rregullat e platformës renditen
**para** rregullit gjenerik "ka grup", dhe `Network`/`Storage`/`Hypervisors`
nuk janë në `_SERVER_GROUP_NAMES`/`_CLIENT_GROUP_NAMES`. Pra mbajtja e një grupi
real nuk e ndryshon kurrë kategorinë. Ajo që *do* ta prishte është futja e tyre
në një grup standard agjenti — kufi që u ruajt. Pema nuk preket fare: e ndërton
pamjen nga kategoria dhe injoron grupet (`void groups;`).

### A design decision was reversed

`test_mikrotik_token_enrollment_stays_ungrouped_and_network` pohonte
`out.group_id is None` — kodifikonte vendimin e mëparshëm që platformat jo-agjent
të mbeteshin pa grup. U riemërtua dhe u rishkrua te sjellja e re, me arsyen në
docstring. Ky ishte ndryshim dizajni me miratim të pronarit, jo rregullim gabimi.

### Existing devices must not move (owner requirement)

Miratimi erdhi me kusht: pajisjet aktuale të shfaqen njësoj edhe pas ndryshimit.
Kjo qëndron strukturalisht — rregulli i ri ka **një thirrës të vetëm**
(`agent_enrollment_service.py:123`, i mbrojtur nga `if not reenrollment_matched`),
`apply_enrollment_assignment` del herët për çdo pajisje me caktim autoritativ,
dhe rruga auto/trusted-domain (`_detect_group`), e vetmja që prek pajisje
ekzistuese në heartbeat, mbeti e paprekur me vetëm `Servers`/`Client PC`.
Katër teste guard e kyçin këtë, përfshirë paritetin e pamjes: një MikroTik pa
grup vazhdon të japë `resolved_group == "Network"` përmes etiketës së kategorisë.

Nuk u bë backfill — MikroTik-ët ekzistues mbeten me `group_id` NULL me qëllim.

### Checks

- `pytest -k "assign or classif or enroll or tree or group or trusted or device or mikrotik"`
  — **323 passed**, me 9 teste të reja (5 për vendosjen e platformave jo-Windows,
  4 guard për mos-prekjen e pajisjeve ekzistuese).
- `npx tsc --noEmit` — pastër.
- `test_agent_command_channel.py` dhe `test_terminal_endpoint.py` dështojnë, por
  u verifikua me `git stash` se dështojnë njësoj në pemën e paprekur — të
  mëparshme dhe të palidhura.
- Jo e deployuar.

### Open: Linux servers enrolled by token stay in Client PC

`AgentEnrollmentRequest` nuk ka fushë `device_type` dhe heuristika e serverit te
motori është vetëm Windows (`windows_product_type`, teksti "windows server"), pra
një server Linux merr kategorinë `clientpc` në enrollim. `LinuxAdapter.classify_device_type`
do ta korrigjonte `device_type` në heartbeat — por ri-grupimi te
[device_heartbeat_service.py:213-223](../backend/app/services/device_heartbeat_service.py#L213-L223)
kryhet vetëm `if not manual_locked`, dhe `enrollment_token` **është** burim
manual-lock. Rezultati: `device_type` bëhet SERVER, grupi mbetet `Client PC`
përgjithmonë, dhe meqë emri i grupit renditet para heuristikës së OS-it, edhe
pema vazhdon ta tregojë si Client PC. Shih RISK-ENROL-002.

## [2026-08-06] RS-IDENTITY-LOCK-2026-08-06 — Device 711 could not connect because the agent locks RustDesk's identity file read-only; DIAGNOSED, FIX NOT APPLIED

Operator report (device 711): Remote Support nuk lidhet, dhe `set_remote_password`
raporton sukses pa pasur efekt. Riinstalimi nga UI nuk ndryshoi asgjë. **Vetëm
kjo pajisje** — pjesa tjetër e flotës lidhet normalisht dhe një pajisje tjetër e
provuar e mori password-in rregullisht. Ai fakt përjashton çdo shkak sistemik dhe
e ngushton çështjen te renditja e ngjarjeve në këtë makinë.

Action log: `deploy_remote_support` → `install=installed version=1.4.6.0
config=written service=running protocol=written id=73997312`; `set_remote_password`
→ `Remote password changed successfully`.

### Evidence from the machine

Read-only dump i të gjitha dosjeve config (PowerShell, si Administrator):

- Vetëm **një** skedar mban identitet të vërtetë —
  `C:\Users\kfc.k02.teg\...\TECHI Remote Support.toml`, me `enc_id` dhe `salt`
  (relikt i kohës kur RustDesk punonte në atë profil; `2.toml` i tij daton 07/21).
- Të dyja dosjet e shërbimit (`systemprofile`, `LocalService`) kanë
  `TECHI Remote Support.toml` **pa `id`, pa `enc_id`, pa `salt`** — vetëm
  `password` plus `custom-rendezvous-server`/`relay-server`/`key`. Kjo është
  fjalë për fjalë prodhimi i `buildRustDeskTOML`
  ([rustdesk_manage.go:240-266](../agent/rustdesk_manage.go#L240-L266)) me
  password-in e ngjitur sipër nga `setRustDeskPassword`.
- Të gjithë identity TOML: `ReadOnly=True`, të gjithë me timestamp **12:11:56**.
- `2.toml` në të njëjtat dosje: `ReadOnly=False`, **12:12:22** — 26 sekonda më
  vonë, shkruar nga vetë RustDesk. Kjo provon që shërbimi është gjallë, po
  shkruan, dhe po përdor pikërisht ato dosje.

### Root cause

Shërbimi niset → lexon skedarin e vet të identitetit → nuk gjen `id`/`salt` →
i gjeneron në memorie → provon t'i ruajë → **skedari është read-only
(`os.Chmod(path, 0444)`, [rustdesk_readonly.go:20-24](../agent/rustdesk_readonly.go#L20-L24))
→ ruajtja dështon**. Identiteti nuk persistohet kurrë. I njëjti bllokim ndalon
edhe persistimin e password-it të hash-uar, sepse pa `salt` të ruajtur hash-i
nuk rikrijohet dot i njëjtë. Prandaj `set_remote_password` raporton sukses me
ndershmëri — agjenti e shkruan vërtet tekstin e thjeshtë në skedarë që i çbllokon
vetë — por shërbimi s'e mban dot.

Connect-i ndërtohet nga `device.rustdesk_id` në DB
([remote_support.py:165](../backend/app/api/v1/endpoints/remote_support.py#L165)),
jo nga ajo që raporton agjenti; me një ID që nuk ngjitet, DB-ja mbetet me një ID
të vdekur.

**Pse vetëm kjo pajisje.** Renditja. Në makinat e shëndosha RustDesk e shkroi
identitetin e vet *përpara* kalimit të parë të riparimit, ndaj vula read-only
ngriu një identitet tashmë të vlefshëm — e padëmshme. Këtu rruga e skedarit të
freskët ([rustdesk_manage.go:221-234](../agent/rustdesk_manage.go#L221-L234))
krijoi skedarë pa identitet në dosjet e shërbimit, dhe një kalim i mëvonshëm i
kyçi. Çdo riinstalim shkakton një riparim tjetër, pra e përkeqëson.

**Pse rikthehet vetvetiu.** `rustDeskConfigNeedsRepair`
([rustdesk_toml.go:150-168](../agent/rustdesk_toml.go#L150-L168)) i kërkon
opsionet e menaxhuara brenda skedarit të **identitetit**. RustDesk i shkruan
opsionet te `2.toml` dhe kurrë te identiteti — pra ai kontroll kthen `true`
përgjithmonë → patch → `setTomlReadOnly`, në çdo cikël riparimi
([rustdesk_manage.go:74-102](../agent/rustdesk_manage.go#L74-L102)). Çdo
rregullim manual rikyçet brenda 30 minutash.

### Relation to the deferred item of 2026-06-28

Ky është pikërisht borxhi i shënuar dhe i shtyrë me kërkesë të përdoruesit te
hyrja `[2026-06-28]` më poshtë: `managedRustDeskOptions`/`writeRustDeskConfig`
shkruajnë `rendezvous_server`/`[options]` në skedarin pa prapashtesë. Aty u
vlerësua si ndoshta "inert/no-op". Nuk është inert — është **aktivisht
shkatërrues** kur fiton garën ndaj shkrimit të parë të RustDesk-ut.

### Status: OPEN

- Mekanizmi mbështetet fort nga provat, por hapi përfundimtar i konfirmimit
  **nuk u ekzekutua**: testi i lëvizjes së ID-së (restart shërbimi → rilexo `id`)
  mbeti pa u bërë sepse operatori u shkëput nga makina. Të kryhet para se fiksi
  të quhet i verifikuar.
- Zbutja në makinë (stop service → hiq read-only → fshi me backup skedarët e
  identitetit pa `id`/`enc_id` në dosjet e shërbimit → start) është hartuar por
  **nuk është aplikuar**. Është e përkohshme; riparimi i agjentit e rikyç.
- Fiksi i vërtetë është në kod: opsionet te `TECHI Remote Support2.toml`
  (Config2), skedari i identitetit të mos vihet kurrë read-only, dhe
  `set_remote_password` të verifikojë efektin në vend që të raportojë shkrimin
  (`wrote = true` edhe kur asgjë s'ndryshon —
  [rustdesk_manage.go:396-399](../agent/rustdesk_manage.go#L396-L399)).
  Nuk është shkruar ende; prek gjithë flotën dhe prodhimi është në total rollback.

## [2026-08-05] TERMINAL-CHANNEL-2026-08-05 — The Web Terminal was unusable on Linux; fixed by pushing instead of waiting, without opening a single port

Operator report (2026-08-04, device 729 `rustdesk-srv`): the Web Terminal never
opened. Every attempt ended `reason=operator_closed` — the operator gave up
before the session started. The instruction that shaped the whole fix was
explicit: *"nuk dua te eksposoj porta apo mundesi per sulme pasi jane servera"*,
and *"windows nuk preket"*.

### Root cause: three 60-second deadlines racing a 250-second heartbeat

Actions reach an agent only inside its heartbeat response. Linux heartbeats
every 250s, but the terminal ticket, the action timeout and the advertised
`expires_in_seconds` were all fixed at 60s. The ticket was therefore **always
dead before the agent could learn the session existed** — not a race, a
certainty. Measured after the fix: delivery at 202s succeeded where the old 60s
ceiling had expired 142 seconds earlier.

The fix derives the deadline instead of hardcoding it
([terminal_service.py:59](../backend/app/services/terminal_service.py#L59)):

```
ticket TTL = heartbeat interval for that platform + 60s attach grace
           = 310s on Linux, 360s on Windows, 310s on MikroTik
```

A second defect surfaced alongside it: a duplicate `open_terminal` returned a
500. It now returns 409 and closes the orphaned session.

### The real fix: an outbound channel, not an inbound port

Raising the TTL makes the terminal *work*; it does not make it *usable* — four
minutes to open a shell is not a product. Shortening the heartbeat interval was
the other obvious lever, and it is the one that took production down on
2026-07-31 (300→180). Neither was acceptable.

The model that satisfies both constraints is the one RustDesk already uses in
this same stack: **the agent dials out and holds the connection open, and the
server pushes down it.** No listening port, no inbound firewall rule, no NAT
traversal, no public IP — the property that makes the agent transport work at
all is preserved exactly, which is what the operator asked for.

- [`agent_channel.py`](../backend/app/websocket/agent_channel.py) — one
  connection per device; a reconnect evicts the stale socket; a late teardown
  cannot evict the connection that replaced it; `push()` never raises.
- [`agent_channel_routes.py`](../backend/app/websocket/agent_channel_routes.py)
  — `/ws/agent/commands`, gated on the device's own `agent_id` (144 bits,
  `compare_digest`, both sides must be non-empty — the RISK-SEC-002 barrier).
  Push-only: inbound frames are ignored.
- `deliver_now()` marks the action SENT, so the next heartbeat cannot deliver
  the same action twice and open a second shell.

**Push is strictly an accelerator.** Every action is persisted first; an agent
that is not connected is served by the heartbeat path exactly as before. This
is what makes the rollback trivial — the channel is never a dependency.

Scope held to Linux by build tag (`command_channel_linux.go` /
`command_channel_other.go`, a no-op everywhere else). Windows was not touched:
it is healthy on the heartbeat path, and a persistent connection from 799
Windows endpoints to a single-vCPU host is not something to ship as a side
effect. Four source-level tests pin that boundary so a build-tag mistake cannot
widen it silently.

### A defect I introduced, and how it was caught

The capacity guardrail I had written charged the **entire fleet** (791 devices)
against **every** platform. It would have refused `linux: 60` — a setting whose
real cost is 0.02 req/s against a 3.0 req/s budget, roughly 150× under. The
guard was protecting production from arithmetic that did not describe
production. Fixed to count devices per platform
([agent_config.py](../backend/app/api/v1/endpoints/agent_config.py)); recorded
here because the guard would otherwise have looked like correct behaviour.

Two test defects surfaced the same way: `pal_test.go` asserts non-Linux
behaviour but carried no build tag, so it was red on Linux **by construction**
and would have blocked the new CI on its first run; and a test forbidding the
string "websocket" in the non-Linux stub tripped on its own explanatory comment.

### Reproducible builds for the Linux agent

Agent 2.1.21 is the first Linux agent built by CI rather than cross-compiled
from a workstation — deliberate, because the channel and the PTY terminal are
both Linux-only and a macOS cross-compile never exercises them.
[`build-agent-linux.yml`](../.github/workflows/build-agent-linux.yml) gates on
`go vet` + `go test` **run natively on Linux**, builds amd64 and arm64, records
SHA-256 per binary, verifies the architecture with `file`, and fails if a
Windows artifact ever appears. It is a separate workflow from the MSI on a
separate trigger; the two cannot interfere.

```
2.1.21 linux/amd64  sha256 08647488082590afecb68fb652c5f4cbeb5a223e8bed8c39d60dba2af58df063
```

### Verified against production before handing over the binary

The failure mode that worried us most was silent: if nginx-proxy-manager did
not forward the WebSocket upgrade, the channel would simply never connect and
nothing would say why. Tested with a real handshake from outside:

```
WebSocket /ws/agent/commands?device_id=729&agent_id=invalid  → 403
[agent-channel] rejected device_id=729 (unknown device or agent_id mismatch)
```

The upgrade traversed the edge and reached the backend, and the auth gate
rejected the bad credential. Both halves proven in one request.

Deployment to 729 is manual and operator-run: 10.5.50.126 is unreachable from
the platform host (NAT), the heartbeat `agent_update` field is still
`None` — there is **no server-side self-update channel in production** — and
the only Linux package in the manifest is `linux-arm64` 2.1.6 against an x86-64
target. The deploy script refuses any binary whose SHA-256 differs from the CI
build, backs up the running binary, and restores it automatically if the
service does not stay up for 20 seconds.

### Distribution: the designed path already existed, and had a hole in it

Rather than inventing a transfer route, the agent was published through the
mechanism already built for this: `/api/v1/agent-packages/platform/{platform}/download`,
which is public by design and already lists `linux-amd64` as an allowed
platform. Registering it exposed the hole — **no `linux-amd64` package existed
at all**, so that endpoint had always returned 404 for x86-64 Linux. The only
Linux entry in the manifest was `linux-arm64` 2.1.6.

The blast radius was larger than one URL. The operator-facing install generator
(`GET /api/v1/install/linux?token=…`, the "Deploy" screen) emits a script whose
download line is `curl -fsSL …/platform/linux-${ARCH}/download`. On any x86-64
host that resolved to the missing `linux-amd64` package, and `-f` makes curl
exit 22 on a 404 — so **the entire Linux onboarding flow died at that line for
every x86-64 machine**, before writing config or enrolling. Confirmed after the
fix by comparing platforms: `linux-amd64` now returns 200, while `linux-armhf`
(still unregistered) returns 404 and reproduces the exit-22 failure exactly.

Registration was performed by calling `AgentPackageService.upload()` inside the
container rather than hand-editing `manifest.json`, so the file was hashed,
validated and recorded exactly as an operator upload would be. The manifest was
backed up first (`manifest.json.bak-pre-linux-amd64-20260805`). Verified from
outside afterwards: the bytes the public URL returns hash to the CI SHA.

Two facts about the store were wrong in the previous baseline and are corrected
in PROJECT_STATE §5: `AGENT_PACKAGE_STORAGE_DIR` is the *relative* path
`agent_packages`, so it resolves to `/app/agent_packages` (named volume
`techi-platform_agent_packages`), **not** the `/opt/techi/packages` bind mount,
which nothing reads at runtime.

### Outcome: deployed and connected

Agent 2.1.21 went onto device 729 at 2026-08-05 01:16 CEST. Both acceptance
conditions were met within a second of the service starting:

```
[agent-channel] device #729 connected
729 | rustdesk-srv | 2.1.21
```

The connection then held past the 180s idle timeout with no disconnect,
reconnect or `idle past 180s; closing` line — the agent's 60s ping against the
server's 180s receive timeout gives a 3× margin, and two ping cycles completed.
The previous binary is retained on the host as `techi-agent.bak-2.1.5`, so the
rollback remains one `cp` and a restart.

### The install generator cannot upgrade a running host

The first attempt used the operator-facing generator and failed:

```
Downloading TECHI agent (linux-amd64)...
curl: (23) Failure writing output to destination
```

`install.py:67` writes the download **directly over** `/usr/local/bin/techi-agent`.
Linux refuses a write to a running executable (`ETXTBSY`), so curl exits 23 and
`set -euo pipefail` stops the script. The installer works only on clean hosts —
it cannot upgrade or repair an existing install.

The failure landed in the safest possible place. It occurs *before* the
`cat > "${CONFIG_PATH}"` block, and `agent_id`/`device_id` live inside that file
(`config.go:20-21`), so nothing was overwritten: device 729 kept its identity,
no enrolment ran, no duplicate device appeared, the fleet count stayed at 802.
Had the download succeeded, the script would have rewritten the config and
re-enrolled — on an existing device that invites the RISK-IDENT-001 dedup path
that collapsed devices 774/800.

The upgrade was completed instead by stopping the service, downloading to
`/tmp`, checking the SHA-256 against the CI build, and installing — which is
what the deploy script had been written to do, and the reason it stops the
service first. Raised as RISK-INSTALL-001.

### The Web Terminal had never worked, and the channel is what revealed it

With delivery fixed, the terminal still failed — and the cause turned out to
have nothing to do with the channel. `TerminalRelay.pump` treated a missing
counterpart as a reason to stop:

```python
target = pair.agent if is_operator else pair.operator
if target is None or pair.closed:
    break
```

The operator always attaches first: the agent only learns a session exists
when it receives `open_terminal` and dials back. xterm.js sends a resize frame
the instant its socket opens. So the operator's **first frame** found
`pair.agent is None`, broke the pump, and the route's `finally` closed the
session. The agent then arrived, found a CLOSED session, and had its ticket
rejected by `_valid_pending` as "invalid/expired". The browser saw the socket
drop, showed "Connection lost", and retried — the ~2s cycle in the logs.

This was invisible while delivery took minutes, because the operator had
always given up long before the agent dialled; the failure read as latency.
Fixing delivery is what made it reproducible in under a second.

`pump` now buffers operator frames (bounded at 64) while the agent is missing
and continues; `attach_agent` replays them, so the initial resize survives.
Embedded Terminal (agent/bash) works in production as of 2026-08-05 01:45 CEST.

### Two defects of my own, in the delivery path

Both found because the terminal still failed after 2.1.21 shipped:

**The push never ran.** `create_terminal_session` is a sync endpoint, so
FastAPI executes it in a worker thread where `asyncio.get_running_loop()`
raises `RuntimeError` — always, for every request. Fixed by capturing the loop
at startup and scheduling with `run_coroutine_threadsafe`, bounded at 5s.

**The action was marked SENT before the push.** `deliver_now()` ran first, so
every `open_terminal` was recorded as delivered and then delivered to nobody —
the heartbeat path collects only QUEUED work. The duplicate-action guard then
blocked every retry ("already queued or running, action #2344, status=sent").
`deliver_now` is now split into `build_delivery` (pure) and `mark_delivered`,
and the mark happens only once the socket has accepted the frame.

Worth recording plainly: between these two, the change intended to *accelerate*
terminal delivery had instead broken it completely, and the earlier reading of
`sent_at == created_at` as "the channel delivers instantly" was wrong — that
timestamp was the premature SENT mark, not a delivery.

### Embedded SSH cannot work for this fleet as designed

Embedded Terminal works; Embedded SSH still fails with
`ssh connect failed: device_id=729 reason=timeout`. This is not a bug in the
above — it is the transport the feature was built on. `terminal.py:371` selects
`host = device.local_ip or device.public_ip` and the **backend** dials SSH
itself (the Connect menu labels it honestly: "Backend relay · Vault"). For
device 729 that is `10.5.50.126`, private and behind the customer's NAT, so the
platform host cannot reach it. The `public_ip` fallback would require port 22
open to the internet on a customer server — explicitly ruled out by the owner
("nuk dua te eksposoj porta apo mundesi per sulme pasi jane servera").

So Embedded SSH is usable only for devices the platform can already reach
directly, and no device in this fleet qualifies. Raised as RISK-SSH-001. The
fix that respects the constraint is to carry SSH over the agent the way the
terminal now is: a TCP-forward action where the agent bridges bytes to
`host:22` and the backend keeps asyncssh and the vault credential server-side,
so credentials never reach the endpoint and no port is exposed. Not built.

### The Linux version badge could never be green

Reported by the operator: device 729 showed no "current" badge despite running
2.1.21, the newest build. `version_service` documents Windows *and Linux* as
agent platforms whose latest version comes from the active AgentPackage, but
`get_active_version` only ever looked up `windows-amd64`; every other agent
platform fell through to `return None`, and `compare_versions(reported, None)`
yields "unknown". No Linux device could ever be badged, at any version.

The package platform is now derived from the device's reported architecture
(`devices.architecture`, `x86_64` for 729), so an arm64 endpoint is measured
against `linux-arm64` instead of being marked outdated whenever the amd64 line
moves ahead. An unknown or absent architecture still resolves to None and keeps
the badge "unknown" — honest, rather than guessing a build the device may not
be running. Verified in production: `get_active_version("linux", "x86_64")` →
`2.1.21`, status `current`.

**The Device List needed a second fix.** The badge there is resolved
independently of the drawer, and `resolveActiveVersion` sent every non-Windows
row to the connector-version map. Linux is an agent platform and never appears
in that map, so it resolved to `null` and stayed grey — the operator's
screenshot showed 729 on 2.1.21 sitting next to a green Windows 2.1.20. The
fleet overview now publishes `active_agent_versions` keyed
`"<platform>:<uname -m>"` (`{"linux:x86_64": "2.1.21"}`), built from
`version_service` so the arch→package table exists in one place instead of
being restated in TypeScript. Windows is deliberately excluded and keeps using
`active_agent_version`, so its badges are byte-identical. Verified in
production after deploy.

**And a third place: the counts.** The AGENT UPDATE tile and the Needs Agent
Update filter ran their own check, `isAgentOutdated(device, activePackageVersion,
…)`, which compared *every* device against the Windows package version. A
MikroTik connector on 1.0.0 and a Linux agent on 2.1.21 were therefore both
"outdated" against Windows' 2.1.20 — the operator noticed MikroTik devices
queued for an update they did not need. Backend and Device List now resolve
each device against its own platform's latest; a platform with no known latest
is never counted, and a version *ahead* of the package is not counted either.
Windows keeps the original two-state check including the sha256 comparison, so
its counts are unchanged. Measured on production data immediately after
deploy: **59 → 56**, the difference being exactly 2 MikroTik and 1 Linux.

The same defect existed in three independent implementations — drawer, table
badge, and counts — because each surface re-derived "what is the latest
version" locally. `version_service` is now the single source for all three.

Noted while verifying: the `linux-arm64` 2.1.6 package is now `is_active:
false` and was active in the 23:03:55 manifest backup. It was **not** the
linux-amd64 registration that changed it — that sequence was replayed against
the pre-change manifest in a scratch container and left arm64 active, since
`set_active` only deactivates entries with the same platform key. The manifest
was rewritten at 23:06:15 by something else that left no audit trail, because
package activation is not audited. Recorded rather than reverted: the operator
may have made the change deliberately, and there are no arm64 devices, so
nothing is affected either way.

### Decision: Embedded SSH stays off, and the agent tunnel is not built

Gated behind `FEATURE_SSH` (off by default, depends on
PLATFORM_CORE/LINUX/VAULT/TERMINAL) and enforced in three places: the Connect
menu reports it unavailable with the real reason, and both the
credential-candidates and session-creation routes return 404 so the flow cannot
be driven directly while the menu says it is off. Shown rather than hidden,
following the registry's own rule — never silently hide a method.

The agent-tunnel design was assessed and declined by the owner on 2026-08-05.
It is viable: the agent forwards TCP, the backend keeps asyncssh and the vault
credential, so no credential reaches the endpoint and no port is opened. It was
declined because Embedded Terminal already gives a root shell over the agent,
making SSH's marginal value least-privilege access and credential auditing —
not access itself.

The security assessment is the part worth keeping. The whole margin rests on
one decision: **the agent must hard-code its destination to `127.0.0.1:22`.**
If it accepted `host:port` from the server, every agent would become a general
TCP proxy into the customer LAN — reaching machines with no agent, and
localhost-only services that are unauthenticated precisely because they are
localhost-only. Against the endpoint itself the tunnel adds little, since
`run_command` already executes arbitrary commands as root; what it would add is
a quiet, persistent channel that starts no process. Anyone reviving this must
carry the hard-coded destination with it.

### The channel never engaged on a freshly-installed endpoint

Device 812 (`debian3xc`) enrolled cleanly on 2.1.21 — correct identity, healthy
heartbeat — and then opening a terminal returned "already queued or running
(action #2481, status=queued)". No `device #812 connected` ever appeared, while
729 connected immediately. The agent had made **zero** connection attempts; not
rejected, never tried.

Cause, and it is mine. `runCommandChannel` was handed the `*Config` loaded at
startup. Enrolment does not touch that struct: `runSingleHeartbeat` calls
`loadConfig(configPath)` and persists `agent_id`/`device_id` onto its own copy.
So on a host that enrolled during its first run, the goroutine's struct stayed
identity-less for the process lifetime, `commandChannelURL()` returned `""`
every cycle, and the channel stayed dark until the service was restarted. 729
was unaffected only because it was already enrolled when 2.1.21 started — the
one case that hid the defect during the original rollout.

Nothing broke: actions fell back to the heartbeat path and were delivered on
the next cycle, which is the pre-channel behaviour. Action #2481 completed on
its own while being investigated. But the accelerator engaged on exactly zero
newly installed endpoints, which is every endpoint from now on.

Agent 2.1.22 takes the config path and reloads it each cycle, matching what the
heartbeat path already does. Two regression tests: one drives a config from
unenrolled to enrolled on disk and asserts the URL resolves only after the
reload — and that the stale struct still does not — and one pins the signature
so the struct cannot be reintroduced.

### restart_agent lied, and self_update could not work on Linux

Both reported on device 812, and both matter at fleet scale — the owner's
constraint is "we may have 200 Linux machines and cannot go to each one by
hand". Command delivery stays on the heartbeat by owner decision; the command
channel continues to accelerate `open_terminal` only.

**restart_agent worked and reported failure.** `systemctl restart techi-agent`
SIGTERMs the agent itself. The handler ran it under the action's context, so
that signal cancelled the context and killed the systemctl child mid-restart,
recording `signal: terminated`. Proven by observation rather than reading: the
command channel dropped at 14:44:19 and reconnected at 14:44:24, and the device
came back on 2.1.22 — the restart had succeeded every time. The restart is now
detached into its own session (`Setsid`) and delayed 3s so the completion
callback reaches the server before systemd stops the process.

**self_update was impossible on Linux for two independent reasons.** The agent
handler ignored the action parameters entirely and called
`performSelfUpdate(&AgentUpdate{Available: false})` — doing nothing while
returning "triggered" — so the backend, which holds the action in `running`
until a heartbeat confirms a version change, waited for a change that could
never come. Separately, `_build_self_update_payloads` sourced every payload
from `SELF_UPDATE_PLATFORM = "windows-amd64"`, so a Linux agent was handed the
Windows `.exe` URL. Notably `performSelfUpdate` in `update_linux.go` was
already complete — download, SHA-256 verify, atomic swap keeping `.old`,
systemctl restart — so the fix was to stop starving it.

The handler now mirrors Windows exactly (`download_url`/`version`/`sha256`),
and the payload builder resolves each device's own architecture. Verified on
production data: a real bulk self_update for 812 produced
`platform/linux-amd64/download`, version 2.1.23, matching SHA. Windows is
untouched, legacy MSI bridge included, and a test asserts a mixed batch gives
each device its own binary.

Chicken-and-egg worth recording: the fix ships *in* 2.1.23, so agents on 2.1.22
and earlier cannot use it. Each existing Linux host needs one more installer
run; after that the UI path is self-sustaining.

### Why one Linux box opens a terminal in 1s and the other in 12s

Operator question, answered by measurement rather than guesswork. Delivery is
**not** the difference: the command channel pushes to both devices with 0s
latency. The user-visible number is how long until the agent attaches:

```
729 rustdesk-srv   session -> agent attached   1s
812 debian3xc      session -> agent attached  12s
```

Two things compound. Each HTTPS round trip from 812's site costs 3-5s, against
~0s from 729's — 89 devices sit behind that public IP, every RustDesk client
among them posting telemetry every 10-15s (RISK-SUPPLY-002), so the site's
uplink is busy. And `runAction` (`actions.go:66-88`) performs **two blocking
callbacks — ack, then running — before dispatching the work**, so on that link
~7s elapses before the terminal dial even starts. On 729 those cost nothing,
which is why the ordering has never been visible.

The RustDesk comparison is not like-for-like: it holds a persistent connection
to the relay and performs no HTTP bookkeeping before acting.

Starting `dispatch()` concurrently with the ack/running reports would remove
those ~7s on slow links and change nothing on fast ones. **Deferred by the
owner on 2026-08-05**, with the terminal working acceptably on both hosts: it
is an agent-wide change to how every action is executed, and there was no
reason to take that on the same day as three other agent releases. Recorded so
the cause does not have to be re-measured when it is picked up.

### The Web Terminal now opens in its own window

Connect in the Device Catalog deep-linked into the drawer's Terminal tab,
which tied a long-lived working surface to a panel that closes the moment the
operator returns to the catalog. It now opens `/terminal/:id` via
`window.open`, named per device so a second click focuses the existing window
rather than starting a duplicate session, with the drawer retained as the
fallback when a browser blocks the popup. `/terminal/` bypasses `AppShell`
alongside `/login`: a sidebar and topbar inside a 1024x640 popup would leave
the terminal a fraction of it.

### Open finding, not acted on

An agent (`Go-http-client/1.1`, `77.242.26.80`) has been retrying
`POST /api/v1/agent/enroll` **every 60 seconds and receiving 403** — 1,365
rejections against 7 successes since midnight, and the loop predates the log
window. Cause per [agent.py:101-102](../backend/app/api/v1/endpoints/agent.py#L101-L102):
the request carries no enrollment token. The machine therefore **never appears
in the UI**, because a failed enrolment creates no device row. This is the same
symptom as the second incident in the original 2026-08-03 brief. Load impact is
negligible; the endpoint is unmanaged. Raised as RISK-ENROL-001, deferred.

Device 729 is *not* this machine — it holds a valid `agent_id` and heartbeats
normally, which is why the deployment was safe to hand over.


## [2026-08-03] DEPLOY-CONSOLIDATION-2026-08-03 — Seven compose files down to three, 1.5 GB reclaimed, and a private key found hiding in an "orphan"

Prompted by two operator questions: *are there files we can delete so we do not
accidentally start an old backend or frontend?* and *if we restart the server,
does everything come back?*

### The hazard was bigger than the known label drift

RISK-DEPLOY-001 was recorded as a provenance annoyance — containers labelled
against different compose files. The audit found something worse. `/root` is a
**complete stale checkout** of the platform:

```
/root   branch stable/phase-2-heartbeat, commit 862b1bf
        docker-compose.yml with  build: context: ./backend
        /root/backend/ and /root/frontend/ present
        /root/.env  differs from production
```

A `docker compose up -d --build` run from `/root` would have **built and
deployed the backend from old source, on the wrong branch, with a different
`.env`** — precisely the accident the question was about.

Seven compose files existed. Three were byte-identical copies of the pre-fix
platform stack (`145140d1…`, all missing `init: true`, so any of them would
have reintroduced the healthcheck zombies), and one was a duplicate RustDesk
stack binding the same ports:

```
/root/docker-compose.yml                                    145140d1…
/docker-compose.yml                                         145140d1…
/root/techi-canary-rollback-20260711T230221Z/…              145140d1…
/opt/rustdesk/docker-compose.yml                            duplicate RustDesk
/opt/techi/techi-platform/docker-compose.yml                e81bdee9…  ACTIVE
```

### Change: renamed, not deleted

All four disabled as `*.DISABLED-20260803`, hashes recorded in
`/root/backups/compose-consolidation/RENAMED-20260803.txt`, reversible with a
single `mv`. Verified beforehand that nothing referenced them — not cron, not
the nightly backup script (which already treats
`/opt/techi/techi-platform/docker-compose.yml` as canonical), not systemd.

Three compose files remain, one per running project.

### Verified safe to run compose again

`docker compose up -d --dry-run` from `/opt/techi/techi-platform` reports all
three services *Running* with no recreate, including PostgreSQL despite its
stale label. So the everyday command is now a safe no-op, which was the point
of the exercise.

### Restart safety, answered with evidence

`docker.service` and `containerd` are `enabled`; all six containers are
`restart=unless-stopped`; none are stopped. Every change made during the day's
incident work lives in a named volume or a bind mount, not inside a container —
`init: true` in compose, the nginx edge rule in the NPM bind mount, the
heartbeat interval in `techi-platform_backend_data`, and the index/autovacuum/
Alembic changes in the database volume. A host restart brings the stack back
intact.

### 1.5 GB reclaimed — and one volume deliberately kept

An anonymous 2.0 GB volume turned out to be a **separate PostgreSQL cluster**,
not a copy of production: different `Database system identifier`
(`7656427481619533860` vs `7641693197796040741`), last checkpoint 2026-06-28
12:49, abandoned since. No retained backup reaches that far back (the oldest is
2026-07-26), so it was archived before removal:
`/root/backups/abandoned-pg-cluster-20260628.tar.gz`, 403 MB, integrity checked
with `tar tzf`, 1,575 files. Then removed, along with 36 empty 8 KB volumes left
by `techi_verify_*` and `root_*` test runs.

Filesystem **72% → 65%**, free space 6.6 GB → 8.1 GB.

**One volume was explicitly not removed.** `rustdesk_rustdesk_data` is attached
to no container and looked like the same class of junk, but it contains
`id_ed25519` — and it is byte-identical to the live RustDesk private key, whose
public half `8B5Z8Vp6…` is embedded in every agent config and in the MSI. It is
a second copy of the credential the entire remote-support fleet depends on. A
blanket `docker volume prune` would have destroyed it silently. Retained and
documented in PROJECT_STATE §5 so it is never mistaken for an orphan again; the
nightly backup covers the primary copy under
`/opt/techi/rustdesk-server/data/`.

### Correction to an earlier note

`/opt/backups/techi/INSTANT_REVERT.sh`, recorded previously as an armed
instant-revert path, **does not exist**. That note was stale.

## [2026-08-03] DB-HEAD-MERGE-2026-08-03 — Two Alembic heads collapsed into one, with the schema proven untouched

RISK-DB-001, closed. Taken before any feature work because the next feature
migration would have had to pick a parent, and picking wrong is a mistake that
only surfaces when a deploy applies half a branch.

### What the fork actually was

```
z1a2b3c4d5e6 (branchpoint)
 |
 +-- a1b2c3d4e5f7  device agent_sha256
 |   b2c3d4e5f8a9  device_heartbeats.created_at index
 |   c7d8e9f0a1b2  reporting engine tables
 |   d8e9f0a1b2c3  enterprise vault                     <- head 1
 |
 +-- a2b3c4d5e6f7  enrollment audit
     b3c4d5e6f7a8  agent_command_batches
     c4d5e6f7a8b9  device agent_version
     d5e6f7a8b9c0  device display name
     e6f7a8b9c0d1  trusted domain client mapping
     hb1x7k9n2q4d  device_heartbeats index hygiene      <- head 2
```

Production held **both** heads as two rows in `alembic_version`, so both
branches were fully applied and nothing was pending on either side. The schema
was never broken — the defect was purely that `alembic upgrade head` had no
single answer.

### Approach

An empty mergepoint, `mrg8b3f1c2a9`, whose `down_revision` is the tuple of both
heads. No DDL: no table, no column, no index. Its only effect is bookkeeping —
two rows in `alembic_version` become one.

Sequence, each step verified before the next:

1. Read-only inspection of `alembic_version`, `alembic current` and `alembic
   history` to establish that both branches were applied and to map the DAG.
2. Confirmed migrations do **not** run at container start (the image `CMD` is
   uvicorn only), so applying this is an explicit, controlled act rather than a
   side effect of the next restart.
3. The revision validated in a throwaway container built from the production
   image, with the repository mounted, before going near the live database:
   `alembic heads` returned a single `mrg8b3f1c2a9 (mergepoint)`.
4. Schema-only `pg_dump` and an `alembic_version` dump captured as a before
   snapshot, alongside the existing daily full backup (2026-08-03 03:01).
5. Applied from a throwaway container with the repository mounted read-only —
   the running backend was never restarted and never touched.

### Verification

The decisive check: because the revision is a no-op, the schema dumps taken
before and after must be identical. Excluding the random `\restrict` nonces
pg_dump emits per run, they are:

```
9800ace23a68f365b04c445d08918d2105baded29755869b576c384c09c4632c  BEFORE
9800ace23a68f365b04c445d08918d2105baded29755869b576c384c09c4632c  AFTER
3,313 lines of schema, zero differences
```

- `alembic_version`: two rows → one, `mrg8b3f1c2a9`
- `alembic current`: `mrg8b3f1c2a9 (head) (mergepoint)`
- a second `alembic upgrade head` runs zero migrations — idempotent
- application health 200 in 98 ms, backend healthy, zero restarts, load 0.36,
  514 devices reporting inside five minutes

### Note on the running image

The live backend image predates this commit, so its bundled `/app/alembic` still
shows two heads. This is harmless and was verified rather than assumed:
application code never reads Alembic state at runtime. The migration state lives
in the database and is correct; the next image rebuild picks the file up
naturally.

## [2026-08-03] GUARDRAILS-2026-08-03 — Capacity-aware heartbeat floor, access-log summaries, identity instrumentation

Three backend guardrails closing out the day's incidents. None of them changes
device resolution or heartbeat processing; the third deliberately only measures.

### 1. The interval floor now knows what the host can carry (RISK-CAP-002)

`HEARTBEAT_INTERVAL_MIN = 60` was a constant with no relationship to fleet size
or CPU. It permitted the 180s setting that took production down, and would have
permitted ~13 req/s.

The floor is now derived — `ceil(fleet / HEARTBEAT_RATE_BUDGET_PER_SEC)`,
clamped to `[MIN, MAX]`, budget configurable via environment and defaulting to
3.0 req/s. It tightens by itself as the fleet grows and relaxes only when the
budget is raised deliberately alongside real capacity. Budget `0` restores the
previous behaviour.

Verified against live production numbers after deploy:

```
791 devices, budget 3.0 req/s  ->  floor 264s
  600s ->  1.32 req/s  ALLOWED
  300s ->  2.64 req/s  ALLOWED
  264s ->  3.00 req/s  ALLOWED
  180s ->  4.39 req/s  REJECTED   <- the change that caused the collapse
   60s -> 13.18 req/s  REJECTED   <- what the old bound permitted
```

The rejection states the projected rate rather than only the verdict, and both
entry points are guarded — the flat `heartbeat_interval_seconds` and the
per-platform map, since either could carry the same mistake. `GET`/`PUT` now
return `active_device_count`, `projected_requests_per_second` and
`minimum_allowed_interval_seconds`, so the cost is visible before saving rather
than discovered afterwards. Counting devices is best-effort: a guardrail that
returns 500 is worse than one that degrades to the static floor.

### 2. Suppressed access logs are now summarised

`_DropNoisyAccessLogs` hid agent heartbeat traffic so thoroughly that the first
reading of the logs during the incident concluded there was none at all — a
wrong conclusion that cost real investigation time. Dropped lines are now
counted and summarised once a minute on a separate `techi.access_summary`
logger (separate so the summary cannot re-enter the filter). First line in
production:

```
techi.access_summary suppressed access logs in 65s:
  /api/v1/agent/heartbeat x6 (0.09/s), /health x3 (0.05/s)
```

Volume stays negligible; the rate stays observable.

### 3. RISK-IDENT-001 instrumentation — observation only, no behaviour change

Heartbeat resolution falls back to a caller-supplied `device_id` without
checking `agent_id`. That is how two cloned machines came to fight over device
774. The obvious fix — refuse `device_id` when `agent_id` disagrees — would
silently stop resolving every device currently relying on that path, and **the
size of that population is unknown**. Shipping it blind would trade a known
defect for an unmeasured outage.

So this release only measures it: a warning naming the device whenever a
heartbeat resolves by `device_id` with a conflicting `agent_id`, throttled to
one line per device per hour. Nothing branches on it. When the fix is made it
will have a counted blast radius instead of a guessed one.

At three minutes after deploy the count was **zero**, which is encouraging but
far too short a window to conclude from.

### Testing

`tests/test_heartbeat_capacity_guard.py`, 24 cases: the exact 180s change that
caused the incident, the per-platform map path, floor clamping at both ends,
budget-0 disablement, database-failure degradation, filter counting and window
reset, and mismatch / absence / throttling for the instrumentation.

Full suite **34 failed, 995 passed** against **34 failed, 971 passed** on the
unmodified baseline — the failures are pre-existing and environmental (those
tests read `agent/` sources absent from a backend-only checkout), and the delta
is exactly the 24 new tests. Run in a throwaway container built from the
production image so nothing touched the running service.

Deployed with `docker compose up -d --build backend`. After deploy: healthy,
zero restarts, load 0.64, zombie count 0, 516 devices reporting inside five
minutes.

## [2026-08-03] DB-WRITEPATH-TRIM-2026-08-03 — Redundant indexes, autovacuum thresholds, and edge log volume

Three no-deploy changes taken after the edge absorption, chosen because they
reduce the cost of the work the single-vCPU host actually does rather than
adding capacity it does not have.

### Redundant indexes on the two hot tables

`pg_stat_user_indexes` showed the same duplicate signature already fixed on
`devices` earlier the same day — the planner uses one index of a pair and never
the other:

| table | index | scans | size | verdict |
|---|---|---|---|---|
| `device_heartbeats` | `ix_device_heartbeats_id` | 3,105,812 | 48 MB | shadows the PK (3 scans) |
| | `ix_device_heartbeats_device_id` | 295 | 22 MB | strict prefix of the composite |
| | `ix_device_heartbeats_rustdesk_status` | 50 | 23 MB | column written, never filtered |
| `device_telemetry` | `ix_device_telemetry_id` | 13,237,081 | 48 MB | shadows the PK (14 scans) |
| | `ix_device_telemetry_device_id` | 423,724 | 23 MB | strict prefix of the composite |

`rustdesk_status` was verified in code before dropping: it appears only in write
paths, never in a `WHERE` clause.

Dropped with `DROP INDEX CONCURRENTLY` (7–27 ms each, no lock taken while the
fleet was heartbeating). Retained: both PKs, both `(device_id, created_at)`
composites, and both `ix_*_created_at` — the last of which the retention DELETE
depends on.

**Result: 544 MB → 380 MB of index, and five fewer index writes per heartbeat
cycle** — every heartbeat inserts one row into each table, so this lands
directly on the burst path. The planner moved to the surviving indexes
immediately (`device_telemetry_pkey` 14 → 20 scans, the composite absorbing the
`device_id` lookups). Rollback script written first:
`/root/backups/db-index/restore-dropped-indexes-20260803.sql`.

### Autovacuum thresholds

```
device_heartbeats  144,662 dead (11.3%)   last autovacuum 2026-08-02 03:02
device_telemetry   145,233 dead (11.2%)   last autovacuum 2026-08-02 03:02
```

Over 36 hours without a vacuum. The 0.2 default scale factor puts the threshold
at ~228k dead tuples, while the 7-day retention deletes ~160k rows/day from each
table — so dead tuples accumulate for two days and are then cleared in one large
vacuum, an I/O spike this host cannot absorb comfortably.

`autovacuum_vacuum_scale_factor = 0.02` (threshold ~23k) and
`autovacuum_analyze_scale_factor = 0.05` on both tables. The change fired
immediately and took both to **zero dead tuples**; database size 1623 MB →
1496 MB.

### Edge log volume

The absorbed `/api/heartbeat` and `/api/sysinfo` locations were still writing
~40 log lines/s — roughly 570 MB/day at ~165 bytes a line, on a filesystem at
73%. `access_log off;` on those two locations only. Absorption remains
verifiable from the backend side, which sees zero legacy requests. Filesystem
73% → 72%.

### Combined state after the day's work

| | morning | after |
|---|---|---|
| requests reaching the backend | 1,462/min | ~1/min |
| load | 2.07, peak 9.5 during the collapse | 0.61 |
| healthcheck zombies | ~5,760/day | 0 |
| index footprint, hot tables | 544 MB | 380 MB |
| dead tuples | 290k | 0 |
| database size | 1623 MB | 1496 MB |

## [2026-08-03] RS-APISERVER-FLOOD-2026-08-03 — 94% of backend traffic was RustDesk clients treating us as their api-server; absorbed at the edge

**Follow-up investigation to HB-INTERVAL-COLLAPSE.** Asking "why does one vCPU
have no headroom at 2.6 req/s?" turned out to be the wrong question: the box was
never carrying 2.6 req/s.

### The causal chain, evidenced at every link

1. The combined MSI passes our API URL to `EpCustomActDll` —
   `CustomActionData=…|https://api-rdp.techi.com.al|…`, captured live in
   `msi-install.log` on two machines. The DLL writes it as `api-server` into the
   Remote Support TOML on **every install and upgrade**
   (`installer.wxs:462-481`).
2. A RustDesk 1.4.6 client with `api-server` set posts its own product telemetry
   there every ~10-15s. Body captured on the wire:
   `{"id":"195635003","uuid":"…","ver":1004060}` — no `hostname`, no `device_id`,
   no `agent_id`.
3. The backend cannot resolve that to a TECHI device, so `_resolves_existing_device`
   returns false and it answers `204` (`legacy_compat.py:82-84`).
4. Nothing ever removes it: the agent's RS repair loop only patches *managed*
   keys, and `api-server` is not one when `rustdesk_api_server` is unset
   (`rustdesk_toml.go:133`). The read-only bit the agent sets on the TOML then
   protects the value from RustDesk itself.

### Scale

Across the full retained NPM log history:

| path | requests | 204 | 502 | **2xx other than 204** |
|---|---|---|---|---|
| `/api/heartbeat` | 1,338,852 | 1,324,271 | 981 | **0** |
| `/api/sysinfo` | 182,824 | 180,636 | 100 | **0** |

Not one legacy request has ever been processed successfully. At ~40 req/s this
was **~94% of all traffic** reaching the backend — each one paying JSON parse,
pydantic validation and up to three device lookups in order to be discarded.

### Fix applied — edge absorption

`/data/nginx/custom/server_proxy.conf` in nginx-proxy-manager (the
`server_proxy[.]conf` include already existed in both generated proxy hosts):

```nginx
location = /api/heartbeat { return 204; }
location = /api/sysinfo   { return 204; }
```

Byte-identical from the client's point of view — 204 before, 204 now — but
uvicorn never sees it. Applied with `nginx -s reload`, no downtime.

Surgical by construction: TECHI agents post to `/api/v1/agent/heartbeat`, a
different path. Verified immediately after reload:

```
/api/heartbeat          -> 204  (nginx)
/api/sysinfo            -> 204  (nginx)
/api/v1/agent/heartbeat -> 400  (reached the backend, rejected the empty body)
/api/v1/health          -> 200
```

### Measured effect

| | before | after |
|---|---|---|
| legacy requests reaching backend | 1,319/min | **0** |
| total backend requests | 1,462/min | ~8/min |
| load | 2.07, spiking to 9.5 under stress | 0.29–0.41 idle |
| devices reporting in 5 min | 550 | 548 — unchanged |

### Finding surfaced during verification: the fleet is fully synchronised

375 heartbeats landed in one sampled minute where 548 devices at a 300s interval
should produce ~110. The per-device rate was correct — mean 1.01 heartbeats per
device per 5 minutes — so the interval works; the arrival pattern does not.
Heartbeats per 30s bucket:

```
15:29:30 → 160     15:34:30 → 163
15:30:00 → 223 ◄   15:35:00 → 216 ◄
15:30:30 →  89     15:35:30 →  97
15:31:30 →  11     15:36:00 →  23
15:32:00 →   3     …trough 1–3 per 30s…
```

The whole fleet fires inside a ~90s window every 300s: **peak 7.4 req/s against
a 1.8 req/s mean, and a ~150× peak-to-trough ratio.** This is RISK-AGENT-002
quantified, and it is now the dominant remaining load. It also explains the
original collapse: the same burst, 1.67× more often at 180s, on top of 40 req/s
of legacy flood.

### Correction

An earlier reading of the packet capture suggested TECHI 2.1.20 agents were
posting to the legacy path. That was a capture artefact — bodies and request
lines arrive in different packets. After correlating URL to body per TCP
connection, every TECHI agent was on v1 and every legacy request was a RustDesk
client. The agent is not at fault.

### Still open

- **The edge rule is a containment, not a cure.** nginx still terminates ~40
  TLS handshakes/s for traffic that should never leave the endpoints. The cure
  is the agent/MSI change that stops writing `api-server`.
- **The file lives outside Git** (`/root/nginx-proxy-manager/data/nginx/custom/`),
  same class as RISK-DEPLOY-001. Recorded in PROJECT_STATE §5 so an NPM rebuild
  does not silently drop it.

## [2026-08-03] HB-INTERVAL-COLLAPSE-2026-08-03 — Heartbeat interval 300→180 tipped a single-vCPU host; healthcheck zombies had been eroding it for days

**Outage.** An operator lowered the Windows heartbeat interval from 300s to 180s
from the Agent Config page. Within minutes the UI returned *failed to fetch*,
logins hung, and feature flags appeared to vanish.

### What the box actually is

`nproc` = **1**. One vCPU, 2 GB RAM, serving 790 endpoints.

| | devices | interval | requests/s |
|---|---|---|---|
| Historic known-good | ~600 | 300s | 2.0 |
| Same morning, healthy | 790 | 300s | 2.6 — load ~0.6 |
| After the change | 790 | 180s | **4.4 — load 9.5, 0% idle** |

The fleet had grown 32% *and* the interval dropped 40%: 2.2× the last known-good
load. That is why it broke now and not before. Past the knee the failure is not
linear — requests time out, agents retry (`retries: 3`), offered load multiplies,
and the box stays pinned. Measured during the incident: `%Cpu(s) 64.3 us, 28.6
sy, 0.0 id`, five consecutive `/api/v1/health` probes returning `000`, two of
them after a 25s timeout. The backend container fell over and auto-restarted at
13:40:42 (exit 0, `OOMKilled=false`).

### The pre-existing defect that made it fragile

`/proc/1/exe -> /usr/local/bin/python3.12`. **uvicorn ran as PID 1 and does not
reap orphaned children.** Docker's healthcheck spawns a process inside the
container that is re-parented to PID 1 when the exec helper exits, so every
15s check left a `<defunct> python3` behind:

- 17 zombies accumulated in the six minutes after the restart — one per interval;
- ~5,760/day; ~23,000 across the four-day uptime that preceded the crash.

This is independent of the operator's change, but it is very likely what turned
a slow hour into a container failure.

### Recovery

1. `platform_heartbeat_intervals.windows` 180 → 300 in `/app/data/agent_policy.json`.
   Note `_load()` caches the policy in a module global and re-reads the file only
   when that global is `None` — **editing the file does nothing until the process
   restarts**.
2. `docker restart techi-platform-backend-1`.

Load fell 9.5 → 0.6 within four minutes; health back to 200 in ~50ms.

### Permanent fixes applied

- **`init: true`** on the backend service — Docker injects `docker-init` (tini)
  as PID 1, which reaps orphans. Verified after recreate: `/proc/1/exe ->
  /usr/sbin/docker-init`, zombie count **0** across six consecutive healthcheck
  cycles. Changing the healthcheck command alone would not have helped: without a
  reaper, any spawned binary leaks a zombie.
- **healthcheck `interval` 15s → 30s.** The image ships no `curl` or `wget`, so
  each check pays a full Python interpreter start — not free on one vCPU.
- **Three duplicate indexes dropped from `devices`.** `pg_stat_user_indexes`
  showed the classic duplicate signature — the planner used one of each pair and
  never the other:

  | used | scans | unused twin | scans |
  |---|---|---|---|
  | `ix_devices_id` | 34,788,735 | `devices_pkey` | 0 |
  | `ix_devices_rustdesk_id` | 3,078,795 | `devices_rustdesk_id_key` | 0 |
  | `ix_devices_agent_id` | 349,240 | `devices_agent_id_key` | 0 |

  The non-unique copies were dropped; the unique/PK indexes are identical in
  structure, cannot be dropped (they carry the constraints the device-identity
  split now depends on), and picked the traffic up immediately — `devices_pkey`
  0 → 3,427 scans, `devices_rustdesk_id_key` 0 → 270. 14 indexes → 11. A small
  win in absolute terms: the indexes were ~208 kB and cached. Recorded honestly
  rather than overstated.

### Corrections to claims made during the investigation

- **"There is no retention, the tables grow forever, disk runs out in a month" —
  wrong.** `cleanup_old_heartbeats` and `cleanup_old_telemetry` already run with
  `days=7` (`app/tasks/cleanup.py:21-39`), and the data confirms it: the oldest
  row in both tables is 2026-07-27, exactly seven days. `device_heartbeats`
  (1,035 MB / 1.13M rows) and `device_telemetry` (437 MB / 1.14M rows) are a
  seven-day steady state, not a runaway. Disk is stable at 73%.
- **The feature flags were never touched.** They come from the container
  environment and survive a restart untouched: `FEATURE_LINUX`,
  `FEATURE_MIKROTIK`, `FEATURE_PLATFORM_CORE`, `FEATURE_REPORTING`,
  `FEATURE_TERMINAL`, `FEATURE_VAULT` all `true` before and after. They looked
  missing because `/api/v1/platform/features` was timing out and the UI falls
  back to everything-off. They returned on their own once the backend recovered.

### Still open

- **`HEARTBEAT_INTERVAL_MIN = 60`** (`agent_config_service.py:25`) lets the UI
  set a value that would mean ~13 requests/s on the current fleet — certain
  collapse, with no warning shown. The bound has no relation to fleet size or
  available CPU.
- **No jitter.** Changing the interval re-synchronises the whole fleet; bursts of
  29 requests/s were logged during the transition and again on every restart. A
  per-agent ±10% spread would smooth both.
- **One vCPU is the binding constraint.** Everything above is marginal next to it.
  Do not lower the interval below 300s on this hardware.

## [2026-08-03] DEVICE-SPLIT-774-2026-08-03 — Two cloned machines behind one NAT collapsed onto a single device row

**Symptom.** A newly installed endpoint never appeared in the UI, and Connect on
"Sabina -pc" opened the operator's laptop instead of the operator's PC.

### Root cause

Two physically distinct machines, cloned from one image, both reporting hostname
`DESKTOP-UKPKR96`, both behind the office NAT `185.66.128.121`, with different
RustDesk IDs (`439466287` and `441674927`).

`DeviceRepository.find_reenrollment_match` tries four keys in order: `agent_id`,
`rustdesk_id`, `hostname+local_ip`, `hostname+public_ip`. On 2026-08-01 13:09:55
the second machine enrolled with a freshly written config (no `agent_id`) and
fell through to the **fourth and weakest key**. Behind NAT that key identifies a
*site*, not a machine. Device 774 — created 2026-07-27 for the first machine,
named "Sabina -pc", manually assigned to TECHI shpk / Client PC — was taken over.

Two amplifiers made it self-sustaining:

- **The heartbeat overwrites the row's identity.** `update_data` excludes only
  `device_id` and `rustdesk_id` (the latter re-added after a conflict check), so
  `agent_id`, `hostname`, `local_ip` and `current_user` all belong to whichever
  machine wrote last. `rustdesk_id` ping-ponged every ~5 minutes — which is why
  Connect was a coin flip. The code comment asserting `agent_id is immutable
  post-enroll` is not true on this path.
- **The heartbeat trusts `payload.device_id` without verifying `agent_id`**
  (resolution order: `agent_id` → `device_id` → `rustdesk_id`). The
  `_RECENTLY_SEEN_HOURS = 24` guard, written precisely to prevent merging live
  machines, sits in `_resolve_via_fingerprint` and therefore never runs.

### Why client-side remediation kept failing

Renaming the laptop to `LAPTOP-TECHI` closed key #4 — and key #2 fired instead.
At 08:59:31 the enroll matched `rustdesk_id 441674927` because the laptop's *own*
heartbeat, **two seconds earlier at 08:59:29**, had just written that ID onto row
774. A full uninstall did not help either: RustDesk regenerates its ID
deterministically from the machine UID, so wiping every identity TOML returns the
same `441674927` on that hardware. Three reinstall attempts were absorbed
(08:40:40, 08:59:31, and an earlier one), each raising `enrollment_count`.

### Resolution — server-side, one transaction

With `agent_id` and `rustdesk_id` both carrying UNIQUE constraints, the split is
enforced by the schema:

1. `UPDATE` pinned 774 to the first machine's identity (`DESKTOP-UKPKR96`,
   `agent_2jkZJ…`, `439466287`, `192.168.183.1`), clearing
   `reenrolled_from_agent_id`.
2. `INSERT` created row **800** for the laptop (`LAPTOP-TECHI`,
   `441674927`), copied from 774 so every NOT NULL column was satisfied, with
   client/group `NULL` so it lands under "No client" and its own RS password
   regenerated.

No endpoint change was needed: heartbeat resolution tries `agent_id` first, so
each machine now lands on its own row and rewrites only its own values.

Backup taken first: `/root/backups/device-split/devices-before-split-20260803-090850.sql`
(791 rows).

### Verification

- Two full heartbeat cycles with no cross-contamination: 774 receives only
  `DESKTOP-UKPKR96 / 192.168.183.1`, 800 only `LAPTOP-TECHI / 10.5.50.84`.
- A reinstall performed *after* the split landed correctly on 800
  (`09:11:57 reenrollment_match → device_id 800`), matched by `rustdesk_id`.
- Zero duplicate `rustdesk_id` fleet-wide; 800 generated its own RS password at
  09:12:06.
- The conflict guard now protects both rows: a stray heartbeat from the old
  process could no longer steal the RustDesk ID, because 800 holds it.

### Still open

The two dedup keys `hostname+local_ip` and `hostname+public_ip` remain, both
resolved with `.order_by(Device.id.desc()).first()` — a silent pick when several
rows match. Cloned images behind NAT will collide again.

## [2026-08-03] MSI-KILLRS-NOOP-2026-08-03 — `KillTechiRS*` custom actions have been no-ops since 2.1.19

**Confirmed on two production machines with direct evidence.** The MSI verbose
log records the custom action's command line *after* Windows Installer formats
it:

```
Target=powershell.exe … -Command "$ErrorActionPreference='SilentlyContinue';
$L=Join-Path $env:ProgramData 'TechiAgent\deploy.log';
function W($m); W 'start'; $j=Start-Job { … }
```

The body of `function W` is **gone**. `CustomAction/@ExeCommand` is an MSI
*Formatted* field, and the logging helper introduced in `de5aaaa` (2026-07-24,
2.1.19) contains `[KillTechiRSBeforeInstall]` inside its `{ }` block. MSI reads
that as an undefined property reference and drops the whole braced group.
PowerShell then fails to parse (`Missing function body in function
declaration`), the script never runs, and `Return="ignore"` hides it completely.

Second, independent confirmation: `deploy.log` on both machines contains
`[bootstrap-config]`, `[remove-tray-artifacts]` and `[watchdog-install]` lines —
and **no `[KillTechiRSBeforeInstall]` line at all**. That action writes `start`
as its first statement; it never wrote it.

**Impact.** `KillTechiRSBeforeInstall` and `KillTechiRS` have not stopped Remote
Support before `InstallFiles` on any machine since 2026-07-24. On the sampled
installs no harm followed — but this is exactly the guard whose absence produces
1603 on machines where RS holds `librustdesk.dll` / `flutter_windows.dll` locked.
Three RS processes were running during one of the observed installs.

**Related, same evidence set.** `BackupAgentConfigBeforeLegacyRemove` fails to
launch with **1721** on every install, because its working directory
`C:\ProgramData\TECHI\` does not yet exist at that point in the sequence.
`Return="ignore"` downgrades it from Error to Info and the install continues with
exit 0 — the action that is supposed to preserve `device_id` before removing
v1.0.4 products never runs. Same signature was already present in the 2026-07-18
CI logs for the Remote Support MSI's sibling action.

**Not fixed.** Recorded for a dedicated change; both actions need the bracket
removed from the log tag, and the whole pattern reviewed — any literal `[` in an
`ExeCommand` is MSI syntax, not text.

## [2026-07-29] SEC-002B-ACTIONS-GATE-2026-07-29 — Pending remote actions gated on agent_id

**Second, more damaging half of RISK-SEC-002, found while reviewing the same
endpoint.** The password gate (SEC-002-GATE below) protected
`remote_support_password`, but the same unauthenticated heartbeat also returned
`pending_actions`, and that path is destructive:
`RemoteActionService.collect_pending_for_delivery(device_id)` marks every action
it returns as SENT. So `POST {"device_id": N}` let an unauthenticated caller:

- read every pending action's full `parameters` — including `set_remote_password`
  and `run_powershell` payloads — plus its `callback_secret`, the HMAC token that
  is the only control on `/actions/{id}/complete`;
- consume them, so the real device never receives them;
- report them complete via the leaked callback token, so the operator sees a
  green "succeeded" for a command that never ran.

Theft, denial, and forgery in one request — worse than the password leak, which
was disclosure only.

**Change.** The `agent_id` check that already guarded the password is computed
once as `authenticated` and now guards both. An unauthenticated caller gets
`pending_actions: []`, and `collect_pending_for_delivery` is **not called at
all**, so nothing is marked SENT:

```python
authenticated = _agent_id_matches(payload.agent_id, getattr(device, "agent_id", None))

pending_actions = (
    RemoteActionService(db).collect_pending_for_delivery(device.id) if authenticated else []
)
rs_password = (
    RemoteSupportPasswordService(db).get_or_create(device) if authenticated else None
)
```

Device resolution and heartbeat ingestion are untouched, exactly as with the
password gate. Verified in production after deploy: an unauthenticated
`{"device_id": N}` returns `pending_actions: []`, and a heartbeat carrying the
device's real `agent_id` still receives its actions.

**Same limitation, same next step.** This is the identical knowledge barrier —
`agent_id` is a readable, non-expiring bearer secret — so RISK-SEC-002 stays
High. It closes the last attacker-usable field on the endpoint; the endpoint
itself is still unauthenticated pending the observe-mode trust work.

**Verification.** `tests/test_heartbeat_password_gate.py` grew to 19 cases; the
new `test_enumeration_by_device_id_steals_no_actions` asserts that an
unauthenticated call returns an empty list and never calls
`collect_pending_for_delivery`, so a probe cannot consume actions. Full backend
suite: 1005 passed.

## [2026-07-29] SEC-002-GATE-2026-07-29 — Remote Support password gated on agent_id

**Partial remediation of RISK-SEC-002** (see PROD-AUDIT-2026-07-29 below for the
finding). `/api/v1/agent/heartbeat` must stay public for agents to function, and
it resolves the device from a caller-supplied sequential `device_id`, so
`POST {"device_id": N}` returned that device's Remote Support password in
plaintext for any N across 773 devices.

**Change.** Device resolution is untouched. Exactly one response field is now
conditional:

```python
rs_password = (
    RemoteSupportPasswordService(db).get_or_create(device)
    if _agent_id_matches(payload.agent_id, getattr(device, "agent_id", None))
    else None
)
```

`_agent_id_matches` requires both sides non-empty and compares with
`secrets.compare_digest`. A heartbeat from an unauthenticated caller is still
processed in full — telemetry, inventory, alerts, pending actions and interval
are unchanged — it simply receives `remote_support_password: null`.

**Why this was chosen over the nginx rate limit as the first step.** With
sequential IDs a 30 req/min limit still enumerates the fleet in ~26 minutes, and
a targeted attack on one known `device_id` needs a single request, which no rate
limit affects. It also charges a real availability risk: a client office of 40
PCs behind one NAT address emits ~8 heartbeats/minute from a single source.
The gate charges nothing and closes the enumeration path.

**Blast radius: zero, measured not assumed.** All 774 devices already carry an
`agent_id` (`f"agent_{secrets.token_urlsafe(18)}"`, 144 bits,
`agent_enrollment_service.py:341`); the agent sends it on every heartbeat; and
`remote_support_password` was already `Optional[str] = None` in
`AgentHeartbeatResponse`, so no schema change was required. Agents below 2.1.5
do not apply the per-device password at all
(`remote_support.py:150-161`), so withholding it from a caller that cannot prove
identity costs them nothing either.

**Accepted limitation.** Three MikroTik devices use `mikrotik-<serial>` as their
`agent_id` rather than 144 bits of entropy, so those three are guessable by
anyone who knows the serial. Impact is negligible — the routers do not run
Remote Support — but it is a real hole and is covered by an explicit test.

**This is a knowledge barrier, not authentication.** `agent_id` is a
non-expiring bearer secret readable by a local administrator from
`agent.config.json` (MSI ACLs restrict it to SYSTEM + Administrators,
`installer.wxs:307`). It offers no replay protection and no freshness proof. It
is the bridge to the RSA-PSS challenge/response in `AgentAuthMigrationService`
on `rollback/remote-support-2026-07-18`, not a replacement for it. RISK-SEC-002
stays open at reduced severity until observe-mode trust measurement and
enforcement land.

**Verification.** `tests/test_heartbeat_password_gate.py` — 18 cases covering the
matching path, four enumeration variants (omitted/empty/wrong/truncated
`agent_id`), a device with no `agent_id` on record, whitespace and
case-sensitivity, and the MikroTik format. The enumeration tests assert that the
password is not merely withheld but never generated, so probing cannot seed a
password for a device that has none. Full backend suite: 1004 passed.

## [2026-07-29] PROD-AUDIT-2026-07-29 — Production-verified read-only audit: four fixes shipped, three findings retracted

**Scope.** A full read-only audit (backup/storage, performance/database, agent
reliability, security, feature gaps) was first performed against the repository
and Git history alone, then re-run against live production. The second pass
overturned three conclusions of the first. Both outcomes are recorded here
because the retractions are the more useful half.

### Findings retracted after production verification

**The GPO agent-upgrade problem does not exist.** The audit was commissioned on
the premise that only ~148 of 630+ devices had reached MSI v2.1.0 and ~480 were
stuck on v2.0.0, suspected to be caused by missing `REINSTALL=ALL
REINSTALLMODE=vomus` flags. Production says otherwise:

| agent_version | total | seen in last hour |
|---|---|---|
| 2.1.20 | 687 | 647 |
| 2.1.5 | 32 | 5 |
| 2.1.0 | 21 | 2 |
| (null) | 10 | 2 |
| 2.1.6 | 9 | 2 |
| 2.0.0 | **8** | 3 |
| 1.0.0 | 3 | 2 |

687 of 773 devices run 2.1.20; eight run 2.0.0. The MSI rollout worked. A
proposed GPO remediation campaign was cancelled on this evidence.

The code-level finding behind that campaign was real but not load-bearing: the
MSI `UpgradeCode` did change between v2.0 (`A1B2C3D4-E5F6-7890-ABCD-EF1234567890`,
commit `c40ccd3`) and 2.1.x (`E6AD0A88-5F26-5665-9B1F-70B8C5EE8363`, commit
`9a11626`), and `installer.wxs` carries explicit legacy-removal custom actions
for the 1.0.4 line but none for 2.0.0. `<MajorUpgrade>` only detects a matching
`UpgradeCode`, and no `REINSTALL` flag can bridge two different products — that
analysis stands. It simply did not stop the fleet in practice.

**PostgreSQL is not exposed to the internet.** `ufw` allows 8000 from anywhere
and `docker-proxy` listens on `0.0.0.0:5432`, which reads as an exposure from
the compose file alone. A `TECHI-SEC1A` chain hooked into `DOCKER-USER` — the
correct place, where Docker otherwise bypasses ufw — restricts 5432/8000/3000/81
to a single administrative IP, with `-P INPUT DROP` as the default. No action
required.

**Connection-pool exhaustion is not a near-term risk.** `session.py` allows
`pool_size=30 + max_overflow=50` = 80 connections per instance. The concern
assumed the PostgreSQL default of 100; production runs `max_connections=200`
(set explicitly in `docker-compose.yml`) with 36 connections in use. Downgraded
from High to Low; no change made.

### Finding confirmed and escalated

**`/api/v1/agent/heartbeat` is public, unauthenticated, and returns the
per-device Remote Support password in plaintext.** Verified in the code the
container actually runs, not merely in the repository:

- `/app/app/api/v1/endpoints/agent.py:25` — `router = APIRouter()` with no
  `dependencies=`, unlike `devices.py:49`, `remote_support.py:28`, `teams.py:22`
- `agent.py:143-145` — the device is selected from a caller-supplied `device_id`
- `agent.py:120,133` — `RemoteSupportPasswordService.get_or_create()` result is
  returned as plaintext `remote_support_password`

`device_id` is a sequential integer across 773 devices, so fleet-wide remote-support
credentials are enumerable. End-to-end probe from two separate networks:
`POST https://api-rdp.techi.com.al/api/v1/agent/heartbeat` with `{}` returns
**HTTP 400, not 401/403** — the request reaches the handler. 65-request bursts
produced zero 429s; `grep -rl limit_req /data/nginx/` in nginx-proxy-manager is
empty. The same secret via the operator route requires `require_min_role(ADMIN)`
plus a scope check (`remote_support.py:357-362`).

The firewall cannot mitigate this: the endpoint must stay public over 443 for
agents to function.

**Remediation is deliberately staged, not deferred by oversight.** This code
path caused the 13–17 July crisis and the 18 July total rollback. The agreed
sequence is (1) `limit_req` at nginx-proxy-manager as detection/availability
mitigation only, (2) port `resolve_heartbeat_trust` and its limiters from
`rollback/remote-support-2026-07-18` in **observe mode**, rejecting nothing,
(3) enforce only once observation shows every agent would pass.

An NPM constraint was found while attempting step 1: a rate limit entered in the
NPM UI's Advanced tab is emitted inside `server{}`, but `limit_req_zone` is an
`http`-level directive. The zone must go in `/data/nginx/custom/http_top.conf`
(that directory did not exist) with `limit_req` in the Advanced tab. A first
attempt left `/data/nginx/proxy_host/2.conf` untouched and had no effect.

A stronger and cheaper mitigation was identified but not yet implemented: gate
the `remote_support_password` field on a supplied `agent_id` matching the
resolved device. `agent_id` is `f"agent_{secrets.token_urlsafe(18)}"`
(`agent_enrollment_service.py:341`) — 144 bits — and **774 of 774 devices already
have one**, so the blast radius is zero while enumeration of 773 sequential
integers becomes a 144-bit guess. It does not change device resolution, only one
response field.

### Shipped in this deployment (`ce56fd4` → `15c0a9c`)

`0a900dc` **perf(db)** — `device_heartbeats` (1,679,402 rows / 1023 MB) had no
`(device_id, created_at)` composite, so `get_recent_by_device()` did a bitmap
scan plus sort over ~2,170 rows per device; `device_telemetry` received the
equivalent index in `x5y6z7a8b9c0` and heartbeats were left out. Migration
`hb1x7k9n2q4d` adds it and drops three indexes measured at **zero scans**
(`windows_product_type`, `rustdesk_install_status`, `rustdesk_id` — 67 MB,
maintained on every one of ~181k daily inserts). All statements use
`CONCURRENTLY` via `autocommit_block()`.

`ix_device_heartbeats_id` was deliberately left in place. It duplicates
`device_heartbeats_pkey`, but `pg_stat_user_indexes` shows the planner using it
(2,366,196 scans against 3 for the pkey), so removing it moves live traffic
rather than removing dead weight, and belongs in its own change.

`3503abf` **fix(backup)** — the deployed `/root/techi-backup.sh` had drifted from
the repository copy and was never brought back under review; the deployed version
(name-scoped 7-day retention preserving manual rollback artifacts) is now the
committed one. Both copies shared a failure mode: under `set -e` without
`pipefail`, `gzip` in `pg_dumpall | gzip` exits 0 even when `pg_dumpall` dies, so
a failed dump produced a small but apparently valid `.sql.gz` and the retention
sweep then deleted the good backups behind it. The dump is now written to
`.partial`, checked with `gzip -t` and a size floor, promoted only when verified;
retention is gated on a verified dump; a dump failure no longer aborts the
RustDesk-key and vault-key backups, which previously died with it.
`scripts/test-techi-backup.sh` covers healthy/failed/truncated and asserts in both
failure cases that an 8-day-old backup survives.

`478fbf0` **fix(ui)** — the Agent Configuration banner claimed interval changes
"must be propagated manually via the PowerShell scripts below or through a GPO
Scheduled Task", citing an `apply_agent_config` remote action. Both halves were
false: heartbeat intervals already propagate automatically (`agent.py:116,131` →
`main.go:173` → `agent.go:83-85`), and `apply_agent_config` exists nowhere in the
codebase. The banner was unconditional JSX warning about a missing capability on
a fleet that is 687/773 on 2.1.20. Replaced with an accurate note that also
records the real limitation: `get_inventory_interval()` is only ever called with
a hardcoded `"mikrotik"` (`install.py:122`,
`device_health_score_service.py:139`) and the agent has no inventory-interval
code at all, so every Inventory row except RouterOS is saved but never applied.

`3b04b56` **feat(drawer)** — the desktop drawer's inventory UI was not missing but
switched off behind `className={false ? "" : "hidden"}`, while its data was
fetched eagerly on every drawer open for every device regardless of active tab.
Now a dedicated Software tab with an explicit, re-clickable Load/Refresh control,
matching the mobile drawer's existing on-demand behaviour. Patch Status moved
into the same tab because it is inventory-derived and would otherwise render
"—". The mobile surface is deliberately untouched.

### Deployment record

Four `fix/*` branches were merged into `deploy/fixes-2026-07-29` on top of
production `ce56fd4` with no conflicts, verified (`tsc --noEmit` clean, frontend
80/80, backend **986 passed**, Alembic heads `d8e9f0a1b2c3` + `hb1x7k9n2q4d`),
then fast-forwarded onto `backport/platform-components-92a521c` as `15c0a9c`.

Branching from `92a521c` rather than the deployed `ce56fd4` was checked before
merge: `ce56fd4` is 100 files and ~11,000 lines ahead, so deploying the fix
branches directly would have reverted Agent 2.1.17–2.1.20 and the package-management
work. Alembic heads were identical on both, and only `DeviceDrawer.tsx` differed
(+5/-0), so the merge was clean.

### Incidental observation

The `techi_pre_total_rollback_20260718` database was present in the 03:00 backup
and absent from a 14:44 manual dump taken the same day, which is why that dump
was 140 MB against 278 MB. This was operator-initiated storage cleanup with an
off-server copy retained, not data loss; recorded because the size delta is
otherwise alarming and because every remaining on-server copy sits inside the
7-day retention window.

## [2026-07-28] PC-3A-MANUAL-OFFSITE-2026-07-28 — Verified manual off-site backup operation

**Result: COMPLETE (Manual Operation).** The WD My Cloud off-site copy was
verified from Linode source `/opt/backups/techi/` to the WD backup share. SSH-key
authentication, rsync pull without `--delete`, the single-instance lock,
incremental behavior, NAS-share logging/state, and `gzip -t` validation of the
newest PostgreSQL dump all passed. The verified script is
`/shares/Backup-TechiPlatform/scripts/pc3a-pull-linode-backups.sh`; its state is
stored under `/shares/Backup-TechiPlatform/pc3a-state/`.

**Scheduler decision.** Root crontab was proven non-persistent by a controlled
reboot test. `schedulerAdd.sh` writes directly to `/etc/cron.d` and is not an
approved production mechanism for this operation. WD's persistent Remote
Backups scheduler is limited to its vendor workflow and does not meet the
PC-3A controls (dedicated SSH key, strict host-key handling, lock, status/log
contract, and gzip verification).

**Architecture decision.** Automation is intentionally deferred. No inbound
port is opened on WD, and no VPN/private transport or existing reverse tunnel
connects Linode to WD. Linode therefore cannot currently reach the WD private
SSH address. Local backups remain scheduled daily on Linode; WD stores verified
off-site copies when the operator runs the pull manually. The manual procedure
and limitations are recorded in
[PC-3A Manual Off-site Backup Runbook](operations/pc3a-manual-offsite-backup-runbook.md).

**Residual risk.** The off-site copy can become stale if the manual operation is
not performed. A full restore rehearsal remains unperformed and is tracked as
`INIT-BKP-002`. No production code, production script, retention policy,
database, Docker, Git, firewall, or deployment was changed by PC-3A.

## [2026-07-27] AGENT-2.1.20-PRODUCTION-ROLLOUT — Successful production rollout reconciliation

**Result.** Windows Agent `2.1.20` is the active production version. Its production rollout is successful: **approximately 95%** of the fleet has updated successfully, and the fleet is operational.

**Mixed-fleet posture.** Legacy versions remain during rollout convergence. They are expected residual versions and are not an open rollout incident or a production blocker.

**Historical relationship.** This event supersedes the initial documentation that recorded the 2.1.20 rollout as incomplete. Existing historical entries remain unchanged; this is a new closure/reconciliation event based on later verified production evidence.

## [2026-07-27] DOC-ARCH-2026-07-27 — Canonical documentation architecture reconciled

**Decision.** TECHI documentation now uses three canonical time axes: `PROJECT_STATE.md` is the sole authority for verified current platform state; `CHANGELOG-SOLUTIONS.md` is the sole authority for technical history, incidents, decisions, deployments, rollbacks, and results; `IMPLEMENTATION-ROADMAP.md` is the sole authority for open, approved, or proposed future work.

**Mobile boundary.** `MOBILE_PROJECT_STATE.md` remains conditional and is **not required** now. Mobile is a responsive/PWA surface of the primary frontend and has no independent release lifecycle, release cadence, owner, or distribution model.

**Historical preservation.** This decision supersedes the 2026-07-04 two-document rule only as the current documentation architecture. The historical 2026-07-04 entry remains unchanged and historically valid for its date.

**Result.** Current facts are recorded once in Project State; historical facts remain in this ledger; future work is represented only by initiative IDs in the roadmap. Cross-document references use links or IDs rather than copied status.

## [2026-07-27] REL-BASELINE-2026-07-26 — Verified production baseline reconciliation

**Verified production baseline.** Production runs repository `/opt/techi/techi-platform` on branch `backport/platform-components-92a521c` at Git SHA `ce56fd4d401319a84437a047012d01caf4630247`. The production working tree was clean, the origin branch matched the production SHA, and the backend source hash matched that SHA.

**Runtime evidence.** Backend, frontend, and PostgreSQL containers were healthy with zero restarts at audit time. `/health` was OK, the frontend returned HTTP 200, smoke tests passed 8/8, and protected endpoints returned HTTP 401 without authentication.

**Release/package evidence.** Backend metadata was `1.0.0` and frontend package metadata `0.1.0`; neither is the primary release identity. Verified package versions were Windows Agent `2.1.20`, Endpoint MSI `2.1.20.0`, Agent Update Bridge MSI `2.1.20.0`, Linux ARM64 Agent `2.1.6`, and Remote Support MSI `1.4.6.0`. Artifact hashes were verified against the package manifest where present.

**Database evidence.** PostgreSQL was `15.18`, database `techi`, with production/repository Alembic heads `d8e9f0a1b2c3` and `e6f7a8b9c0d1`; `device_repair_count_reset_20260702` remained as schema residue.

**Release posture.** This is a **verified production baseline**, not a clean immutable release baseline: HEAD has no immutable release tag. Rollback/recovery posture still requires release anchoring, off-host backup evidence, and a restore rehearsal. This entry does not promote the SHA to `main` and does not assert that a tag was created.

## [2026-07-27] AGENT-2.1.20-RECONCILIATION — Active mixed-fleet lifecycle evidence

**Reconciliation.** The source version is `2.1.20`. Agent MSI/EXE artifacts exist and their hashes match the package manifest evidence available to the audit. The fleet is mixed: 414 devices report Agent `2.1.20`, while devices also report `2.1.5` and `2.1.6`.

**Status.** Agent `2.1.20` is the active fleet version, but it is not fleet-universal. This closes the documentary gap between the older entry that recorded the 2.1.20 code fix before Windows build/canary evidence was available and the later verified production snapshot.

**Limit.** The historical record still does not prove the exact canary device, canary date, ProductCode, rollout percentage, or a single end-to-end build/canary event. Those details remain an evidence gap; none is inferred here.

## [2026-07-27] PROD-VALIDATION-RECONCILIATION-2026-07-26 — Verification event without retroactive closure

**Historical state.** The production validation window opened on 2026-07-08 without a formal recorded `PASSED` closure. That historical lifecycle state is preserved and is not retroactively rewritten.

**New verification event.** On the 2026-07-26 production baseline audit, runtime health was verified: healthy backend/frontend/PostgreSQL containers, zero restarts at audit time, `/health` OK, frontend HTTP 200, smoke 8/8, and protected endpoints returning 401 without authentication.

**Boundary.** This is a new production-baseline verification event. It does not claim that the 2026-07-08 validation window passed, and it does not replace any owner closure that may be required for that historical programme.

## [2026-07-27] TERMINAL-729-EVIDENCE-GAP — Scoped-terminal historical evidence gap

**Known historical evidence.** Limited Terminal enablement for device `#729` was documented during the 2026-07-10 rollout work. The final browser/operator PASS or FAIL result for that individual device was not found in the historical record.

**Current verified state.** `FEATURE_TERMINAL` is ON in the verified production feature-flag snapshot.

**Classification.** The individual device `#729` result remains **UNRESOLVED HISTORICAL EVIDENCE GAP**. This entry does not infer a successful session, a failed session, a revert, or a rollout scope from the current flag state.

## [2026-07-25] Fresh MSI installs never register — legacy config gets an empty deny-all DACL from the installer's icacls (FIXED in code · Agent 2.1.20 · NOT yet built/canaried)

**Status: ROOT CAUSE PROVEN + FIX IMPLEMENTED (host-validated). MSI NOT yet built (Windows CI) and NOT canaried. Do not deploy without the canary below.**

**Symptom.** Fresh MSI 2.1.19 installs via GPO on two unrelated domains (ADPASCUCCI.COM, GFFA.LOCAL): MSI exit 0, `TechiAgent` service RUNNING, `techi-agent.exe` running, correct version — but **no heartbeat, no registration, no RustDesk, no `TECHI Remote Support2.toml`**. `agent.log` repeats forever: `open C:\ProgramData\TECHI\agent.config.json: Access is denied` / retry in 5 min. **Upgrades of existing agents are unaffected.**

**Root cause (proven).** The MSI custom action `LockdownTechiDataDir` ran:
`icacls "C:\ProgramData\TECHI\." /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /T /C /Q`.
`(OI)(CI)` are **container-only inheritance flags**; applied to the leaf file `agent.config.json` via `/T`, icacls (with `/C /Q`) **skips the grant on the file** while still stripping inheritance → the file ends up with an **empty, protected, deny-all DACL** (`O:SYG:SYD:PAI`, zero ACEs). An empty DACL denies data reads to *everyone*, including the SYSTEM owner (owner keeps only implicit `READ_CONTROL`/`WRITE_DAC`, not `FILE_READ_DATA` — which is why `Get-Acl` still works and shows "Access: empty," and why even an elevated admin gets Access Denied). This action runs on **every** install, so the legacy file ends up empty-DACL on **both** fresh and upgraded machines — hence the identical displayed SDDL.

**Why upgraded machines stayed operational.** The service loads the **canonical** `C:\ProgramData\TechiAgent\agent.config.json`. On upgrades that file already exists, so `migrateConfigIfNeeded` takes the `refreshEnrollmentTokenIfNeeded` branch and **never opens** the crippled legacy `TECHI\` file. Its healthy DACL comes from the agent's own per-file `lockdownConfigACL` (`*S-1-5-18:F`, no `(OI)(CI)`, no `/T`) — which always worked.

**Why fresh installs failed.** On a fresh install the canonical file does not exist yet, so `migrateConfigIfNeeded` must `os.Open(C:\ProgramData\TECHI\agent.config.json)` (paths.go) to bootstrap it — the exact call that returns "Access is denied," matching the log verbatim. `LockdownTechiDataDir` is sequenced **before** `StartServices`, so the DACL is already empty the first time the service reads it: deterministic, permanent failure.

**The missing RustDesk TOML is a downstream symptom, not a cause.** `ensureRustDesk` runs only inside the heartbeat cycle, after config load succeeds; config load never succeeds, so the TOML is never generated.

**CORRECTION to the [2026-07-09] entry below** ("PC i sapo-formatuar … Access is denied"). That investigation **wrongly exonerated our ACL code and blamed AV/EDR**, on the assumption that `*S-1-5-18:F` guarantees SYSTEM access. The on-disk DACL is **empty** (no `(A;;FA;;;SY)` ACE), proving the SYSTEM grant never landed — it was our installer, not AV. The 2026-07-09 change only added the lifecycle retry loop, which converted a silent death into an infinite retry (the "retry in 5 min forever" seen now). The elevated-admin "cannot repair" evidence is consistent with this and does **not** contradict SYSTEM being able to repair: Administrators is not the file owner and `icacls /grant` does not engage take-ownership/restore privileges.

**Windows security semantics (why ACL repair from the running service works).** A file with an empty (non-NULL) DACL and no OWNER RIGHTS (S-1-3-4) ACE still grants the object **owner** implicit `WRITE_DAC`; the LocalSystem service owns the file (`O:SY`), so it can re-grant itself `F` and read. The field observation that an *elevated administrator* cannot repair the ACL does **not** contradict this: Administrators is not the file owner, and a plain `icacls /grant` does not engage `SeTakeOwnership`/`SeRestore`. (A `SeBackupPrivilege` backup-semantics read was considered as a fallback that never modifies the file, but **deliberately not shipped** — it is unnecessary for the proven root cause, adds a DACL-bypass code path and privilege manipulation that can't be unit-tested off Windows, and cuts against the smallest-safe-change principle. If a canary ever shows owner-implicit `WRITE_DAC` failing, add it then, with evidence.)

**Fix (two parts, code only; no deploy).**
- **Installer (removes the cause):** `LockdownTechiDataDir` now grants `*S-1-5-18:F *S-1-5-32-544:F` (no `(OI)(CI)`) — icacls applies `(OI)(CI)` to directories and plain `F` to files on its own, identical to the proven per-file `lockdownConfigACL`. Still SYSTEM+Administrators only, inheritance still removed, idempotent. Requires MSI 2.1.20.
- **Agent self-heal (recovers the already-stuck fielded fleet without a new MSI):** on the migration read path, an access-denied on the legacy file triggers a scoped, file-only, idempotent ACL repair (grant SYSTEM+Administrators, retry exactly once). Non-permission errors (missing file, malformed JSON) never trigger ACL work. On failure the wrapped error preserves `os.ErrPermission` and the existing lifecycle retry loop continues. Secrets are never logged.

**Security scope.** No broad principals (no Users/Everyone/Authenticated Users). Secrets still restricted to SYSTEM + Administrators. Self-heal touches only the exact legacy config file, never recurses, never recreates/overwrites it, never replaces a valid canonical config.

**Files changed.** `agent/installer/installer.wxs` (icacls fix + comment), `agent/config_windows.go` (extract `applyConfigACL`; wire the repair seam via `init`), `agent/paths.go` (scoped ACL-repair recovery in migration + seam), `agent/config_recovery_test.go` (new), `agent/config_acl_repair_windows_test.go` (new; Windows integration test — real icacls empty-DACL repro → `applyConfigACL` → `os.ReadFile` succeeds), `agent/installer_wxs_test.go` (new), `agent/VERSION` → 2.1.20.

**Test evidence (macOS host).** `gofmt` clean; `go vet ./...` clean; `go test ./...` PASS. New recovery tests **ran, not skipped** (host enforces mode bits → real EACCES exercised): fast-path, missing-file-no-repair, malformed-JSON-not-ACL, permission→exactly-one-repair→retry, repair-fails→actionable wrapped error preserving `os.ErrPermission` (file left untouched), repair-reports-success-but-still-unreadable→actionable error, idempotency, and no-secret-in-logs. Installer assertion test confirms the command has no `(OI)(CI)` and no broad principals. `GOOS=windows GOARCH=amd64 go build` PASS. **Not runnable on macOS:** the MSI build (`wix` on macOS errors on unrelated `Directory/@Name` lines — "WiX only supports Windows"); build the MSI on the Windows CI runner. The real icacls repair is compile-validated only and needs a Windows canary.

**Canary procedure.** Build MSI 2.1.20 on Windows CI (single-source version = `agent/VERSION`). On a throwaway fresh VM joined to a test domain: GPO/`msiexec /i TECHI-Endpoint-Deployment-2.1.20.msi /qn ENROLLMENT_TOKEN=…`; confirm `(Get-Acl 'C:\ProgramData\TECHI\agent.config.json').Sddl` now contains an `(A;;FA;;;SY)` ACE, the device registers, heartbeats, and `TECHI Remote Support2.toml` is generated. Separately, on an *already-stuck* 2.1.5–2.1.19 fresh install, deploy the 2.1.20 agent binary (or `sc stop/start TechiAgent` after dropping the new exe) and confirm the self-heal log lines and successful migration **without** reinstalling the MSI.

**Rollback procedure.** Code is unshipped; revert is `git revert`/reset of the listed files. If 2.1.20 MSI is published and regresses, the MajorUpgrade/UpgradeCode is unchanged, so redeploying the prior signed 2.1.19 MSI is a standard downgrade-by-reinstall; existing `device_id`/enrollment are preserved (config untouched by rollback).

**Remaining risks.** MSI build + the Windows-only ACL repair are unproven on a live Windows host (canary required). If owner-implicit `WRITE_DAC` ever fails on a real machine, the agent stays in its (harmless) retry loop and the 2.1.20 MSI reinstall still fixes it — no regression vs. today. Edge case: if a machine has both a broken legacy file *and* a broken canonical file, the canonical path is out of scope of this fix (not observed).



**Status: PILOT-VALIDATED / FIXED.** Priority-1 blocker. NOT rolled fleet-wide.

**Symptom (GPO pilot, upgrading an old agent):** `msiexec /i TECHI-Agent-2.1.18.0.msi` never
exited; `techi-deploy.cmd` (`\\...\NETLOGON`) stayed running; Windows Installer stayed locked
("Another installation is in progress"); a `techi-agent.exe stop-remote-support-runtime` child
process stayed alive >1h and kept heartbeating.

**Root cause.** The agent MSI custom action **`KillTechiRSBeforeInstall`** runs `Before InstallFiles`
as a **synchronous deferred** action and invoked `[INSTALLFOLDER]techi-agent.exe stop-remote-support-runtime`
on the **pre-existing** binary. On any agent older than 2.1.17 (the pilot ran **2.1.6**), that binary
has no `stop-remote-support-runtime` case in `main()`: `os.Args[1]` matches no dispatch case →
`isServiceCommand` is false → `flag.Parse` leaves it as a positional → `main()` reaches
`runAgent(ctx, …)` — the normal heartbeat loop, which never exits. Because a deferred CA is
synchronous, msiexec waits on it forever → Installer locked. The >1h "stop" process was in fact a
full 2.1.6 agent loop (hence the heartbeats). Compounding: the same CA ran `sc delete "TECHI Remote
Support"` on **every** agent upgrade, needlessly disrupting a healthy managed RS service.

**Fix (Windows agent + MSI only; no GPO/deployment change; no fleet trigger). Commit `de5aaaa`, Agent 2.1.19.**
- `installer.wxs` — `KillTechiRS` + `KillTechiRSBeforeInstall` **no longer invoke the agent binary**.
  They run a self-contained, PID-targeted, path-validated PowerShell stop (`Get-CimInstance` →
  `Stop-Process -Id`, only exes under a Remote Support install dir), **bounded** by
  `Start-Job`/`Wait-Job -Timeout 45`, logging start/done/timeout to `deploy.log`. The old-binary
  fall-through is eliminated; the CA cannot hang.
- `sc delete "TECHI Remote Support"` on upgrade → `sc stop` (stop to release file locks for
  `InstallFiles`, never delete the healthy service). Full-uninstall deletion unchanged.
- Agent subcommands hardened (`boundedoneshot.go`, `bootstrap_windows.go`):
  `stop-remote-support-runtime` / `remove-tray-artifacts` run under a hard 60 s wall-clock bound
  (deterministic exit 0/2); `main()` dispatches them via `os.Exit` **before** `runAgent`.
- Failure policy: `Return="ignore"` — a stop hiccup does not fail the MSI (InstallFiles has
  FileInUse handling); documented in the CA comment.

**Changed files:** `agent/installer/installer.wxs`, `agent/boundedoneshot.go` (new),
`agent/boundedoneshot_test.go` (new), `agent/bootstrap_windows.go`, `agent/VERSION` (→2.1.19),
`backend/tests/test_remote_support_migration_source.py`.

**Preflight (off-prod, `de5aaaa`):** PASSED — contract 15/0, backend **975/975** flags OFF & ON,
tsc, frontend build, agent go build+test (windows+linux); all 3 WiX installers well-formed.

**Canary (CI run 30053953120, success):** `TECHI-Endpoint-Deployment-2.1.19.msi`
sha256 `2a75803ead4ad56a5185c000adf801ecd398ddbce08e52fbc5b300fb6c10b286`;
`techi-agent-2.1.19.exe` sha256 `c36bc9774b9bd4f5a57a7af6c2a60faed2997d76cdec27a142435ece599bc902`
(AgentVersion 2.1.19). Verified in-MSI: fixed CA present, `stop-remote-support-runtime` agent-binary
call absent, `sc stop` (not delete).

**Pilot evidence (GPO machine, PASSED):** GPO installed **2.1.19.0**; dashboard Installed 2.1.19 /
Desired 2.1.19 / **Current**; TechiAgent **Running**; **`msi_exit_code=0`**; scheduled task
"TECHI Agent Deploy" **Ready**, Last Result **0**; **no** `stop-remote-support-runtime` process left;
**no** stuck msiexec; `deploy.cmd` completed; `registry_version_after_install=2.1.19.0`,
`installed_product_code_after_install={12F2C383-3E83-4BEB-B6E1-080A991E9F40}`,
`service_state_after_install=RUNNING`, `version_state=equal`, `result=0`, `service_after=RUNNING`.
**Existing Remote Support preserved** (no RS disruption from the agent-only upgrade).

**Decisions / not-done (owner-directed):** 2.1.19 packages **not** activated fleet-wide (no
self-update trigger); **no** fleet rollout; auto-remediation stays **OFF**. Phase-2 Remote Support
migration/discovery work (legacy `RustDesk`-DisplayName classification, migration-condition
correction in `isRustDeskInstalled`/`ensureRustDesk`, deploy-hazard hardening) is **queued, not
started** — see the RCA in this session; migration will be operator-triggered per device (option a).

**Branch context (this session, `backport/platform-components-92a521c`):** backend deployed to prod
`/opt/techi/techi-platform` at `75b5761` then `dc67334` (drawer self_update payload fix); agent
builds `3b1fa51` (2.1.18, ProductCode-first discovery), `de5aaaa` (2.1.19, this fix). RS package
1.4.6.0 active (windows-amd64). No DB migration in any of these.

---

## [2026-07-22] Platform Components — Operational · PRODUCTION DEPLOY (v2.2.1-platform-components-operational)

Deploy i të gjitha 14 milestone-ve Operational në prodhim. **Rollback NUK u përdor.**

**Release:**
- Branch `backport/platform-components-92a521c`, **FINAL_SHA `2918855b93e451658f4f75e5732bb9b5554665cd`** (14 commit-e Operational mbi `cf59590`).
- Push në origin via HTTPS (osxkeychain; çelësi SSH `github_techi` ka passphrase e s'ngarkohej — HTTPS funksionoi si më parë).
- Annotated tag **`v2.2.1-platform-components-operational`** → `2918855` (origin).

**Preflight lokal:** `scripts/preflight.sh` → PASSED (single-engine guard; contract 15/0; backend flags OFF/ON **924 passed / 4 baseline**; tsc; frontend build; agent go build). 4 dështimet = saktësisht baseline `test_enrollment_audit_diagnostics`, identike me `cf59590`.

**Preflight prod (`/opt/techi/techi-platform`):** live HEAD `cf59590` (PRE_DEPLOY_SHA), working tree clean, containers healthy, `/health` 200, 0 HTTP-500. Rollback anchors të krijuar (aditive, s'prekën runtime-in): git tag **`pre-v2.2.1-operational` → `cf59590`** + image snapshots **`techi-platform-backend:pre-v2.2.1-operational`** (`bcb238`) / **`frontend:pre-v2.2.1-operational`** (`13f6ae`). (Ekzistonin edhe `pre-backport-deploy` = build `92a521c` si fallback më i thellë.)

**Deploy:** `git fetch --tags origin` → `git checkout --detach 2918855` (HEAD==FINAL_SHA, tree clean) → `docker compose build` (backend+frontend) → `docker compose up -d`. Postgres **Running/i paprekur** (i njëjti volume, **pa migration**). Images të reja: backend `0cb72f17`, frontend `bd7617c7` (të dyja healthy). PRE-deploy images: backend `bcb238`, frontend `13f6ae`.

**Health & smoke:** `/health` 200, frontend 200, login 401, `scripts/smoke.sh` **8/8 PASSED**. Endpoint-et e reja Component-Action (actions/telemetry/package/bulk/component-states/platform-components) të gjitha **401 (jo 500)** → rutat e regjistruara e të mbrojtura si duhet. (`openapi.json` 404 — sjellje ekzistuese e prodhimit, e pandryshuar; s'preka konfig-un e docs.)

**Monitorim ~10 min:** 0 HTTP-500, 0 Traceback, 0 ERROR/CRITICAL, 0 auth-failures; heartbeat të gjithë **204** (~2000/min) — **pa storm, firma e incidentit të korrikut mungon**; containers healthy, 0 restarts; load stable/në rënie (5-min 3.97→2.58, tail i build-it). Rollback NUK u aktivizua (asnjë kriter dështimi).

**Verifikim i mbetur (owner):** click-through i autentikuar në UI (drawer/panel/history/telemetry) — s'ka token operatori/browser në sesionin e deploy-it; **asnjë veprim real mbi pajisje s'u ekzekutua** (asnjë target test i aprovuar).

**Rollback (nëse duhet ndonjëherë):** `cd /opt/techi/techi-platform && git checkout --detach pre-v2.2.1-operational` + rikthe images `techi-platform-backend:pre-v2.2.1-operational` / `frontend:pre-v2.2.1-operational` (ose `docker tag ... :latest`) + `docker compose up -d`.

---

## [2026-07-22] Platform Components — Operational · Milestone 14: Production Hardening (deployed)

Kalim rishikimi + hardening mbi tërë sipërfaqen Operational. Posture:

- **Audit:** çdo path që ndryshon gjendjen shkruan `audit_log` (single `action_queued` +
  component/operation; retry `action_retried` + `retried_from`; bulk një summary; remediation që
  vepron). Read-endpoints s'auditohen.
- **Logging:** shtuar te `ComponentActionService` (log për çdo veprim të radhitur + summary bulk)
  dhe `ComponentRemediationService` (auto-skip). Mbi log-et ekzistuese të `RemoteActionService`.
- **Validation:** një validator i vetëm i renditur (M3) me kode stabël gabimi.
- **Race/concurrency:** pa dublikate — rojtari ekzistues i konfliktit te `queue_action` është pika
  e vetme e serializimit; single/retry/bulk kalojnë përmes tij (test: dublikatë→409, s'dyfishohet).
- **Security:** çdo write kërkon ≥OPERATOR + scope + permission per-action; read kërkon auth+scope;
  override vetëm owner/admin (`is_unrestricted`); pajisje jashtë scope/që mungon → 404 (s'rrjedhin);
  bulk i kufizuar 1000.
- **Performance:** history/telemetry lexojnë dritare të kufizuar + agregim në memorie; bulk i kufizuar;
  package ripërdor leximin ekzistues të manifestit; pa hot-path të ri në heartbeat.

**Tests:** `tests/test_component_action_hardening.py` (7 raste: auth i detyruar në read/write/bulk,
audit single + bulk, idempotency s'dyfishon, override kërkon operator elevated). Backend full suite:
**924 passed** (4 baseline pre-ekzistuese, të palidhura); frontend tsc clean + vitest 80 + build green.
NOT deployed.

**Përfundim:** të 14 milestone-t e Platform Components — Operational të plota. Themeli
(Registry/Lifecycle/Policy/Desired-State) i paprekur. Deployment vendoset vetëm nga owner-i.

## [2026-07-22] Platform Components — Operational · Milestone 13: Telemetry (NOT deployed)

Agregim read-only mbi store-in **ekzistues** `remote_actions` — pa storage të ri, pa counter-a
për të mbajtur në sinkron. Ripërdor të njëjtin seam atribuimi si History.

**Shtuar:** `services/component_telemetry_service.py` — grupim i veprimeve sipas komponentit dhe
operacionit, me metrics per-komponent **dhe** per-operacion: total/succeeded/failed/in_progress/
cancelled, failures, success_rate (succeeded/(succeeded+failed), null kur asnjë), avg_duration_seconds
(mbi veprimet completed), statistika per-operacion.
- `GET /devices/{id}/components/telemetry` (scope-checked, `limit ≤ 2000`) + schema.
- FE: `getComponentTelemetry()` + tipat.

**Tests:** `tests/test_component_telemetry.py` (4 raste: agregim per-komponent/operacion me durim,
injorim i veprimeve jo-komponent, success_rate=null kur in-progress, endpoint shape). Backend full
suite: **917 passed** (4 baseline); frontend tsc clean. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 12: Auto Remediation (NOT deployed)

Zbulon një komponent të pashëndetshëm dhe, **nëse policy e lejon**, e riparon duke radhitur
operacionin e rekomanduar përmes path-it **ekzistues** të veprimeve. Pa automatizim paralel,
**pa scheduler** — rollout/scheduling mbetet "future" te Policy-ja STABLE.

**Shtuar:** `services/component_remediation_service.py`:
- `detect()` (read i pastër, ripërdor statusin e M11): outdated→update; missing→install (ose
  reinstall kur install është out-of-band, p.sh. Agent GPO); healthy/unknown→asgjë. Operacioni
  duhet të jetë i mbështetur **dhe** i ekzekutueshëm — Agent missing → asnjë veprim (s'trillohet).
- `remediate(dry_run, auto)`: radhit përmes `ComponentActionService.execute` ekzistues.
- Dy porta: **auto** (unattended) kërkon policy `AUTO_REMEDIATION` (`GLOBAL_AUTO_REMEDIATION` +
  override per-komponent), default **OFF**; **manual** kalon nëpër validim+policy(M10)+permission.
- `POST /devices/{id}/components/{component}/remediate` (`dry_run`→detect-only) + schema.
- FE: `remediateComponent()`.

**Tests:** `tests/test_component_remediation.py` (11 raste me status të patched: detect
outdated/missing-agent/missing-RS/healthy; remediate queues/dry_run/noop; auto disabled default,
runs kur enabled, allowed default False) + endpoint shape. Backend full suite: **913 passed**
(4 baseline); frontend tsc clean. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 11: Package Integration (NOT deployed)

Lidh shtresën e veprimeve me Package Registry, read-only, duke ripërdorur burimet ekzistuese
(pa storage të ri; resolver-i STABLE i Desired-State dhe `policy.py` s'preken — vetëm lexohen).

**Shtuar:**
- `services/component_package_service.py` (`ComponentPackageService`, `ComponentPackageStatus`).
  Ripërdor privatët e `component_state_service` (`_package_platform`, `_DESIRED_FILE_TYPE_ORDER`)
  pa i modifikuar.
- `GET /devices/{id}/components/{component}/package` → Installed/Desired/Available + Outdated.
  Available = versioni më i lartë në manifest (aktiv OSE joaktiv) për file-types e komponentit.
- Enrichment i payload-it për operacionet version-changing (install/update/reinstall):
  injekton `version` (+ `target_sha256`) të paketës aktive te payload-i i radhitur, që
  `self_update`/`deploy_remote_support` të synojnë paketën Desired dhe verifikimi me heartbeat
  të konfirmojë. **Parametrat e operatorit fitojnë gjithmonë**; enrichment mbush vetëm boshllëqet;
  inert kur s'ka paketë aktive (i sigurt për testet pa manifest). Në path-et single + bulk.
- FE: `getComponentPackageStatus()` + tipi.

**Tests:** `tests/test_component_package_service.py` (7 raste me fakes: available active/inactive,
status i kombinuar, enrichment version+sha, jo për restart, bosh pa aktive) + enrichment-merge te
execution + endpoint shape. Backend full suite: **902 passed** (4 baseline); frontend tsc clean.
NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 10: Policy Enforcement (NOT deployed)

Shtresë e re *zbatimi* policy-je (pa prekur `policy.py` STABLE — vetëm e lexon), e kompozuar
më e përgjithshmja e para, kthen mohimin e parë (fail-closed): **global → tenant → component →
override**. E lidhur si hapi 6 i validatorit (M3 e shtyu enforcement-in këtu).

**Shtuar:** `services/component_policy_enforcement.py` (`ComponentPolicyEnforcer`,
`GLOBAL_COMPONENT_POLICY` kill-switch, `TENANT_COMPONENT_POLICIES` seam per-tenant, `EnforcementDecision`).
- Global: ndalon të gjitha veprimet manuale pa deploy.
- Tenant: override opsional sipas `client_id`; mungon ⇒ trashëgon global (pa tabelë DB).
- Component: lexon `policy_for` — strategy jo-`MANUAL` ⇒ automation-governed, s'lejohet manualisht.
- Override: vetëm owner/admin (`override: true`) kalon mbi policy-t soft; kurrë mbi validimin e fortë.
Mohimi → `POLICY_DENIED` → **403** me scope-in në mesazh. I threaduar në path-et single/retry/bulk
(kod i ri `policy_denied`; `override` te request-et, honored vetëm për operator elevated).

**Tests:** `tests/test_component_policy_enforcement.py` (7 raste: default lejon, global kill-switch,
tenant i izoluar, strategy jo-manuale mohon (monkeypatch pa prekur registrin), override bypass,
+ validator raises/override) + 2 endpoint (403 + admin override 200). Suite i lidhur: **65 passed**.
NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 9: Bulk Operations (NOT deployed)

Veprime në masë mbi **shumë pajisje × shumë komponentë** në një kërkesë të vetme, secili i
radhitur **në mënyrë të pavarur** përmes path-it ekzistues single-item.

**Shtuar:**
- `POST /components/actions/bulk` — body `device_ids[]` + `targets[]` (`{component_id, operation}`)
  + `parameters`/`timeout_seconds` opsionale. Validim per-item + partial failures: çdo item kthen
  `ok` ose `error_code` stabël (`unsupported_operation`/`unavailable_for_device`/`device_not_found`/
  `permission_denied`/`conflict`/…). Pajisjet jashtë scope/që mungojnë → `device_not_found` (s'rrjedhin).
  device_ids dedup. Guardrail `device_ids × targets ≤ 1000` (400). Përmbledhje `total/succeeded/failed`.
  Progres live përmes event-eve realtime ekzistuese (M6).
- `ComponentActionService.bulk_execute()` + `BulkComponentActionItemResult`.
- Schemas `BulkComponentAction{Target,Request,Item,Response}`.
- FE: `bulkComponentActions()` + tipat.

**Tests:** `tests/test_component_action_bulk.py` (6 raste: sukses i plotë multi-device/multi-komponent,
partial failure per-item, konflikt dublikate në batch, kërkesa boshe→400, limit madhësie→400, timeout).
Backend full suite: **885 passed** (4 baseline pre-ekzistuese); frontend tsc clean. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 8: Retry & Idempotency (NOT deployed)

**Idempotency:** dublikatat bllokohen tashmë nga rojtari ekzistues i konfliktit të radhës (409) —
asnjë mekanizëm i ri; testet e vërtetojnë.

**Shtuar:**
- Retry: `POST /devices/{id}/components/actions/{action_id}/retry` — ri-validon `(component,
  operation)` kundër gjendjes **aktuale** të pajisjes (capability/policy mund të kenë ndryshuar),
  i njëjti gate lejesh, ri-radhitet përmes `retry_action` ekzistues. Refuzohet: 409 nëse jo-terminal,
  422 (`not_a_component_action`) nëse s'është veprim komponenti, 404 nëse mungon/jashtë scope. Audit
  `action_retried`. `ComponentActionService.retry()`.
- Timeout: `ComponentActionRequest.timeout_seconds` (opsional) validohet në `[1, 3600]`
  (`invalid_timeout` → 400) dhe kalon te `execution_timeout_seconds`; mungesa = default (300s).
  `bool` refuzohet shprehimisht. Kode të reja: `invalid_timeout`, `not_a_component_action`.
- FE: `retryComponentAction()` + `timeoutSeconds` te `queueComponentAction`.

**Tests:** 8 raste të reja (timeout valid/invalid, retry i suksesshëm i një veprimi terminal,
retry jo-terminal→409, jo-komponent→422, mungon→404; + timeout te validatori incl. bool). Backend
i lidhur: **69 passed**; frontend tsc clean. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 7: History (NOT deployed)

Historia e veprimeve të komponentit **ripërdor store-in ekzistues `remote_actions`** — asnjë
tabelë e re, asnjë migrim (rregulli i DB-schema).

**Shtuar:**
- `GET /devices/{id}/components/actions` (opsionale `component_id`, `limit`) — kthen çdo
  `RemoteAction` të radhitur që i atribuohet një komponenti (përmes indeksit të kundërt të
  Lifecycle / `attribute()`) me: operation, user (`created_by`), timestamp (`created_at`),
  result (`result_message`/`error_message`/`status`), duration (`duration_seconds`), device,
  component. Më i riu i pari; scope-checked.
- `ComponentActionService.history()` + `ComponentActionHistoryEntry`.
- Schemas `ComponentActionHistoryItem` (zgjeron `RemoteActionResponse`) + `...Response`.
- FE: `getComponentActionHistory()` + tipat në `api/platform.ts` (pa UI të re — ActivityTimeline
  ekzistuese e drawer-it e shfaq tashmë; s'krijohet histori e dyfishtë).

**Tests:** 3 raste të reja endpoint (atribuim + fusha, filter sipas komponentit, bosh). Backend i
lidhur: **34 passed**; frontend tsc clean. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 6: Realtime Status (NOT deployed)

Statusi i ekzekutimit i drejtpërdrejtë në panel, **pa refresh manual**. Meqë veprimet e
komponentit janë `RemoteAction` të zakonshëm, ato emetojnë tashmë event-et ekzistuese
realtime (`action_queued`/`action_status_changed`) — asnjë event i ri, asnjë ndryshim backend.

**Shtuar:**
- `ComponentStatesPanel.tsx`: abonim përmes `useDeviceRealtime`; badge live për komponent —
  Pending (queued/sent/acknowledged), Running (running, me spinner), Success (completed),
  Failed (failed/expired/cancelled). Atribuim event→komponent me hartë `action_type→component_id`
  të ndërtuar nga metadata e lifecycle (pasqyrë client-side e indeksit të kundërt të backend-it).
  Në fazë terminale → refetch i desired-state. Helper i pastër i eksportuar `phaseForStatus`.
- `services/deviceRealtime.ts`: guard mbrojtës — kur `WebSocket` mungon (jsdom/tests) degradon
  te `fallback` në vend që të hedhë exception (i padëmshëm në prod).

**Tests:** `phaseForStatus.test.tsx` (5 raste, mapping i pastër); panel-tests mbeten green me
realtime të aktivizuar (guard-i parandalon crash). Frontend gate: **tsc clean, vitest 80 passed
(12 files), build green**. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 5: Frontend Wiring (NOT deployed)

Paneli ekzistues read-only (`ComponentStatesPanel.tsx`) i lidhur me endpoint-in e ri
**pa ridizajn UI**. Çdo chip operacioni me `kind === "action"` bëhet buton i klikueshëm
(pamje e njëjtë); operacionet out-of-band (GPO install, heartbeat discover) mbeten etiketa
statike të zbehta.

**Shtuar:**
- `api/platform.ts`: `queueComponentAction(deviceId, componentId, operation, parameters?)`
  + tipat `ComponentActionAccepted`/`QueuedRemoteAction` (POST te endpoint-i i ri).
- `ComponentStatesPanel.tsx`: klik → POST, spinner mbi operacionin që ekzekutohet,
  **disable i të gjitha operacioneve të atij komponenti** gjatë ekzekutimit (`busy` key
  `component:operation`), sukses → "<Label> queued" + refetch i desired-state, dështim →
  mesazhi i strukturuar i backend-it në një rresht të kuq.
- `api/client.ts`: përmirësim aditiv — nxjerr `detail.detail` nga trupi i gabimit të
  strukturuar (pa prishur sjelljen ekzistuese për `detail` string).

**Tests:** `ComponentStatesPanel.test.tsx` zgjeruar në 6 raste (trigger + feedback, gabim i
strukturuar, out-of-band s'është buton, + 3 ekzistueset). Frontend gate: **tsc clean,
vitest 75 passed (11 files), build green**. Pa varësi të re (përdor butona të thjeshtë).
NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 4: Execution Layer (NOT deployed)

Resolver-i i lidhur me mekanizmin **ekzistues** të device actions — asnjë sistem paralel,
Action Queue nuk ridizajnohet. Një veprim komponenti i radhitur nga `execute()` bëhet një
`RemoteAction` i zakonshëm në të njëjtën tabelë `remote_actions` dhe kalon të njëjtin
pipeline: `collect_pending_for_delivery` (dorëzim me heartbeat) → `acknowledge` →
`mark_running` → `complete`/`fail`, të gjitha nga `RemoteActionService` i paprekur.
Rojtari ekzistues i konfliktit/dublikatës zbatohet i pandryshuar.

**Shtuar:** `ComponentActionService.attribute(action_type)` — seam-i i kundërt që mapon çdo
`RemoteAction` mbrapsht te `(component_id, operation)` përmes indeksit të kundërt ekzistues
të Lifecycle Registry (`component_operation_for_action`); pa store të ri, veprim i përbashkët
palohet te operacioni i parë i deklaruar. Kjo shërben History (M7) + Telemetry (M13).

**Tests:** `tests/test_component_action_execution.py` (5 raste: veprim komponenti = `RemoteAction`
i thjeshtë; rrjedhë e plotë deri në COMPLETED përmes pipeline-it ekzistues; rojtari i konfliktit;
atribuim i kundërt). Suite i lidhur: **57 passed**. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 3: Validation Layer (NOT deployed)

Shtresë e vetme validimi, e renditur — çdo vendim "a lejohet të radhitet ky veprim"
te një vend i vetëm, pa degëzim të shpërndarë.

**Shtuar:** `services/component_action_validator.py` (`ComponentActionValidator.validate`)
me kontrolle të renditura, secili ngre `ComponentActionError` me `code` stabël:
(1) component/operation/executability → resolver-i i pastër (M1); (2) capability e
pajisjes (`actions_for`) → `unavailable_for_device`; (3) prania e policy-t (`policy_for`)
→ `no_policy`; (4) formati i `version`-it të dhënë → `invalid_version` (400).
`ComponentActionService.resolve_for_device` tani delegon te validatori (hoqa kontrollin
inline të capability-t — validimi rron në një vend). Kode të reja gabimi: `no_policy`,
`invalid_version`. Shtuar te allowlist-i i wiring-ut.

**Jashtë qëllimit me vetëdije** (milestone të veta; do e lidhnin këtë shtresë me manifestin
file-based dhe do e bënin jo-deterministe): disponueshmëria e paketës / zgjidhja e desired-version
/ outdated → **M11**; *zbatimi* i policy-t përtej "ekziston një policy" → **M10**. Ato milestone
e zgjerojnë këtë validator, s'krijojnë gate paralel.

**Tests:** `tests/test_component_action_validator.py` (11 raste: kalime, të gjitha kodet
e gabimit, renditja e kontrolleve, version bosh injorohet, agjenti Windows pa capability
ruan sipërfaqen e plotë). M2 endpoint tests mbeten green (asnjë gate i ri që i prish).
Suite i lidhur: **53 passed**. NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 2: Component Action API (NOT deployed)

Endpoint i vetëm, registry-driven, për çdo operacion lifecycle të një komponenti —
pa route per-operacion, pa degëzim per-komponent.

**Shtuar:**
- `POST /devices/{id}/components/{component}/actions` (`endpoints/component_actions.py`)
  me body `{operation, parameters?}`. Rrjedha: scope-check → resolve (M1) + kontroll
  disponueshmërie për pajisjen (`actions_for` mbi platform+capabilities) → i njëjti gate
  lejesh si endpoint-i gjenerik (`ACTION_PERMISSION_MAP`) → radhitje përmes
  `RemoteActionService.queue_action` **ekzistues** (asnjë queue paralel).
- `services/component_action_service.py` — shtresa e hollë resolver→queue
  (`ComponentActionService.execute/resolve_for_device`), kthen `ComponentActionResult`.
- Schemas: `ComponentActionRequest/Accepted/ErrorOut` në `schemas/platform_component.py`.
- Kod i ri gabimi `unavailable_for_device` te `ComponentActionErrorCode`.
- Regjistruar te `api/v1/api.py`; shtuar te allowlist-i i kufirit të wiring-ut
  (`test_platform_core.py`) si dy seam-e të miratuara.

**Mapping gabimesh → HTTP:** `unknown_component`→404, `unknown_operation`→400,
`unsupported_operation`/`not_executable`/`unavailable_for_device`→422, konflikt radhe→409.
Sukses → `ComponentActionAccepted` (component/operation/action_type/label + `RemoteAction`).
Audit `action_queued` me kontekstin component/operation.

**S'u prek:** asnjë `ActionType` i ri, asnjë queue paralel, asnjë kontratë agent/heartbeat,
asnjë migrim DB. Foundation-i mbetet i ngrirë.

**Tests:** `tests/test_component_action_endpoint.py` (10 raste kundër sqlite-it real:
happy-path, pass-through parametrash, të 5 kodet e gabimit, dhe rojtari i konfliktit).
Backend full suite: **852 passed**, 4 dështime baseline pre-ekzistuese
(`test_enrollment_audit_diagnostics`, të padokumentuara si rezultat i kësaj pune). NOT deployed.

## [2026-07-22] Platform Components — Operational · Milestone 1: Component Action Resolver (NOT deployed)

Nisi puna *Operational* mbi themelin STABLE (Registry/Lifecycle/Policy/Desired State
nuk u prekën). Milestone 1 shton **vetëm** resolver-in — asnjë endpoint, asnjë ekzekutim.

**Shtuar:** `backend/app/platform_core/action_resolver.py` — një shtresë e pastër domain
(si pjesa tjetër e `platform_core`: importon vetëm registrat motra + enum-et e schema-ve;
kurrë FastAPI/DB/services/queue). Kthen `(component, operation)` → `ActionType` ekzistues
+ payload bazë, ose një `ComponentActionError` të strukturuar me `code` stabël
(`unknown_component` / `unknown_operation` / `unsupported_operation` / `not_executable`).
Degëzimi sipas komponentit rron **vetëm** këtu (`resolve_component_action`); `can_resolve()`
është varianti që s'ngre kurrë exception. Fail-closed: operacionet out-of-band (Agent install
via GPO, discover via heartbeat — `action_type is None`) nuk shndërrohen kurrë në veprim të
trilluar. Re-exportuar nga `platform_core/__init__.py`.

**S'u prek:** asnjë `ActionType` i ri, asnjë queue paralel, asnjë kontratë prodhimi, asnjë
migrim DB, asnjë agent/heartbeat/enrollment.

**Tests:** `tests/test_action_resolver.py` (16 raste: happy-path për të gjitha operacionet e
`agent`/`remote_support`, gabimet e strukturuara, normalizim, immutability, dhe një kontroll
shterues që çdo `(component, operation)` e zgjidhshme jep një `ActionType` real). Backend suite
i lidhur: **88 passed** (resolver + lifecycle + component + policy + state + endpoint + action
registry). `py_compile` + import OK. NOT deployed.

## [2026-07-21] Platform Components — backport onto production base 92a521c (additive, read-only; NOT deployed)

Backported the Platform Components layer onto the production commit `92a521c` WITHOUT
carrying any of the 97 other commits on `stable/phase-2-heartbeat`. Purpose: allow
shipping Platform Components to prod without undoing the 2026-07-18 total rollback.

**Ported (allowed set):** 4 inert `AgentFileType` enum declarations
(`remote_support_msi/dmg/pkg/bundle` — identifiers only, no behavior); Component
Registry (`platform_core/components.py`); Lifecycle Registry (`lifecycle.py`);
Deployment Policy model (`policy.py`); Desired-State resolver
(`services/component_state_service.py`); schemas (`schemas/platform_component.py`);
read-only endpoints (`GET /platform/components`, `GET /devices/{id}/component-states`);
`platform_core/__init__.py` exports; wiring-boundary allowlist entry; frontend API
(`api/platform.ts`), the read-only `ComponentStatesPanel` mounted in both Device
Drawers; canonical design doc `architecture/PLATFORM-COMPONENTS.md`; tests.

**Deliberately EXCLUDED (not ported):** the installer/agent split, all Remote Support
behavior, macOS changes, Package Registry changes, the Agent Packages page grouping +
`usePlatformComponents` hook (Package-Registry UI), the `agent-auth-migration` endpoint
(enrollment), `agentPackages.ts` type change, and the unrelated
`test_windows_installer_reliability` fix. No heartbeat, enrollment, manifest, Action
Queue, or DB change. **No migration.**

**Method:** no cherry-pick. Files whose 92a521c→branch diff was purely additive
(`__init__.py`, `platform.py`, `api/platform.ts`, `GenericDeviceDrawer.tsx`) were taken
verbatim from the branch; diverged/behaviour-carrying files (`agent_package.py`,
`devices.py`, `DeviceDrawer.tsx`) were edited by hand to add ONLY the Platform Components
lines. Branch: `backport/platform-components-92a521c` (based on `92a521c`).

**Validation:** backend full suite **827 passed + 4 known pre-existing baseline failures**
(`test_enrollment_audit_diagnostics`, missing `trusted_domains` table — unrelated, present
at 92a521c). Frontend `tsc` clean, vitest **72/72**, `npm run build` OK. Local runtime
smoke: `/health` 200, both new routes registered in OpenAPI, `/platform/components`
returns 401 (not 500) unauthenticated. **Not deployed.**

**This file is the project's HISTORY — and only the history.** Every bug,
incident, deploy, optimization, migration, technical decision, hotfix,
analysis, root cause, and workaround is recorded here, newest first. The
CURRENT state of the project lives exclusively in
[PROJECT_STATE.md](PROJECT_STATE.md) — never describe current state here, and
never record history there.

**Entry format for new entries** (use the sections that apply):

```markdown
## [YYYY-MM-DD] <title>
### Problemi     — what was wrong / what was needed
### Analiza      — what was investigated, with evidence
### Shkaku       — root cause
### Zgjidhja     — the decision/fix taken
### Ndryshimet   — files/config/infra changed
### Rezultati    — verified outcome
### Mësimet      — lessons / gotchas for the future
```

Older entries predate this template; they remain valid as written.

## [2026-07-11] FIX/FEATURE: Connect aligned to the approved V3 mockup — split button, categorized menu, Winbox restored, honest embedded gating

### Problemi

Owner reported the production Connect experience does not match the approved
V3 Connect mockup (docs/reference/PLATFORM-EXPANSION-AUDIT.md "mockups v3",
artifact `ab02c7de-d2d7-4adf-a37d-4965965e1395`, screen 6): (1) Winbox not
visible at all for MikroTik; (2) the Device Catalog Connect button opened the
Device Drawer instead of launching the default method / showing the method
menu; (3) the Connect menu was a flat list, not the categorized menu of the
mockup; (4) the platform-specific methods promised by the Platform Registry
were not exposed as promised; (5) overall visual/functional divergence from
the approved mockup (no split button, no "Always use this option", no
transport labels).

### Analiza

- **Why Winbox "disappeared"**: two independent layers hid it. (a) The
  2026-07-10 UX pass made `ConnectMenu.tsx` REMOVE any method whose
  `requires_client_os` didn't match the operator's OS — on the owner's macOS,
  Winbox was deleted from the array entirely (the 2026-07-11 release
  `9b99a07` changed this to disabled-with-reason, but only inside the Drawer
  menu). (b) The Device Catalog Connect button for non-Windows rows never
  showed methods at all — it deliberately opened the Drawer (the 2026-07-11
  compromise to avoid an N+1 per-row status fetch), so from the Catalog the
  operator never saw Winbox exist. The backend registry itself always had
  Winbox (`platform_core/connect.py`, capability=None → always returned by
  `/connect-methods`).
- **Embedded methods were "fake" outside the rollout scope**: Connect ▸ SSH
  opened the Embedded SSH modal even for devices where `FEATURE_TERMINAL`'s
  rollout scope (device-729-only in prod) makes session creation 403 — the
  method looked Ready and failed on click. Same for the Web Terminal entry,
  which only showed a "has its own Connect flow" toast.
- **No OS-aware defaults**: `_resolve_preferred_method` ignored the operator's
  OS, so on macOS the registry default for MikroTik was Winbox — a method
  that can never work there.

### Zgjidhja

**Backend** (`platform_core/connect.py`, `platform_core/registry.py`,
`api/v1/endpoints/connect.py`):
- `ConnectMethod` gained `transport` (short label: "Agent tunnel", "Backend
  relay · Vault", "Browser", "Desktop app"), `category`
  (`available`/`web`/`desktop_app` — the mockup's menu sections), and
  `embedded` (runs on the Terminal stack). Labels aligned to the mockup:
  Linux `web_terminal` → **Embedded Terminal**, `ssh` → **Embedded SSH**
  (external OS SSH client stays the secondary link inside the modal).
- **MikroTik priorities re-encoded the approved defaults**: Winbox(10) →
  Embedded SSH(20) → WebFig(30) (was Winbox/WebFig/SSH), and the
  `PlatformDescriptor.connect_methods` promise updated to match — a Windows
  operator defaults to Winbox; a macOS/Linux operator defaults to Embedded
  SSH when Ready, WebFig as fallback.
- `GET /devices/{id}/connect-methods?client_os=` — new optional param; a
  method whose `requires_client_os` doesn't match returns
  `status="unavailable"` + reason server-side (frontend keeps its own check
  as backup), and can never be picked as the effective default.
- **Honest embedded gating**: an `embedded` method now returns
  `status="unavailable"` ("Embedded terminal is not enabled for this device
  yet") when `FEATURE_TERMINAL` is off or the device is outside its rollout
  scope — exactly the gates `POST /terminal/sessions` enforces (403) —
  instead of a method that fails on click.
- New `GET /connect-status?device_ids=…&client_os=…` (≤200 ids): batched
  per-row Connect-button state for the Catalog (ready /
  credential_required / unavailable + reason + effective default), so row
  buttons are credential-aware without N+1.

**Frontend** (`ConnectMenu.tsx` rebuilt; `DevicesTable.tsx`, `Devices.tsx`,
`GenericDeviceDrawer.tsx`, `DeviceDrawer.tsx`, `CredentialVault.tsx`,
`api/connect.ts`):
- **Split Connect button everywhere the Connect Framework renders**: main
  segment launches the operator's SAVED default method immediately when
  Ready; with no saved preference it opens the menu once (mockup behavior);
  the ▾ arrow always opens the menu directly. **Neither opens the Drawer.**
- **Categorized menu** ("Connect to <hostname>" header): Recommended (the
  effective default) · Available (embedded) · Web · Desktop Applications ·
  Unavailable (feature-gated). Every row: icon · name · transport/source ·
  status ("Device credential · Ready", "Browser · Credential required",
  "Windows only · Unavailable on macOS"). OS-mismatched desktop apps stay
  VISIBLE in Desktop Applications, disabled with the reason.
- **"Always use this option"** checkbox in the menu footer (saves the
  launched method as the per-operator platform default) alongside the
  existing per-method pin; Settings ▸ Connect Defaults unchanged for
  view/reset.
- **Device Catalog**: non-Windows rows render the split button (row variant,
  lazy fetch on first interaction; button state from the batched
  /connect-status feed). Windows rows byte-identical — main click still opens
  TECHI Remote Support directly (single method; the mockup itself annotates
  Windows "Opens directly — single option"). Flag-off renders the exact old
  button.
- **Embedded Terminal is no longer a dead toast**: in the Drawer it switches
  to the Terminal tab; from a Catalog row it deep-links the drawer open on
  the Terminal tab (`GenericDeviceDrawer` gained `initialTab`).
- **Live refresh**: a `techi:connect-refresh` window event fires on Vault
  credential create/edit/delete/status-toggle and on default pin/reset;
  every mounted Connect surface (menus + Catalog row states) refetches
  immediately — no manual refresh.
- **Winbox launcher honesty**: after a `winbox://` launch the UI notes "If
  Winbox didn't open, the desktop launcher isn't installed — install Winbox 4
  (it registers winbox://)". The browser cannot detect protocol-handler
  presence; see Remaining limitations.

### Ndryshimet

Modified: `backend/app/platform_core/connect.py`,
`backend/app/platform_core/registry.py`,
`backend/app/api/v1/endpoints/connect.py`,
`frontend/src/api/connect.ts`, `frontend/src/components/ConnectMenu.tsx`,
`frontend/src/components/DevicesTable.tsx`,
`frontend/src/components/GenericDeviceDrawer.tsx`,
`frontend/src/components/DeviceDrawer.tsx` (hostname prop only),
`frontend/src/pages/Devices.tsx`, `frontend/src/pages/CredentialVault.tsx`,
plus test updates (`tests/test_connect_method_status_and_preferences.py`,
`tests/test_mikrotik_deployment.py`,
`src/components/__tests__/ConnectMenu.test.tsx`). No schema change. No new
flag — same `FEATURE_PLATFORM_CORE`/`FEATURE_TERMINAL` gates.

### Rezultati

22 new backend tests (mockup fidelity: winbox visible-but-unavailable on
macOS, ready on Windows with credential, embedded gating both axes, OS-aware
defaults, no credential material in launch URLs, batch endpoint states) + new
frontend tests (grouping, split-button launch/menu behavior, always-use
persistence, feature-gated Unavailable section) — see the test files for the
full list. Preflight + smoke results recorded in the deploy note below.

### Mësimet

- A method's existence, its credential readiness, its feature-gate
  availability, and its OS compatibility are FOUR separate axes; every prior
  regression here came from collapsing one into another (hiding for OS,
  faking readiness across a feature gate).
- When a feature is rollout-scoped (FEATURE_TERMINAL → device 729), every UI
  surface that triggers it must reflect the same scope, or the UI "lies" for
  the rest of the fleet.

### Remaining limitations

- **Winbox desktop launcher dependency**: TECHI has no desktop launcher/agent
  on the operator's machine; the `winbox://` URI relies on Winbox 4's own
  protocol registration, and a browser cannot detect whether a handler
  exists. If Winbox 4 isn't installed, the click is a no-op and the UI shows
  the "launcher not installed" note after the attempt. Real auto-login (Vault
  credential injected into the Winbox session) additionally requires a
  desktop launcher component — not built; credentials are intentionally
  never placed in the URL.
- **Embedded SSH/Terminal visibility in prod follows FEATURE_TERMINAL's
  rollout scope** (currently device 729 only): on every other device they now
  honestly show "Unavailable — not enabled for this device" and MikroTik on
  macOS defaults to WebFig. Seeing Embedded SSH Ready fleet-wide is a
  config-only owner decision (`FEATURE_TERMINAL_SCOPE=fleet` or a wider
  allowlist) — Manual Approval per PROJECT_STATE.
- Browser click-through validation still requires the owner (same constraint
  as the previous two deploys: no browser tool + rotated owner bootstrap
  password).

## [2026-07-11] FIX: Vault scope assignment (production 400) + Connect credential resolution/status/preferences

### Problemi

Owner reported five production problems in one bundle: (1) creating a
Device-scoped Vault credential failed with `scope 'device' must not set
client_id`; (2) Client/Group/Device assignment "wasn't working correctly" in
the Vault UI; (3) suspicion that the SSH username shown for a device
("root") came from heartbeat `current_user` rather than a real credential;
(4) Connect methods were inconsistent — Winbox missing/unavailable on
MikroTik, Linux SSH/Web options shown but inert, and the Device Catalog
Connect button permanently grey with no explanation; (5) no way for an
operator to set a default Connect method per platform/device.

### Analiza

Read the actual Vault form code (`frontend/src/pages/CredentialVault.tsx`).
`FormState` had a single `client_id` field serving two purposes at once: the
real "Client" scope target, AND the narrowing filter used to populate the
Device dropdown when scope="device". `handleSave()`'s payload builder:
```ts
client_id: form.scope_type === "client" || form.scope_type === "device" ? Number(form.client_id) || null : null,
```
sent `client_id` for BOTH scopes — so picking a client to filter the device
list (a UI convenience) also submitted that client_id as the credential's
own, which `VaultService._validate_scope` correctly rejects for scope=
"device" (device scope must carry ONLY `device_id`). The backend validation
was never the bug — it caught a real frontend defect. Separately, the form
had **no "Group" option in the Scope `<select>` at all** — only Global/
Client/Device existed, despite the backend, schema, and
`VaultCredentialCreate` type all fully supporting Group scope since Phase 4.

Investigated `current_user` (the device's OS-logged-in username, reported by
heartbeat) end-to-end: `EmbeddedSSHModal.tsx`, `SSHSessionInfo.tsx`,
`ConnectMenu.tsx`, `DeviceTerminal.tsx`, `terminal.py`, `ssh_connector.py`,
and `connect.py` — zero references. SSH username resolution
(`app/api/v1/endpoints/terminal.py`) only ever reads the resolved Vault
credential's `username` column or the operator's explicit Temporary Session
input. **No bug found** — the observed "root" username was the real,
correctly-resolved Vault credential's own username, not a heartbeat
fallback. Added 5 regression tests pinning this invariant defensively (a
credential resolving to a DIFFERENT username than `current_user` proves the
field is never consulted).

Investigated Connect: `ConnectMenu.tsx` fetched `/connect-methods` and
filtered by `requires_client_os` — a method failing that check was **removed
from the array entirely**, with no "why" ever reaching the UI; the backend
had no concept of credential-aware readiness at all (Winbox/WebFig always
looked identical whether a credential existed or not). Separately, the
Device Catalog's per-row Connect button (`DevicesTable.tsx`/
`DeviceMobileCard.tsx`) turned out to be a completely different, older,
Windows/RustDesk-only affordance (`canConnect = isValidRustDeskId(...) &&
!conflict`) — unrelated to the Connect Framework dropdown used elsewhere.
Since non-Windows devices never have a `rustdesk_id`, this button was
**permanently grey for every Linux/MikroTik device**, independent of whether
real Connect methods existed for them.

### Shkaku

1. Frontend payload bug: the Vault form's client-filter state doubled as the
   submitted `client_id` field regardless of scope, and Group scope's UI was
   simply never built.
2. Design gap, not a bug: Connect Framework had no credential-awareness or
   per-operator preference concept yet (both explicitly out of scope until
   this release).
3. Legacy UI collision: the Device Catalog table's Connect button predates
   the Connect Framework and was never updated to know about non-Windows
   platforms.

### Zgjidhja

**A/B — Vault scope + selectors** (`CredentialVault.tsx`, new
`EntitySearchSelect.tsx`): separated the submitted scope target from the
narrowing filter (`scope_client_filter`, never submitted); added the missing
Group option + picker (Client-filtered Group dropdown, submitting only
`group_id`); replaced every plain `<select>` for Client/Group/Device with a
searchable combobox (type-to-filter locally for Client/Group, debounced
server search via `GET /devices?search=` for Device — shows hostname,
client, group, platform, device ID). Backend: new
`VaultService.resolve_display_context()`/`enrich()` field additions
(`device_hostname`, `context_client_id/name`, `context_group_id/name`) join
a Device/Group-scoped credential's Client/Group through the device/group row
at **read time only** — nothing is stored, scope integrity (`_validate_scope`)
is completely unchanged and still correctly rejects an over-specified
payload.

**C — current_user isolation**: no code change (none needed); 5 regression
tests added (`test_ssh_current_user_isolation.py`).

**D/F — Generic credential resolution**: `VaultService._tier_candidates()`
extracted as the shared Device>Group>Client>Global tiering helper (both
`resolve_ssh_candidates` and the new `resolve_credentials_for_method` build
on it — zero duplicated precedence logic). `METHOD_CREDENTIAL_TYPES` maps
`ssh`→SSH types, `winbox`→`winbox`, `webfig`→`webfig` (+ a
`generic_username_password` credential, but only when its `purpose` field
mentions "webfig" — an explicit operator marking, never an automatic
assumption).

**E/I — Connect method status**: `ConnectMethodOut` gained `status`
(`ready`|`credential_required`), `status_reason`, `credential_source`.
`GET /devices/{id}/connect-methods` now computes per-method status via
`resolve_credentials_for_method` (dedicated methods `remote_support`/
`web_terminal` are always "ready" — they have their own tab/flow).
`ConnectMenu.tsx` **never hides a method** — it renders all three states:
Ready (with the resolving scope tier shown), Credential required (with an
"Add credential" action that deep-links to `/vault?prefill_scope=device&
prefill_device_id=..&prefill_credential_type=..`, which `CredentialVault.tsx`
now reads on mount to auto-open the form pre-populated), and Unavailable on
this OS (computed client-side from `requires_client_os`, shown disabled with
a reason instead of removed from the list).

**G — Per-operator default Connect method**: new table
`operator_connect_preferences` (`operator_id`, `platform`, nullable
`device_id`, `method_id`; unique on the triple) — deliberately NOT global,
every read/write scoped to the calling operator. New
`ConnectPreferenceService` implements the 4-tier hierarchy (device override
→ platform default → registry priority order → first Ready method);
`_resolve_preferred_method()` in `connect.py` applies tiers 3-4 on top of
whatever tier 1-2 resolves, and the response separates `preferred_method_id`
(the effective choice, post-fallback) from `configured_preference_id` (what
the operator actually set, even if it's not usable right now) so the UI can
say "X isn't ready, using Y instead." New endpoints:
`GET/PUT/DELETE /connect-preferences`. `ConnectMenu.tsx` gained a pin icon
("Always use this method") and a "Default" badge; Settings gained a "Connect
Defaults" section (view/reset, only rendered when the operator has any).

**Device Catalog Connect button**: `DevicesTable.tsx`/`DeviceMobileCard.tsx`
now branch on platform. Windows rows are **byte-identical** (same RustDesk
`canConnect`/`onConnect`/tooltip). Non-Windows rows use a new
`hasStructuralConnectMethod()` — platforms whose Connect Framework entry has
an always-present native method (Winbox/WebFig for MikroTik, DSM/QTS/
vSphere/Web UI/Remote Support for Synology/QNAP/VMware/Proxmox/Hyper-V) are
always connectable; Linux needs at least one reported capability (mirrors
`methods_for("linux", {})` returning empty). Clicking a non-Windows row's
Connect button opens the Drawer (real, credential-aware `ConnectMenu`)
instead of attempting the RustDesk flow — deliberately NOT a live per-row
credential status fetch (would be N+1 across a ~700-device table).

### Ndryshimet

New: `backend/app/models/connect_preference.py`,
`backend/app/services/connect_preference_service.py`,
`frontend/src/components/EntitySearchSelect.tsx`,
`frontend/src/api/connect.ts`, 5 new backend test files, 4 new frontend test
files (see test file names in the repo — all under
`tests/test_vault_scope_display_context.py`,
`tests/test_ssh_current_user_isolation.py`,
`tests/test_connect_method_status_and_preferences.py`,
`src/pages/__tests__/CredentialVaultScopeForm.test.tsx`,
`src/pages/__tests__/Settings.connectDefaults.test.tsx`,
`src/components/__tests__/DevicesTable.connectButton.test.tsx`). Modified:
`vault_service.py`, `schemas/vault.py`, `api/v1/endpoints/vault.py`,
`api/v1/endpoints/connect.py`, `models/__init__.py`,
`services/schema_compat_service.py` (new dev table),
`pages/CredentialVault.tsx`, `api/vault.ts`, `components/ConnectMenu.tsx`,
`pages/Settings.tsx`, `components/DevicesTable.tsx`,
`components/DeviceMobileCard.tsx`.

**Schema (additive, new table, apply schema-first before deploy)**:
```sql
CREATE TABLE IF NOT EXISTS operator_connect_preferences (
    id SERIAL PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id),
    platform VARCHAR(32) NOT NULL,
    device_id INTEGER REFERENCES devices(id),
    method_id VARCHAR(32) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    updated_at TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT uq_connect_pref_operator_platform_device UNIQUE (operator_id, platform, device_id)
);
CREATE INDEX IF NOT EXISTS ix_operator_connect_preferences_operator_id ON operator_connect_preferences (operator_id);
CREATE INDEX IF NOT EXISTS ix_operator_connect_preferences_platform ON operator_connect_preferences (platform);
CREATE INDEX IF NOT EXISTS ix_operator_connect_preferences_device_id ON operator_connect_preferences (device_id);
```
Inverse (rollback): `DROP TABLE IF EXISTS operator_connect_preferences;`

No new `FEATURE_*` flag — Vault/Connect endpoints are gated by the existing
`FEATURE_VAULT`/`FEATURE_PLATFORM_CORE` flags exactly as before.

### Rezultati

58 new tests (38 backend, 20 frontend). Preflight PASSED: contract 15/15,
backend suite 767 passed + the 4 known baseline failures (flags OFF and ON),
full frontend vitest suite 61/61, `tsc --noEmit` clean, production build
clean, agent builds clean.

### Mësimet

- The exact bug class here (a UI convenience field silently reused as a
  submitted field) is easy to miss in review because the code "looks"
  scope-aware — `form.scope_type === "client" || form.scope_type ===
  "device"` reads like a deliberate scope check, not a leaked filter.
  Renaming the filter field (`scope_client_filter`) to be unmistakably
  non-submitted is cheaper insurance than a comment.
- Backend validation that rejects a real frontend bug should be trusted, not
  loosened — `_validate_scope`'s strict "must not set X" behavior was
  correct the whole time; the fix belonged entirely on the frontend side.
- A credential-aware "is this actually usable" status is a genuinely
  different question from "does this method exist for the platform" — the
  Connect Framework had only ever answered the second question; conflating
  them (hiding methods that need credentials) is what made Winbox "missing"
  on MikroTik instead of "needs a credential."

### Remaining limitations

- **No live browser click-through validation performed by AI this release** —
  this environment has no browser-automation tool, and the bootstrap owner
  password in prod `.env` no longer matches the live `owner` account
  (rotated at some point after bootstrap, not a bug), so a scripted
  API/WebSocket login-and-drive wasn't possible either (same constraint hit
  during the 2026-07-10 Embedded SSH Connect deploy). Deployed and smoke-
  tested (health/401 contracts only); owner should click through the 12
  validation steps in the original task (create a Device-scoped credential,
  confirm Group scope works, open Connect on a Linux/MikroTik device, set/
  reset a default method, etc.) via the real browser UI.
- Winbox/WebFig credential status is type-matching and messaging only — the
  resolved credential is not injected into the `winbox://`/`http://` launch
  URL (see OPERATOR-MANUAL §30). Only Embedded SSH Connect performs a real
  authenticated connection end-to-end.

## [2026-07-10] FEATURE: Embedded SSH Connect — Device Drawer ▸ Connect ▸ SSH ▸ Embedded TECHI Terminal

### Problemi

Two prior investigations left this gap open on record: (1) the 2026-07-10
Enterprise Vault upgrade built `VaultService.resolve_for_context()` but
explicitly did not wire it into any live connection path; (2) a dedicated
investigation into embedding SSH for MikroTik concluded the existing
`TerminalRelay`/`TerminalSession` architecture (built for a device's own
agent to dial out over a websocket and hold a live PTY) could not be reused
as-is for a Connector platform with no persistent process, and recorded a
"connector relay" architecture recommendation without building it. Meanwhile
Connect ▸ SSH opened the operator's own OS SSH client, requiring the
operator to already have credentials memorized or stored locally, with no
audit trail of what was actually used. The mission: complete Embedded SSH
and integrate it end-to-end — Device Drawer ▸ Connect ▸ SSH ▸ Embedded TECHI
Terminal, credentials resolved from the Vault (Device > Group > Client >
Global), reusing the existing Terminal/Connect/Vault/RBAC/Audit
infrastructure with no new subsystem.

### Analiza

Re-read the recorded "connector relay" recommendation: replace the agent leg
of `TerminalRelay`'s pair with the **backend itself acting as an SSH
client**, piping bytes between an outbound SSH connection and the SAME
operator WebSocket route (`/ws/terminal/{id}`), ticket model, and
`DeviceTerminal.tsx` frontend already shipped for the Linux Web Terminal.
`TerminalRelay.pump()`/`close()` operate on whatever object is stored in the
pair's `agent` slot via plain Python duck typing (`receive()`/`send_bytes()`/
`send_text()`/`close()`, matching FastAPI's `WebSocket` shape) — nothing in
the relay actually requires a real WebSocket. That meant a small adapter
wrapping an `asyncssh` PTY process could attach to `terminal_relay` exactly
like the Linux agent's websocket leg, with **zero changes** to
`TerminalRelay`, `TerminalWatchdog`, or the operator-facing WS handler.

For scheduling the SSH dial from a synchronous FastAPI endpoint (SQLAlchemy
sync session, no `async def`), the exact same pattern `RealtimeEventPublisher`
already uses was reused: capture the running event loop at app startup
(`asyncio.get_running_loop()`), then `asyncio.run_coroutine_threadsafe()`
from the sync request-handling thread.

For credential resolution, `resolve_for_context()`'s tiered
`by_scope.setdefault(...)` logic picks one arbitrary credential per tier
without exposing whether that tier had one match or several — insufficient
for "auto-connect on one match, show a selector on multiple." A sibling
method was needed that returns every candidate at the first non-empty tier.

### Zgjidhja

Backend (all additive, no existing endpoint's behavior changed):

- **`app/services/ssh_connector.py`** (new): `SSHConnectAdapter` (duck-types
  the WebSocket interface `TerminalRelay.pump()` uses, backed by an
  `asyncssh` PTY process instead of a real socket); `SSHConnectError` with a
  `reason` mapped from `asyncssh`/`asyncio`/`OSError` exceptions into exactly
  the categories the mission specified (`credential_missing`,
  `host_unreachable`, `authentication_failed`, `timeout`,
  `host_key_mismatch`, `connection_refused`, `network_error`); `dial_and_run()`
  — the top-level coroutine that dials, attaches, records Vault usage on
  success, blocks on the reverse-direction pump for the connection's
  lifetime, then cleans up (marks the DB session, writes the audit entry,
  force-closes the relay pair — same shape as `terminal_watchdog.run_once()`);
  `SSHConnectorRunner` (same capture-the-loop pattern as
  `RealtimeEventPublisher`), started/stopped in `main.py`'s lifespan
  alongside `terminal_watchdog`, gated by the same `FEATURE_TERMINAL` check.
- **`app/services/vault_service.py`**: `resolve_ssh_candidates(device)` —
  reuses `resolve_for_context`'s exact Device > Group > Client > Global
  precedence, restricted to SSH-capable types (`ssh_password`,
  `ssh_private_key`, legacy `ssh_key`), returning `(tier, [candidates])` for
  the first non-empty tier; `get_secret_fields_for_use()` (decrypts for a
  live connection — distinct from `reveal()`, which is for showing plaintext
  to a human, requires `vault_reveal` + a reason, and writes a `"reveal"`
  usage row); `record_credential_use()` (sets `last_used_at`, writes a
  `"use"` usage row); `enrich()` gained `used_by` — non-empty exactly when a
  `"use"` row exists, i.e. the credential has actually authenticated a
  connection (distinct from the static `future_consumers` registry hint).
- **`app/models/terminal_session.py`**: 4 additive nullable columns — `mode`
  (`agent`|`ssh`), `vault_credential_id`, `ssh_username`, `credential_source`
  (`device`|`group`|`client`|`global`|`temporary`). The previously-declared-
  but-never-used `TerminalSessionStatus.FAILED` is now set on a dial
  failure, with `TerminalService.close()` extended to also treat `FAILED` as
  terminal (a later generic `operator_closed` close call — from the
  operator's own WS handler racing the failure — must never clobber a
  specific failure reason with a generic one).
- **`app/api/v1/endpoints/terminal.py`**: `GET /devices/{id}/ssh/credentials`
  (candidate list), `POST /devices/{id}/ssh/sessions` (resolves/validates a
  credential — explicit `credential_id`, auto-pick on exactly one candidate,
  409 with a clear message on zero or on 2+ without a choice, or an explicit
  Temporary Session's ad hoc username/password, never persisted — creates
  the session, audits, schedules the dial), `GET
  /devices/{id}/ssh/sessions/{id}` (session detail: device, client, operator,
  username, authentication source, start, duration, idle timer (new
  `TerminalRelay.idle_seconds()`), status, and — on failure — the precise
  reason, feeding the frontend session-info panel and error display).
- **RBAC**: `terminal_open`/`terminal_view`/`terminal_manage`/`vault_use` —
  4 new permissions, additive over the existing admin+ floor, same shape as
  the 7 `vault_*` permissions from the Enterprise Vault upgrade. A new shared
  `require_role_or_permission()` in `app/core/auth.py` generalizes vault.py's
  own `_vault_gate` dependency-factory pattern (vault.py itself is
  untouched) so terminal.py doesn't duplicate it. Consuming a *stored* Vault
  credential additionally requires `vault_use`; a Temporary Session does not
  (it never touches the Vault).
- **Audit**: 6 new `AuditAction` values — `ssh_session_started`/
  `ssh_session_ended`, `ssh_credential_resolved`/`ssh_credential_missing`,
  `ssh_connection_failed`/`ssh_authentication_failed`.
  `terminal_routes.py`'s existing `_audit_session_end()` now branches on the
  session's `mode` column to pick `SSH_SESSION_ENDED` vs
  `TERMINAL_SESSION_CLOSED` — the one call site both modes' operator-WS
  disconnect path already shares.
- **Connect Framework reuse, no per-platform code**: which devices offer
  Embedded SSH Connect is decided entirely by whether their platform declares
  an `ssh` `ConnectMethod` in `app/platform_core/connect.py` (already true
  for Linux, MikroTik) — nothing new added there, and no `platform ==
  "linux"`/`"mikrotik"` checks anywhere in the new code.
- **`requirements.txt`**: `asyncssh==2.14.2` (new dependency — the SSH
  client; no other library in the codebase implements the SSH protocol).

Frontend:

- **`api/terminal.ts`**: `getSshCredentialCandidates()`,
  `createSshTerminalSession()`, `getSshSessionDetail()`,
  `SSH_FAILURE_MESSAGES` (reason → human-readable text map).
- **`components/EmbeddedSSHModal.tsx`** (new): the actual "Connect ▸ SSH ▸
  Embedded TECHI Terminal" flow — resolves candidates, then auto-connects
  (one candidate) / shows a selector (multiple) / shows a clear "no
  credential available" message with an explicit **Temporary Session** form
  (never a silent fallback) — renders the session info panel
  (`SSHSessionInfo.tsx`, new: device/client/operator/username/auth
  source/start/duration/idle timer/status, polling the session-detail
  endpoint) plus `DeviceTerminal` in a new `mode="ssh"` and keeps "Open in
  your own SSH client instead" as a secondary link (reuses the existing
  generic `/connect-methods/ssh/launch` endpoint unchanged).
- **`components/DeviceTerminal.tsx`**: gained an optional `mode`/
  `sshOptions`/`onSessionId` prop set — when `mode="ssh"` it calls
  `createSshTerminalSession()` instead of `createTerminalSession()`; every
  other line (xterm rendering, resize, bounded auto-reconnect) is unchanged
  and shared by both modes. On an abnormal close it now also best-effort
  fetches the SSH session detail to replace the generic "connection closed"
  message with the precise reason.
- **`components/ConnectMenu.tsx`**: selecting the `ssh` method now opens
  `EmbeddedSSHModal` instead of calling the generic launcher — `remote_
  support`/`web_terminal`'s existing dedicated-flow handling is untouched.
- **`pages/CredentialVault.tsx`**: renders "Used by: Embedded SSH" under a
  credential's name when `used_by` is non-empty (Last Used already existed
  and now reflects real SSH usage too via the backend change above).

### Ndryshimet

New: `backend/app/services/ssh_connector.py`,
`backend/tests/test_ssh_connector.py`,
`backend/tests/test_ssh_terminal_endpoint.py`,
`backend/tests/test_ssh_permission_gates.py`,
`backend/tests/test_vault_ssh_resolution.py`,
`frontend/src/components/EmbeddedSSHModal.tsx`,
`frontend/src/components/SSHSessionInfo.tsx`, +2 new frontend test files.
Modified: `terminal_session.py` (model), `terminal_service.py`,
`terminal_relay.py` (`idle_seconds()`), `terminal.py` (endpoints),
`terminal_routes.py` (audit branch), `vault_service.py`, `schemas/vault.py`,
`vault.py` (endpoint, `used_by` wiring), `permission_service.py`,
`audit_service.py`, `core/auth.py` (`require_role_or_permission`), `main.py`
(runner start/stop), `schema_compat_service.py` (sqlite dev columns/table),
`requirements.txt`, `api/terminal.ts`, `api/vault.ts`, `ConnectMenu.tsx`,
`DeviceTerminal.tsx`, `CredentialVault.tsx` (+its test file).

**Schema (additive, apply schema-first before deploy, same rule as every
other phase)**:
```sql
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS mode VARCHAR(16) NOT NULL DEFAULT 'agent';
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS vault_credential_id INTEGER;
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS ssh_username VARCHAR(160);
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS credential_source VARCHAR(16);
```
Inverse (rollback, only if ever needed — nullable/defaulted, safe to leave in place):
```sql
ALTER TABLE terminal_sessions DROP COLUMN IF EXISTS credential_source;
ALTER TABLE terminal_sessions DROP COLUMN IF EXISTS ssh_username;
ALTER TABLE terminal_sessions DROP COLUMN IF EXISTS vault_credential_id;
ALTER TABLE terminal_sessions DROP COLUMN IF EXISTS mode;
```

No new `FEATURE_*` flag — reuses `FEATURE_TERMINAL` (still `false` in prod)
and its existing `FEATURE_TERMINAL_SCOPE` rollout mechanism unchanged, so
Embedded SSH Connect goes live at the same time as the Linux Web Terminal
when the owner eventually flips that flag.

### Rezultati

73 new tests (49 backend across 4 new files, 24 frontend across 4
new/updated files) — credential-resolution precedence/multiple/missing/
disabled/wrong-scope, session lifecycle (create/failure/success/already-
closed), connector error-mapping for every `SSHConnectError` reason, RBAC
(admin/owner bypass, additive `terminal_open`/`terminal_view`/`vault_use`,
the OPERATOR-floor view-gate precedent from `vault.py`'s own `_require_view`),
Vault usage tracking, and the frontend credential-resolution branching /
session info panel / Vault "Used by" display / ConnectMenu wiring. Preflight
PASSED: contract 15/15, backend suite 729 passed + the 4 known baseline
failures (flags OFF and ON), full frontend vitest suite 41/41, `tsc --noEmit`
clean, production build clean, agent builds clean. `smoke.sh` 8/8 against a
local server; manually verified the 3 new endpoints return 401 (never 500)
unauthenticated. Deployed dark under the existing `FEATURE_TERMINAL=false` —
zero behavior change while the flag stays off, same darkness invariant as
every other flag-gated feature in this codebase.

### Mësimet

- `TerminalRelay`'s duck-typed pairing (no type check on what's stored in a
  pair's `operator`/`agent` slot, just `receive()`/`send_bytes()`/
  `send_text()`/`close()`) turned out to be exactly general enough to accept
  a non-websocket leg with zero modification — worth remembering the next
  time a "requires a persistent process" architecture note gets revisited:
  check whether the *consuming* code actually requires that persistent
  process's specific transport, or just its interface.
- Two independent code paths can race to close the same session (the
  operator's own WS handler vs. `ssh_connector.dial_and_run`'s cleanup, or
  vs. the watchdog) — this already existed for the Linux PTY case (the
  watchdog forcing a close while the operator's WS is mid-`pump()` triggers
  that handler's own close+audit too) and is tolerated, not fixed, by
  design: `TerminalService.close()`'s idempotent guard makes the DB state
  correct regardless of ordering, and a duplicate audit entry from a race is
  accepted noise, not a correctness bug.
- Host-key verification (`known_hosts=None`) was deliberately deferred, not
  silently skipped — the `SSHConnectError` mapping already handles
  `HostKeyNotVerifiable` so turning verification on later needs no other
  code change, only a place to store trusted per-device host keys.

### Deploy + live validation addendum (same day)

Deployed to production: schema-first `ALTER TABLE terminal_sessions ADD
COLUMN` ×4 applied on prod Postgres and verified via `\d terminal_sessions`;
`git pull --ff-only` (5adf1bf→ea49eb3, clean fast-forward); `docker compose
-p techi-platform build backend frontend` (confirmed `asyncssh==2.14.2`
importable inside the rebuilt backend container, and the frontend build
code-split the new components into their own chunks —
`EmbeddedSSHModal-v2-*.js`, `SSHSessionInfo-v2-*.js`); `up -d backend
frontend` — both recreated and healthy within seconds, zero heartbeat
disruption, zero errors in logs. `scripts/smoke.sh` against
`https://api-rdp.techi.com.al` passed 8/8; the 3 new SSH endpoints manually
confirmed reachable (401 unauthenticated, never 500); `FEATURE_TERMINAL`
confirmed `False` in the running container immediately after deploy (dark,
as designed).

Owner then asked for a real browser-driven validation rather than accepting
the dark deploy alone. Found one real online Linux device already reporting
the `terminal` capability (`#729`, `rustdesk-srv`) and one pre-existing
global-scope `ssh_key` Vault credential — sufficient to test the actual
resolve→connect path. `.env` backed up
(`.env.bak-ssh-connect-validation-2026-07-10`) before appending
`FEATURE_TERMINAL=true` / `FEATURE_TERMINAL_SCOPE=device` /
`FEATURE_TERMINAL_ALLOWED_DEVICE_IDS=729`; backend restarted, watchdog
started cleanly, rollout scope verified server-side
(`is_rollout_allowed(..., device_id=729)` → True, `device_id=1` → False —
fail-closed for the rest of the fleet as designed). Attempting to complete
the validation end-to-end via a scripted login (to drive the API/WebSocket
without a browser, since this environment has no browser-automation tool)
found the bootstrap owner password in `.env` no longer matches the live
`owner` account (401 "Invalid username or password" — expected once a real
password rotation happens post-bootstrap; not a bug). Owner chose to leave
`FEATURE_TERMINAL` enabled, scoped to device #729 only, to complete the
click-through validation themselves through the real browser UI rather than
share credentials or have a new one created. **Left in this state
deliberately** — see PROJECT_STATE.md for the current flag/scope and the
revert command.

## [2026-07-10] FEATURE: Enterprise Credential Vault upgrade — types/purpose/scope/assignments/RBAC/test-connection

### Problemi

The 2026-07-07 Vault shipped a functional but minimal secret store: 6 fixed
credential types with one flat form, a single Global/Client/Group/Device
scope with no way to see *where else* a credential was meant to be used, no
purpose/lifecycle metadata, only Admin-or-nothing RBAC, and no way to verify a
stored credential actually works. The owner requested an enterprise-grade
upgrade covering current consumers (SSH, Windows, Winbox, WebFig, API tokens,
SMTP, Webhook, SNMP) and future ones, explicitly as an owner-approved
exception to the LIVE VALIDATION "no new features" gate (this release
includes schema/RBAC/architecture changes normally requiring that gate).

### Zgjidhja

Upgraded the same storage/crypto layer in place — no rewrite, no second
secret store, no crypto migration:

- **Credential-type registry** (`app/platform_core/vault_credential_types.py`,
  new, same pattern as `platform_core/actions.py`): 11 new types + the 4
  original types kept as `legacy=True`. Each type declares its non-secret
  metadata fields (port, TLS mode, auth/privacy protocol, ...), its secret
  fields, whether it needs a username, and its honest "future consumers"
  list. One frontend form renders itself from `GET /vault/types` — no
  per-type hardcoded forms anywhere.
- **Multi-field secrets, same cipher**: a type with more than one secret
  field (SSH private key + passphrase, SNMPv3 auth+privacy secrets) is
  JSON-encoded, then that JSON string is encrypted through the *unchanged*
  `vault_cipher.encrypt_secret`. Reveal tries `json.loads` first and falls
  back to treating a non-JSON plaintext as a legacy single secret under key
  `"secret"` — every credential created before this release keeps revealing
  correctly with zero re-encryption.
- **Schema** (migration `d8e9f0a1b2c3`, additive, applied schema-first):
  `vault_credentials` gains nullable `purpose`, `status`, `expires_at`,
  `rotation_due_at`, `last_tested_at`, `last_test_status`, `metadata_json`;
  new table `vault_credential_assignments` (credential→client/device,
  `ON DELETE CASCADE` from the credential side) for explicit "also used by"
  links beyond a credential's primary scope. `schema_compat_service.py`'s
  SQLite dev-schema mechanism got matching column/table definitions so local
  dev never drifts from production's real shape.
- **Scope-resolution service** (`VaultService.resolve_for_context`): Device →
  Group (legacy) → Client → Global precedence, ACTIVE-only, optional Purpose
  filter. Built and tested as the one place a future SSH/SNMP/Connect
  integration should ask "which credential applies here" — **not called by
  anything yet**, per the explicit scope boundary ("do not start SSH relay,
  SNMP, RDP, or RouterOS API in this task").
- **Delete-reference guard extended**: `blocking_references()` (added in the
  same-day delete-safety fix above) now also checks
  `vault_credential_assignments`, not just the primary scope target, before
  allowing a 409-free delete.
- **RBAC**: 7 new permissions (`vault_view/create/edit/reveal/delete/test/
  assign`), assignable per-Team via the existing Team Permissions UI. Wired
  as `_vault_gate(min_role, perm_key)` in `vault.py` — passes on role alone
  (today's Admin+ behavior, unchanged) OR on the team permission being
  granted. Purely additive: never narrows what Admin/Owner already have,
  only lets a team optionally hand a narrower Vault permission to a
  non-admin operator.
- **Test Connection, real not simulated**: SMTP credentials get an actual
  `smtplib` connect + STARTTLS + login (no email sent, just proves the
  credential authenticates); Webhook credentials get a real HTTP POST via the
  Notification Engine's own `send_via_channel("webhook", ...)` sender (code
  reuse, not a new HTTP client). Every other type returns `"unsupported"`
  with the exact honest message the owner specified — there is no SSH/SNMP/
  RouterOS client anywhere in this codebase to test against.
- **Frontend**: `CredentialVault.tsx` rebuilt in place — summary cards (total/
  by scope/by category/attention-needed), a filter bar (type/scope/client/
  status/search) plus view tabs (All/SSH/Windows/Network/API/Notifications/
  SNMP/Unused/Attention) computed client-side over the same list call, a
  metadata-driven create/edit form, an assignments panel, status toggle, and
  a test-connection button — reusing the existing `Badge`/`Button`/
  `ConfirmationModal`/theme tokens, no new design system or component
  library.

### Ndryshimet

Backend: `app/models/vault_credential.py` (new columns + `VaultCredentialAssignment`
+ `VaultCredentialStatus`), `app/platform_core/vault_credential_types.py` (new),
`app/services/vault_service.py` (metadata validation, assignments, scope
resolution, test-connection, JSON secret envelope), `app/schemas/vault.py`
(rewritten), `app/api/v1/endpoints/vault.py` (rewritten — types/assignments/
status/test endpoints, `_vault_gate`), `app/services/permission_service.py`
(7 new permission constants), `app/services/schema_compat_service.py` (SQLite
dev schema), `alembic/versions/d8e9f0a1b2c3_enterprise_vault.py` (new).
Frontend: `frontend/src/api/vault.ts` (rewritten), `frontend/src/pages/
CredentialVault.tsx` (rewritten), `frontend/src/pages/TeamDetail.tsx` (7 new
permission defs). Tests: `backend/tests/test_vault.py` (46 tests, up from 17 —
type registry, scope resolution, assignments, RBAC additive-OR, lifecycle/
expiry, no-plaintext-in-list/audit), `backend/tests/test_platform_core.py`
(wiring-boundary allowlist +1), `frontend/src/pages/__tests__/
CredentialVault.test.tsx` (new, 6 tests — loading/error/filter/permission
states).

### Rezultati

Backend suite: 675 passed + 4 known baseline (unchanged) in both flag modes.
Frontend: tsc/build clean, vitest 25/25 (19 pre-existing + 6 new). Full
`preflight.sh` PASSED. Schema applied before deploy (see deploy log for exact
`ALTER TABLE`/`CREATE TABLE`/`CREATE INDEX` statements run against
production Postgres). All 1 pre-existing production credential ("test",
global scope) preserved and verified still present/revealable after the
schema change and code deploy.

### Mësimet

- A real FK-enforced Postgres constraint that SQLite silently ignores by
  default is a recurring blind spot in this codebase (this is the second time
  this session it caused a bug the local test suite couldn't see) — the
  `PRAGMA foreign_keys=ON` fix added to `test_vault.py` earlier the same day
  should become the default for every new SQLite-backed test session, not
  just Vault's.
- SQLAlchemy declarative models reserve `.metadata` (the `MetaData` registry)
  on every instance — naming a Pydantic `from_attributes` field `metadata` to
  mirror a `metadata_json` column silently validates against the WRONG
  object. Renamed to `credential_metadata`; worth grepping for elsewhere
  before it's copied into a future schema.
- Reusing an existing sender (`notification_channels.send_via_channel`) for
  Vault's webhook test avoided writing a second HTTP client with its own bugs
  — the "reuse existing code" instruction paid off concretely here, not just
  as a compliance checkbox.

## [2026-07-10] BUGFIX: Vault credential delete had no reference guard + added Report History delete

### Problemi

Two asks in one session: (1) a reported production bug — Credential Vault
delete fails with "Failed to fetch"; (2) Report History had no delete action
at all (only schedules could be deleted, not individual generated
runs/artifacts).

### Analiza

For (1): traced the full path end-to-end — frontend `DELETE /api/v1/vault/${id}`
matches the backend route exactly, RBAC (`_require_admin`) is correct, and a
live curl against the production proxy confirmed both the DELETE method and
its OPTIONS preflight succeed with correct CORS headers
(`access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT`).
No code-level or infra-level cause for a literal "Failed to fetch" (a
browser-level network-layer error, not an application error string) was
found. No live reproduction (Network tab/console) was available to pin down
further. What the investigation DID surface as a real, independent gap:
`VaultService.delete()` deleted a credential unconditionally, even when its
scope (`client_id`/`group_id`/`device_id`) still pointed at a live
client/group/device — no 409, no warning, silent data loss risk.

### Shkaku

(1) Unconfirmed — could not reproduce a code/infra cause; likely
environment-specific (stale bundle, transient network) rather than an
application defect. (2) Missing feature, not a regression — Report History
never had a per-run delete endpoint.

### Zgjidhja

**Vault**: `VaultService.blocking_references(credential)` checks whether the
credential's scope target still exists and returns human-readable references
(e.g. `"Device #42 (WIN-ABC123)"`); `delete()` raises a new
`VaultReferencedError` when references exist, which the endpoint maps to a
409 with the reference list in `detail`. `?force=true` bypasses the guard
(operator has now seen and dismissed the warning) and is audited separately
as `vault_credential_deleted_forced`. An orphaned scope (the target was
already deleted) never blocks cleanup — only a still-alive target does.
Frontend shows a second `ConfirmationModal` on a 409 response instead of a
raw error string, offering "Delete anyway."

**Reports**: added `DELETE /api/v1/reports/runs/{run_id}` (Admin/Owner,
client-scope enforced same as generate/download). `ReportService.delete_run()`
removes the stored PDF/CSV file (tolerating an already-missing file — logged,
not fatal, same pattern as the existing 365-day `cleanup_expired()` retention
sweep) then deletes the `report_runs` row. Never touches the parent
`ReportSchedule` — `ReportRun.schedule_id` is already `ForeignKey(...,
ondelete="SET NULL")`, so a schedule's lifecycle is structurally independent
of any one of its generated runs. Audited as `report_run_deleted`. Frontend
gets a per-row delete action in Report History with its own confirmation
dialog, gated to admins (matching the backend RBAC gate).

Explicitly deferred to a follow-up session (not attempted here, to avoid
rushing production PDF/storage work): Generate Now section/filter/threshold
options, a report branding/logo configuration subsystem, and a PDF template
rewrite. Each is roadmap-sized on its own.

### Ndryshimet

`backend/app/services/vault_service.py` (`VaultReferencedError`,
`blocking_references`, `delete(..., force=)`),
`backend/app/api/v1/endpoints/vault.py` (409 mapping, `force` query param),
`backend/app/services/report_service.py` (`delete_run`),
`backend/app/repositories/report_repository.py` (`ReportRunRepository.delete`),
`backend/app/api/v1/endpoints/reports.py` (`DELETE /runs/{run_id}`),
`backend/app/services/audit_service.py` (`REPORT_RUN_DELETED`),
`frontend/src/pages/CredentialVault.tsx` + `api/vault.ts`,
`frontend/src/pages/Reports.tsx` + `api/reports.ts`. 10 new backend tests
(16 vault total, 12 report-endpoint total).

### Rezultati

Preflight PASSED: contract 15/15, backend 645 passed + 4 known baseline
(unchanged) in both flag modes, frontend tsc/build clean, vitest 19 passed.
Deployed (`218203d`) — rebuilt/restarted only `backend`+`frontend` containers
under the correct compose project (`-p techi-platform`; `postgres` untouched,
stayed healthy throughout). Production smoke 8/8. Both new endpoints
confirmed live via unauthenticated curl: `DELETE /vault/999999` → 401,
`DELETE /reports/runs/999999` → 401 (never 500).

### Mësimet

- A missing "is this still referenced" check is a silent-data-loss bug even
  when nothing currently exercises the referenced path in production —
  Credential Vault isn't wired into Connect/Terminal yet, but the guard is
  cheap and correct to add now rather than after the first real incident.
- "Failed to fetch" in a bug report is a strong signal to check the network
  layer (CORS preflight, proxy, DNS) before the application code — a live
  curl against production settled that question in under a minute versus
  guessing from source alone.
- When a work request bundles a small, real bug fix with several
  roadmap-sized feature asks, scope them explicitly rather than silently
  cutting corners on the large ones to hit "one commit."

## [2026-07-10] BUGFIX: Reports/Vault sidebar links redirected to Dashboard — feature-flag loading race

### Problemi

Reports and Credential Vault were visible in the sidebar in production (both
`FEATURE_REPORTING`/`FEATURE_VAULT` confirmed `true` in both `.env` and the
live container), but clicking either link bounced straight back to
Dashboard with no network request to the Reports/Vault endpoints — a
client-side redirect before the destination page ever mounted.

### Analiza

`usePlatformFeatures()` (`frontend/src/hooks/usePlatformFeatures.ts`) started
a brand-new fetch defaulting to all-flags-off on every mount, with no shared
loading signal. The Sidebar's instance resolved fine on initial load, but
`RequireFeature` (the route guard) mounts fresh only when the operator
navigates to `/reports` or `/vault` — at that point it started its own
fetch from the all-off default and, since it treated "not yet loaded" the
same as "flag is off," redirected to `/` before that fetch ever settled.

### Shkaku

Per-mount feature-flag fetch with no shared cache and no loading/off
distinction in the route guard.

### Zgjidhja

`usePlatformFeatures` is now one shared module-level store (mirrors the
existing `sessionStore.ts` `useSyncExternalStore` pattern) so every consumer
shares one fetch and one resolved snapshot; added `usePlatformFeaturesLoading()`
so `RequireFeature` renders a loading state instead of redirecting while
unresolved. Extracted the route guards into `frontend/src/routes/guards.tsx`
so they're testable without pulling in the full page tree (importing the
full `AppRoutes.tsx` in a test — which transitively imports `@xterm/xterm`
via `RemoteSupport.tsx` — caused a real jsdom/vitest OOM in the test harness,
unrelated to the app bug itself).

### Ndryshimet

`frontend/src/hooks/usePlatformFeatures.ts`, `frontend/src/routes/guards.tsx`
(new), `frontend/src/routes/AppRoutes.tsx`. Added `frontend/vitest.config.ts`
+ `frontend/src/test/setup.ts` — first frontend test infra in this repo — and
19 regression tests across 3 files covering flag ON/OFF/loading and
permission-denied for both Reports and Vault.

### Rezultati

Preflight PASSED: backend 635 passed + 4 known baseline (unchanged), frontend
tsc/build clean, 19/19 new vitest tests passed. Deployed (`e6d10f2`) —
rebuilt/restarted only the `frontend` container. Production smoke 8/8.

### Mësimet

- A feature flag's "loading" state must be a first-class value distinct from
  both `true` and `false` in any consumer that gates navigation — collapsing
  it into `false` turns a slow network round-trip into a visible bug.
- When `docker compose` is run without an explicit `-p <project>`, it derives
  the project name from the current directory's basename — on this server
  that's `root` (from `/root`), not the actual running project name
  `techi-platform`. Running it bare creates a parallel duplicate stack
  instead of touching the live one. Always pass `-p techi-platform`
  explicitly on this server.

## [2026-07-10] FEATURE: Reporting Engine v1 — scheduled per-client PDF/CSV proof of value

### Problemi

Production Readiness audit identified Reporting as a Critical commercial
blocker: TECHI had no client-facing deliverable, export, schedule, or report
history even though Fleet Dashboard and Alerts already held the required data.

### Analiza

The smallest production-complete scope required no new telemetry or reporting
architecture. `DeviceOverviewService` already owns the Dashboard fleet-health
calculation; `DeviceRepository` owns scoped device reads;
`AlertRepository` owns alert data; team `AllowedScope`, `view_devices`, Audit,
feature flags, worker lifecycle, and the TECHI component/theme system already
provide every integration seam. A full-client report can leak data if a
group-only operator is allowed to create it, so scope must be checked at the
Client level rather than merely finding one visible device in that client.

### Zgjidhja

- Added `FEATURE_REPORTING` as a rollback/darkness switch and a new `/reports`
  UI/route/sidebar entry.
- On-demand PDF/CSV generation by Client and validated period (1–366 days).
  Both formats reuse current Overview/device/alert data; no duplicate business
  calculations. PDF is dependency-free PDF 1.4 with selectable text and
  pagination; CSV is UTF-8 with summary, device, and alert sections.
- Added database-backed run history/download and daily/weekly/monthly UTC
  schedules. `ReportWorker` checks due work every 60 seconds, records failures,
  advances the cadence before generation (prevents a failure retry-loop), and
  prunes artifacts/runs after 365 days.
- Generated files live in `data/reports` on the existing persistent
  `backend_data` volume; paths are resolved/contained before download or delete
  to prevent traversal.
- RBAC: read/generate/download require `view_devices`; restricted operators
  require full-client scope (group/device-only access is rejected); schedule
  management is Admin/Owner only. Generation, failure, download, and all
  schedule mutations are audited.
- Frontend reuses Button, Badge, ConfirmationModal, premium cards, and theme
  tokens; layout is responsive and supports light/dark themes.

### Ndryshimet

New backend modules: `models/report.py`, `schemas/report.py`,
`repositories/report_repository.py`, `services/report_service.py`,
`workers/report_worker.py`, `api/v1/endpoints/reports.py`; existing Alert
Repository gained one client-period query. New frontend modules:
`api/reports.ts`, `pages/Reports.tsx`; existing feature flag, route, and sidebar
wiring extended. New migration `c7d8e9f0a1b2` extends the existing
`b2c3d4e5f8a9` head (the pre-existing second Alembic head remains untouched).

Production SQL is schema-first: create `report_schedules` (client/format/
cadence/period/hour/day/enabled/next+last run/creator/timestamps) and
`report_runs` (schedule/client snapshot/format/period/status/file metadata/
error/generator/timestamps) plus indexes on client, status, enabled,
next-run, and created-at. Rollback behavior: set `FEATURE_REPORTING=false` and
restart backend. Destructive SQL rollback (only with owner approval):
`DROP TABLE IF EXISTS report_runs; DROP TABLE IF EXISTS report_schedules;`.

### Rezultati

Focused Reporting/contract/flag tests: 43 passed. Full preflight PASSED:
contract **15/15**; backend **635 passed + 4 documented baseline failures** in
both feature-off and feature-on modes; frontend `tsc --noEmit` and production
build clean; Windows/Linux agent builds and Go tests clean. Generated CSV
content was asserted and a generated PDF was identified as valid PDF 1.4.
Local smoke passed 8/8, including `/api/v1/reports/runs` (401 without a token,
never 500). While running it, the known macOS Bash 3.2 empty-array failure in
`smoke.sh` was fixed by avoiding an empty `hdr` array under `set -u`; Linux
behavior is unchanged and the smoke gate now works on both operator platforms.

### Mësimet

- Reporting did not need a data warehouse for v1: composing authoritative
  Overview + repository reads preserved one source of truth and closed the
  commercial gap without a new collection path.
- Scope checks must match the granularity of the deliverable. Device visibility
  is not proof that an operator may export a complete Client fleet.
- A scheduler must advance before executing fallible work; otherwise a broken
  export retries every sweep and can become its own incident.

## [2026-07-10] FEATURE: Notification Engine — email/webhook, event-driven, reused across Alert Engine/Remote Actions/Terminal/Enrollment/Maintenance

### Problemi

TECHI had no outbound notification channel — every 2026-07-10 readiness
audit flagged this as a Critical production blocker: a 24/7 managed
platform that can't page anyone when a client's server goes down. Mission:
build a single, reusable Notification Engine (not a one-off "email on
alert" hack) that every existing event source can plug into, supporting
Email + generic Webhook now and Slack/Teams/Telegram/Discord/PagerDuty
later without touching dispatch logic.

### Zgjidhja

**Generic, registry-shaped architecture** — same pattern this codebase
already uses for Platform/Capability/Action/Connect: a small
`NotificationSender` interface (`app/services/notification_channels.py`)
with one class per channel type (`EmailSender`, `WebhookSender`) in a
`CHANNEL_SENDERS` dict; adding Slack later is one new class + one registry
entry, `NotificationService.dispatch()` never changes.

**Data model** (3 new tables, `app/models/notification.py`):
- `notification_channels` — name, type, enabled, non-secret `config_json`
  (justified JSON: shape genuinely varies by channel type — SMTP host/port/
  tls/from/to vs webhook url/headers), plus a separately-encrypted secret
  (SMTP password / webhook shared secret) using the **same AES-256-GCM
  cipher and master key as the Credential Vault**
  (`app/core/vault_cipher.py`, reused directly — no new key material, no
  new crypto).
- `notification_rules` — binds `(event_type, scope)` to one channel, with
  `min_severity`, `cooldown_seconds`, `rate_limit_per_hour`. Global or
  per-client scope (reuses `Device.client_id`, no new column elsewhere).
- `notification_deliveries` — every send attempt: also the retry queue
  (RETRYING rows + `next_retry_at`) and the delivery-history the UI reads.
  No blob beyond the two genuinely-variable-shape JSON fields above.

**Dispatch is best-effort, same contract as `audit_log`**: wrapped in
`try/except`, never raises, so a notification failure can never break the
event source that triggered it. `dispatch()` checks `FEATURE_NOTIFICATIONS`
first and returns immediately when off — zero behavior/query change with
the flag off, same darkness contract as every other Platform Expansion flag.

**Retry**: fixed backoff (1/5/15/30 min, 5 attempts total) via a new
`NotificationWorker` (`app/workers/notification_worker.py`) — identical
start/stop/sweep pattern to `terminal_watchdog`/
`device_reconciliation_worker`; sweeps every 60s; only started when
`FEATURE_NOTIFICATIONS` is on (`main.py` lifespan), so flag-off adds no
periodic queries.

**Wired into 5 existing event sources, one small call each — no service
redesigned**:
- **Alert Engine** (`alert_engine.py`): `_open_alert` fires `device_offline`
  (for that specific alert kind) and, independently, `critical_alert` for
  any alert opened at CRITICAL severity (covers HIGH_CPU/HIGH_RAM/LOW_DISK
  reaching critical without a rule per alert kind). `resolve_device_offline`
  fires `device_online`.
- **Remote Actions** (`remote_action_service.py`): a new
  `_notify_action_result()` helper called from the 3 existing
  completion/failure paths (`complete()`, `verify_self_update_for_device()`,
  `fail()`) — distinguishes `agent_update_completed`/`agent_update_failed`
  (self_update action type) from generic `remote_action_completed`/
  `remote_action_failed`.
- **Terminal** (`terminal_routes.py`): `terminal_session_started` fires when
  `mark_active()` fires (both sides attached — already-existing call site);
  `terminal_session_ended` folded into the existing `_audit_session_end()`
  helper so every disconnect path (operator_closed/agent_gone/watchdog
  idle-timeout/max-duration) is covered automatically.
- **Enrollment** (`agent_enrollment_service.py`): hooked once, inside the
  existing `_record_audit()` helper, gated on `result == "failed"` — covers
  all 5 existing failure call sites (bad token, expired token, unsupported
  architecture, processing errors) without touching any of them individually.
- **Maintenance** (`device_maintenance_service.py`): `maintenance_finished`
  fires from both `clear_maintenance()` (manual) and `expire_if_needed()`'s
  auto-clear branch (scheduled expiry).

**UI** (`frontend/src/pages/NotificationSettings.tsx`, new): Channels
(add/edit/test/delete, admin+), Rules (event/scope/channel/severity/
cooldown/rate-limit, enable toggle), Delivery History (paginated, status
color-coded) — one page, three stacked sections, reusing `premium-card`/
`Badge`/`Button`/`ConfirmationModal` exactly as `CredentialVault.tsx` does.
Sidebar + route gated by `FEATURE_NOTIFICATIONS` + `system_settings`
permission, same `RequireFeature` pattern as the Vault link.

**Audit**: every channel/rule create/update/delete/test is audited
(`NOTIFICATION_CHANNEL_*`/`NOTIFICATION_RULE_*` constants added to the
existing `AuditAction` class) — nothing new invented, same
`audit_log()`/`AuditLog` table every other mutation uses.

### Ndryshimet

Schema (Postgres, applied by hand before deploy per the manual-SQL
discipline — Alembic doesn't run in prod):

```sql
CREATE TABLE IF NOT EXISTS notification_channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    channel_type VARCHAR(24) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config_json TEXT NOT NULL,
    secret_ciphertext TEXT,
    secret_dek_wrapped TEXT,
    created_by VARCHAR(128),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_notification_channels_channel_type ON notification_channels (channel_type);

CREATE TABLE IF NOT EXISTS notification_rules (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    scope_type VARCHAR(16) NOT NULL DEFAULT 'global',
    client_id INTEGER REFERENCES clients(id),
    channel_id INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    min_severity VARCHAR(16),
    cooldown_seconds INTEGER NOT NULL DEFAULT 0,
    rate_limit_per_hour INTEGER,
    created_by VARCHAR(128),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_notification_rules_event_type ON notification_rules (event_type);
CREATE INDEX IF NOT EXISTS ix_notification_rules_scope_type ON notification_rules (scope_type);
CREATE INDEX IF NOT EXISTS ix_notification_rules_client_id ON notification_rules (client_id);
CREATE INDEX IF NOT EXISTS ix_notification_rules_channel_id ON notification_rules (channel_id);

CREATE TABLE IF NOT EXISTS notification_deliveries (
    id SERIAL PRIMARY KEY,
    rule_id INTEGER REFERENCES notification_rules(id) ON DELETE SET NULL,
    channel_id INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    device_id INTEGER,
    client_id INTEGER,
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error VARCHAR(1024),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMP,
    next_retry_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_rule_id ON notification_deliveries (rule_id);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_channel_id ON notification_deliveries (channel_id);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_event_type ON notification_deliveries (event_type);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_device_id ON notification_deliveries (device_id);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_client_id ON notification_deliveries (client_id);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_status ON notification_deliveries (status);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_created_at ON notification_deliveries (created_at);
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_next_retry_at ON notification_deliveries (next_retry_at);
```

Inverse (rollback): `DROP TABLE IF EXISTS notification_deliveries,
notification_rules, notification_channels CASCADE;` (drop children before
parents, or rely on CASCADE as written).

Backend: `app/models/notification.py`, `app/schemas/notification.py`,
`app/repositories/notification_repository.py`,
`app/services/notification_channels.py`, `app/services/notification_service.py`,
`app/services/notification_events.py`, `app/workers/notification_worker.py`,
`app/api/v1/endpoints/notifications.py`; `app/core/config.py` (+
`FEATURE_NOTIFICATIONS`), `app/platform_core/flags.py` (dependency entry,
no deps), `app/services/audit_service.py` (+7 `NOTIFICATION_*` actions),
`app/main.py` (worker start/stop, flag-gated), `app/api/v1/api.py`
(router registration), `requirements.txt` (+`httpx==0.28.1`, now a direct
dependency, was already transitive via `TestClient`).

Wiring (small additions, no service redesigned): `alert_engine.py`,
`remote_action_service.py`, `websocket/terminal_routes.py`,
`agent_enrollment_service.py`, `device_maintenance_service.py`.

Frontend: `frontend/src/pages/NotificationSettings.tsx` (new),
`frontend/src/api/notifications.ts` (new), `frontend/src/api/platform.ts` +
`hooks/usePlatformFeatures.ts` (+`FEATURE_NOTIFICATIONS`),
`routes/AppRoutes.tsx` + `components/Sidebar.tsx` (route + nav entry,
flag-gated).

Tests (new): `test_notification_service.py` (15 — dispatch flag-gate,
severity filter, cooldown, rate limit, retry scheduling, secret
encryption round-trip), `test_notification_channels.py` (10 — Email/
Webhook senders, mocked SMTP/HTTP), `test_notification_endpoint.py` (11 —
API CRUD, RBAC, audit-on-mutation, flag-off 404), `test_notification_worker.py`
(4 — retry sweep), `test_notification_wiring.py` (13 — proves each of the
5 event sources actually calls `dispatch()` with the right `event_type`,
by patching `NotificationService.dispatch` at the class level so one spy
intercepts every call site). `test_service_repository_contracts.py` +
`test_platform_core.py` extended per the existing coverage/wiring-boundary
rules (every new public service/flag-gated module must be added there).

### Rezultati

Preflight PASSED: contract 14/14, backend suite 620 passed + 4 known
baseline (flags off & on — +54 net new tests), tsc/build clean, agent
builds. Deployed with `FEATURE_NOTIFICATIONS=false` — code live, fully
inert (matches the darkness contract every other flag-gated feature uses).

### Mësimet

- Building the channel abstraction as a tiny interface + a plain dict
  registry (rather than, say, a class hierarchy with inheritance) made the
  "reusable for Slack/Teams/Telegram/Discord/PagerDuty later" requirement
  nearly free — the registry pattern this codebase already uses everywhere
  else (Platform/Capability/Action/Connect) turned out to be exactly the
  right shape for channels too.
- Hooking `_record_audit()`/`_audit_session_end()` (existing shared
  helpers) instead of each individual call site is what made 5-failure-path
  enrollment and 2-close-path terminal wiring take one line each instead of
  five/two — worth always checking for an existing shared choke point
  before wiring a cross-cutting concern into a service.
- `asyncio.Lock()`/`asyncio.Event()` must be constructed while a loop is
  running under Python 3.9 once any other test in the suite has called
  `asyncio.run()` — the same gotcha hit during the Terminal completion work
  recurred here for `NotificationWorker`; the fix is identical (construct
  the object inside the `asyncio.run()`'d coroutine, not before it).

## [2026-07-10] DECISION: Feature flags default-ON once complete + validated — supersedes the "default OFF" rule for new work

### Problemi

Since Phase 0 (2026-07-07), every Platform Expansion feature shipped
default-OFF and required a separate, explicit owner Manual Approval to
flip on — even after implementation, automated tests, `preflight.sh`,
`smoke.sh`, and (for the 4 currently-live flags) a full production
validation window had already passed. The owner directed a change: once a
feature clears that bar, it should ship enabled by default instead of
sitting dark waiting for a second approval round-trip. Long-lived dark
features don't get exercised by real usage, so bugs that only show up
under real traffic/devices stay hidden longer than necessary.

### Zgjidhja

Adopted **going forward only** — nothing already shipped today (e.g. the
Embedded Connect / Web Terminal work completed earlier in this same
session, still `FEATURE_TERMINAL=false` in prod) is retroactively flipped
by this decision. For new work from this date forward:

- A `FEATURE_*` flag is still the mechanism for incomplete or
  intentionally-hidden work — nothing about dark development changes.
- Once a feature has implementation + automated tests + `preflight.sh` +
  `smoke.sh` + a production validation window, it ships flipped ON
  (`.env` value only) as a normal part of closing that work — not as a
  separate Manual-Approval request.
- The flag/if-checks stay in the code as a rollback switch — "remove the
  gate" means flip the `.env` default, not delete the code path. A fully
  matured feature can still have its flag deleted later as a deliberate
  cleanup, but that's a separate, explicit decision, not implied by this one.
- Deploy rigor is unchanged: preflight, smoke, a CHANGELOG entry, and a
  rollback plan are still mandatory every time a flag flips, in prod or not.

### Ndryshimet

- `docs/PROJECT_STATE.md` — "Feature Flags policy" row under PLATFORM
  EXPANSION rewritten to state the new default-ON-when-complete rule,
  with an explicit note that it doesn't retroactively touch flags already
  sitting OFF in prod.

### Rezultati

Policy-only change — no code, no deploy, no flag flipped in prod as part
of this entry. Applies to the next feature that reaches "done."

### Mësimet

- Worth distinguishing, in future "ship it enabled" decisions, between
  flipping a `.env` value (cheap, reversible, what was decided here) and
  deleting the flag/code path outright (essentially permanent) — they were
  conflated in the original ask and are meaningfully different levels of
  commitment.

## [2026-07-10] FEATURE: Embedded Connect (Web Terminal) completed to production-ready — generic rollout framework, full lifecycle, deployed dark

### Problemi

Owner directive ("Phase Next") prioritizes Embedded Connect as the top
item, with explicit requirements: complete the existing Web Terminal
(Phase 5, dark-complete since `991ae07` 2026-07-08) to enterprise-ready
without redesigning it — session lifecycle, resize, reconnect, cleanup,
timeout, audit, error handling, logging all need to be real; and replace
any device-ID-only canary with a generic rollout mechanism
(`none`/`device`/`group`/`client`/`fleet`) reusable by future features
(Remote Actions, SSH Relay, future connector platforms). Linux only —
no MikroTik/NAS/VMware relay work. Two Manual Approval blockers were on
record: an NPM edge WebSocket route, and enabling `FEATURE_TERMINAL`.

### Analiza

**NPM blocker re-verified live** (read-only `ssh techi-server`):
`/root/nginx-proxy-manager/data/nginx/proxy_host/2.conf`
(`api-rdp.techi.com.al`) has exactly one `location /` block with
`proxy_set_header Upgrade $http_upgrade;` / `Connection $http_connection;`
/ `proxy_http_version 1.1;` set host-wide, not scoped to `/ws/devices`.
NPM's "Websockets Support" toggle is per proxy-host, not per-path — the
two new terminal WS paths were already reachable. No NPM change needed.

**Lifecycle gap audit** (reading `terminal_service.py`, `terminal_relay.py`,
`terminal_routes.py`, `agent/terminal_linux.go`, `DeviceTerminal.tsx`):
resize was already implemented end-to-end (frontend `{t:"resize"}` control
frame → agent `pty.Setsize`, not the flat WS-only relay code); authorization
(admin+) already existed. But `IDLE_TIMEOUT_SECONDS`/`SESSION_MAX_SECONDS`
were declared constants nobody enforced, `expire_stale()` existed but
nothing called it periodically, no session-end audit existed (only
session-open was audited), no logging existed in the WS routes at all, and
a half-attached relay pair (operator connects, agent never dials in — e.g.
device offline) could sit in memory forever since `pump()` only exits on a
message or a disconnect, not on inactivity. Root risk: exactly the "leak an
orphan session" failure mode the owner called out.

### Shkaku

Phase 5 shipped the wire protocol and the happy path but stopped at "dark
complete" — the hardening pass (idle/max-duration enforcement, a periodic
sweep, audit-on-close, structured logging, reconnect UX) was explicitly
deferred and never revisited. Separately, `FEATURE_TERMINAL` (like every
`FEATURE_*` flag) is a single fleet-wide boolean with no per-device concept,
so any prior "enable for a canary" plan for it was unimplementable as
written.

### Zgjidhja

**Generic rollout framework** (`backend/app/platform_core/rollout.py`,
new) — `is_rollout_allowed(feature_prefix, *, device_id, group_id,
client_id)` reads `{PREFIX}_SCOPE` (`none`/`device`/`group`/`client`/
`fleet`) + `{PREFIX}_ALLOWED_DEVICE_IDS`/`_ALLOWED_GROUPS`/
`_ALLOWED_CLIENTS` off Settings; default scope `none` fails closed
regardless of the flag. Takes the prefix as a parameter (not
Terminal-specific) and is unit-tested standalone including with a
synthetic future prefix to prove genericity. `FEATURE_TERMINAL_SCOPE`/
`_ALLOWED_DEVICE_IDS`/`_ALLOWED_GROUPS`/`_ALLOWED_CLIENTS`
(`backend/app/core/config.py`) replace the previous device-only
`TERMINAL_CANARY_DEVICE_IDS` draft (never committed) before it shipped.
No DB migration — group/client scope reuses the existing `Device.group_id`/
`client_id` columns.

**Lifecycle completed, architecture reused, nothing redesigned**:
- `TerminalRelay` (`terminal_relay.py`) now tracks `started_monotonic` /
  `last_activity_monotonic` per pair and exposes a read-only
  `idle_and_expired_sessions(idle_timeout, max_session)` snapshot — the
  relay itself stays a pure transport with no DB/audit side effects.
- New `TerminalWatchdog` (`backend/app/workers/terminal_watchdog.py`, same
  start/stop pattern as `device_reconciliation_worker`) sweeps every 30 s:
  calls `TerminalService.expire_stale()` (now actually wired up) and closes
  any relay pair the snapshot flags, marking the DB session
  closed/expired and writing a `terminal_session_closed` /
  `terminal_session_expired` audit entry either way. Started only when
  `FEATURE_TERMINAL` is enabled (`main.py` lifespan) so flag-OFF stays
  zero-extra-behavior — no new periodic queries when the feature doesn't
  exist in this deployment.
- Both WS handlers (`terminal_routes.py`) now log every attach/reject/close
  and write a `terminal_session_closed` audit entry on every disconnect
  (`operator_closed`/`agent_gone`), wrapped in `try/except Exception` so a
  relay/DB error can't leave a session stuck without ever being marked
  closed.
- `POST /devices/{id}/terminal/sessions` (`terminal.py`) now audits BOTH
  grant (`terminal_session_opened`) and denial
  (`terminal_session_denied`, reason `outside_rollout_scope`), plus
  structured logging on both paths. New `AuditAction.TERMINAL_SESSION_*`
  constants added to `audit_service.py` alongside the existing action list.
- Frontend (`DeviceTerminal.tsx`): bounded auto-reconnect (up to 2 attempts,
  1.5 s/3 s backoff) on an abnormal WS close (`event.code` not 4001/4003 —
  those are permanent: expired ticket / flag off), plus a manual
  "Reconnect" button in the closed/error state. A reconnect always opens a
  **new** backend session (the architecture is one-shot end-to-end — the
  agent tears down its PTY when the WS drops, so there is no session state
  to resume); the UI is honest about this with a
  `[reconnected — new session]` marker instead of faking continuity.

**Linux-only, capability-driven, zero platform-specific code**: verified
by grep that none of the new/changed files contain a `platform ==`
check anywhere — every new gate (flag, rollout scope, `terminal`
capability) is generic. Linux stays the only live platform purely because
it's the only agent reporting the `terminal` capability today; MikroTik/
NAS/VMware relays were explicitly out of scope and untouched.

### Ndryshimet

- `backend/app/platform_core/rollout.py` (new) — generic rollout scoping.
- `backend/app/core/config.py` — `FEATURE_TERMINAL_SCOPE` +
  `_ALLOWED_DEVICE_IDS`/`_ALLOWED_GROUPS`/`_ALLOWED_CLIENTS`.
- `backend/app/services/terminal_relay.py` — activity/duration tracking +
  `idle_and_expired_sessions()`.
- `backend/app/workers/terminal_watchdog.py` (new) — 30 s cleanup sweep.
- `backend/app/websocket/terminal_routes.py` — logging + close-audit on
  every disconnect path, `try/except` hardening.
- `backend/app/api/v1/endpoints/terminal.py` — rollout-scope 403 (replacing
  the device-only draft), grant/denial audit + logging.
- `backend/app/services/audit_service.py` — `TERMINAL_SESSION_*` constants.
- `backend/app/main.py` — starts/stops `terminal_watchdog`, gated by
  `feature_enabled("FEATURE_TERMINAL")`; added to the platform_core wiring
  allowlist in `tests/test_platform_core.py` (deliberate, reviewed).
- `frontend/src/components/DeviceTerminal.tsx` — bounded auto-reconnect +
  manual Reconnect button.
- New tests: `tests/test_platform_rollout.py` (9), `tests/test_terminal_relay.py`
  (10), `tests/test_terminal_watchdog.py` (4); `tests/test_terminal_endpoint.py`
  rewritten for scope enforcement (device/group/client/fleet/none, +audit
  assertions); `tests/test_terminal_service.py` trimmed of the retired
  canary helpers.

### Rezultati

Preflight PASSED: contract 13/13, backend suite 566 passed + 4 known
baseline (flags off & on — +28 net new tests), tsc/build clean, agent
builds (windows+linux). Committed as a single commit, pushed to
`stable/phase-2-heartbeat`, deployed to production. **`FEATURE_TERMINAL`
was left `false` in prod `.env` — untouched, no rollout scope selected.**
Code is live in the running containers but fully inert (identical to
flag-off behavior, matching Phase 5's original darkness invariant).

### Mësimet

- A documented "blocker" should be re-verified against live state before
  planning around it — the NPM route requirement had been carried forward
  as fact since 2026-07-08 without anyone re-checking the actual proxy
  config; a 90-second `ssh` + `grep` settled it.
- "Dark complete" and "production ready" are different bars — the wire
  protocol working end-to-end in a demo does not imply cleanup/timeout/
  audit paths exist; those are easy to defer silently because nothing
  fails until a real orphaned session shows up in production.
- Building the rollout scope as a standalone, prefix-parameterized module
  (rather than inlining a Terminal-specific allowlist) cost almost nothing
  extra here and removes a whole category of future "let's add canary
  support to feature X" work.

## [2026-07-10] POLISH: Generic Device Drawer visual pass — enterprise-grade standard interface

### Problemi

Pipeline-i i Generic Drawer-it ishte tashmë funksional (assignment, Version
Service, Connect OS-aware, të gjitha nga sesioni i mëparshëm i sotëm), por
vizualisht dukej si prototip: tipografi e vogël/e lehtë, hierarki e dobët,
Connect jo mjaftueshëm i theksuar, karta pa lidhje vizuale, pa ngjyra
intencionale. Kërkesa: bëje Generic Drawer STANDARDIN final enterprise për
çdo platformë jo-Windows, referencë NinjaOne/Datto RMM/Domotz/Linear/GitHub
Enterprise — pa prekur Windows.

### Analiza

Rishikim kritik i `GenericDeviceDrawer.tsx`/`ConnectMenu.tsx` + krahasim me
`DeviceDrawer.tsx` (Windows, referencë e paprekshme). U gjet edhe një defekt
real gjatë rishikimit: `ConnectMenu.tsx` përdorte ngjyra Tailwind hardcoded
(`text-slate-200/400/500`) që injoronin plotësisht temën e çelët — rregulluar
si pjesë e po kësaj pune.

### Zgjidhja

- **Header**: chip ikonë platforme (ripërdor `PlatformIcon`), hostname më i
  madh, `HealthBadge` (ripërdorur nga Windows) i dukshëm menjëherë — "çfarë
  është, a është e shëndetshme" bëhet e qartë para se operatori të hapë
  ndonjë tab.
- **Rendi i Overview** ndryshoi: Connect në krye si kartë kryesore (chip
  ikonë + buton primar i mbushur me ngjyrën e markës) — "pika kryesore e
  hyrjes"; Identity+Status krah për krah; Resources; Assignment (sipas
  hierarkisë së kërkuar). U hoqën 2 rreshta të përsëritur (Platform, Health
  — tashmë në header).
- **Tipografi**: rreshtat 11px→12.5px + font-weight më i fortë; titujt e
  seksioneve morën chip ikonë 20×20; Device ID/IP në monospace.
- **Ngjyra intencionale, jo interface shumëngjyrësh**: Identity=blu,
  Status=jeshile, Resources=vjollcë, Assignment=portokalli, Connect=ngjyra e
  markës — VETËM si chip ikone, kurrë background i mbushur; harta `ACCENTS`
  e re, pa gradiente.
- **Resources**: `ResourceMeter` i ri LOKAL (ikonë + % e theksuar + mbushje
  me ngjyër, amber ≥75%, kuq ≥90%) — QËLLIMISHT jo i shtuar te `ResourceBar`
  i përbashkët (Windows e përdor po atë) — Windows mbetet i paprekur.
- **ConnectMenu**: buton primar i vërtetë (mbushje me ngjyrën e markës,
  ikonë `Link2`); ngjyrat hardcoded `slate-*` u zëvendësuan me token-et e
  temës — defekt real i rregulluar.
- **Verifikuar VIZUALISHT, jo vetëm me tsc**: u ngrit backend lokal (SQLite)
  + frontend dev server + Playwright (Chromium headless), u mbolli një
  operator + pajisje MikroTik dhe Linux reale, u bë login dhe u hap Drawer-i
  live. Konfirmuar: (1) MikroTik Overview tregon "Group: Network" (jo bosh —
  fix-i i sesionit të mëparshëm funksionon vizualisht); (2) menyja Connect
  në browser Linux fsheh automatikisht Winbox dhe ofron vetëm WebFig/SSH
  (OS-awareness i konfirmuar LIVE, jo vetëm në teste); (3) metrat e
  burimeve ngjyrosen saktë (vjollcë/amber/kuq) në 63/78/91%; (4) tema e
  çelët rendëron çdo kartë/badge/ikonë saktë, pa asnjë ngjyrë hardcoded të
  errët; (5) tab-i Management dhe scroll-i i tab-bar-it kontrolluar.

### Ndryshimet

- `frontend/src/components/GenericDeviceDrawer.tsx` (rishkrim vizual i plotë)
- `frontend/src/components/ConnectMenu.tsx` (buton primar + fix teme)
- 4 dokumentet.
- **Zero ndryshime backend. Zero ndryshime te `DeviceDrawer.tsx` (Windows).**

### Rezultati

Preflight PASSED: contract 13/13, backend 534 passed + 4 baseline (të
paprekura, sepse s'ka ndryshime backend), tsc + frontend build, agent
builds. Verifikim vizual i drejtpërdrejtë (jo vetëm typecheck) në Chromium
lokal me të dhëna reale, para deploy.

### Mësimet

- Për ndryshime thjesht vizuale, tsc/build i pastër NUK mjafton — screenshot
  i vërtetë në browser (dritë+errët, ≥2 platforma) zbuloi defekte reale
  (ConnectMenu injoronte temën e çelët) që asnjë typecheck s'do t'i kapte.
- Ndarja e komponentëve LOKALË (ResourceMeter) nga ata të PËRBASHKËT
  (ResourceBar) është mënyra e sigurt për të modernizuar një drawer pa
  rrezikuar tjetrin — edhe kur të dy dukshëm bëjnë "të njëjtën gjë".

## [2026-07-10] FEATURE: Platform-wide UX pass — Generic Drawer standard, Version Service, OS-aware Connect, assignment display fix

### Problemi

MikroTik backend (enrollment/heartbeat/inventory) tashmë punonte saktë; kjo
punë ishte një kalim UX/konsistencë-platformash mbi Generic Drawer-in që çdo
platformë jo-Windows do ta ndajë (Linux, MikroTik, e çdo connector i
ardhshëm). Nëntë probleme konkrete: (1) Drawer-i dukej si prototip; (2) badge
i version-it të MikroTik gjithmonë "1.0.0" portokalli — krahasohej kundër
version-it aktiv të flotës Windows; (3) Connect ofronte Winbox edhe në
macOS/Linux ku s'punon; (4) SSH hapej jashtë platformës, jo brenda Drawer-it;
(5) current_user mungonte për MikroTik; (6)-(8) "Client i caktuar, Group
bosh" — dukej si defekt caktimi/tree; (9) version-i i connector-it s'kishte
burim të vetëm kur skripti rigjenerohej.

### Analiza

Eksplorim kodi (jo supozime): `device_overview_service.py::_active_agent_package()`
është hardcoded te "windows-amd64" dhe krahasohet kundër ÇDO pajisje —
kjo ishte shkaku i vërtetë i badge-it gjithmonë portokalli për MikroTik.
`DeviceAssignmentService.resolve_device_assignment()` kthen `resolved_group=
None` kur `client_id` është vendosur por `group_id` jo — e VËRTETË për çdo
platformë jo-agjent me dizajn (koment ekzistues: "a standard agent group
would mis-classify them"). Tree-u (`count_by_client_category_platform`)
tashmë e rendëron saktë Client▸Network▸MikroTik në mënyrë VIRTUALE (pa rresht
real grupi) — identike me Client▸Servers▸Windows — pra Tree-u NUK ishte i
prishur, vetëm fusha `resolved_group` e Drawer-it/Listës. Nuk ekziston "Version
Service" 3-gjendjesh (jeshile/portokalli/blu) i vërtetë as për Windows —
logjika reale ishte 2-gjendjesh (barazi string + SHA tiebreak); u ndërtua si
i ri, i përgjithësuar për çdo platformë. Terminal-i ekzistues (`TerminalRelay`)
kërkon proces të vazhdueshëm që lidhet vetë te WS-ja dhe mban PTY të gjallë —
MikroTik s'ka proces të tillë (vetëm heartbeat periodik HTTP).

### Zgjidhja

1. **Drawer standard**: Overview u kufizua në saktësisht 5 seksione (Connect,
   Identity, Status, Resources, Assignment — hoqi listën e chip-eve
   Capabilities). Zero ndryshime te `DeviceDrawer.tsx` (Windows).
2. **Version Service** (`backend/app/services/version_service.py`, e re):
   `compare_versions()` + `get_active_version()` — Windows/Linux ripërdorin
   AgentPackage EKZISTUES (të paprekur); platformat connector krahasohen
   kundër `PlatformDescriptor.latest_connector_version` (fushë e re në
   Platform Registry; `MIKROTIK_CONNECTOR_VERSION` u zhvendos aty si burim i
   vetëm). `VersionBadge.tsx` e re (jeshile/portokalli/blu) përdoret në
   Drawer (`/devices/{id}/drawer` → `reported_version`/`latest_version`/
   `version_status`, `null` për Windows) DHE në Device List
   (`DeviceFleetOverview.active_connector_versions`; rreshtat Windows
   zgjidhen te i njëjti `activePackageVersion`/`isAgentOutdated` — 0 ndryshim
   vizual, provuar).
3. **Assignment "Group bosh" u rregullua** duke ripërdorur Unified
   Classification Engine: `classification.category_display_label()`
   (funksion i ri, "Network"/"Storage"/"Hypervisors") plotëson
   `resolved_group` kur s'ka rresht real grupi — asnjë logjikë specifike
   MikroTik, punon për çdo platformë jo-agjent.
4. **Connect OS-aware**: fushë e re `ConnectMethod.requires_client_os`
   (Winbox → "windows"); `ConnectMenu.tsx` zbulon OS-in e OPERATORIT
   (`navigator.platform`, i njëjti pattern si zbulimi ekzistues i iOS-it) dhe
   fsheh metodat që s'punojnë atje. Backend-i s'filtron kurrë vetë — vetëm
   deklaron kërkesën.
5. **current_user për MikroTik**: vetëm në Inventory (jo Heartbeat) — një
   query shtesë (`/user active find`), jo ngarkesë shtesë në ciklin e shpeshtë.
6. **SSH e integruar (embedded) u hetua, NUK u implementua**: arkitektura e
   rekomanduar (backend si klient SSH, "connector relay" mode e
   `TerminalRelay`, duke ripërdorur Credential Vault për kredencialin) u
   dokumentua në IMPLEMENTATION-ROADMAP.md; sot SSH hap klientin e VETË
   operatorit (`ssh://<ip>`), pa kërkesë reachability nga backend-i.

### Ndryshimet

- `backend/app/services/version_service.py` (i ri)
- `backend/app/platform_core/classification.py` (`category_display_label`)
- `backend/app/platform_core/registry.py` (`latest_connector_version`)
- `backend/app/platform_core/connect.py` (`requires_client_os`)
- `backend/app/services/device_assignment_service.py`
- `backend/app/services/device_overview_service.py`
- `backend/app/schemas/device.py`, `backend/app/api/v1/endpoints/connect.py`,
  `backend/app/api/v1/endpoints/install.py`
- `frontend/src/components/VersionBadge.tsx` (i ri),
  `frontend/src/utils/version.ts` (i ri),
  `frontend/src/utils/operatorOs.ts` (i ri)
- `frontend/src/components/GenericDeviceDrawer.tsx`,
  `frontend/src/components/DevicesTable.tsx`,
  `frontend/src/components/ConnectMenu.tsx`
- Teste: `test_version_service.py` (i ri), `test_mikrotik_deployment.py`,
  `test_connect_framework.py`, `test_platform_core.py` (allowlist)
- 4 dokumentet.

### Rezultati

Preflight PASSED: contract 13/13, backend **534 passed + 4 baseline** (flags
OFF/ON), tsc + frontend build, agent builds. `DeviceDrawer.tsx` (Windows) 0
ndryshime. Deploy + validim live: shih poshtë.

### Mësimet

- "Version Service" 3-gjendjesh nuk ekzistonte më parë — u ndërtua si i ri,
  i përgjithësuar, jo si "gjetje" e diçkaje ekzistuese; e rëndësishme të
  raportohet ndershmërisht kur pritshmëria e pronarit s'përputhet me kodin.
  Windows mban VETËM 2 gjendjet e vjetra (asnjë "blu" i ri për Windows).
  Tree-u ishte tashmë korrekt (mekanizëm virtual) — jo çdo "problem" i
  raportuar është defekt kodi; disa janë hendeqe DUKJEje mbi arkitekturë
  tashmë korrekte.

## [2026-07-10] FIX/FEATURE: MikroTik Enterprise Completion — enrollment root cause, Connect launchers, resource cards, Drawer parity

### Problemi

Katër boshllëqe operacionale mbi Connector v1: (1) një pajisje reale ishte
regjistruar por s'kishte trashëguar Client/Group nga token-i; (2) menyja
Connect vetëm listonte metoda pa i hapur (Winbox/WebFig/SSH); (3) Overview
s'kishte kartat e burimeve (CPU/Memory/Storage); (4) Overview s'kishte
Device ID dhe Client/Group ishin vetëm-lexim, ndryshe nga Windows Drawer.

### Analiza

U rilexuan 4 dokumentet + u eksplorua kodi (DeviceDrawer.tsx për paritet
vizual, agent_enrollment_service.py + device_assignment_service.py për rrjedhën
e caktimit, connect.py + remote_support.py për pattern-in ekzistues të
lidhjes/audit-it). Test i drejtpërdrejtë që riprodhon SAKTËSISHT sekuencën e
skriptit RouterOS (enroll real me token → heartbeat pa token, njësoj si
routeri) provoi se `AgentEnrollmentService`/`DeviceAssignmentService` e
caktojnë saktë Client/Group që në krijim (asnjë kod specifik MikroTik) dhe e
ruajnë atë nëpër heartbeat-e — pipeline-i gjenerik ishte tashmë korrekt.

### Shkaku

`/tool fetch` në RouterOS NUK ngre gabim skripti për një status HTTP jo-2xx
(token i skaduar/i përdorur, problem rrjeti) — skripti vazhdonte në heshtje te
instalimi i scheduler-it dhe heartbeat-i i parë, dhe rruga ekzistuese e
auto-krijimit me identitet stabil (`_create_from_stable_identity`, e nevojshme
sepse connector-i s'e mban token-in) krijonte pajisjen me
`assignment_source="system_auto"` dhe pa client — asnjëherë e trashëguar nga
enrollment-i real që dështoi në heshtje.

### Zgjidhja

- **Enrollment**: `/tool fetch` i enroll-it mbështillet me
  `:do{...}on-error={:error "TECHI enrollment failed"}` — një enrollment i
  dështuar NDALON skriptin (asnjë scheduler, asnjë heartbeat, asnjë pajisje
  e pashoqëruar). Skripti rritet 49→62 rreshta; tavani i kontratës ngrihet
  60→70 (ende zero loops/globals/enumerim, e testuar).
- **Connect launchers**: endpoint i ri `GET /devices/{id}/connect-methods/
  {method_id}/launch` — ripërdor lejen ekzistuese `remote_support_connect`
  dhe audit action-in `remote_connect` (i njëjti pattern si
  `/connect-url` i Windows). Ndërton `scheme://<ip>` (Winbox/SSH) ose
  `http://<ip><web_path>` (WebFig, fushë e re `ConnectMethod.web_path`) nga
  local_ip/public_ip i pajisjes — gjenerik për çdo platformë. `ConnectMenu.tsx`
  tani lundron/hap tab të ri në vend të toast-it "coming soon";
  `remote_support`/`web_terminal` mbajnë rrjedhat e tyre ekzistuese.
- **Resource cards**: heartbeat/inventory i MikroTik mbushin TANI fushat e
  NJËJTA gjenerike `cpu_percent`/`ram_percent`/`disk_percent` që Windows/Linux
  përdorin tashmë (lexime të vetme RouterOS — `cpu-load`, `free-memory`,
  `free-hdd-space` — pa loops); Overview i ri i rendon me `ResourceBar`
  ekzistues (vetëm përdorimi aktual, pa grafikë monitorimi).
- **Paritet Overview/Assignment**: rresht Device ID + seksion Client/Group i
  redaktueshëm, duke ripërdorur SAKTËSISHT `assignDeviceClient`/
  `assignDeviceGroup` dhe `AssignmentSourceBadge` e Windows Drawer-it klasik.
  **Zero ndryshime te `DeviceDrawer.tsx`** — Windows byte-identik.

### Ndryshimet

- `backend/app/platform_core/registry.py` (on-error guard + cpu/ram/disk_percent)
- `backend/app/platform_core/connect.py` (`web_path` field)
- `backend/app/api/v1/endpoints/connect.py` (endpoint `/launch`)
- `backend/tests/test_mikrotik_deployment.py`, `test_connect_framework.py`
- `frontend/src/components/ConnectMenu.tsx` (launch real)
- `frontend/src/components/GenericDeviceDrawer.tsx` (Overview enterprise)
- `frontend/src/services/rustdeskLaunch.ts` (`clickProtocolUrl` exported)
- `frontend/src/pages/Devices.tsx` (`onDeviceUpdated` prop)
- 4 dokumentet.

### Rezultati

`test_mikrotik_real_enroll_then_heartbeat_keeps_token_assignment` PROVON
rrjedhën e vërtetë (enroll→heartbeat) ruan Client/Group; `test_mikrotik_
heartbeat_without_enrollment_stays_unassigned` dokumenton defektin e
parandaluar. Preflight PASSED: contract 13/13, backend 521 passed + 4 baseline
(flags OFF/ON), tsc + frontend build, agent builds. `DeviceDrawer.tsx` (Windows)
0 ndryshime; Linux Generic Drawer i paprekur në sjellje (vetëm Overview i ri
i përbashkët).

### Mësimet

- Kur "pipeline gjenerik" duket i thyer, testo SEKUENCËN REALE (enroll pastaj
  heartbeat) përpara se të supozosh defekt logjik — defekti ishte te
  qëndrueshmëria e skriptit RouterOS, jo te backend-i.
- `/tool fetch` i RouterOS s'ngre gabim për HTTP jo-2xx — çdo hap kritik
  (enrollment) duhet mbështjellë me `:do/on-error` + `:error` eksplicit.

## [2026-07-10] SIMPLIFICATION: MikroTik Connector v1 — Connector, jo agjent; skripti RouterOS përgjysmohet

### Problemi

Pronari ndaloi rritjen e connector-it: skripti RouterOS ishte bërë tepër i
rëndë (97 rreshta / 7.6 KB, 2 cikle `:foreach` mbi interfaces + packages,
JSON të ndërtuar me string-e të mbivendosura, 15 blloqe on-error) dhe po
rrëshqiste drejt replikimit të Linux Agent-it. TECHI është RMM, jo zëvendësim
i Winbox-it — menaxhimi i avancuar RouterOS bëhet gjithmonë përmes Connect
(Winbox/WebFig/SSH); connector-i duhet të japë vetëm dukshmëri operacionale.

### Analiza

U rilexuan 4 dokumentet kanonike; arkitektura mbetet e pandryshuar (Platform
Registry si burim i vetëm i templateve, enrollment/heartbeat gjenerikë,
Generic Drawer nga registrat). U gjet edhe një defekt real në v1: skriptet e
skeduluara mbaheshin mbi RouterOS globals (`$techiApi`, `$techiAgentId`) që
NUK i mbijetojnë reboot-it — pas rindezjes router-i do të dilte offline
përgjithmonë deri në ri-ngjitje të skriptit.

### Zgjidhja

- **Skripti RouterOS**: 97 → **49 rreshta**, 7.6 → **4.6 KB**, `:foreach` 2 →
  **0**, RouterOS globals → **0** (skriptet e skeduluara janë të
  vetë-mjaftueshme — i mbijetojnë reboot-it), on-error 15 → 10. Test i ri
  kontrate ndalon rirritjen (≤60 rreshta, pa `:foreach`/`:global`, pa
  komanda enumerimi, capabilities vetëm `connect`).
- **Heartbeat minimal (~250 B)**: agent_id/hostname/platform/os_name/
  os_version/architecture/local_ip/agent_version/`connect`. Pa MAC, pa
  health (llogaritet krejtësisht në backend), pa public IP (nxirret nga
  X-Forwarded-For në edge).
- **Inventory i lehtë (~450 B, çdo 1800 s)**: Board/Model/Serial/Firmware/
  Uptime/Bridges/Wireless po-jo/DefaultRoute po-jo (në os_caption) +
  CPU/RAM/storage + 2 rreshta statikë software (RouterOS, RouterBOOT — që
  snapshot-i i inventory-t të ekzistojë dhe health freshness të punojë). Pa
  enumerim interfaces/packages/routes/firewall/DHCP/DNS/ARP.
- **Kapacitetet**: MikroTik raporton VETËM `connect`; fjalori i Capability
  Registry u kthye mbrapsht (u hoqën routes/bridge/dhcp/dns/identity/system
  të shtuara dje); `connect` nuk mapohet në asnjë tab → Drawer-i =
  Overview / Management / Notes / Timeline, pa tabe kapacitetesh.
- **Drawer Overview** (gjenerik, i përbashkët me Linux): kompakt në 9 fushat
  e kërkuara — Identity, RouterOS Version, Board, Architecture, Last Seen,
  Health, Local IP, Public IP, Connector Version (+ Connect, Assignment).
  U hoqën seksionet Network/Hardware dhe tab-i "Interfaces".
- **Actions**: hiqet `reconnect` — mbeten Refresh Inventory / Restart
  Connector / Re-enroll.
- **Forcim identiteti**: heartbeat-i mikrotik refuzon edhe `mikrotik-` të
  zbrazët (serial bosh do të shkrinte routera të ndryshëm në një pajisje).

### Ndryshimet

- `backend/app/platform_core/registry.py` (templati i ri + capabilities `{connect}`)
- `backend/app/platform_core/capabilities.py` (fjalori i kthyer, pa tab-order MikroTik)
- `backend/app/platform_core/actions.py`, `backend/app/schemas/remote_action.py` (pa reconnect)
- `backend/app/api/v1/endpoints/connect.py` (firma origjinale capability_tabs)
- `backend/app/services/device_heartbeat_service.py` (guard `mikrotik-` bosh)
- `frontend/src/components/GenericDeviceDrawer.tsx` (Overview kompakt, pa panele MikroTik)
- Teste: `test_mikrotik_deployment.py` (+test madhësie/flatness), `test_action_registry.py`
- 4 dokumentet.

### Rezultati

Preflight PASSED: contract 13/13, suite **510 passed + 4 baseline** (flags
OFF dhe ON), tsc + frontend build, agent builds. Windows/Linux/macOS të
paprekur (asnjë ndryshim në deployment/enrollment/heartbeat contract).
Deploy + validim live: shih fundin e hyrjes së 2026-07-09 më poshtë;
validimi në RouterOS real mbetet hapi i pronarit (ngjitja e skriptit të ri).

### Mësimet

- Një "connector" rrëshqet natyrshëm drejt "agjenti" — kufiri duhet mbajtur
  me test kontrate (madhësi + flatness), jo me disiplinë.
- RouterOS globals nuk i mbijetojnë reboot-it — skriptet e skeduluara duhet
  të jenë të vetë-mjaftueshme.

## [2026-07-09] FEATURE/FIX: MikroTik Connector v1 — heartbeat, inventory, capabilities, generic drawer

### Problemi

MikroTik deployment could register a RouterOS device, but the integration ended
there: no heartbeat, no Last Seen/freshness lifecycle, no inventory/capabilities,
and no capability signal to select the Generic Drawer. A registered MikroTik could
therefore look like a capability-less device and expose Windows-oriented drawer
concepts.

### Analiza

Read path stayed the existing architecture: Platform Registry generates
`/install/mikrotik`; enrollment goes through `/agent/enroll`; heartbeat is the
standard `/agent/heartbeat`; Generic Drawer metadata comes from Platform +
Capability + Connect + Action registries. RouterOS cannot reliably parse and
reuse the JSON enrollment response across RouterOS 6/7, so the connector needed a
stable identity before enrollment.

### Shkaku

The previous MikroTik implementation was intentionally registration-only. It sent
one enrollment POST and did not install any recurring RouterOS-side heartbeat or
capability report, so the backend had no live signal to update status/health or
select RouterOS-specific drawer/connect/action surfaces.

### Zgjidhja

- RouterOS 6/7 templates now set deterministic
  `agent_id=mikrotik-<serial-or-software-id>`, enroll once, install two scripts
  (`TECHI-Heartbeat`, `TECHI-Inventory`), add two schedulers, and run both once
  immediately.
- Agent Config now carries per-platform heartbeat intervals and per-platform
  inventory intervals; RouterOS deployment embeds the current MikroTik values
  instead of hardcoding scheduler intervals.
- Heartbeat reuses the existing `/api/v1/agent/heartbeat` contract and reports
  only lightweight live identity/capabilities. Inventory is separated from
  heartbeat (default 1800 s) and reports RouterOS identity, version,
  architecture, board/model/serial/firmware/uptime, CPU/RAM/storage,
  interfaces, default route, DNS, bridge/wireless counts, MAC/local/public IP,
  software rows, and the MikroTik capability set.
- Capability Registry adds RouterOS vocabulary (`routes`, `bridge`, `dhcp`,
  `dns`, `identity`, `system`, `connect`).
- Connect Framework exposes MikroTik metadata-only Winbox/WebFig/SSH; no Web
  Terminal capability.
- Action Registry filters by platform and exposes only Refresh Inventory,
  Restart Connector, Reconnect, Re-enroll for MikroTik.
- Generic Drawer Overview shows existing identity/hardware fields; Remote
  Support/Web Terminal are absent for MikroTik.
- Heartbeat side effects record MikroTik timeline events without spamming:
  `heartbeat_received` is transition-gated (first heartbeat or offline→online
  recovery only — never one row per beat) and `inventory_updated` follows the
  inventory cadence (default 1800 s); health skips Remote Support/user penalties
  when a platform does not report Remote Support and scores RouterOS inventory
  freshness instead of Windows patch state.

### Ndryshimet

- `backend/app/platform_core/registry.py`
- `backend/app/platform_core/capabilities.py`
- `backend/app/platform_core/connect.py`
- `backend/app/platform_core/actions.py`
- `backend/app/schemas/remote_action.py`
- `backend/app/api/v1/endpoints/agent.py`
- `backend/app/services/agent_enrollment_service.py`
- `backend/app/services/device_heartbeat_service.py`
- `backend/app/services/device_health_score_service.py`
- `backend/app/services/agent_config_service.py`
- `backend/app/api/v1/endpoints/agent_config.py`
- `backend/app/api/v1/endpoints/install.py`
- `frontend/src/api/devices.ts`
- `frontend/src/api/agentConfig.ts`
- `frontend/src/pages/AgentConfig.tsx`
- `frontend/src/components/GenericDeviceDrawer.tsx`
- Tests and docs.

### Rezultati

Validation passed locally:
- Focused backend: 92 passed
  (`test_agent_config.py`, `test_mikrotik_deployment.py`,
  `test_connect_framework.py`, `test_action_registry.py`,
  `test_platform_core.py`).
- Adjacent deployment/connect/action regressions: 177 passed.
- Frontend `tsc --noEmit`: passed.
- Frontend production build: passed (existing large chunk warning only).
- `scripts/preflight.sh`: PASSED — contract 13/13, backend suite 509 passed +
  4 known baseline failures in both flag modes, frontend build OK, agent build
  OK.

Final pre-commit review (same day) tightened two things, re-validated with the
full preflight (still PASSED, 509+4 both flag modes):
- `heartbeat_received` timeline event is transition-gated (was: one activity
  row per beat ≈ 345/day/device — timeline spam + unnecessary DB writes);
  a regression assertion locks steady-state heartbeats to zero new events.
- Generic Drawer Overview now also shows Last Seen, Health (score + state via
  the existing telemetry hook) and Connector Version, completing the required
  compact overview (Identity / RouterOS version / Board / Architecture /
  Last Seen / Health / Local IP / Public IP / Connector Version).

Remaining production validation requires pasting the generated script into a real
RouterOS 6.x and 7.x device after deploy and verifying the scheduled heartbeat,
device placement, drawer, timeline, and health against the live backend.

## [2026-07-09] BUGFIX: MikroTik deployment generated shell-like script; RouterOS 6/7 native templates

### Problemi

Deployment ▸ token ▸ View generated one MikroTik RouterOS script. When pasted
into a real MikroTik terminal it failed immediately with `expected end of command`
/ `syntax error`. The generated command looked like shell:

```routeros
/tool fetch url="..." http-method=post \
  http-header-field-value="Content-Type: application/json" \
  http-data="$body" output=none
```

### Analiza

Read path: Platform Registry (`platform_core/registry.py`) held the template;
`GET /install/mikrotik?token=` rendered it; Deployment UI fetched that endpoint
from the metadata-driven `ScriptSection`; enrollment still went through the
generic `/agent/enroll` pipeline. MikroTik documentation for `/tool fetch`
uses `http-header-field="Content-Type:application/json"` for POST JSON; the
generated template used the unsupported `http-header-field-value` property and
shell-style line continuations.

### Shkaku

The template mixed shell habits with RouterOS syntax: backslash continuations,
an unsupported fetch parameter, and one versionless fetch command. RouterOS 6
and 7 both support POST via `/tool fetch`, but both templates must specify
`mode=https` when the URL is built from a variable expression. RouterOS 6 uses
`keep-result=no`; RouterOS 7 uses `output=none`.

### Zgjidhja

Smallest registry-preserving fix:
- Platform Registry now declares two versioned MikroTik templates:
  RouterOS 6.x and RouterOS 7.x.
- `render_deployment_script()` accepts an optional `routeros_version` and keeps
  the existing default template for backward compatibility.
- `/install/mikrotik` accepts `routeros_version=6|7`, defaulting to `7` for old
  callers.
- Deployment UI adds a RouterOS Version radio selector inside the existing
  metadata-driven MikroTik script section.
- Follow-up from a real RouterOS 7 terminal (`Mario Home`): omitting `mode=https`
  with `url=($api . "...")` produced `failure: Mode not specified`; RouterOS 7
  template now includes `mode=https` too.
- Second real-terminal follow-up: pasting line-by-line meant each `:local`
  variable was scoped to its own prompt command; `/tool fetch` then saw an empty
  `$api` and returned `failure: Please provide IP address or host`. Both templates
  are now wrapped in a RouterOS `{ ... }` block and use `:local enrollUrl (...)`
  followed by `url=$enrollUrl`, so variables survive for the whole pasted script.

### Ndryshimet

- `backend/app/platform_core/registry.py`
- `backend/app/api/v1/endpoints/install.py`
- `backend/tests/test_mikrotik_deployment.py`
- `frontend/src/pages/Deployment.tsx`
- Docs: `PROJECT_STATE.md`, `IMPLEMENTATION-ROADMAP.md`,
  `reference/OPERATOR-MANUAL.md`, this changelog.

### Rezultati

Generated scripts are native RouterOS blocks with single-command fetch lines,
`mode=https`, no shell continuations, no `http-header-field-value`. Enrollment
token/client/default group/classification flow unchanged; Windows/Linux/macOS
deployment paths untouched.

Validation:
- `tests/test_mikrotik_deployment.py`: 13 passed.
- Windows/Linux/platform deployment regressions:
  `test_install_linux.py`, `test_linux_enrollment_oneliner.py`,
  `test_enrollment_token_workflow.py`, `test_enrollment_bootstrap_script.py`,
  `test_platform_core.py`: 136 passed.
- Frontend `npx tsc --noEmit`: passed.
- Frontend production build: passed.

## [2026-07-09] RELEASE: Agent 2.1.6 — baseline i ri prodhimi (zëvendëson 2.1.5); NJË lifecycle engine për Windows + Linux

### Problemi

Pronari promovoi 2.1.6 si baseline zyrtar prodhimi: duheshin (1) merge i
përmirësimeve Lifecycle të miratuara, (2) i njëjti Lifecycle Engine edhe për
Linux (JO implementime të ndara — retry, state machine, first heartbeat,
operational, recovery identike; kodi platformë-specifik vetëm operacione
platforme), (3) build + validim i plotë, (4) përgatitja e artifakteve për
NETLOGON pa asnjë ndryshim GPO/skriptesh.

### Zgjidhja

- **Merge**: `pending-agent-2.1.6` → `stable/phase-2-heartbeat` (`cd06f3b`,
  pa konflikte): lifecycle state machine (64f70ed) + log rotation/cache
  pruning (313cb74). Urdhri i ngrirjes së agent-code për rrjedhojë mbyllet —
  2.1.6 është baseline i ri.
- **Unifikim Linux** (release commit `1b0ddf3`): engine ishte tashmë
  platformë-neutral; u mbyllën dy hendeqet e fundit: (a) `agent.state.json`
  tani gjithmonë NGJITUR me config-un — Windows
  `C:\ProgramData\TechiAgent\`, Linux `/etc/techi-agent/`, dev `./`;
  `-config` i personalizuar e mbart me vete (initLifecycleStateFile);
  (b) hiqet migrate i dyfishtë para-lifecycle në `main.go` — konsola,
  Windows service dhe systemd (Type=simple, `Restart=always`) ndajnë
  SAKTËSISHT të njëjtin path nisjeje/retry. Recovery: SCM failure actions
  (Windows) ≡ systemd Restart=always (Linux) — semantikë crash-and-restart
  identike. VERSION → 2.1.6.
- **Artifaktet Windows** dalin nga NJË run i CI `build-agent-msi.yml`
  (rregulli SHA-alignment): `TECHI-Endpoint-Deployment-2.1.6.msi` (kombinuar),
  `TECHI-Agent-Update-2.1.6.msi` (bridge), `techi-agent-2.1.6.exe`
  (standalone, i njëjti binar si në MSI) + .sha256 secili. **Linux**: build
  lokal `-s -w -X main.AgentVersion=2.1.6 -trimpath` →
  `techi-agent-linux-{amd64,arm64,armhf}.bin`, SHA në
  `agent/dist/SHA256SUMS-2.1.6-linux.txt`
  (amd64 8e398a90…, arm64 06174baa…, armhf 972dcbf8…).
- **Deployment (vetëm zëvendësim artifaktesh)**: në NETLOGON zëvendësohen
  `TECHI-Agent-2.1.6.msi` (MSI i kombinuar i RIEMËRUAR — techi-deploy.cmd
  pret `TECHI-Agent-%%VERSION%%.msi`), `techi-version.txt` → `2.1.6`, bridge
  MSI, agent binary (upload si Agent Binary package nga i njëjti CI run).
  ASNJË ndryshim në GPO/techi-deploy.cmd/komanda — Scheduled Task ekzistues
  e ngre flotën automatikisht. Pas 100%: 2.1.7+ shpërndahen kryesisht me
  self_update; NETLOGON/GPO mbetet bootstrap + recovery.

### Rezultati

Preflight PASSED në baseline: contract 13/13; backend 488 passed + 4 baseline
(flags OFF dhe ON); tsc + frontend build; agent builds. `go vet` + `go test`
(me testet e reja lifecycle); build 5 targete (windows/amd64,
linux/amd64+arm64+armv7, darwin dev). Smoke lokal 7/7 (skripti kërkon bash ≥4;
në macOS bash 3.2 `"${hdr[@]}"` bosh + `set -u` jep false-fail — në serverin
prod s'ka problem). Provë e gjallë: `-config` custom → `agent.state.json`
ngjitur me të, tranzicionet loading_config → enrolling të logruara.

### Mësimet

- Lifecycle platformë-neutral që nga dita zero i bëri "ndryshimet Linux"
  gati zero — vetëm vendndodhja e state file dhe heqja e një dublimi.
- Rregulli SHA-alignment mbetet ligj: MSI + exe standalone VETËM nga i njëjti
  CI run, ndryshe flota bëhet portokalli.
- deploy.cmd pret emrin `TECHI-Agent-<version>.msi` — CI prodhon
  `TECHI-Endpoint-Deployment-<version>.msi`; riemërtimi në NETLOGON është
  hap i detyrueshëm i deployment-it.

## [2026-07-09] INCIDENT PRODHIMI: PC i sapo-formatuar nuk shfaqet kurrë në platformë — "Access is denied" te agent.config.json; agjenti vdes në heshtje pas një service RUNNING

### Problemi

PC Windows i formatuar dhe i ri-bashkuar në domain: MSI instalohet me sukses,
service `TechiAgent` RUNNING, RustDesk OK — por pajisja nuk shfaqet kurrë në
platformë. `agent.log`: `open C:\ProgramData\TECHI\agent.config.json: Access
is denied`.

### Analiza

Hetim i plotë kodi (pa supozuar ACL): u gjurmuan TË GJITHË krijuesit/lexuesit
e `agent.config.json` — `bootstrap-config` (MSI CA `WriteAgentConfig`,
deferred + `Impersonate="no"` → SYSTEM), migrimi në start
(`paths.go` `migrateConfigIfNeeded` → `os.Open` i file-it legacy — **thirrja
që dështon**, mesazhi përputhet fjalë-për-fjalë), `refreshEnrollmentTokenIfNeeded`,
`swap_windows.go`, `techi-deploy.cmd`. Të dy manipulimet ACL
(`LockdownTechiDataDir` në MSI, `lockdownConfigACL` në agjent) japin
`*S-1-5-18:F` — SYSTEM ka gjithmonë akses; service-i, GPO task-u dhe CA-të
xhirojnë të gjithë si SYSTEM. Pra denial-i NUK prodhohet dot nga ACL-të e
kodit tonë; prodhuesi realist është shtresa AV/EDR në makinat e sapo-formatuara
(saktësisht arsyeja pse ekziston GPO "TECHI Agent - Defender Exclusions" për
`C:\ProgramData\TECHI` + `techi-agent.exe`), para se exclusions të aplikohen.

### Shkaku

Defekti real në kod: **një dështim i vetëm, kalimtar, i leximit të config-ut
në startup e vret agent loop-in përgjithmonë ndërsa service-i vazhdon të
raportojë RUNNING** — `Execute` (service_windows.go) vetëm e logonte gabimin
e goroutine-s; procesi nuk dilte, SCM recovery (restart 1m/1m/5m) s'aktivizohej
kurrë, watchdog-u shihte service "të shëndetshëm". Asnjë retry, asnjë gjendje.

### Zgjidhja

**Agent Startup State Machine** (miratuar nga pronari): Installing (MSI) →
LoadingConfig → Enrolling → FirstHeartbeat → Operational.

- Leximi i config-ut retry pa fund me backoff eksponencial (5s → cap 5min);
  çdo retry logohet — gjendje startup-i gjithmonë e rikuperueshme.
- Gjendja eksplicite, e logruar në çdo tranzicion dhe e pasqyruar në
  `C:\ProgramData\TechiAgent\agent.state.json` (state/detail/updated_at/pid).
- Heartbeat-i i parë i suksesshëm → Operational; dështimet kalimtare pas tij
  nuk e largojnë nga Operational.
- Nëse loop-i del me gabim gjithsesi: shkruhet `faulted` dhe procesi bën
  `os.Exit(2)` PA raportuar SERVICE_STOPPED → SCM failure actions bëhen
  përsëri kuptimplota.
- `watchdog-check` dallon Service Running / Agent Initializing / Agent
  Operational / Agent Faulted nga state file dhe e riniset service-in kur
  agjenti është Faulted ose i ngecur në initializing me file të vjetruar
  (>30min). I heshtur kur Operational.
- **Pa ndryshime** në installer, enrollment, skriptet e deployment, apo
  formatin e `agent.config.json`.

### Ndryshimet

Branch `pending-agent-2.1.6`, commit `64f70ed` (sipas urdhrit në fuqi: kodi i
agjentit nuk preket në `stable/phase-2-heartbeat` gjatë rollout-it 2.1.5):
`agent/lifecycle.go` (i ri), `agent/lifecycle_test.go` (i ri),
`agent/agent.go`, `agent/service_windows.go`, `agent/swap_windows.go`.
Dokumentim: OPERATOR-MANUAL §9a + Troubleshooting, PROJECT_STATE (Known
Issue 14, Pending 2.1.6).

### Rezultati

`go vet`, `GOOS=windows go build`, `go test ./...` OK. Provë e drejtpërdrejtë
(host build): config me permission denied → `loading_config` me retry 5s/10s
të logruara → config u riparua gjatë xhirimit → tranzicion në `enrolling`,
state file i saktë. Kodi i vjetër dilte fatalisht në tentativën 1.

### Mësimet

- Service RUNNING ≠ agjent i gjallë: çdo daemon me loop në goroutine duhet
  ose të vdesë bashkë me loop-in (që SCM të veprojë) ose të ekspozojë gjendje.
- `Return="ignore"` në MSI CA + gabime të gëlltitura në service = incidente
  të padukshme; verifikimi kërkon evidencë nga endpoint-i (state file).
- Në makina të sapo-formatuara AV/EDR godet para GPO exclusions — startup-i
  i agjentit duhet ta mbijetojë këtë me retry, jo të varet nga rendi i GPO-ve.
- Workaround për flotën 2.1.5 deri në rollout 2.1.6: restart i service-it
  `TechiAgent` në pajisjen e prekur.

## [2026-07-09] PHASE: MikroTik Platform Integration (deployment + registration only)

### Objektivi
Vetëm pipeline-i i enrollment-it MikroTik (pa RouterOS API/Winbox/WebFig/SSH
launchers, pa menaxhim). MikroTik si **Connector/Proxy** — adapteri i vetëm që flet
RouterOS; pjesa tjetër e platformës mbetet platform-independent. Additive, Windows
byte-identik.

### Zgjidhja
- **Platform Registry si burim i vetëm**: `PlatformDescriptor` merr fusha shtesë
  `deployment_method` / `deployment_template` / `supported_architectures` /
  `supported_routeros_versions` (platformat agent i lënë bosh → të paprekura).
  MikroTik deklaron template RouterOS + arkitektura (chr/x86/arm/arm64/mipsbe/mmips/
  ppc/tile) + RouterOS 6/7. `render_deployment_script()` mbush template-in;
  `validate_architecture()` refuzon arch të panjohur/mungues për platformat që
  deklarojnë set (platformat agent nuk arch-validohen).
- **Gjenerim skripti**: `GET /install/mikrotik?token=` (FEATURE_MIKROTIK-gated 404)
  gjeneron skriptin RouterOS nga template-i i registry-t — kurrë hardcoded. Skripti
  bën `/tool fetch` POST te `/agent/enroll` me token + platform + arch (self-detektuar).
- **Enrollment**: ripërdor pipeline-in gjenerik. Arch validohet në enroll
  (`AgentEnrollmentRequest` merr `architecture` opsionale). Auto-group u rafinua —
  platformat non-agent (MikroTik → Network sipas platformës) NUK detyrohen në
  Servers/Client PC; agent të pandryshuar. Pema: Client ▸ Network ▸ MikroTik automatik.
- **Deployment dialog**: MikroTik tani është seksion "script" i drejtuar nga metadata
  (RouterOS Script + arkitekturat), i renderuar sipas `kind` — jo sipas platform id.
- **Connect** (Winbox/WebFig/SSH) tashmë i deklaruar në registry; metadata-only, i paprekur.

### Ndryshimet
- `backend/app/platform_core/registry.py` (fusha + template + render + validate)
- `backend/app/api/v1/endpoints/install.py` (`/mikrotik`)
- `backend/app/schemas/agent.py` (`architecture`), `agent_enrollment_service.py` (validim)
- `backend/app/services/device_assignment_service.py` (auto-group non-agent)
- `frontend/src/pages/Deployment.tsx` (kind "script" + ScriptSection)
- `backend/tests/test_mikrotik_deployment.py` (i ri). Commit `07a808b`.

### Rezultati (provë live)
Suite 497+4 baseline (flags OFF & ON); tsc/build/agent OK; smoke 7/7. Prod tip
`07a808b`. Live: `/install/mikrotik?token=DEMO` → skript RouterOS me token të injektuar;
enroll me arch `sparc` → **400** (validim registry). Windows/Linux/macOS të pandryshuara.

### Mësimet
Metadata-driven i vërtetë: shtimi i menaxhimit RouterOS më vonë = vetëm Platform
Adapter + Capability Mapping + Action Registry + Capability Renderer, pa ndryshime
Drawer/Tree/UI. Shih [[platform-v3-design]].

## [2026-07-09] ARKITEKTURË: Enrollment gjenerik platform-neutral — Step 2 (auto-group)

Token-at mbeten **platform-neutral** (Client + Default Group opsional + assignment
source + policy; identiteti i platformës vjen nga agjenti/adapter, jo nga token-i).
Kur një token jep Client por JO Default Group, `apply_enrollment_assignment` tani
zgjidh grupin standard nga sinjali i agjentit përmes Unified Classification Engine
(`_detect_group` → Servers/Client PC) dhe krijon grupet standarde → **çdo platformë**
(Linux/MikroTik/e ardhshme) ulet te Client ▸ Group i saktë **pa caktim manual**
(zgjidh problemin që pajisja e parë Linux u desh të vendosej me dorë). Token me
Default Group eksplicit respektohet i pandryshuar; token pa client ndjek path-in
ekzistues auto. Pa logjikë specifike Linux — pipeline gjenerik i ripërdorshëm.

Ndryshimet: `backend/app/services/device_assignment_service.py`,
`backend/tests/test_enrollment_auto_group.py` (i ri). Suite 488+4 baseline;
tsc/build/agent OK; smoke 7/7. Prod tip `a5a9b86`. Shih [[platform-v3-design]].

## [2026-07-09] ARKITEKTURË: Registry-driven Device Drawer — Step 1c (enforcement unifikohet)

`ACTION_PERMISSION_MAP` tani **derivon** nga `platform_core.actions.permission_map()`
(jo më dict literal). Kështu të katër konsumatorët konsumojnë të njëjtin
ActionDescriptor: UI (`/drawer`), permissions (mapi i derivuar), execution (queue
me `action_type` == descriptor id) dhe audit (`ACTION_QUEUED`). Vlerat të
pandryshuara (13 hyrje); test konkret që kap një edit të gabuar descriptor-i;
`permission_service.py` u shtua në allowlist-in e wiring boundary. Labels mbeten te
`schemas.remote_action` (ActionType enum-cycle), të kyçur me contract-test te
registri. Contract 13/13, suite 484+4 baseline, smoke 7/7. Prod tip `53854c5`.
**Step 1 (Drawer registry-driven) i plotë.** Shih [[platform-v3-design]].

## [2026-07-09] ARKITEKTURË: Registry-driven Device Drawer — Step 1b (generic renderer)

### Zgjidhja
`frontend/src/components/GenericDeviceDrawer.tsx` (i ri) renderon TËRËSISHT nga
`GET /devices/{id}/drawer` (Platform + Capability + Action + Connect registries):
Overview me **Connect si veprimi primar**, tabs të gjeneruar nga capabilities
(Services/Processes/Packages/Docker/Logs/Network/Storage — vetëm kur capability
raportohet), tab **Management me butona nga Action Registry** (confirm policy
respektohet), Terminal (kur `terminal` + `FEATURE_TERMINAL`), Notes, Timeline.
**Remote Support shfaqet vetëm kur pajisja raporton capability `remote_support`**
→ Linux nuk ripërdor më sipërfaqen Windows RS.

**Përzgjedhja e renderer-it në render-site** (Devices.tsx): pajisje që raporton
capabilities → GenericDeviceDrawer; pajisje pa capabilities (çdo agjent Windows) →
DeviceDrawer klasik, **i paprekur dhe byte-identik**. Platformat e reja janë gjithnjë
capability-reporting → path gjenerik → **shtimi i një platforme s'kërkon ndryshim Drawer**.

### Ndryshimet
- `frontend/src/components/GenericDeviceDrawer.tsx` (i ri)
- `frontend/src/api/platform.ts` (`getDrawerMeta` + tipat)
- `frontend/src/pages/Devices.tsx` (përzgjedhja e renderer-it)
- Commit `7d405c8`.

### Rezultati
tsc + build OK; preflight PASSED (suite 483+4 baseline, flags OFF & ON); smoke 7/7.
Prod tip `7d405c8`. Linux `rustdesk-srv` → Drawer gjenerik (pa RS, capability tabs,
Connect); Windows → Drawer klasik i pandryshuar. Reuse: ConnectMenu, ActivityTimeline,
DeviceTerminal, notes/inventory/actions API, ConfirmationModal.

### Mësimet
Përzgjedhja e renderer-it në call-site (jo degëzim brenda komponentit) mban Windows-in
byte-identik me zero edits te DeviceDrawer.tsx. Shih [[platform-v3-design]].

## [2026-07-09] ARKITEKTURË: Registry-driven Device Drawer — Step 1a (Action Registry, dark)

### Vendimi (owner)
Pas enrollment-it të parë real Linux, Drawer-i s'duhet të bëhet "Linux Drawer" por
një **Device Drawer gjenerik** i renderuar tërësisht nga Platform Registry +
Capability Registry + **Action Registry** + Connect Registry → një **Generic
Renderer**, pa degëzim Windows/Linux. **Action Registry = burimi i vetëm i së
vërtetës** për çdo operacion të ekzekutueshëm (id, label, permission, required
capability, confirmation policy, audit metadata, execution target, execution
handler); UI, permissions, audit dhe execution konsumojnë të njëjtin descriptor.
Rendi: **Step 1 = Drawer gjenerik**, pastaj **Step 2 = enrollment gjenerik**.
Objektivi: shtimi i një platforme të re = vetëm Platform Adapter + Capability
Mapping + Connect Methods + Action Registry entries + (opsionale) Capability
Renderers — pa ndryshime Drawer/Management/Tree/UI. Windows selektohet nga
registry si renderer i grandfathered (Appendix C) → byte-identik.

### Zgjidhja — Step 1a (dark, backend-only)
- `backend/app/platform_core/actions.py`: `ActionDescriptor` (single source) +
  `ACTION_REGISTRY` + `actions_for()`/`effective_capabilities()`. Disponueshmëria
  vendoset nga capability; **"mungesa e capabilities ⇒ capabilities e deklaruara
  të platformës"** → floti aktual Windows (pa capabilities) ruan tërë sipërfaqen
  byte-identike pa rebuild agjenti. Contract test: `permission_map() ==
  ACTION_PERMISSION_MAP` dhe labels == `ACTION_LABELS` (që hard-mapet t'i derivojmë
  më vonë pa drift).
- `capabilities.py`: `capability_tabs()` — capability→tab, pa degë platforme.
- `GET /devices/{id}/drawer` (dark, CORE-gated 404): feed-i i vetëm i renderer-it
  gjenerik (platform, effective capabilities, remote_support/terminal, capability
  tabs, connect methods, actions).

### Rezultati (provë live)
Contract 13/13; suite 483+4 baseline (flags OFF & ON); tsc/build/agent OK; smoke 7/7.
Prod tip `14f7103`. Feed live: Linux `rustdesk-srv` → remote_support=false, tabs
[services,processes,packages,docker,logs,network], connect [web_terminal,ssh], pa
veprime RS; Windows `kds-03dr` → remote_support=true, set i plotë veprimesh RS,
connect [remote_support]. **UI e paprekur (dark).**

### Mësimet
Foundation-i i regjistrave zbresim dark + contract test që lidh regjistrin me
hard-mapet ekzistuese → migrim pa risk i sipërfaqes prodhuese. Shih [[platform-v3-design]].

## [2026-07-09] UX: Deployment dialog bëhet platform-aware (Windows byte-identik)

### Konteksti / Vendimi
Kompletim UX i dialogut ekzistues të Deployment (jo feature i ri, jo faqe e re).
Dialogu i token-it (Deployment ▸ View) u bë **platform-aware, metadata-driven**,
i gated nga flamujt e Platform Expansion. **Një token i vetëm ndahet nga të gjitha
platformat** (nxjerrur nga i njëjti Windows bootstrap URL) → rigjenerimi përditëson
të gjitha, pa deploy të dyfishtë.

### Zgjidhja
- **Windows: BYTE-IDENTIK** — të njëjtat CommandBlocks (Safe one-time / GPO Startup /
  GPO Scheduled Task / Bootstrap URL), të njëjtat Copy targets, i njëjti Download PS1.
  Asnjë skript/endpoint/workflow Windows i prekur. **Zero ndryshime backend.**
- **Linux** (`FEATURE_LINUX`, Experimental): One-Time Install (`curl … | sudo bash`),
  Manual URL, arkitekturat (amd64/arm64/armhf), paketa Linux aktive.
- **macOS / MikroTik / Synology / QNAP / VMware / Hyper-V / Proxmox**: placeholder-a
  UI të rezervuar (Coming soon + metoda të planifikuara), gated nga
  `FEATURE_MACOS`/`FEATURE_MIKROTIK`/`FEATURE_STORAGE`/`FEATURE_HYPERVISOR`.
- Regjistër i vetëm `DEPLOYMENT_PLATFORMS` në frontend, i gated nga flamujt e backend-it;
  shtimi i një platforme = një hyrje + ikonë, pa rishkrim UI.

### Ndryshimet
- `frontend/src/pages/Deployment.tsx` (DeploymentModal → metadata-driven + PlatformSection)
- `frontend/src/api/enrollmentBootstrap.ts` (buildLinuxInstallUrl/Command, tokenFromBootstrapUrl)
- `docs/reference/OPERATOR-MANUAL.md` (§8a + matrica e statuseve)
- Commit `6fa72c7`.

### Rezultati
tsc + build OK; preflight PASSED (suite 472+4 baseline, flags OFF & ON); smoke 7/7.
Windows byte-identik; token i përbashkët Windows+Linux; responsive + dark/light
(përdor tokenat ekzistues `--th-*`). Deployed (frontend), prod tip `6fa72c7`.

### Mësimet
Zgjerimi metadata-driven i një dialogu ekzistues e mban Windows-in sacred: platformat
e reja janë të dhëna, jo degë kodi. Shih [[platform-v3-design]].

## [2026-07-09] BUG: Zinxhiri i paketës Linux jofunksional (upload→lookup→download→install)

### Problemi
Gjatë përgatitjes së provës së parë Linux (server 3CX mbi Debian), ngarkimi i binarit
Linux dështoi me "Unsupported package file extension". Hetimi zbuloi se e gjithë rruga
e paketimit Linux e Fazës 2 kishte shkuar **dark** dhe s'ishte ekzekutuar kurrë
end-to-end (0 ngarkime Linux ndonjëherë).

### Shkaku (tre boshllëqe, vetëm Linux)
1. **Upload**: `ALLOWED_EXTENSIONS` s'kishte tip për binar raw → refuzonte binarin Linux.
2. **Public download**: `PUBLIC_DOWNLOAD_PLATFORMS` s'përfshinte `linux-*` → **400**.
3. **Zgjidhja e paketës**: download-i publik kishte `file_type="msi"` hardcoded → një
   `agent_binary` Linux jepte **404**.
Instaluesi ([install.py]) shkruan binar RAW + `chmod +x`, pra pret binar të papaketuar.

### Zgjidhja (më e vogla; Windows byte-identik)
- `ALLOWED_EXTENSIONS += ".bin"` (konventë për binar raw; shërbehet si-është).
- `PUBLIC_DOWNLOAD_PLATFORMS += linux-amd64/arm64/armhf`.
- `/platform/{platform}/download`: dega `linux-*` → `file_type=agent_binary`
  (me fallback te çdo aktiv i platformës); **dega Windows e pandryshuar**
  (`latest_active(platform, file_type="msi")`) → MSI bootstrap / GPO / self-update PREKUR ASPAK.
- `install.py`: `armv7l|armv6l|armhf → armhf` që `linux-armhf` të jetë i arritshëm.

### Ndryshimet
- `backend/app/services/agent_package_service.py` (ALLOWED_EXTENSIONS)
- `backend/app/api/v1/endpoints/agent_packages.py` (PUBLIC_DOWNLOAD_PLATFORMS + resolution)
- `backend/app/api/v1/endpoints/install.py` (arch armhf)
- `backend/tests/test_agent_package_public_download.py` (Linux + platformë e paskualifikuar e re)
- `backend/tests/test_agent_package_upload_linux.py` (i ri)
- Commit `c80a621`.

### Rezultati (provë prodhimi live)
- Contract 13/13; suite 472+4 baseline (flags OFF & ON); tsc/build/agent OK; smoke 7/7.
- Live: `linux-amd64` → **404** (i arritshëm; ishte 400), `freebsd-amd64` → **400**
  (ende i paskualifikuar), `windows-amd64` → **200** (MSI i pandryshuar).
- Prod tip `c80a621`. Artefakti i parë `linux-amd64` gati: `techi-agent-linux-amd64.bin`.

### Mësimet
Një rrugë e dërguar "dark" nuk është e provuar derisa të ekzekutohet end-to-end me
artefakt real. Ndryshimet e zgjeruara (Linux) duhet të ndajnë degën nga Windows që
sjellja referencë të mbetet byte-identike. Shih [[platform-v3-design]].

## [2026-07-08] BUG: Device Tree click nuk sinkronizohej me Device Catalog (cache key i frontend-it)

### Problemi
Klikimi i një nyje Client/Servers/Client PC/Platform ndonjëherë nuk rifreskonte
Catalog-un (mbetej rezultati i mëparshëm / All Devices); "Refresh List" e rregullonte
menjëherë; disa klientë punonin, të tjerë kërkonin refresh manual.

### Analiza / Shkaku (NUK është motori i klasifikimit)
Backend-i kthen të dhëna korrekte. Regresioni është te çelësi i cache-it SWR në
frontend: `deviceTableCacheKey` (`src/store/appCache.ts`) përfshinte `smart_folder`
por JO `category`/`platform`. Kur fix-i i pemës `e08544d` i kaloi nyjet e pemës në
filtrat `category`/`platform`, ky allow-list nuk u përditësua. Dy përzgjedhje brenda
të njëjtit klient (Servers vs Client PC, ose një nën-folder platforme) prodhonin
çelës IDENTIK → `loadTableData` gjente një hyrje "fresh" përplasëse dhe kthehej herët
(**0 kërkesa API**), pra Catalog mbante rreshtat e vjetër derisa "Refresh" bënte
`invalidatePrefix("devices-table")` → refetch i detyruar. Riprodhuar: `client-4-servers`,
`client-4-clientpc`, `client-4-servers-windows` → i njëjti çelës `devices-table|1|50||||||4||||`.

### Zgjidhja (fiksi më i vogël)
Shto `category` + `platform` te `deviceTableCacheKey`. Çdo përzgjedhje pemë → çelës
unik → saktësisht një kërkesë për klik → Catalog përditësohet automatikisht. Motori
i klasifikimit i paprekur (u vërtetua se s'ishte shkaku).

### Ndryshimet
- `frontend/src/store/appCache.ts` — `deviceTableCacheKey` (+category, +platform)
- Commit `dd976af`.

### Rezultati
Çelësat tani distinktë (verifikuar për client/servers/clientpc/servers+windows).
Contract 13/13; suite 463+4 baseline; tsc + build OK; smoke 7/7. Deployed (frontend).

### Mësimet
Një çelës cache-i SWR duhet të përmbajë ÇDO fushë që ndikon kërkesën. Allow-list-et
statike divergjojnë kur ndryshojnë filtrat — kjo është e njëjta klasë me divergjencën
C1–C4. Rrezik i mbetur (i dokumentuar, jashtë këtij regresioni): `device_type` dhe
`assignment_source` (FilterSheet mobF) gjithashtu mungojnë te çelësi. Shih [[platform-v3-design]].

## [2026-07-08] ARKITEKTURË: Unified Classification Engine (një motor, zëvendëson C1–C4)

### Konteksti
Audit i klasifikimit (`docs/reference/CLASSIFICATION-ARCHITECTURE-REVIEW.md`) zbuloi
**katër** klasifikues kategorish të dublikuar që divergonin në skajet: C1 resolution
(`_category_from_group`/`_category_from_os`), C2 smart_folder, C3 tree-case
(`_tree_category_case`), C4 write-time (`_detect_group`/`detect_group_name`). Owner-i
urdhëroi NJË motor të ri (jo të kurorëzohej ndonjë nga bug-et ekzistuese).

### Vendimi / Zgjidhja
`app/platform_core/classification.py`: NJË tabelë e renditur rregullash + NJË set
konstantesh, e renderuar në dy mënyra nga i njëjti burim — SQL (`category_case()`,
`platform_case()`) dhe in-memory (`classify_category()`, `classify_platform()`).
Precedencë e kategorisë: (1) grup standard DB → servers/clientpc, (2) platformë
non-agent → network/storage/hypervisors, (3) heuristikë OS → servers, (4) grup custom
→ **other**, default clientpc. Kategoria është e pavarur nga pronësia; kova
"Unassigned" mbetet koncept i boshtit Client (client_id), jo kategori.
Owner decisions: **D1** other-folder e re (aditive), **D2** ruaj çelësat
`windows_server`/`windows_workstation` (implementim përmes motorit).

### Rollout (5 faza, secila contract+preflight+smoke, deploy)
- **P1** `4559a64` — motor + parity test (~2800 rreshta matricë: SQL==in-memory) + golden Windows/non-agent. Dead code.
- **P2** `2137119` — migrimi i konsumatorëve SQL (tree counts, overview, category/platform/smart_folder filters). **Provë live: counts byte-identike për të 28 klientët.**
- **P3** `26c84a8` — migrimi i konsumatorëve in-memory (resolution/Drawer, write-time placement). **Provë live: resolved_device_category identik për të 723 pajisjet.**
- **P4** `864cf8f` — folder "Other" në Device Tree (shfaqet vetëm kur jo bosh, si Network/Storage).
- **P5** `d543b70` — fshirja e C1–C4 + guard në preflight.sh (simbolet e vjetra s'kthehen dot jashtë motorit).

### Rezultati
Prod tip `d543b70`. Contract 13/13; suite 463+4 baseline (flags OFF & ON); tsc + build
+ agent OK; smoke 7/7. Fleti (723 pajisje, 0 grupe custom) → sjellje BYTE-IDENTIKE;
`other` është vetëm future-proofing. Tani: **Tree badges == catalog filters == overview
== Drawer**, të garantuara nga parity test-i + preflight guard.

### Mësimet
Kur e njëjta pyetje ("çfarë kategorie?") implementohet në >1 vend, kopjet divergojnë.
Zgjidhja s'është të zgjedhësh një kopje, por një motor të vetëm i renderuar në SQL +
Python me një test parity që i mban të pandashme. Klasifikimi ≠ pronësia (Client axis).
Shih [[platform-v3-design]].

## [2026-07-08] BUG: Heartbeat mund të prishte një caktim manual kur ndryshonte device_type

### Problemi
Invariant i pronarit: heartbeat/re-enrollment nuk duhet KURRË të prishë një caktim
manual. Por blloku i ri-grupimit në heartbeat aktivizohej sa herë ndryshonte
`device_type` (p.sh. CLIENT→SERVER) dhe e detyronte `assignment_source=trusted_domain`,
duke mposkaluar mbrojtjen manuale te `reconcile` → pajisja e vendosur manualisht
ri-grupohej sipas domain-it.

### Shkaku
Blloku `if device.device_type != device_type ...` (device_heartbeat_service.py) fshinte
`client_id/group_id/assignment_source/auto_assigned` dhe mbishkruante burimin në
`trusted_domain` PA kontrolluar nëse burimi ishte manual. Gjithashtu bllojtë e ruajtjes
listonin burimet me dorë në 3 vende të ndryshme, jo konsistentë (reuse-path i mungonte
`legacy_manual`).

### Zgjidhja (fiks i vogël, PR i veçantë)
- `DeviceAssignmentService.is_manual_locked()` — burim i vetëm i së vërtetës për
  "lock"-un (manual / legacy_manual / enrollment_token; trusted_domain MBETET auto).
- Blloku i ri-grupimit në device_type-flip tani është i gated me `not manual_locked`.
- `reconcile_trusted_domain_assignment` dhe reuse-path guard kalojnë të njëjtin predikat.

### Ndryshimet
- `backend/app/services/device_assignment_service.py` — `MANUAL_LOCK_SOURCES` + `is_manual_locked`
- `backend/app/services/device_heartbeat_service.py` — dy bllojtë e ruajtjes + flip guard
- `backend/tests/test_heartbeat_manual_lock.py` — test i predikatit + test real me SQLite
  që `process_heartbeat_core` ruan client/group/source kur device_type kthehet në SERVER.
- Commit `96020cd`.

### Rezultati
Contract 13/13; suite 460+4 baseline (flags OFF & ON); tsc + build + agent OK; smoke 7/7.
Deployed në prod (tip `96020cd`).

### Mësimet
Një invariant duhet të ketë NJË përkufizim të vetëm. Tri kopje inline të "manual set"
divergjuan (njëra harroi `legacy_manual`). Tani ekziston `is_manual_locked()` i vetëm —
lidhet me punën e ardhshme të Unified Classification Engine ([[platform-v3-design]]).

## [2026-07-08] BUG: Tree filtering jo-kumulativ — Client→Servers→Windows kthente TË GJITHA Windows-at

### Problemi
Në Device Tree, hierarkia `Client → Servers → Windows` injoronte filtrin prind:
kthente të gjitha pajisjet Windows të klientit, jo vetëm Windows Server-at. Pritej
filtër kumulativ: **Client AND Device Category AND Platform** — çdo nyje duhet të
trashëgojë të gjithë filtrat e prindit.

### Analiza
Numëruesi i badge-it të pemës (`count_by_client_category_platform`) klasifikon një
server me `_tree_category_case()`: `device_type==SERVER` **OSE**
`windows_product_type in (2,3)` **OSE** os caption ilike "windows server". Por
filtri i leaf-it (frontend `handleTreeSelect`) dërgonte `device_type=server +
platform=windows`. Serverat e identifikuar VETËM nga product-type (me
`device_type=UNASSIGNED`) numëroheshin te Servers por përjashtoheshin nga filtri.
Provë me të dhëna reale: Agroblend0 (cid=4) badge Servers.Windows=3, filtër i vjetër=1;
Eugreen (cid=24) 3 vs 2.

### Shkaku
Dy klasifikime të ndryshme për të njëjtën nyje: numëruesi përdorte
`_tree_category_case()`, filtri përdorte `device_type`. Prandaj rezultati i filtruar
≠ numri i badge-it.

### Zgjidhja (fiksi më i vogël, pa ridizajn)
- Backend `_apply_category_filter`: `category=servers/clientpc` tani ripërdor
  `_tree_category_case() == cat` (me `outerjoin(DeviceGroup)` që të shohë
  vendosjen sipas emrit të grupit) — i njëjti klasifikim si numëruesi.
- Frontend `Devices.tsx handleTreeSelect`: nyja leaf dhe parent dërgojnë tani
  `category + platform` në vend të `device_type + platform`. Çdo nyje trashëgon
  client + category + platform.

### Ndryshimet
- `backend/app/repositories/device_repository.py` — `_apply_category_filter`
- `frontend/src/pages/Devices.tsx` — `handleTreeSelect`
- `backend/tests/test_tree_platform_aggregation.py` — test regresioni: filtri ==
  numëruesi për rastin server-nga-product-type + provë `get_multi` pa dyfishim rreshtash.
- Commit `e08544d`, branch `stable/phase-2-heartbeat`.

### Rezultati
- Contract tests 13/13; suite 458 pass + 4 baseline (flags OFF & ON); tsc + build
  + agent OK (preflight ✅). Smoke 7/7 (asnjë 500).
- **Provë live në PostgreSQL prod**: për të 28 klientët me pajisje Windows,
  `filter(category, platform)` == badge i pemës, **0 mospërputhje**.
- `get_multi` verifikuar pa dyfishim rreshtash nga `outerjoin` + `joinedload`.

### Mësimet
Kur një badge numërimi dhe filtri i tij vijnë nga dy klasifikime të ndryshme, do
të divergjojnë. Nyja e pemës dhe numëruesi i saj DUHET të ndajnë të njëjtin funksion
klasifikimi. `_tree_category_case()` është burimi i vetëm i së vërtetës për
servers/clientpc — filtri s'duhet të riimplementojë logjikën me `device_type`.

## [2026-07-08] LIVE VALIDATION: u ndezën 4 feature flags në prodhim (CORE+LINUX+VAULT+MIKROTIK)

### Vendimi

Pas Operator Manual-it, owner-i aprovoi ndezjen e setit të rekomanduar për
validim live. **U ndezën VETËM 4**: `FEATURE_PLATFORM_CORE`, `FEATURE_LINUX`,
`FEATURE_VAULT`, `FEATURE_MIKROTIK`. Mbetën OFF: `FEATURE_TERMINAL` (kërkon
rrugën NPM WS — jo e bërë), `FEATURE_STORAGE`, `FEATURE_HYPERVISOR`. (Shënim:
emri real i flag-ut është `FEATURE_PLATFORM_CORE`, jo `FEATURE_CORE`.)

### Ndryshimet (pa kod)

Backend-i i merr flags nga `env_file: .env` (`/root/.env`, injektuar si env i
kontejnerit). Hapat: (1) backup `/root/.env` → `/root/.env.bak-2026-07-08`;
(2) shtuar 4 rreshtat `FEATURE_*=true`; (3) `docker compose -p techi-platform
up -d backend` — **vetëm backend** (frontend-i i lexon flags nga
`/platform/features` në runtime, s'kërkon rebuild). Zero ndryshim kodi.

### Verifikimi

- **Flags në backend-in që xhiron**: CORE/LINUX/VAULT/MIKROTIK = True
  (`feature_enabled` = True, varësitë e plotësuara); TERMINAL/STORAGE/HYPERVISOR
  = False.
- **Provë flag-on**: `GET /install/linux?token=test` → **200** (ishte 404 me
  flag off); `/connect-methods` dhe `/vault` → **401** (auth, jo më 404 —
  endpoint-et të arritshme).
- **Kod paths në kontejner**: Platform Registry 8; MikroTik adapter proxy;
  Connect(mikrotik+terminal)=[winbox,webfig,ssh,web_terminal]; Connect(windows)=
  [remote_support]; Vault list []; Catalog get_devices → 723 total.
- **smoke.sh**: 7/7 OK (health 200, të tjerat 401, 0×500).
- **preflight.sh** (kod): 457 passed + 4 të njohura (flags OFF & ON), tsc,
  frontend build, agent go build/test — **PASSED**.
- Post-ndezje: 0 gabime reale, ~115 hb/min, backend healthy.

### Prodhimi tani

**NUK është më bit-identik me Windows RMM klasik** — sipërfaqet Linux (katalog
ikona, tree sub-folders, one-liner, packages tab, drawer capabilities, Command
Center Run Command), Connect Framework (dropdown), dhe Credential Vault janë
tani të dukshme për operatorët. MikroTik: klasifikim + connect metadata (adapter
framework; RouterOS API/launchers = fazë tjetër). Windows sjellja bazë e
pandryshuar.

### Rollback

`cp /root/.env.bak-2026-07-08 /root/.env && docker compose -p techi-platform up
-d backend` → kthen të gjitha flags OFF (prodhim bit-identik me para).

## [2026-07-08] Production Validation window — FILLIM (feature-t në pauzë)

### Vendimi

Owner-i pauzoi çdo punë feature. Hyjmë në dritaren **Production Stabilization /
Validation** (24–48h): asnjë fazë e re, vetëm bug fixes prodhimi me verifikim të
plotë (root cause → fix vetëm atë bug → contract+regression+preflight+smoke →
deploy → vazhdo dritaren). Zero scope creep. Roadmap vazhdon VETËM me
konfirmimin e owner-it për stabilitet.

### Baseline i shëndetit të prodhimit (fillim dritareje, prod tip `3cdcc82`)

- Të 8 FEATURE_* flags **OFF** (prodhimi = sjellje para-expansion, bit-identike).
- 723 pajisje (603 online); 605 aktive/5min; **141.6 heartbeats/min** (~605 @ 250s).
- **0 gabime reale** në 30 min; të gjithë kontejnerët healthy; smoke **7/7**.
- DB 2010 MB, retention 7-ditor i shëndetshëm (heartbeat më i vjetër 2026-07-01).
- Disk 70% (16/25 GB); backend mem 31% (247/800 MB).

### Statusi

Dritarja e hapur. Vëzhgimet, bug-et (nëse ka) dhe raporti final do të shtohen
këtu gjatë/në fund të dritares.

## [2026-07-08] Hardening: Deployment Contract Verification (contract tests + preflight + smoke)

### Problemi

Pas regresionit të katalogut (shërbimi forward-oi një param që repository s'e
kishte), duhej një mekanizëm permanent që kap mismatch-et service↔repository
PARA deploy-it, dhe një smoke pas deploy-it.

### Zgjidhja

- **Contract tests** (`tests/test_service_repository_contracts.py`): dy shtresa —
  (1) signature contract (DB-free): kwargs që shërbimi forward-on ⊆ params që
  repository pranon (kap ekzaktësisht regresionin `category`); (2) end-to-end:
  çdo shërbim publik instancohet dhe metoda read ekzekutohet deri në SQL.
  Mbulon DeviceService, DeviceOverviewService, VaultService,
  EnrollmentTokenService, TerminalService, ConnectService, AgentPackageService,
  RemoteActionService. Plus `test_device_service_filter_contract.py`.
- **`scripts/preflight.sh`** (gate para push/deploy): contract tests (zero
  tolerancë) + suita e plotë flags OFF & ON (pa dështime të reja mbi baseline
  4) + tsc + frontend build + agent go build/test. Del non-zero në çdo dështim.
  Detekton edhe collection errors dhe "collected no tests" (një version i parë
  kishte false-pass kur pytest gabonte importin — u rregullua me `cd backend` +
  numërim passed/failed/errors).
- **`scripts/smoke.sh`** (pas deploy-it): `/health`, `/api/v1/devices/`,
  `/platform/features`, `/auth/me`, `/devices/overview`, `/enrollment-tokens`,
  `/agent-packages`. 500 kudo = deployment FAILED.
- Milestone permanent "Deployment Contract Verification" te IMPLEMENTATION-
  ROADMAP.md; hapi 0 i Deploy Process te PROJECT_STATE.

### Rezultati

`preflight.sh`: **13 contract passed** + suita 457 passed + 4 të njohura (flags
OFF & ON) + tsc + build + agent — **PASSED**. Provuar që gate-i punon: kapi një
flakiness izolimi (overview cache modul-nivel) gjatë ndërtimit dhe u rregullua.
`smoke.sh` kundër prodhimit: 7/7 endpoints OK (health 200, të tjerat 401, zero
500). Të dy skriptet dalin non-zero në dështim → ndalojnë deploy-in/e shënojnë
FAILED.

### Mësimet

Testet duhet të ekzekutojnë kontratën publike (shërbimin), jo vetëm repository-n.
Një gate deploy-i që parse-on output pytest duhet të kontrollojë passed>0 +
errors==0 + failed≤baseline (përndryshe një import error jep false-pass).

## [2026-07-08] INCIDENT: Device Catalog 500 — commit i paplotë hoqi `category` nga repository

### Problemi

Device Catalog nuk ngarkohej: "Unable to load devices / Failed to fetch". Çdo
`GET /api/v1/devices/` kthente 500. Release blocker — path-i SACRED i katalogut
Windows i prishur pa kushte (pavarësisht flags).

### Analiza (frontend → API → endpoint → service → repository → SQL)

Logu i backend-it dha shkakun ekzakt:
```
File "/app/app/services/device_service.py", line 68, in get_devices
    devices = self.repository.get_multi(
TypeError: DeviceRepository.get_multi() got an unexpected keyword argument 'category'
```
`git status`: `device_repository.py` i modifikuar por **i pa-commit-uar** (5
referenca `category` në working tree, 0 në HEAD). `device_service.py` (që i
kalon `category=category`) ishte commit-uar dhe deployuar; `device_repository.py`
(që e pranon) JO. "Failed to fetch" në browser = 500-i pa header-at e duhur në
rrugën e gabimit.

### Shkaku

Commit-i **`c042724`** ("feat: tree Network/Storage/Hypervisor folders +
ConnectMenu", Phase 7 M3-M4) përfshiu `device_service.py` (forward i `category`)
por harroi `git add backend/app/repositories/device_repository.py`. Testet
lokale kaluan sepse working tree e kishte fix-in; prodhimi mori vetëm gjysmën.

### Zgjidhja

Commit i ndryshimit të tashmë-shkruar te repository (`_apply_category_filter` +
parametri `category` te `get_multi`/`count`) — pa ndryshim sjelljeje, vetëm
plotëson kontratën service→repository. Fajl: `device_repository.py` (+22),
`tests/test_device_service_filter_contract.py` (i ri).

### Rezultati

Deploy prod tip `2dae09a` (vetëm backend). health 200; `/api/v1/devices/` → 401
(auth), JO 500; 0 `get_multi` TypeErrors; 0 gabime reale. Validim end-to-end
kundër DB-së reale në kontejner: `DeviceService.get_devices(limit=20)` → 20
rreshta, total 723 pajisje, windows 723, network 0. **Katalogu i rikthyer.**

### Testet e regresionit

`test_device_service_filter_contract.py` ekzekuton **shërbimin** (jo repository-n
drejtpërdrejt) me të gjithë `filter_kwargs` e endpoint-it (incl. platform+
category) — **verifikuar që DËSHTON kundër repository-t të deployuar (të prishur)
me TypeError-in ekzakt të prodhimit** (via git stash), dhe kalon me fix-in. Ky
lloc mismatch (shërbimi forward-on një kwarg që repository s'e ka) tani kapet.

### Mësimet

`git add` selektiv për ndryshime multi-file është i rrezikshëm — një commit që
prek service+repository duhet t'i përfshijë të dyja. Testet duhet të ekzekutojnë
**shërbimin** (kontrata publike), jo vetëm repository-n, që mismatch-et
service→repository të kapen para deploy-it. Deploy-i i backend-it duhet të bëjë
një smoke të `/devices/` me auth (jo vetëm `/health`).

## [2026-07-08] Platform Expansion Phase 7 — MikroTik Proxy Adapter + Connect Framework (DARK)

### Problemi

Të provohet se Platform Expansion mbështet platformat pa-agent me të njëjtën
arkitekturë: Linux = platforma e parë native, MikroTik = e para proxy-managed.
Të ndërtohet **Connect Framework** gjenerik (metadata capability-driven), pa
launchers, pa RouterOS API/SSH/credentials (ato janë faza tjetër). Flag OFF =
identik.

### Zgjidhja (deploy prod tip `7df3cba`, të gjitha flags OFF)

- **Connect Framework** (`platform_core/connect.py`): metadata e strukturuar
  `ConnectMethod` (id, label, surface desktop/browser, capability, priority,
  scheme) per platformë; `methods_for(device)` = metoda native (capability
  None) + gjenerike ku pajisja raporton capability-n. **SSH/Web Terminal
  varen nga capability `terminal`** → SSH gjenerik, jo Linux-only; Winbox/
  WebFig/DSM/QTS/vSphere janë thjesht metoda native, jo feature speciale.
  `GET /devices/{id}/connect-methods` (gated CORE→404) ndërton dropdown-in
  dinamikisht. Frontend `ConnectMenu` — dropdown 100% nga metadata; launcher-at
  vijnë fazën tjetër (klikimi shfaq metadata, jo veprim fiktiv). 10 teste.
- **MikroTik proxy adapter** (`platform_adapters/mikrotik.py`, `is_proxy=True`)
  i regjistruar — provon kontratën adapter platform-neutrale (pa RouterOS API).
- **Auto-classification**: `_tree_category_case` klasifikon platformat pa-agent
  me platform-class FIRST (network/storage/hypervisors); platformat agent mbajnë
  logjikën referencë servers/clientpc. Filtër i ri aditiv `category`
  (network/storage/hypervisors). Tree: foldera Network/Storage/Hypervisors +
  nën-foldera platforme, shfaqen vetëm kur kanë pajisje → flag-off tree identik.
  Vendosje automatike (MikroTik→Network→MikroTik), zero lëvizje manuale.

### Rezultati

Suita backend **444 passed + 4 të njohura, flag OFF DHE ON**; agent 4 targetet;
tsc + build clean. Deploy: health 200, frontend 200, connect-methods 401 pa
auth (404 me auth+flag off), FEATURE_MIKROTIK+CORE False, adapter i ngarkuar,
0 gabime reale, 131 hb/min. Sjellja e prodhimit e paprekur.

### Objektivi arkitekturor — arritur

Shtimi i një platforme të re tani kërkon VETËM: (1) Platform Adapter, (2)
Capability Mapping, (3) Platform Icon, (4) Connect Methods (rreshta te
`connect.py` + `_platform_class_case`). PA ndryshim te Device Tree/Catalog/
Drawer/Command Center/Navigation. Synology/QNAP/VMware/Proxmox/Hyper-V tashmë
kanë connect-methods të deklaruara + klasifikim; u mbetet vetëm adapter-i.

### Boundary — çfarë NUK u implementua (faza tjetër)

Winbox/WebFig launcher, RouterOS API, SSH, credential management, terminal
integration. Phase 7 ndërtoi vetëm framework-un ku këto plug-in pa ridizajn.

## [2026-07-08] Platform Expansion Phase 5 — Web Terminal (implementim DARK, pa NPM, pa flag)

### Problemi

Të ndërtohet i gjithë Web Terminal-i pas `FEATURE_TERMINAL` (OFF), pa prekur
NPM, pa ekspozuar rrugë publike, pa canary. Arkitekturë platform-independent:
Linux i pari, platformat e ardhshme ripërdorin të njëjtën. Flow: Browser →
Backend → Agent WS → PTY → Shell.

### Zgjidhja (5 milestone, prod tip `991ae07`, FEATURE_TERMINAL OFF)

- **M1 backend model+service**: `TerminalSession` (tabelë e izoluar) +
  `TerminalService` (create→attach→active→close/expire) me dy tickets një-
  përdorimshe të hash-uara (operator+agent, side-specific, TTL 60s), idle/max
  caps, `recording_path` i përgatitur por i papërdorur. 6 teste.
- **M2 backend endpoint+relay**: `POST /devices/{id}/terminal/sessions` (admin+,
  gated → 404; kontrollon capability `terminal`; krijon sesion; radhit
  `open_terminal` remote action; audit; kthen operator WS path + ticket).
  `TerminalRelay` in-memory çift operator↔agent; rrugët WS `/ws/terminal/{id}`
  + `/ws/agent/terminal/{id}` (accept+close 4003 kur flag off). 4 teste.
- **M3 agent (Linux)**: dispatch `open_terminal` → `handleOpenTerminal` dial WS
  (gorilla/websocket) + PTY (creack/pty) bash/sh, relay binar + resize + cap 60
  min. Goroutine e izoluar — s'prek heartbeat/enrollment/inventory/update/
  RustDesk. Deps importohen vetëm në files linux → Windows/darwin të paprekur.
  Windows/other stub. 4 targetet ndërtohen.
- **M4 frontend**: `DeviceTerminal` (xterm.js + fit, lazy) — session→operator WS
  →relay+resize. Tab "Terminal" te Drawer VETËM kur FEATURE_TERMINAL on DHE
  pajisja raporton capability `terminal`. xterm në chunk të veçantë (293KB, jo
  në main path). Windows s'ka terminal cap → tab s'shfaqet → drawer identik.

### Siguria

Sesione: authenticated (JWT admin+), authorized (device scope), audited,
time-limited (TTL 60s ticket, cap 60 min, idle 15 min), tickets një-përdorimshe
side-specific të hash-uara, zero sekret në browser. E ndarë nga Remote Support
(RustDesk). E gatshme për integrim me Vault (SSH-mode i ardhshëm).

### Rezultati

Suita backend **434 passed + 4 të njohura, flag OFF DHE ON**; agent 4 targetet +
go test green; tsc + build clean (xterm code-split). SQL `terminal_sessions`
aplikuar schema-first. Deploy: health 200, frontend 200, terminal endpoint 401
pa auth (i mbrojtur; 404 me auth + flag off), **FEATURE_TERMINAL False**, 0
gabime reale, 142 hb/min. Sjellja e prodhimit e paprekur.

### STOP — mbeten VETËM (Manual Approval)

(1) shtimi i rrugës WS në NPM (`/ws/terminal/*`, `/ws/agent/terminal/*`),
(2) ndezja e `FEATURE_TERMINAL` për canary. Të dyja presin aprovimin eksplicit
të owner-it — NUK u prekën.

### Mësimet

Sinjali "hap terminal" ripërdor rrugën ekzistuese `pending_actions` (pa lidhje
persistente të re per-pajisje) → latencë deri në një heartbeat (250s) për të
nisur; e pranueshme dark, por para canary-t vlen një sinjal më i shpejtë ose
interval më i ulët për pajisjet me terminal aktiv. Relay-i in-memory është
per-worker — nëse terminali ndizet në shkallë të gjerë, ky komponent lëviz
out-of-process (audit R5), pa ndryshuar protokollin.

## [2026-07-07] Platform Expansion Phase 3 (pjesa 2, PËRFUNDIM) — tree auto-classification + Command Center engine

### Problemi

Të përfundohet Faza 3: (1) Device Tree me sub-foldera platforme me **klasifikim
automatik** (asnjë vendosje manuale), (2) Command Center i vetëm me **engine
automatik** (Windows→PowerShell, Linux→Bash). Flag OFF = identik.

### Zgjidhja (deploy prod tip `dfd601b`)

**Tree auto-classification (3e):**
- Backend: `_platform_class_case()` — klasifikim i centralizuar platforme (NULL⇒
  windows, audit §8) + `count_by_client_category_platform()` — agregim i veçantë
  i lehtë GROUP BY, që **NUK prek** path-in e nxehtë 2-query të overview-t.
  `DeviceTreeCounts.by_client_category_platform` llogaritet **vetëm kur
  FEATURE_LINUX on** → overview mbetet 2 query në prodhimin e sotëm (testi ende
  `==2`, i fiksuar në flag-off).
- Frontend: DeviceTree rendon sub-foldera platforme (PlatformIcon) nën Servers/
  Client PC kur `showPlatformFolders`; Devices mapon `client-N-servers-linux` →
  filtër device_type+platform. Klasifikim automatik nga OS/device_type — asnjë
  lëvizje manuale. Flag off ⇒ tree identik (backend kthen {}).

**Command Center engine (3c):**
- Agent: dispatch case i ri `run_command` + `handleRunCommand` (Linux real:
  bash/sh/busybox/python3 via runLinuxCommand; Windows/other stub — Windows
  përdor run_powershell, s'merr kurrë run_command). Ndërton të 4 targetet.
- Backend: `run_command` në BULK_COMMAND_TYPES + ADMIN_ONLY; payload
  {command,engine} kalon si pending action (pa ndryshim shërbimi).
- Frontend: command type `run_command` + PayloadEditor (engine select + script),
  i dukshëm **vetëm kur FEATURE_LINUX on** → Command Center flag-off identik.

### Rezultati

Suita backend **424 passed + 4 të njohura, flag off DHE on** (testet e
invariantit 2-query të overview-t fiksuar në flag-off). Agent: 4 targetet
ndërtohen, go test green. tsc + build clean. Deploy: health 200, frontend 200,
0 gabime reale; heartbeats ~98/min (400 pajisje aktive @ 250s — konsistente),
FEATURE_LINUX False verifikuar. **Faza 3 e plotë.**

### Shtimi i një platforme të ardhshme kërkon tani vetëm

(1) një degë te `_platform_class_case`, (2) një adapter backend + capability
mapping, (3) një etiketë + hyrje te `PlatformIcon`. Asnjë ridizajn UI.

### Mësimet

Invariantet e performancës (overview 2-query) shprehen si garanci flag-OFF:
puna e re shtesë gate-ohet nga flag-u, dhe testet fiksohen në flag-off që të
dokumentojnë prodhimin e sotëm pa u prishur nga env-i.

## [2026-07-07] Platform Expansion Phase 3 (pjesa 1) — UI Linux native (flag-gated)

### Problemi

Të bëhet Linux "native" në Desktop UI ekzistuese, pa ridizajn, pa faqe të reja,
me flag OFF = UI identik me sot. Çdo komponent duhet të mbështesë platformat e
ardhshme pa ridizajn.

### Zgjidhja (deploy prod tip `5212753`, të gjitha pas FEATURE_LINUX OFF)

- **PlatformIcon** (`components/PlatformIcon.tsx`): burim i vetëm ikonash
  (Windows/Linux/MikroTik/generic, SVG inline). Në katalog para emrit, vetëm kur
  FEATURE_LINUX on; flag off → markup origjinal verbatim.
- **Packages**: toggle Windows|Linux (vetëm flag on) → `LinuxPackagesPanel`
  (upload/list/activate/delete `agent_binary` per arch: amd64/arm64/armhf).
  Windows scope i paprekur. Backend enum + arch të reja; të ardhmet = config.
- **Enrollment**: opsioni Linux gjeneron one-liner-in real
  `curl … /api/v1/install/linux?token=… | sudo bash` (flag on); flag off → script
  legacy.
- **Device Drawer**: Overview shton Kernel, Architecture dhe rreshtin
  Capabilities (chips) — të dhëna reale nga agjenti, vetëm flag on + kur pajisja
  raporton; Windows kurrë s'raporton → drawer Windows identik. Backend Device
  schema kthen `capabilities`.
- **Platform filter** (themel): devices list/count + repository marrin filtër
  opsional `platform` (`_apply_platform_filter`); "windows" përfshin edhe
  rreshtat legacy me platform NULL (audit §8). Aditiv/inert kur i pasetuar.

### Rezultati

Suita backend 422 passed + 4 të njohura (flag off **dhe** on); tsc + build
clean. Deploy: health 200, frontend 200, `/api/v1/devices?platform=linux` → 401
(auth, filtri i lidhur), 186 hb/min, 0 gabime reale. Flags OFF → UI identik.

### Mbetet për Fazën 3 (pjesa 2)

(1) **Device Tree platform sub-folders** — kërkon zgjerim të agregimit
`get_overview_inputs` (GROUP BY + platform) në një path të nxehtë + trajtim
key-i te Devices.tsx; u shty për të mos rrezikuar navigimin SACRED Windows pa
verifikim vizual. Themeli (filtri platform) është gati.
(2) **Command Center platform-aware execution** — kërkon një action type të ri
`run_command` (engine bash/sh/python) end-to-end agent+backend+frontend.

### Mësimet

Tree merr `tableDevices` (faqja aktuale, jo flota) → numëratorët e sub-folderave
duhen nga backend, jo client-side. Çdo sipërfaqe e re UI u ndërtua flag-gated me
degë të veçantë "windows" të pandryshuar.

## [2026-07-07] Platform Expansion Phase 2 — Linux Agent MVP (flag-gated, Windows bit-identik në sjellje)

### Problemi

Agjenti i parë native jo-Windows: enroll → heartbeat → inventory → actions →
self-update → systemd, me të njëjtën kontratë si Windows, pa prekur sjelljen
Windows. Autorizuar pas shpalljes zyrtare të owner-it që rollout-i 2.1.5 është
i mbyllur.

### Analiza / Zgjidhja (7 milestone, commits të vegjël)

Ndarja ekzistuese build-tag (`_windows.go`/`_other.go`) u formalizua në një
kontratë PAL të dokumentuar (`agent/pal.go`: `Platform` me `Capabilities()` +
`ExtraInventory()`). Windows-i implementon kontratën me kthime bosh → payload-i
i heartbeat-it byte-identik (të gjitha fushat e reja `omitempty`); Linux-i
raporton realisht. Për të shmangur simbole të dyfishta, `_other.go`-t përkatëse
u ritag-uan `!windows && !linux` (darwin mbetet fallback) dhe u shtuan
`*_linux.go`.

- **M1**: `pal.go` + `platform_{windows,linux,other}.go`.
- **M2**: 7 fusha aditive (`fqdn, kernel_version, architecture, mac_address,
  timezone, last_boot_at, capabilities`) në Inventory + HeartbeatPayload,
  populuar nga `currentPlatform()`. Test `pal_test.go` provon që payload-i
  jo-Linux nuk përmban asnjë nga fushat e reja.
- **M3**: `collectOSInfo` real në Linux nga `/etc/os-release` + kernel (uname).
- **M4**: actions Linux (restart_agent/restart_device/reboot via systemd;
  RustDesk/PowerShell → "not supported on Linux").
- **M5**: service management systemd (install shkruan unit + enable --now;
  uninstall/start/stop/status) + self-update (download → SHA256 → atomic
  rename me `.old` për rollback → `systemctl restart`).
- **M6**: backend `GET /api/v1/install/linux?token=` (bash one-liner, 404 kur
  FEATURE_LINUX OFF) + `linux-arm64` te AgentPackagePlatform.

### Windows protection — provë

Baseline i binarit Windows u kap PARA punës. Byte-identik i binarit është i
pamundur kur shtohet kod i përbashkët (pal.go kompilohet edhe në Windows),
prandaj garancia është **sjellje bit-identike**: (1) test që provon payload-i
jo-Linux s'ka fushat e reja; (2) suita Go e gjelbër; (3) **agjenti Windows NUK
u rindërtua/rideploy-ua — flota mbetet në 2.1.5**. Të katër targetet ndërtohen
(linux amd64/arm64, windows, darwin).

### Smoke test (server Ubuntu)

Binari `linux/amd64` (ELF statik ~9.5MB) u ekzekutua me `--once`: mblodhi
inventory + RustDesk discovery (`not_installed` — saktë në Linux) dhe dështoi
me elegancë te enrollment pa token. Kodi Linux u ushtrua pa gabime.

### Deploy + validim

Backend prod tip `59a781b` (backend-only rebuild). health 200;
`/api/v1/install/linux` → **404** (FEATURE_LINUX OFF, verifikuar); 206
heartbeats/min (~750 pajisje @ 250s — normale); 0 gabime reale në logje.
FEATURE_LINUX mbetet OFF — Linux është dark. Binarët Linux nuk u ngarkuan si
paketa (kërkon ndezjen e flag-ut për canary — Manual Approval).

### Certifikim

Linux → **Experimental** (Appendix C): kod i implementuar, dark, pa pajisje
prodhimi. Internal kërkon UI-n e Fazës 3 + një host të brendshëm.

### Mësimet

Ritag-imi build-tag (`!windows && !linux`) është mënyra e pastër të shtosh një
platformë të tretë pa prekur dy të parat: kompajlleri garanton izolim, jo
disiplina. Çdo funksion i hequr nga `_other.go` duhet ripërkufizuar për Linux.

## [2026-07-07] Vault Operational Safety — backup + recovery i çelësit master (hardening, pa ndryshim sjelljeje)

### Problemi

Çelësi master i Credential Vault (`vault_master.key`, në volume `backend_data`)
nuk ishte në backup — humbja e tij = çdo sekret vault i parikuperueshëm.
Boshllëk i regjistruar te deploy-i i Fazës 4; duhej mbyllur PARA se
`FEATURE_VAULT` të ndizej ndonjëherë. Kjo NUK është feature platforme; është
hardening operacional. Zero ndryshim sjelljeje, asnjë flag i ndezur.

### Zgjidhja

`scripts/techi-backup.sh` (i versionuar tani në repo, i deploy-uar në
`/root/techi-backup.sh`) shton një hap: resolve i mountpoint-it të volume-it
`techi-platform_backend_data` (dinamik — që një recreation i compose të mos
çojë te path i vjetër), tar i `vault_master.key` me `chmod 600`, dhe një file
integriteti `vault-key-<date>.sha256`. Hyn në retention-in ekzistues 14-ditor.
Nëse çelësi mungon (vault i painicializuar) → warning, jo error.

### Procedura e restaurimit (dokumentuar te PROJECT_STATE › Disaster Recovery)

Extract `vault-key-<date>.tar.gz` → verifiko `sha256sum` kundër `.sha256` →
vendos te `data/vault_master.key` (`0400`) në volume → restart backend.

### Rezultati (verifikim end-to-end, 2026-07-07)

Backup u ekzekutua: çelësi u ruajt, sha `e7bcd67f…710b`. Verifikim integriteti:
sha e restauruar = e regjistruar = live. **Verifikim rikuperimi**: një sekret i
enkriptuar me çelësin LIVE u dekriptua saktë duke ngarkuar çelësin nga kopja e
RESTAURUAR e backup-it (`recovery-canary-42`) — pra artefakti i backup-it është
i vlefshëm dhe funksional për recovery. Temp files u pastruan. Prodhimi i
paprekur; asnjë flag i ndryshuar.

### Mësimet

Ky është i vetmi komponent DR me restore të provuar realisht (postgres/NPM/
offsite mbeten të pa-provuara — boshllëqe para-ekzistuese). Sekretet e reja
persistente kërkojnë hyrje në backup + provë recovery që në deploy-in e parë.

## [2026-07-07] Platform Expansion Phase 4 — Enterprise Credential Vault (flag-gated)

### Problemi

Vault enterprise për sekrete (password/ssh_key/api_token/snmp/winbox/cert),
me scope Global→Client→Group→Device, i ndarë PLOTËSISHT nga sistemi i
RS-password (secret_cipher), pa u prekur asgjë me flags OFF. (Fazat 2–3 u
anashkaluan për momentin: Faza 2 e bllokuar nga rollout-i 2.1.5; fazat
zhvillohen në mënyrë të pavarur.)

### Analiza / Zgjidhja

Envelope AES-256-GCM në `core/vault_cipher.py`: master key file jashtë
repo/DB (`data/vault_master.key`, `0400`, në volume `backend_data`) → DEK
per-credential → payload; rotation me re-wrap (payload i paprekur). E ndarë
nga `secret_cipher` (keystream i RS-password — i ngrirë). Tabela të reja
`vault_credentials` + `vault_credential_usage` (append-only audit). Service
me integritet scope-i (scope_type ↔ target id), reveal me arsye + audit,
rotim. API `/vault` me role gates (list operator+, mutim admin+) dhe **404
kur FEATURE_VAULT është OFF** (i padukshëm, jo "i çaktivizuar"). Endpoint i ri
read-only `/platform/features` për frontend-in. UI: faqe `CredentialVault.tsx`
+ hook `usePlatformFeatures` (default all-off) + rrugë + zë Sidebar-i, të
gjitha të gated nga FEATURE_VAULT.

**SQL i aplikuar në prodhim para deploy-it** (dy tabela + indekse; shih
commit). Rollback: `FEATURE_VAULT=false` (default, i menjëhershëm) + `git
revert`; DROP TABLE vault_* vetëm me aprovim.

Varësi e re: `cryptography==42.0.8` (vjen me docker build).

### Rezultati

Deploy 2026-07-07 (backend+frontend, prod tip `9a119a7`): health 200, të dy
kontejnerët healthy, `/api/v1/vault` → **404** me flag OFF, `/platform/features`
→ 401 pa auth (i mbrojtur), cipher round-trip OK në kontejner, çelësi master
`0400` në `/app/data` (volume `techi-platform_backend_data`), 380 heartbeats/
2min. Suita 2×: flags OFF dhe FEATURE_PLATFORM_CORE+FEATURE_VAULT ON → 414
passed + 4 të njohura; tsc pastër; frontend build OK.

### ⚠️ Veprim i detyrueshëm PARA se FEATURE_VAULT të ndizet në prodhim

Çelësi master `vault_master.key` **nuk është ende në backup**. Skripti
`techi-backup.sh` merr postgres + RustDesk keys + config tar, JO volume-in
`backend_data`. Humbja e këtij çelësi = çdo sekret vault i parikuperueshëm
(si RustDesk keys). Përpara ndezjes së flag-ut (që kërkon aprovim owner-i —
kusht Manual Approval): (1) shto `vault_master.key` te config tar-i i
backup-it; (2) rishiko rotation. Deri atëherë vault është i zbrazët dhe OFF,
pa rrezik real.

### Mësimet

Sekretet e reja persistente kërkojnë hyrje në DR/backup që në ditën e parë —
u regjistrua si gate para ndezjes së flag-ut, jo si borxh i heshtur.

## [2026-07-07] Platform Expansion Phase 1 — Platform Core Integration (dark wiring + kolona DB)

### Problemi

Faza 1 e roadmap-it: themeli i Fazës 0 duhej bërë i përdorshëm pa ndryshuar
sjelljen — kolona aditive në `devices`, nxjerrja e Windows adapter-it dhe
parsing i capabilities në side effects, të gjitha nën `FEATURE_PLATFORM_CORE`.

### Analiza

Seam-i i klasifikimit: `DeviceHeartbeatService.classify_device_type` (statike,
Windows-specifike) — logjika u zhvendos FJALË PËR FJALË te
`platform_adapters/windows.py::classify_windows_device_type`; metoda statike
tani delegon aty (API publike + testet ekzistuese të paprekura). Dispatch
flag-gated në `process_heartbeat_core`: flag OFF → rruga legacy identike;
flag ON → `get_adapter(payload.platform)`. Kujdes i veçantë te tre
`payload.model_dump(...)` (update / create / reuse) — `capabilities`
përjashtohet që të mos rrjedhë raw në DeviceCreate/DeviceUpdate; normalizohet
vetëm në `_run_side_effects._process_capabilities` (jashtë fast path).
Fallback i sigurt: platformë e panjohur ose pa adapter → Windows adapter
(sjellja legacy), me log.

### Shkaku

n/a — fazë e planifikuar e roadmap-it.

### Zgjidhja

Kod: `app/services/platform_adapters/{__init__,base,windows,linux,registry}.py`;
`device_heartbeat_service.py` (delegim + dispatch + `_process_capabilities` +
3 përjashtime dump); `models/device.py` +7 kolona nullable; skemat
DeviceBase/DeviceUpdate +6 fusha, `AgentHeartbeatPayload` +7 fusha opsionale;
`schema_compat_service.DEVICE_COLUMNS` +7 (SQLite dev). Teste:
`test_platform_adapters.py` (13 teste: golden corpus me pritshmëri të
ngurtësuara para-ekstraktimit, ekuivalenca adapter↔legacy, fallbacks,
filtrimi per-platform i capabilities, side-effect flag on/off);
`test_platform_core.py` — invarianti i errësirës u zëvendësua me kufi wiring
(vetëm 3 module të aprovuara importojnë platform_core) dhe testet e flags u
bënë imune ndaj env override (lexojnë defaults të klasës Settings).

**SQL i aplikuar në prodhim PARA deploy-it** (schema-first, hapi 4):

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fqdn VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS kernel_version VARCHAR(120);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS architecture VARCHAR(40);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_boot_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS capabilities JSONB;
```

Rollback SQL (VETËM me aprovim të owner-it — rregulli i drop-eve):

```sql
ALTER TABLE devices DROP COLUMN IF EXISTS fqdn, DROP COLUMN IF EXISTS kernel_version,
  DROP COLUMN IF EXISTS architecture, DROP COLUMN IF EXISTS mac_address,
  DROP COLUMN IF EXISTS timezone, DROP COLUMN IF EXISTS last_boot_at,
  DROP COLUMN IF EXISTS capabilities;
```

Rollback sjelljeje: `FEATURE_PLATFORM_CORE=false` (default) — i menjëhershëm.

### Ndryshimet

Shih listën e file-ve më lart; zero ndryshime frontend; zero endpoints të reja.

### Rezultati

Suita e plotë **2×**: me flag OFF → 403 passed + 4 dështimet e njohura;
me `FEATURE_PLATFORM_CORE=true` → identike (403 + 4) — dispatch-i i adapter-it
nuk ndryshon asnjë klasifikim (golden corpus 10 rastesh e provon fushë më
fushë). Deploy + validimi i prodhimit: shih rreshtat e roadmap-it (Phase 1).

### Mësimet

Tre vendet e `model_dump` (update/create/reuse) janë kontrata e heshtur e
heartbeat-it me skemat Device* — çdo fushë e re e payload-it duhet ose të
ekzistojë në DeviceUpdate/DeviceCreate, ose të përjashtohet shprehimisht në
të tre vendet, përndryshe heartbeat 500 fleet-wide.

## [2026-07-07] Deploy: Platform Expansion Phase 0 (Platform Core Foundation) + gotcha e emrit të compose project

### Problemi

Deploy i Fazës 0 (flags + Platform Registry + Capability Registry — kod dark,
flags OFF) në prodhim, sipas standing approval të owner-it për workflow-in e
plotë të fazave.

### Analiza

Para deploy-it u verifikua me evidencë: live dir `/root` (docker label),
prod në `9644634`, working tree i pastër. Gjatë deploy-it u zbulua një
**gotcha kritike**: `cd /root && docker compose build backend && up -d backend`
krijoi projekt të ri compose të quajtur **`root`** (nga emri i direktorisë) —
kontejnerë `root-backend-1`/`root-postgres-1` paralelë me projektin real
`techi-platform`. `root-postgres-1` dështoi në nisje (porta 5432 e zënë nga
postgres-i real) — prodhimi mbeti i paprekur, por procesi i dokumentuar i
deploy-it ishte i paplotë: kërkon **`-p techi-platform`** (ose
`COMPOSE_PROJECT_NAME=techi-platform`), sepse emri i projektit nuk del nga
compose file, po nga direktoria.

### Shkaku

Compose project name i pa-fiksuar në `/root/.env` ose në compose file;
deploy-et e mëparshme duket se e kanë dhënë manualisht.

### Zgjidhja

Pastrim i menjëhershëm (`docker rm root-backend-1 root-postgres-1`,
`docker network rm root_default`, heqja e imazhit `root-backend`) dhe rideploy
me `docker compose -p techi-platform build backend && … up -d backend`.
Hapi 5 i Deploy Process në PROJECT_STATE.md u përditësua me `-p techi-platform`.

### Ndryshimet

Prodhimi: `9644634` → `c60ff62` (3 commits: `d19f5d9` docs aprovimi/design-lock,
`f1975ed` Phase 0 platform_core, `c60ff62` roadmap). Vetëm imazhi backend u
rindërtua; frontend/postgres të paprekur. Zero SQL (Faza 0 s'ka ndryshime skeme).

### Rezultati

`/health` 200; `techi-platform-backend-1` healthy; operatorët u rilidhën në
`/ws/devices`; **740 heartbeats në 5 min** (~750 pajisje @ 250 s — normale);
verifikuar në kontejner: të 7 flags OFF, `feature_enabled('FEATURE_LINUX')` =
False, 8 platforma në registry. Sjellja e prodhimit bit-identike (kod dark i
pa-importuar nga asnjë modul ekzistues — invariant i testuar).

### Mësimet

(1) **Gjithmonë `docker compose -p techi-platform` në `/root`** — pa të,
compose krijon projekt paralel "root" dhe tenton postgres të dytë në 5432.
Vlen ta fiksojmë me `COMPOSE_PROJECT_NAME=techi-platform` në `/root/.env`
(kërkon vendim të owner-it — prek edhe backup/restore docs). (2) Filtri i
heartbeat access-log (deploy 2026-07-06) do të thotë që rrjedha e heartbeat-eve
verifikohet me DB (`device_heartbeats.created_at`), jo me logje.

## [2026-07-07] Vendim: Platform Expansion — arkitektura APROVOHET dhe DESIGN LOCKED

### Problemi

TECHI Platform (LIVE, ~750 pajisje Windows) duhet të zgjerohet në multi-platform
(Linux i pari; më pas MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox) pa
prishur asgjë nga sistemi aktual dhe pa krijuar produkt paralel.

### Analiza

Auditi u krye në 4 raunde iterative (2026-07-06 → 2026-07-07) nën mbikëqyrjen e
owner-it: (1) draft "Linux Support" + mockups; (2) mockups të rindërtuara mbi
design language-in real të frontend-it; (3) draft "V3" i zgjeruar; (4) pas
urdhrit të owner-it "dokumentacioni para kodit", u lexuan të plota
PROJECT_STATE.md, CHANGELOG-SOLUTIONS.md, MOBILE-DESIGN-SPEC.md dhe u raportuan
8 konflikte draft-vs-dokumentacion (kryesorët: agjentët NUK kanë kanal
WebSocket — komandat udhëtojnë vetëm si `pending_actions` në heartbeat; policy
globale 250 s; asnjë punë në `agent/` gjatë rollout-it 2.1.5; kufiri me Zabbix).
Gjetje pozitive: `Device.platform`, selektori Platform në Enrollment Bootstrap,
`linux-amd64` te Packages dhe stubs `_other.go` të agjentit ekzistojnë tashmë.

### Shkaku

n/a — vendim arkitekturor, jo incident.

### Zgjidhja

**Arkitektura u APROVUA dhe u shpall DESIGN LOCKED nga owner-i (2026-07-07).**
Dokumenti bazë: `docs/reference/PLATFORM-EXPANSION-AUDIT.md` (riemërtuar nga
`LINUX-AGENT-DESIGN-SPEC.md`). Vendimet kryesore të ngrira:

- **No Rewrite policy**: asnjë ridizajn i platformës/UI/backend; vetëm zgjerim
  aditiv i komponentëve ekzistues; Windows mbetet reference implementation.
- **Feature Flags policy**: gjithçka e re pas flags (FEATURE_PLATFORM_CORE,
  FEATURE_LINUX, FEATURE_VAULT, FEATURE_TERMINAL, …), default OFF;
  **flag OFF = sjellje BIT-IDENTIKE me prodhimin e sotëm**.
- **Platform Expansion nis** me roadmap fazor (audit §12), një fazë në një kohë,
  me STOP + aprovim manual të owner-it mes fazave; çdo fazë mbyllet vetëm me
  Definition of Done (Appendix A) + Regression Matrix (Appendix B) +
  Platform Certification (Appendix C).
- **Linux shtyhet** derisa rollout-i i Windows Agent 2.1.5 të shpallet
  zyrtarisht i përfunduar (standing order — asnjë prekje e `agent/`).
- Dy porta me aprovim të veçantë të owner-it: rruga WS në NPM (Faza Terminal)
  dhe data e nisjes së punës në `agent/`.

### Ndryshimet

`docs/reference/LINUX-AGENT-DESIGN-SPEC.md` → riemërtuar
`docs/reference/PLATFORM-EXPANSION-AUDIT.md` (+ banner ARCHITECTURE STATUS:
DESIGN LOCKED); hyrje të reja në PROJECT_STATE.md (seksioni PLATFORM EXPANSION);
kjo hyrje. Zero ndryshime kodi/prodhimi në këtë vendim.

### Rezultati

Baseline zyrtar i ngrirë; implementimi nis me Fazën 0 (Platform Core Foundation
— dark, pa ndryshim sjelljeje), e cila raportohet më vete pas përfundimit.

### Mësimet

Dokumentacioni ka përparësi mbi kodin — auditi kodi-i-parë prodhoi 8 supozime
të gabuara që u kapën vetëm nga leximi i plotë i PROJECT_STATE/CHANGELOG.
Çdo iniciativë e re duhet të fillojë me leximin e dy dokumenteve kanonike.

## [2026-07-06] JetBrains Mono self-hosted — hiqet varësia nga Google Fonts CDN

### Problemi

Owner-i vërejti te DevTools Issues (prodhim, desktop) një "Page Error:
failed to load a stylesheet" për `fonts.googleapis.com/css2?family=
JetBrains+Mono...` (`index.html:17`).

### Analiza

URL-ja e font-it ishte valide (curl → 200 OK; Chromium i pastër kundër
prodhimit → stylesheet 200, zero kërkesa të dështuara). Dështimi ndodhte
vetëm në browser-in e owner-it sepse ka AdBlock të instaluar — shumë
filter-lista privatësie bllokojnë Google Fonts. Pasoja: monospace i
sistemit në vend të JetBrains Mono për çdo operator me ad-blocker (pjesa
më e madhe e teknikëve). Dy issues të tjera në panel u analizuan si
jo-probleme: "bounce tracking 486643457" = heuristikë e Chrome mbi
protokollet custom `techiremotesupport://` / `rustdesk://` të butonit
Connect (ID-ja interpretohet si hostname — s'ka tracking real, s'ka
veprim); "16 form fields without id/name" = rekomandim autofill-i i
Chrome-it (kategoria Improvements), jo error.

### Shkaku

Varësi e vetme runtime nga një CDN palë e tretë (Google Fonts) për
JetBrains Mono — të bllokueshme nga çdo ad-blocker, GDPR-gri, dhe jashtë
mbulimit të service worker-it offline.

### Zgjidhja

Self-hosting: shkarkuar saktësisht të njëjtat woff2 latin-subset që
shërbente Google (një file variabël wght 400–800 për upright — konfirmuar
me fontTools `fvar` axis — dhe një statik 400 italic; latin U+0000-00FF
mbulon edhe ë/ç shqip), vendosur te `frontend/public/fonts/`; `@font-face`
në krye të `index.css` me të njëjtat `unicode-range`/`font-display: swap`;
hequr 3 rreshtat e Google Fonts (2 preconnect + stylesheet) nga
`index.html`; CSP në `nginx.conf` u SHTRËNGUA — `fonts.googleapis.com`
hequr nga `style-src`, `fonts.gstatic.com` hequr nga `font-src` (tani
`font-src 'self' data:`).

### Ndryshimet

`frontend/public/fonts/jetbrains-mono-latin.woff2` (i ri, 31KB),
`frontend/public/fonts/jetbrains-mono-latin-italic.woff2` (i ri, 22KB),
`frontend/src/index.css` (@font-face), `frontend/index.html` (hequr 3
rreshta), `frontend/nginx.conf` (CSP më e ngushtë). Zero ndryshim
backend/API/komponentësh.

### Rezultati

Verifikuar Playwright kundër build-it të prodhimit (`vite preview`):
`document.fonts.check` true për 400/700/italic; vetëm 2 kërkesa fonts,
të dyja nga origjina vetjake; zero kërkesa te `fonts.googleapis.com`/
`fonts.gstatic.com`; zero referenca Google në `dist/`. Font-et bien nën
rregullin ekzistues nginx `\.woff2$` (1 vit immutable — korrekte këtu:
nëse përditësohen, riemërtohen) dhe cache-ohen edhe nga runtime cache i
service worker-it (mbulim offline).

### Mësimet

Për një konsolë të brendshme MSP, çdo asset kritik UI duhet të vijë nga
`'self'` — CDN-të e palëve të treta dështojnë në mënyra të padukshme
(ad-blockers, DNS filtering në rrjetet e klientëve) pikërisht për
audiencën që e përdor më shumë (teknikë me ad-blocker). Bonus: heqja e
një origjine nga CSP është përmirësim sigurie në vetvete.

## [2026-07-06] "Add to Home Screen" në iOS shfaqte logo-n e vjetër — file i vjetëruar + cache 1-vjeçar

### Problemi

Owner-i raportoi se ikona e "Save to Home Screen" në iOS mbetej ajo e
VJETËR edhe pas ndryshimit të logo-s, dhe që fshirja+rishtimi i
shkurtores nga home screen nuk ndihmonte fare — e njëjta gjë përsëritej.

### Analiza

`git log` zbuloi që `frontend/public/apple-touch-icon.png` (referuar te
`<link rel="apple-touch-icon">` në `index.html`, mekanizmi kryesor që iOS
Safari përdor për "Add to Home Screen") s'ishte prekur që nga commit
`aec945e` (shumë i vjetër) — ndërsa `manifest.json`'s `/icons/*.png` u
rregulluan më vonë te commit `bf32ef8` ("fix: PWA icons from real
Logo.png"). Krahasimi vizual (Read tool mbi të dy PNG-të) e konfirmoi:
`icon-512.png` tregonte logo-n e saktë aktuale (sfond i errët, "techi"
wordmark, gradient rozë→portokalli), `apple-touch-icon.png` tregonte një
version krejt tjetër, të vjetër, të prerë keq (flakë portokalli e
sheshtë). iOS injoron kryesisht manifest.json për home-screen icon dhe
mbështetet te `apple-touch-icon` link tag-u — kështu që rregullimi i
`bf32ef8` kurrë s'e prekte atë që iOS-i faktikisht shfaq. Gjetje e dytë,
më e rëndësishme afatgjatë: `nginx.conf`'s rregulli gjenerik
`location ~* \.(js|css|png|...)$` i cakonte `apple-touch-icon.png` dhe
`favicon.svg`/`favicon.png` me `Cache-Control: public, max-age=31536000,
immutable` (1 VIT) — ndryshe nga `/icons/` që kishte tashmë rregull të
veçantë me `max-age=86400`. Kjo shpjegon pse "remove+add" nuk ndihmoi:
edhe nëse skedari të ndryshohej, header-i "immutable" 1-vjeçar i thoshte
çdo cache (browser, sistemi iOS) të mos e rikontrollonte fare për një vit.

### Shkaku

Dy shkaqe të pavarura, të dyja duhej të rregulloheshin: (1) vetë skedari
`apple-touch-icon.png` s'u rigjenerua kurrë kur logo-ja u ndryshua/u
rregullua për manifest-in; (2) `nginx.conf` s'kishte një rregull të
veçantë për ikonat rrënjë (root-level) siç kishte për `/icons/`, kështu që
ato binin nën rregullin gjenerik immutable-1-vit të menduar për bundle-t e
hash-uara të Vite-it (që VËRTET s'ndryshojnë kurrë nën të njëjtin emër,
ndryshe nga këto ikona).

### Zgjidhja

(1) Rigjeneruar `apple-touch-icon.png` (180×180, `sips`) nga i njëjti
burim si `icon-512.png` (logo-ja aktuale korrekte); bump `?v=4→5` te
`index.html` për cache-bust të menjëhershëm anë-browser. (2) Shtuar një
`location` e re e veçantë në `nginx.conf` (`favicon.svg`, `favicon.png`,
`apple-touch-icon.png`) me të njëjtën politikë ditore (`max-age=86400`,
JO immutable) si `/icons/` — vendosur PARA rregullit gjenerik `\.png$` në
skedar, që nginx (rregulla regex zgjidhen sipas radhës së parë-që-
përputhet) ta zgjedhë këtë në vend të asaj immutable.

### Ndryshimet

`frontend/public/apple-touch-icon.png` (rigjeneruar), `frontend/index.html`
(cache-bust bump), `frontend/nginx.conf` (location e re). Zero ndryshim
backend/API, zero ndryshim komponentësh React — thjesht asete + config
serveri statik.

### Rezultati

Verifikuar lokalisht (`npm run build`): `dist/apple-touch-icon.png` e re,
`dist/index.html` përmban `?v=5`. Nginx.conf u rishikua rresht-për-rresht
për radhën e location-eve (rregullat regex `~*` zgjidhen sipas radhës së
parë-që-përputhet në skedar, jo sipas specifikimit — rregulli i ri është
para atij gjenerik). Verifikimi live pas deploy: header-at `Cache-Control`
mbi `https://rdp.techi.com.al/apple-touch-icon.png` duhet të tregojnë
`max-age=86400` (jo `31536000, immutable`).

### Mësimet

Kur një "fix" i mëparshëm (`bf32ef8`, rregullimi i ikonave PWA) prek
VETËM `manifest.json`'s icons array, kontrollo GJITHMONË nëse ka file të
tjerë referuar drejtpërdrejt nga `index.html` (`apple-touch-icon`,
`favicon`) që mbeten jashtë — iOS Safari në veçanti u jep përparësi këtyre
mbi manifest-in. Dhe: një header `Cache-Control: immutable` i gabuar mbi
një asset JO të hash-uar (që ndryshon me të njëjtin emër file-i) e bën
çdo "fix" të ardhshëm të padukshëm për muaj/vite, pavarësisht sa herë
rifreskon ose fshin+rishton — duhet verifikuar që politika e cache-ut
përputhet me natyrën reale të file-it (i hash-uar+immutable, apo i
riemërtueshëm+revalidate).

## [2026-07-06] Mobile UI 2.0 — 4 raunde rregullimesh pas deploy-it

### Problemi

Pas deploy-it të Mobile UI 2.0 (shih entry-n më poshtë), owner-i rishikoi
prodhimin live dhe raportoi katër probleme në katër raunde të veçanta:
Raundi 1 — Software te Device Details fetch-ohej automatikisht sapo hapej
accordion-i (rrezik ngarkese DB të panevojshme) dhe seksioni Performance i
mungonte sparkline-i i mockup-it dhe dukej me "të dhëna jo reale". Raundi 2
— Uptime/Latency në Device Details mobile "s'janë reale" krahasuar me web.
Raundi 3 — Fleet Tree mobile i mungon opsioni "No Client" (i pranishëm në
Desktop), dhe Alerts mobile s'ka kategori filtri "Disk"/"Storage" për
alertet e diskut. Raundi 4 — screenshot nga prodhimi tregoi që kur
shtypej brenda fushës "Search devices…", e gjithë faqja zoom-ohej dhe
kërkonte zoom-out manual.

### Analiza

Raundi 1: `DeviceInventoryService.get_inventory()` në backend u lexua
drejtpërdrejt — është një lookup i lehtë me një rresht, jo një query e
rëndë; problemi real ishte payload-i JSON (software/services/processes të
plota), jo kostoja e DB-së, dhe fakti që mobile hapet më rastësisht se
desktop. Raundi 2: krahasimi me `DeviceDrawer.tsx` tregoi se e dhëna
(`uptime_seconds`, `heartbeat_latency_ms` nga `useDeviceTelemetry`) ishte
identike me desktop-un — divergjenca ishte thjesht formatimi
(`formatUptime()` mungonte në mobile, ndante vetëm në orë totale). Raundi
3: `DeviceTree.tsx` (Desktop) konfirmoi konventën `client_id = -1` +
`treeCounts.unassigned` për "No Client"; `AlertsMobile.tsx` konfirmoi se
`low_disk` ekzistonte tashmë plotësisht në `AlertKind`/`KIND_LABEL`/
`KindIcon` por mungonte thjesht nga `FilterId`/`FILTER_PILLS`. Raundi 4:
sjellje e njohur e iOS Safari-t — çdo `<input>`/`<select>`/`<textarea>` i
fokusuar me `font-size` të llogaritur nën 16px shkakton auto-zoom të
viewport-it; disa fusha teksti të Mobile UI 2.0 (Devices search
`text-[13px]`, Remote Support search `text-[13px]`, notes te Device
Details `text-[12.5px]`) përdorin madhësi nën 16px për densitet.

### Shkaku

Raundi 1: mungesë gate-i eksplicit për një fetch të shtrenjtë në payload.
Raundi 2: divergjencë formatimi e prezantuar gjatë implementimit fillestar
të Phase 4 (mobile s'e riprodhoi `formatUptime()` e Desktop-it). Raundi 3:
dy feature paritetesh Desktop→Mobile të harruara gjatë Phase 3/5 fillestare
(elementë additivë, jo bug logjike). Raundi 4: asnjë nga input-et e reja të
Mobile UI 2.0 s'u projektua me kufizimin "≥16px" të iOS Safari-t në mendje
gjatë fazave 1–7 — densiteti vizual u prioritizua pa e ditur këtë sjellje
specifike browser-i.

### Zgjidhja

Raundi 1 (commit `44770fd`): `Software` kërkon tap eksplicit ("Load
software list") para se të thërrasë `getDeviceInventory`; shtuar
`Sparkline.tsx` (SVG, real) i ushqyer nga `getDeviceTelemetryHistory`.
Raundi 2 (commit `7161f73`): `formatUptime()` në `DeviceDetailsMobile.tsx`
bërë identike me `DeviceDrawer.tsx`; hequr heuristika e gabuar "0ms =
e pamatur" — Latency tani përdor saktësisht të njëjtin kontroll `!== null`
si Desktop. Raundi 3 (commit `c1b5f9f`): shtuar buton "No Client" te
`FilterSheet.tsx` (menjëherë pas "All clients", ikonë `Box`, ripërdor
`client_id = -1` ekzistues, `unassignedCount` nga
`fleetOverview.tree_counts.unassigned`); shtuar `low_disk`/"Disk" te
`FilterId`/`FILTER_PILLS` në `AlertsMobile.tsx` (aditiv i pastër,
`applyFilter`'s fallback tashmë e mbulonte). Raundi 4: një rregull CSS
global te `index.css` — `@media (max-width: 767px) { input:focus,
select:focus, textarea:focus { font-size: 16px !important; } }` — forcon
16px vetëm gjatë fokusit dhe vetëm nën të njëjtin breakpoint `md:768px`
që përdor pjesa tjetër e Mobile UI 2.0, në vend të ndryshimit të çdo
input-i individualisht.

### Ndryshimet

Raundi 1: `frontend/src/pages/DeviceDetailsMobile.tsx`,
`frontend/src/components/mobile/Sparkline.tsx` (i ri). Raundi 2:
`frontend/src/pages/DeviceDetailsMobile.tsx`. Raundi 3:
`frontend/src/components/FilterSheet.tsx`,
`frontend/src/components/DevicesTable.tsx`, `frontend/src/pages/Devices.tsx`,
`frontend/src/pages/AlertsMobile.tsx`. Raundi 4: `frontend/src/index.css`.
Të katër raundet: vetëm frontend, zero ndryshim backend/API, zero prekje
Desktop (verifikuar me smoke test Playwright kundër komponentëve desktop
përkatës, dhe në rastin e Raundit 4 nga vetë kufiri i media query-t).
`docs/reference/MOBILE-DESIGN-SPEC.md` përditësuar me Implementation Notes
#8–#12 dhe rreshta Progress Log pas secilit raund.

### Rezultati

Të katër raundet u verifikuan me Playwright (mock data + build prodhimi
`vite preview`) para push+deploy, dhe me verifikim live kundër
https://rdp.techi.com.al pas deploy-it. 0 gabime console në çdo rast.
Raundi 4 u verifikua përmes mekanizmit shkaktar (`getComputedStyle` para/
gjatë/pas fokusit: 13px→16px→13px) — vetë zoom-i i Safari-t s'riprodhohet
me Chromium headless. Deploy: `docker compose -p techi-platform build
frontend && ... up -d frontend` (frontend-only, pa prekur backend/
postgres).

### Mësimet

"E dhëna është 'jo reale'" nga një owner që krahason Mobile me Desktop
shpesh do të thotë **divergjencë formatimi/veçorie**, jo të dhëna false —
krahasimi drejtpërdrejt me komponentin ekuivalent të Desktop-it (para se
të supozohet një bug backend-i) e zgjidhi çdo raund më shpejt dhe me
ndryshim më të vogël se sa do të kishte kërkuar një "rregullim" i ri
spekulativ. Raundi 4 shton: një bug UX specifik për iOS Safari (font-size
<16px → auto-zoom) është më i lirë për t'u eliminuar me një rregull CSS
global i kufizuar me media query sesa duke kaluar çdo input individualisht
— zvogëlon rrezikun e harresës për input-e të ardhshme.

## [2026-07-06] Mobile UI 2.0 — implementim i plotë (7 faza) + deploy në prodhim

### Problemi

Audit vizual (Playwright, live prod, 2026-07-05) zbuloi Mobile-in e TECHI si
"companion view" jo enterprise-ready: BUG 1 (search i Devices nuk
rifreskohej — cache-key mungues), BUG 2 (pa refresh), BUG 3 (ikona Android e
RustDesk e pandryshuar), plus B2 (offline = ekran i bardhë), B9 (401 pa
mesazh), Device Details si drawer jo faqe, Alerts si listë e sheshtë me
"Device #93", sidebar mobile i papërdorshëm, etj. Owner-i aprovoi mockup-in
(artifact `af146cd9`) dhe kërkoi implementim të plotë "design-locked" në 7
faza, secila e commit-uar veçmas, pastaj push + deploy.

### Zgjidhja

Kontrata e dizajnit: `docs/reference/MOBILE-DESIGN-SPEC.md` (Vision →
Implementation Notes, wireframe për çdo ekran, design tokens). Implementim
sipas fazave:

1. **Shell/Nav/Theme** — BottomNav 4-tab (More zëvendëson sidebar-in
   mobile), MobileTopBar+FreshnessPill, MobileSheet/Snackbar/primitives,
   tokens dark+light.
2. **Dashboard** — theme-aware, Recent Activity e re, "Stale" si rresht
   normal.
3. **Devices** — DeviceMobileCard v2 (emri dominues), empty-search fix
   (B1), FilterSheet v2 (Apply/Reset), infinite scroll.
4. **Device Details** — faqe e re `/devices/:id` (jo drawer): header,
   VitalsStrip live, 6 accordion sections, StickyActionBar. Ripërdor
   drejtpërdrejt hooks/API ekzistuese (`useDeviceTelemetry`,
   `useDeviceAlerts`, `useDeviceActivity`, `getDeviceInventory`, etj.) —
   zero logjikë e duplikuar; drawer desktop i paprekur.
5. **Alerts** — grupim sipas pajisjes (emra realë via `getDevice()`),
   dismiss me UNDO real (resolveAlert i shtyrë 5s).
6. **Remote Support mobile + Settings i plotë** — grupim Issues/Online/Not
   installed brenda `RemoteSupport.tsx` ekzistues; Settings me System
   theme, Default screen, Diagnostics.
7. **Offline/A11y/Responsive** — `sw.js` me precache shell + runtime cache
   (zgjidh B2); OfflineBanner; session-expired message (zgjidh B9);
   `:focus-visible` global; landscape-compact BottomNav.

### Bugs reale të zbuluara dhe rregulluara gjatë verifikimit (jo gjetje mockup-i)

- **`MobileSheet`**: `history.back()` në mbyllje programatike anullonte
  navigim tjetër që ndodhte njëkohësisht (p.sh. `setSearchParams` i
  FilterSheet Apply) — hequr.
- **`Devices.tsx`**: `setSearchParams` i thirrur >1 herë brenda të njëjtit
  handler sinkron e anullonte njëri-tjetrin (react-router-dom resolon
  "updater" kundër snapshot-it të render-it aktual, jo një gjendje
  gjithmonë e freskët) — kaluar në functional-updater form + FilterSheet's
  Apply e riorganizoi rendin (onQuickFilterChange i fundit).
- **`AlertsMobile`**: `<button>` i ngulitur brenda `<button>` (header
  grupi + "Dismiss all") shkaktonte `validateDOMNesting` + crash të plotë
  të faqes kur klikohej në pikën qendrore — ndarë në elementë vëllazëror.
- **`Login.tsx`**: leximi+fshirja e flag-ut session-expired brenda një
  `useState` lazy-initializer ishte i papastër (side-effect); React
  StrictMode e thërret dy herë në dev, thirrja e dytë e gjente flag-un
  tashmë të fshirë → mesazhi s'shfaqej kurrë — zgjidhur me `useEffect` +
  `useRef` guard.

### Deploy (2026-07-06, https://rdp.techi.com.al)

Push i 9 commits në `origin/stable/phase-2-heartbeat`: 7 fazat mobile
(`27f1687`…`a8a35ea`) + 2 commits ekzistues të papushuara pa lidhje me
mobile-in (`49fce27` storage optimization, `1fe93de` docs) — bashkimi u
konfirmua shprehimisht nga owner-i pas një pyetjeje të drejtpërdrejtë mbi
scope-in (dega është lineare, s'mund të ndaheshin pa krijuar degë të re).

Në server (`/root`, projekt Docker Compose `techi-platform`): `git pull
--ff-only` → `docker compose build backend` → indeksi
`ix_device_heartbeats_created_at` (nga `49fce27`) ekzistonte tashmë në
Postgres (aplikuar me dorë më parë) → `alembic stamp b2c3d4e5f8a9` (via
imazhin e ri, `docker compose run --rm backend`) → `docker compose up -d
backend` → `docker compose build frontend` → `docker compose up -d
frontend`.

**E papritur**: `docker compose run --rm backend` shkaktoi rikrijim
automatik të kontejnerit `postgres` — Compose zbuloi që
`docker-compose.yml` (nga `49fce27`) kishte shtuar cap-in e logging-ut për
shërbimin postgres dhe e rikrijoi vetë për ta aplikuar, edhe pse komanda
kërkonte vetëm `backend`. Postgres u rishëndosh brenda ~30s; heartbeats
vazhduan (204-a në logje menjëherë pas); backend `/health` 200 gjatë
gjithë kohës. Efekt anësor pozitiv: log-cap i postgres tani aktiv, pa u
dashur një "dritare e qetë" e veçantë.

### Rezultati

Të tre kontejnerët "healthy". Verifikuar me Playwright kundër site-it real
(login manual nga owner-i): Dashboard (720 pajisje, 86% online, "Live"),
Devices, Device Details (`/devices/714`, vitals reale CPU 71%/RAM 76%/Disk
41%), Alerts (grupim real "Recepsion-hr · Gffa"), More, Settings — 0
gabime 4xx/5xx në sweep të pastër të 6 rrugëve kryesore.

### Mësimet

- `docker compose run --rm <svc>` respekton `depends_on` dhe rikrijon
  varësi (si `postgres`) nëse config-u i tyre në compose file ka ndryshuar
  që nga hera e fundit e krijimit — edhe kur kërkohet vetëm një shërbim
  tjetër. Të pritet gjatë çdo deploy që përfshin ndryshime docker-compose.yml
  për shërbime "silent" (postgres), jo vetëm ato eksplicitisht të prekura.
- React StrictMode dev-only double-invoke i lazy state initializers /
  effects zbulon efekte anësore të papastra (si mutacione
  localStorage/sessionStorage) që në prodhim (single-invoke) do të kishin
  kaluar pa u vënë re — trajtoji si gabime reale, jo zhurmë e StrictMode.
- `setSearchParams` (react-router-dom) i thirrur disa herë sinkron brenda
  të njëjtit handler NUK kompozohet si `useState`'s functional updater;
  çdo flow i ri që kombinon disa ndryshime filtri/URL në një veprim duhet
  ose një thirrje e vetme, ose kujdes eksplicit për renditjen.

## [2026-07-05] Shkrirja e historisë së munguar 19–26 qershor nga root CHANGELOG

### Problemi

Changelog-u kanonik s'kishte asnjë hyrje midis 2026-06-19 dhe 2026-06-26; ajo
javë (Command Center Fazat A/B, komanda self_update, fix-e kritike të
techi-deploy.cmd, eliminimi i false-positive AV) jetonte vetëm në
`CHANGELOG-SOLUTIONS.md` të root-it — më parë i vlerësuar gabimisht si dublikatë.

### Zgjidhja

14 hyrjet u shkrinë verbatim në pozicionin kronologjik (pas 2026-06-27, para
2026-06-18), me shënues proveniençe HTML në vend. Verifikim: krahasim
byte-për-byte i bllokut, 0 dublime titujsh, rend datash i plotë. Root-i tani
është 100% i mbuluar nga ky dokument dhe propozohet për arkivim (vetëm me
miratimin e Marios).

## [2026-07-04] Vendim: standardi i dokumentacionit me dy dokumente

### Problemi

Documentation was scattered across 20+ files of different eras
(`ai-context/*` frozen at Phase 3 / SQLite / no-auth, stale READMEs, two files
named CHANGELOG-SOLUTIONS.md, plans already implemented). A new AI session had
no reliable single source of truth, and production facts (deploy dir, real
retention, real heartbeat interval) existed only in chat history.

### Zgjidhja

Owner decision (permanent standard): exactly TWO canonical documents —
`docs/PROJECT_STATE.md` (current state only, verified facts flagged) and
`docs/CHANGELOG-SOLUTIONS.md` (history only, this file). Every meaningful
change updates PROJECT_STATE immediately; every incident/decision lands here
immediately; nothing critical may exist only in AI conversations. All other
docs demoted to historical/technical reference.

### Ndryshimet

- `docs/PROJECT_STATE.md` rewritten to the agreed structure (state-only, with
  (verified)/(needs verification) markers, AI Instructions, Things Never To
  Change).
- This header rewritten to define the history-only role + entry template.
- No documents deleted; archive proposals listed in the reorg report to the
  owner (root `CHANGELOG-SOLUTIONS.md`, `ai-context/current-phase|
  completed-phases|next-steps|runtime.md`, `AGENT-UPDATE-PLAN.md`, stale
  READMEs → proposed `docs/archive/`).

### Rezultati

A new AI session needs only PROJECT_STATE.md + this changelog to work safely
on the project.

## [2026-07-04] Storage: retention, log rotation, cache pruning (safe batch)

### Why

Server disk at ~98%. Audit found unbounded growth in: DB tables without
retention (audit_logs, resolved alerts, terminal remote_actions incl. full
PowerShell output, status history, command batches, enrollment audit), the
postgres container log (no docker cap), agent-side `agent.log`/`deploy.log`
(append-only, never rotated), and `%ProgramData%\TechiAgent\cache` (old RS
MSIs ~25 MB + old self-update exes ~10 MB per version, never deleted).
Heartbeat redesign is NOT part of this batch — see
`docs/architecture/heartbeat-storage-redesign.md` (proposal, needs approval).

### What changed (behavior-preserving)

- `app/tasks/cleanup.py` + `app/main.py`: nightly 03:00 UTC job now also
  cleans resolved alerts (90 d), terminal remote actions (90 d), empty
  command batches (90 d), status history (60 d), audit logs (180 d),
  enrollment audit (180 d). Open alerts and non-terminal actions untouched.
  Each task is isolated — one failure no longer stops the rest.
- Alembic `b2c3d4e5f8a9`: index on `device_heartbeats.created_at` (nightly
  cleanup was full-scanning the biggest table).
- `logging_config.py`: uvicorn access lines for `/api/v1/agent/heartbeat` and
  `/health` are dropped (per-device-per-minute noise that churned rotation).
- `docker-compose.yml`: postgres service now has the same json-file 10m×5 cap
  as backend/frontend (was unbounded).
- Agent-side changes (log rotation 5 MB for `agent.log` / 1 MB for
  `deploy.log`, startup pruning of stale cache files) are **NOT in this
  batch**: they live on branch `pending-agent-2.1.6`, marked *Pending Agent
  2.1.6*. Nothing on the current branch requires an agent build or touches
  the heartbeat contract — the 2.1.5 fleet (700-device rollout) is fully
  compatible as-is.

### Deploy notes (Postgres — remember the schema gotcha)

The index must exist in prod. Either run the alembic revision or, to avoid
blocking live heartbeat INSERTs on a large table, apply by hand:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_heartbeats_created_at
    ON device_heartbeats (created_at);
```

Recreate the postgres container for the logging cap to take effect
(`docker compose up -d postgres`) — note this restarts the DB, do it in a
quiet window. Pre-existing condition, unchanged by this batch: alembic has
two heads (`a1b2c3d4e5f7`, `e6f7a8b9c0d1`); the new revision extends the
first.

### Verify

- Backend: 368 tests pass (the 4 failures in
  `test_enrollment_audit_diagnostics.py` are pre-existing on a clean tree).
- Agent: `go vet` clean, `GOOS=windows` build OK, `go test ./...` pass.
- Next morning after deploy: `grep Cleanup /app/logs/techi.log` shows the six
  new tasks; `docker logs techi-postgres --tail 1` capped.

## [2026-07-04] Security: Per-Device Remote Support Password (Phase 1, backend)

### Why

The TECHI Remote Support password was a single fleet-wide value (`Durres.12`),
written in plaintext into the RustDesk TOMLs and re-applied every heartbeat.
One compromised/curious user reading a TOML exposed remote access to the
ENTIRE fleet. The enrollment token was also plaintext in
`\\DOMAIN\NETLOGON\techi-deploy.cmd` (world-readable by domain users).

### Phase 1 (backend, deployed)

- Each device gets a unique, server-generated RS password, stored encrypted
  at rest (`app/core/secret_cipher.py`, XOR+HMAC keyed off SECRET_KEY;
  `remote_support_password_ciphertext` column).
- `RemoteSupportPasswordService`: get_or_create / set_custom / regenerate.
- Heartbeat response now returns `remote_support_password`; a >= 2.1.5 agent
  will apply it to RustDesk (Phase 2).
- `/connect-url` uses the per-device password, with a **transition-safe
  fallback** to the legacy shared password for agents < 2.1.5 (so remote
  access does not break during rollout; the fallback retires itself).
- New audited endpoints: `GET/POST /remote-support/devices/{id}/password`,
  `POST .../password/regenerate`.

### GOTCHA (caused a brief heartbeat outage during deploy)

`schema_compat_service.ensure_sqlite_dev_schema` only adds columns on
**SQLite (dev)**. Production Postgres needs the columns added by hand — the
heartbeat 500'd fleet-wide until:

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_ciphertext TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_updated_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_source VARCHAR(16);
```

Any new model column that the heartbeat/enrollment fast-path reads MUST be
ALTER-ed into Postgres before/with the deploy.

### Phase 2 (agent 2.1.5) + Phase 3 (frontend) — done, in commit 0335ec7

- Agent 2.1.5: the heartbeat response `remote_support_password` is adopted
  into `cfg.RustDeskDefaultPassword`, persisted to config, and applied to
  RustDesk immediately (`applyRemoteSupportPassword`). The management loop
  now re-applies the server's per-device value, not the old global.
- Also in 2.1.5: `bootstrap-config -rustdesk-password` (fresh installs write
  the RS password), and `watchdog-check` starts the TECHI Remote Support
  service if stopped (remote access survives agent-down).
- Frontend: RemoteSupport page password modal (reveal / copy / regenerate /
  set-custom), deployed.

**Rollout dependency:** devices only APPLY the per-device password once on
2.1.5. Until a device is on 2.1.5, connect-url returns the legacy shared
password for it (version-gated fallback), so remote access keeps working.
Standalone 2.1.5 exe: `/private/tmp/techi-agent-2.1.5.exe` SHA256
`cdc413f191faab7046c04451a7ff6f83300449e03f067377bda96a3ef52e29a3`
(CI builds the MSIs). Keep the agent_binary SHA aligned to the MSI's exe.

### Still open

- NETLOGON `techi-deploy.cmd` token: restrict ACL to Domain Computers.
- Optionally stop the install writing the transient Durres.12 bootstrap value
  (server overrides it on first heartbeat anyway).

## [2026-07-04] INCIDENT: v2.1.3 Agent Won't Launch — Broken Manifest XML Declaration (SxS)

### Root cause

The physical test PC failed every 2.1.3 install with msiexec 1603. After
ruling out (via the verbose MSI log) leftover MSI registration, and after
confirming Windows Defender real-time was genuinely OFF and it still failed,
the decisive test was an administrative extract (`msiexec /a`) of the exe
plus a direct run:

`The application has failed to start because its side-by-side configuration
is incorrect.` (SxS, error 14001)

Both the combined-MSI exe and the agent-binary exe failed identically — the
binary would not launch at all, as a service (1920) or as an MSI custom
action (1721).

The cause was in `agent/techi-agent.manifest`:

`<?xml version="2.1.3.0" encoding="UTF-8" standalone="yes"?>`

The 2.1.3 version-bump used a sloppy inline regex
(`version="[0-9.]+"` with `count=1`) that replaced the FIRST `version="..."`
in the file — the **XML declaration**, which must always be `version="1.0"`.
An invalid XML declaration makes the whole manifest unparseable, so Windows
cannot build the activation context and refuses to start the process. 2.1.2
was fine because its build used a 4-part-only regex that never matched the
2-part `version="1.0"`. Once the declaration was poisoned to `2.1.3.0`
(4-part), even the "safe" CI regex kept re-stamping it 4-part, so every
2.1.3 artifact shipped broken.

### Fix

- `techi-agent.manifest` restored: `<?xml version="1.0"...?>`,
  assemblyIdentity `version="2.1.4.0"`.
- All three manifest-stamping regexes (`build.sh`, `build-agent-update.sh`,
  CI `build-agent-msi.yml`) anchored to the indented assemblyIdentity line
  `(?m)^(\s+version=")...` so they can NEVER touch the XML declaration again.
- Version bumped to **2.1.4** to retire the poisoned 2.1.3 artifacts.

### Verification

- `agent/techi-agent.manifest` parses as valid XML; declaration is
  `version="1.0"`, assemblyIdentity is `2.1.4.0`.
- Built exe embeds `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  (confirmed via strings). Local standalone build:
  `/private/tmp/techi-agent-2.1.4.exe`
  SHA256 `8657e4d59072162851f3a1ccae2525ed0fac036c0bc8c6039d2088a82e6b1f82`.
- `go build ./...` (darwin + windows) clean.

### Lesson

Never regex the manifest with a pattern that can match the XML declaration.
Defender/AV was a red herring here — the exe never ran on ANY machine.

## [2026-07-03] v2.1.3: Package-Type Split (agent_update_msi) + Script-Free Combined MSI

### Root cause

Two remaining structural gaps after v2.1.2:

1. One "active MSI" slot served two conflicting purposes: the public
   `/agent-packages/platform/windows-amd64/download` feeds BOTH the
   GPO/NETLOGON bootstrap (needs the combined MSI with Remote Support) AND
   legacy self_update payloads (need the agent-only bridge MSI). Activating
   the bridge broke bootstrap; activating the combined re-exposed RS to
   MajorUpgrade during routine agent updates.
2. The combined bootstrap MSI still ran ~12 PowerShell custom actions
   (config, service ensure, recovery, icacls, tray task, shortcuts, kill RS,
   cleanup). AV/AMSI-strict clients (Symantec, CybeeAI) block all of them,
   leaving fresh GPO installs half-configured.

### Fix

**Backend/UI — new package type `agent_update_msi`:**
- `AgentFileType` gains `agent_update_msi` (bridge). `msi` keeps meaning the
  combined bootstrap package; `set_active` scopes per platform+file_type, so
  combined and bridge can be active simultaneously.
- New public endpoint `GET /api/v1/agent-packages/agent-update-msi/download`.
- Legacy self_update payloads now require an active `agent_update_msi`
  matching the active agent binary version and point at the new endpoint;
  `/platform/{platform}/download` (bootstrap) is untouched and again always
  serves the combined MSI.
- Agent Packages UI gains a third tab "Update MSI (Bridge)".

**Combined MSI (installer.wxs) — script-free:**
- `WriteAgentConfig` → `techi-agent.exe bootstrap-config ...` (native Go,
  bootstrap_windows.go); public-desktop shortcut is now a declarative WiX
  component (`PublicDesktopShortcut`).
- `EnsureServiceCreated` → `techi-agent.exe watchdog-check`.
- `CreateRustDeskTrayTask` → `techi-agent.exe rs-tray-task` (task definition
  shipped as Task Scheduler XML via `schtasks /Create /XML` — keeps group SID
  S-1-5-32-545 and ExecutionTimeLimit PT0S which the schtasks CLI cannot express).
- `SetServiceRecovery` → direct `sc.exe failure ...`; `LockdownTechiDataDir`
  → direct `icacls.exe`; `KillTechiRS*`, `RemoveRustDeskTrayArtifacts`,
  `CleanupProgramData` → `cmd.exe /d /c` chains. No PowerShell anywhere in
  the normal install path.
- Intentionally still PowerShell (documented in the wxs): the four
  v1.0.4-legacy config backup/restore/registry-cleanup actions — they run
  before the new exe exists and only matter when upgrading from 1.0.4.

### Version

`agent/VERSION` bumped to 2.1.3 (binary gains bootstrap-config/rs-tray-task).
Standalone exe for upload: `/private/tmp/techi-agent-2.1.3-native-bootstrap.exe`
SHA256 `94a0bda42c929d2521b450f7edffd65dba04cc7fc36c1cf8a3faf2e55033874e`.
CI builds the three 2.1.3 MSIs on push.

### Checks

- `cd agent && go build ./...` (darwin + windows), `go test ./...` -> clean.
- `cd backend && python3 -m pytest` -> 363 passed (4 pre-existing
  enrollment-audit failures, unrelated).
- `cd frontend && npx tsc --noEmit && npm run build` -> clean.
- installer.wxs parses as XML; `powershell.exe` appears only in the four
  documented v1.0.4-legacy actions.

## [2026-07-03] INCIDENT: Server 90-99% CPU From 09:00 — Legacy Heartbeat Bridge + 60s Global Interval

### Root cause

Two compounding factors, both unrelated to the previous night's
self_update-classification deploy:

1. The v1 heartbeat endpoint gained a `background_tasks` parameter, but
   `legacy_compat.py` still called it as `agent_heartbeat(payload, db)`.
   Every legacy `/api/heartbeat` request raised, was answered with a bodyless
   204, and old agents treated it as failure and retried in a tight loop
   (~34 req/s). The flood began at exactly 09:00 local when the legacy-fleet
   client offices (zoomtrip, vasdream, Travel, Reservation-*, Remote-*)
   powered on — overnight traffic on that route was zero. This was the
   long-failing `test_current_v1_heartbeat_route_is_unchanged`.
2. The global agent heartbeat policy had been left at 60 seconds for the
   whole fleet (~600 online devices ≈ 10 heavy heartbeats/s on a 2 vCPU/2 GB
   host).

Additionally, leftover pre-2.1 agent services on those client machines
fire-and-forget POST `/api/heartbeat` with tiny timeouts; each request died
with a full ClientDisconnect traceback (~2 300/min of log spam).

### Fix

- `legacy_compat.py` now calls the v1 handler with a real `BackgroundTasks`
  and runs the side effects inline; known legacy devices again receive the
  JSON body old agents expect (commit `60576a7`).
- `_read_limited_body` swallows `ClientDisconnect` quietly (commit `107528c`).
- Global heartbeat policy raised 60 → 180 seconds (`/app/data/agent_policy.json`).
- `test_legacy_compat.py` updated to the core+background endpoint shape and
  extended with a regression test that a known legacy device gets a JSON body.

### Result

Backend CPU fell from pegged 90-99% to normal levels within minutes; v1
heartbeats settled at ~150/min; zero tracebacks. The ~2 200/min legacy churn
from leftover old services continues (cheap, bodyless) — the durable cleanup
is uninstalling the leftover legacy agent services on those fleets.

## [2026-07-03] v2.1.2: Script-Free Self-Update and Watchdog (AV/AMSI-Proof)

### Root cause

Devices in the GFFA and INDUSTRIALE domains run an AV policy that blocks
every PowerShell script the agent launches (AMSI:
"This script contains malicious content and has been blocked by your
antivirus software" — reproduced with a read-only diagnostic script on
device 112). Everything in the update chain depended on PowerShell:

- the 2.1.0 legacy agent runs `self-update-*.ps1` before msiexec;
- the 2.1.1 binary-swap agent writes `binary-swap-*.ps1` + a PS task launcher;
- the watchdog is a `.ps1` registered through PowerShell cmdlets;
- the Agent Update Bridge MSI custom action runs `agent-update-helper.ps1`.

On those domains self_update failed silently and expired as "timeout"
(devices 16 `PDC`/GFFA, 112 `PM-SRV`/GFFA, 451 `PDC`/INDUSTRIALE), while the
same payloads worked in seconds elsewhere (device 5 `PDC`/AGROBLEND0: 25 s).

### Fix (agent v2.1.2)

The swap and watchdog are now native Go code inside techi-agent.exe; the only
external process used is Microsoft-signed `schtasks.exe`. No `.ps1` files are
written or executed anywhere in the update chain:

- `agent/swap_windows.go` (new): `techi-agent.exe swap-binary` — stop
  TechiAgent via the SCM API, wait for full stop, kill lingering agent
  processes (gopsutil), backup, copy itself over the target, recreate the
  service if missing, reapply recovery actions, start, verify Running,
  rollback to backup on failure. Logs to deploy.log. Also
  `techi-agent.exe watchdog-check` — the watchdog body in Go.
- `agent/update.go`: self_update registers a one-shot SYSTEM task via
  schtasks.exe running the downloaded exe with `swap-binary`; both PS1
  template functions are deleted.
- `agent/watchdog_windows.go`: registers "TECHI Agent Watchdog" via
  `schtasks /SC MINUTE /MO 5` running `techi-agent.exe watchdog-check`;
  removes the stale `techi-agent-watchdog.ps1`.
- `agent/installer/agent-update.wxs`: the bridge custom action now runs
  `[BRIDGEFOLDER]techi-agent.exe swap-binary -swap-target ... -swap-api-url
  ... -swap-enrollment-token ...` directly; `agent-update-helper.ps1` is
  deleted from the package and repo. Config-preservation semantics are kept
  in Go (`ensureFreshAgentConfig`): existing configs are never touched, a
  minimal config is created only when none exists and a token was supplied.

Still PowerShell-dependent (out of scope, features rather than update path):
`run_powershell` action itself, `restart_agent` helper, patch-status
telemetry. These remain blocked on AMSI-strict domains.

### Version

`agent/VERSION` bumped to 2.1.2 (versioninfo.json + manifest updated).
Backend legacy classification (`BINARY_SELF_UPDATE_MIN_VERSION = 2.1.1`)
already routes 2.1.1 devices to the EXE payload, so the 2.1.1 fleet can be
updated to 2.1.2 from the UI. GitHub Actions builds the 2.1.2 MSIs on push.

### Rollout

1. Upload `/private/tmp/techi-agent-2.1.2-native-swap.exe` as
   `file_type=agent_binary`, windows-amd64, version `2.1.2`, activate. SHA256:
   `253e0c56c4540305f7b86fd15a5e37880598ef88827d67d98c97a6965365e8de`
2. Upload/activate the CI-built `TECHI-Agent-Update-2.1.2.msi` as
   `file_type=msi` (legacy 2.1.0 devices refuse UI updates until the MSI
   version matches the active binary).
3. Pilot on one AMSI-strict device (16/112/451 via GPO or manual msiexec of
   the 2.1.2 bridge MSI — their *current* agents still use PS, so the first
   hop cannot come from UI self_update on those domains).
4. After the first hop, UI self_update works everywhere, including
   AMSI-strict domains.

### Checks

- `cd agent && go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -> clean (vet warnings in inventory_windows.go pre-exist).
- `cd backend && python3 -m pytest` -> 359 passed; the 5 failures pre-exist
  (enrollment audit diagnostics + legacy compat, unrelated).
- Final exe strings confirm `2.1.2`, `swap-binary`, `watchdog-check`,
  `schtasks.exe`; no `binary-swap-*.ps1` templates remain.

## [2026-07-03] Fix: Legacy self_update Classification Must Use Version, Not Missing SHA

### Root cause

UI self_update to devices 603 (`PDC`), 604 (`FileSharing-SRV`), 714 (`AC-SRV`)
timed out. All three run 2.1.1 fleet builds deployed via bootstrap v2 that
predate the SHA-reporting rebuild: they use the binary-swap self_update flow
but never send `agent_sha256`.

`_requires_legacy_msi_self_update` treated "no agent_sha256" as "legacy
msiexec agent" and shipped them the Agent Update Bridge MSI payload
(`sha256` = MSI hash). The binary-swap agent downloaded the MSI, the checksum
matched, and it tried to install the MSI bytes as `techi-agent.exe`. The
service could not start, rollback restored the old exe, no failure was ever
reported, and the action expired at 900s as "timeout".

Fleet impact at the time of the fix: 115 online devices were in the same trap
(2.1.1 without SHA); only 6 devices reported SHA and got the correct payload.

### Fix

`agent_command_service.py`: legacy now means `agent_version < 2.1.1`
(`BINARY_SELF_UPDATE_MIN_VERSION`). Devices reporting `agent_sha256` are
always binary-swap; devices with missing/unparseable versions still fall back
to the MSI flow. 2.1.1+ agents get the EXE payload even without a reported
SHA — completion is still verified by heartbeat SHA because the new binary
reports it after the swap.

### Operations note

The 115 affected devices run the pre-scheduled-task swap helper (child
PowerShell). The payload is now correct for them, but their internal swap is
the unreliable one — retest on 714/603/604 first and roll out in waves ≤50.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 11 passed (new regression test: 2.1.1 without SHA gets binary payload).
- Full backend suite: 358 passed; 5 failures pre-exist without the change
  (enrollment audit diagnostics + legacy compat, unrelated).
- Deployed commit `620ea31` to production: backend rebuilt, `/health` ok,
  heartbeats flowing (~496/min), new constant present in the container.

## [2026-07-02] Fix: Platform Package Download Must Serve MSI, Not Agent Binary

### Root cause

After split packaging, production can have two active Windows packages at the
same time:

- `file_type=msi` for legacy MSI self-update/GPO;
- `file_type=agent_binary` for clean binary-only self-update.

The public `/agent-packages/platform/windows-amd64/download` endpoint used
`latest_active(platform)` without a file type. Once the active EXE was newer
than the MSI, this endpoint returned `techi-agent.exe` even though legacy agents
use it as an MSI URL.

### Fix

The platform download endpoint now explicitly selects
`latest_active(platform, file_type="msi")`.

`/agent-packages/agent-binary/download` remains the EXE endpoint.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_package_public_download.py tests/test_agent_command_service.py -q`
  -> 18 passed.
- `python3 -m compileall backend/app/api/v1/endpoints/agent_packages.py`
  -> clean.

## [2026-07-02] Packaging: Split Agent Update Bridge and Remote Support MSI

### Root cause

The existing production MSI is a combined endpoint package: it contains both
`techi-agent.exe` and the TECHI Remote Support runtime. That is correct for
full bootstrap, but it is risky for routine agent upgrades because a normal
MSI major upgrade can uninstall/reinstall remote support files while operators
still depend on remote access to recover devices.

Legacy agents also still expect an MSI payload for `self_update`; sending them
the new binary-only EXE causes `msiexec` failures.

### Fix

The combined MSI is kept as fallback/full-bootstrap. Two new split packages
were added:

- `agent/installer/agent-update.wxs`
  - builds `TECHI-Agent-Update-<version>.msi`;
  - carries only `techi-agent.exe` and `agent-update-helper.ps1`;
  - does not use the combined MSI `UpgradeCode`;
  - does not run `MajorUpgrade`;
  - does not ship or stop TECHI Remote Support;
  - stops only `TechiAgent`, writes a backup, copies the new exe, recreates the
    service if missing, sets service recovery, starts it, and rolls back on
    failure.
- `agent/installer/remote-support.wxs`
  - builds `TECHI-Remote-Support-1.4.6.msi`;
  - carries only the TECHI Remote Support runtime, protocol handler, service,
    tray scheduled task, and RS config;
  - contains no enrollment token flow and no agent config writes.

GitHub Actions now builds three artifacts on Windows:

- combined full-bootstrap MSI;
- agent update bridge MSI;
- remote support MSI.

### Rollout Rule

For the existing fleet, use the Agent Update Bridge MSI first. Do not replace
the combined MSI in every GPO until device #5 and a small pilot confirm:

1. `TechiAgent` updates to `2.1.1`;
2. heartbeat reports the expected agent SHA;
3. `TECHI Remote Support` still connects;
4. `agent.config.json` keeps the same device identity.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_update_bridge_installer.py tests/test_remote_support_installer.py tests/test_agent_command_service.py -q`
  -> 21 passed.
- macOS local WiX still cannot be used as the final MSI build authority for
  this repo; Windows GitHub Actions is the expected MSI build path.

## [2026-07-02] Fix: Legacy Agent self_update Must Not Receive EXE as MSI

### Root cause

Device #5 (`PDC`) was online and receiving actions, but remained on
`agent_version=2.1.0` with empty `agent_sha256`. The local deploy log showed
the old agent self-update path:

`msiexec.exe /i C:\ProgramData\TechiAgent\cache\techi-agent-2.1.1.msi`

followed by:

`result=1620 command=msiexec.exe`

MSI exit code `1620` means Windows Installer could not open the package as a
valid MSI. The backend was sending the new binary-only EXE endpoint, while the
legacy `2.1.0` agent saved the download as `.msi` and ran `msiexec`.

NETLOGON was also still advertising `active_version=2.1.0`, so the scheduled
GPO run correctly logged `result=uptodate` and never moved the machine to the
clean `2.1.1` build.

### Fix

`AgentCommandService` now builds `self_update` payloads per device:

- clean agents that report `agent_sha256` receive the binary-only EXE payload;
- legacy agents without `agent_sha256` must receive an active MSI package for
  the same target version;
- if a matching active MSI is missing, the backend rejects the UI command with
  a clear error instead of sending an EXE to an agent that will run `msiexec`
  and fail;
- legacy MSI payloads include `target_sha256`, so completion is still verified
  by the installed `techi-agent.exe` hash from heartbeat, not by the MSI hash.

### Operations Note

Production currently has active MSI `2.1.0` and active agent binary `2.1.1`.
That means legacy agents like device #5 cannot be safely updated from the UI
until a matching `2.1.1` MSI is uploaded/activated or NETLOGON/GPO is updated
once with the clean `2.1.1` installer.

### Checks

- `python3 -m compileall backend/app/services/agent_command_service.py backend/app/services/remote_action_service.py`
  -> clean.
- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 10 passed.

## [2026-07-02] Cleanup: Ignore RustDesk Repair Counters Older Than 24h

### Root cause

Resetting historical `rustdesk_repair_count` in the database is not enough by
itself. Older agents still have the cumulative repair counter in local config
and can resend it on the next heartbeat, causing old counts to reappear in the
UI.

### Fix

`DeviceHeartbeatService` now drops stale repair counters from heartbeat device
updates when `rustdesk_last_repair_at` is missing or older than 24 hours:

- `rustdesk_repair_count` is set to `0`;
- `rustdesk_last_repair_at` is set to `NULL`.

Recent repair counters inside the last 24 hours are preserved, so active repair
loops remain visible.

### Operations

Before deploying this backend filter, production historical repair counters
older than 24 hours were backed up to:

`device_repair_count_reset_20260702`

and reset for 314 devices.

### Checks

- `python3 -m compileall backend/app/services/device_heartbeat_service.py`
  -> clean.
- `cd backend && python3 -m pytest tests/test_rustdesk_repair_event_throttle.py tests/test_rustdesk_heartbeat_sync.py -q`
  -> 8 passed.

## [2026-07-02] Fix: self_update Batch Completion Must Wait for Heartbeat SHA

### Root cause

On device #5 (`PDC`), the agent reported `self_update` as completed, but the
next heartbeat still showed `agent_version=2.1.0` and empty `agent_sha256`.
This is the old false-positive behavior: older agents report that the
background swap was initiated, not that the new binary is actually running.

### Fix

Backend `RemoteActionService.complete()` now treats `self_update` specially:

- agent callback "complete" moves the action to `running` with
  `Self-update initiated; awaiting heartbeat verification` unless the device
  already reports the target version/SHA;
- `DeviceHeartbeatService` verifies running `self_update` actions after each
  heartbeat and marks them completed only when `agent_sha256` matches the
  active package payload;
- bulk `self_update` timeout is raised to at least 900 seconds so server
  swaps, restarts, and heartbeat verification have enough time.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 7 passed.
- `python3 -m compileall backend/app/services/remote_action_service.py backend/app/services/device_heartbeat_service.py backend/app/services/agent_command_service.py`
  -> clean.

## [2026-07-02] Fix: Watchdog Task Creation on Clean 2.1.1 Build

### Root cause

Device #11 successfully updated to the clean `2.1.1` binary and reported the
expected SHA256, but `Get-ScheduledTask -TaskName "TECHI Agent Watchdog"`
returned not found after service restart. The installed binary was correct;
the issue was in the watchdog registration script. It set repetition fields by
mutating `$repeatTrigger.Repetition.Interval` / `.Duration`, which is not
reliable across Windows PowerShell/ScheduledTasks implementations.

The agent service log path is:

`C:\ProgramData\TechiAgent\logs\agent.log`

not:

`C:\ProgramData\TechiAgent\agent.log`

### Fix

`agent/watchdog_windows.go` now creates the repeat trigger using the supported
parameters directly:

```powershell
New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
```

It also writes watchdog install success/failure to:

`C:\ProgramData\TechiAgent\deploy.log`

with `[watchdog-install]`, so failures are visible even when operators do not
know the agent log location.

### Final replacement binary

Upload this as `file_type=agent_binary`, platform `windows-amd64`, version
`2.1.1`, then activate it:

`/private/tmp/techi-agent-2.1.1-watchdog-fix.exe`

SHA256:

`264516f15e2fe26fccb334bb017845f4ecee7a4cb4b9711e9e3f437a3a216600`

### Checks

- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- Final binary strings confirm `2.1.1`, `TECHI Agent Watchdog`,
  `watchdog-install`, and `-RepetitionInterval`.

## [2026-07-02] Hardening: Same-Version Agent Rebuilds Verified by SHA256

### Root cause

Keeping the public agent version at `2.1.1` is correct, but version-only
comparison is not enough when we rebuild the same version to fix self-update,
watchdog, or deployment behavior. A device can report `2.1.1` while still
running an older `2.1.1` binary if the previous self-update did not complete.

Another old path was confusing the UI: some backend checks read the active
`windows-amd64` package without filtering `file_type="agent_binary"`, so they
could compare the fleet against the MSI package instead of the active
standalone agent binary.

### Fix

- The agent now sends `agent_sha256` during enrollment and every heartbeat.
- `devices.agent_sha256` stores the last reported hash.
- Fleet overview exposes both `active_agent_version` and
  `active_agent_sha256`.
- "Needs Agent Update" uses version plus SHA256 when the active package is an
  `agent_binary`.
- `/api/v1/agent-packages/active-version` now prefers the active
  `agent_binary` over the MSI package.
- Command Center target `outdated_agents` is now a real backend target for
  `self_update`; it queues only devices whose version or binary hash differs
  from the active agent binary.

### Final 2.1.1 binary for upload

Upload this as `file_type=agent_binary`, platform `windows-amd64`, version
`2.1.1`, then activate it:

`/private/tmp/techi-agent-2.1.1-clean.exe`

SHA256:

`f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`

### Checks

- `cd backend && python3 -m pytest tests/test_agent_package_public_download.py tests/test_device_scope.py tests/test_agent_command_service.py tests/test_remote_support_connect_url.py tests/test_enrollment_bootstrap_script.py -q`
  -> 144 passed.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- `cd frontend && npm run build`
  -> clean.
- Final binary strings confirm `2.1.1`, `TECHI-Agent-SelfUpdate`, and
  `TECHI Agent Watchdog`.

## [2026-07-02] Hardening: TechiAgent Watchdog Scheduled Task

### Root cause

Windows Service recovery actions restart `TechiAgent` after process failure,
but they do not reliably cover every operational case we hit during recovery:
manual stop, a service left stopped after an interrupted script, or a missing
service entry while `techi-agent.exe` still exists. Also, if `TechiAgent` is
already stopped, the agent process cannot execute code to start itself.

### Fix

`agent/watchdog_windows.go` adds a separate Task Scheduler watchdog:
- On agent startup, `ensureAgentServiceWatchdog()` registers/refreshes
  `TECHI Agent Watchdog` as `SYSTEM`.
- The task runs at Windows startup and then every 5 minutes.
- It checks `TechiAgent`; if stopped, it starts it.
- If the service entry is missing but
  `C:\ProgramData\TechiAgent\techi-agent.exe` exists, it recreates the service
  and starts it.
- It reapplies SCM failure actions
  `restart/60000/restart/60000/restart/300000`.
- It logs to `C:\ProgramData\TechiAgent\deploy.log` with `[watchdog]`.

Non-Windows builds use a no-op implementation.

### Checks

- Final same-version binary for upload:
  superseded by `/private/tmp/techi-agent-2.1.1-clean.exe`, SHA256
  `f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.

## [2026-07-02] Fix: Remote Support Connect Must Not Depend on Agent Heartbeat

### Root cause

During recovery, some machines had no TechiAgent heartbeat, so the platform
marked the device as offline and `/api/v1/remote-support/devices/{id}/connect-url`
returned `422 "Device is OFFLINE — cannot initiate remote session"`.

That block was too strict. TECHI Remote Support runs as a separate Windows
service and can still be reachable through its RustDesk/TECHI Remote ID even
when the monitoring agent is stopped, stuck in update, or missing heartbeat.
In this incident, blocking connect removed the exact fallback path operators
needed to inspect/recover the machine.

### Fix

`backend/app/api/v1/endpoints/remote_support.py`:
- `connect-url` still rejects devices with no valid TECHI Remote ID.
- It no longer rejects only because computed remote support status is
  `offline` from stale `device.last_seen`.
- Audit logs now include the computed `remote_support_status`, so operators can
  see whether the connection was attempted while heartbeat was stale.

`frontend/src/pages/RemoteSupport.tsx`:
- The Connect button is enabled whenever a TECHI Remote ID exists.
- If status is offline, tooltip now says "Agent heartbeat offline — try remote
  session" instead of disabling the action.

### Checks

- `cd backend && python3 -m pytest tests/test_remote_support_connect_url.py -q`
  -> 5 passed.
- `cd frontend && npm run build` -> clean.

## [2026-07-02] Fix: self_update Must Use Scheduled Task, Not Child PowerShell

### Root cause

Device 590 (`Server002`) accepted `self_update` for v2.1.1 and the action
completed with payload SHA256 `3f0917e245...`, but later heartbeats still
reported agent version `2.1.0`. The active uploaded binary was verified by
SHA256 and contained version string `2.1.1`, so the problem was not the UI
payload or the uploaded package.

The remaining unsafe part was `agent/update.go`: it launched the binary-swap
PowerShell helper as a child process of `TechiAgent` with
`CREATE_NEW_PROCESS_GROUP`. That is not a hard detach from the service's
process/job tree. When the helper stops `TechiAgent`, Windows can still
terminate that child helper before the swap finishes. This is the same class
of failure as the earlier v1 PowerShell rollout incident.

### Fix

`agent/update.go` now writes a small launcher PS1 that registers a one-shot
Scheduled Task named `TECHI-Agent-SelfUpdate-*` as `SYSTEM`, starts it, and
returns. The task runs the real binary-swap helper independently of the agent
process, then unregisters itself on success or failure. The swap still does
download verification before scheduling, stop -> backup -> replace -> start,
and rollback on failure.

Operator decision: keep the public agent version at `2.1.1` and rebuild/re-upload
the `agent_binary` package with the same version string but a new SHA256, rather
than creating `2.1.2`. Superseded by the final clean build above:
`/private/tmp/techi-agent-2.1.1-clean.exe`, SHA256
`f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`.

### Related GPO recovery hardening

`techi-deploy.cmd` generation now calls `:recover_missing_agent_binary` before
the `VERSION_STATE=equal` / `:already_uptodate` gate. If registry says the MSI
version is current but `C:\ProgramData\TechiAgent\techi-agent.exe` is missing,
the script restores one of the known incident backup names
(`techi-agent-new.exe`, `techi-agent-old.exe`, `techi-agent.new.exe`,
`techi-agent.previous.exe`) and starts the service. If no backup exists, it
forces `VERSION_STATE=missing` so the scheduled GPO run reinstalls from the
NETLOGON MSI instead of falsely treating the machine as up to date.

### Checks

- Active prod agent binary download SHA256 verified:
  `3f0917e245103dd9de0b4497c1f35e9d93e26f9827338de0415ea89dd0196de4`.
- Device 590 action history confirmed `self_update` completed but heartbeat
  stayed `2.1.0`, proving command completion alone was not sufficient evidence
  of swap completion.
- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -> 107 passed.
- `cd agent && GOOS=windows GOARCH=amd64 go build ./...` -> clean.
- Fixed same-version binary built with
  `AgentVersion=2.1.1`; strings confirm `TECHI-Agent-SelfUpdate-*` and `2.1.1`.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...` -> clean.

## [2026-07-02] INCIDENT: Fleet Bootstrap v1 Killed 253 Devices — Root Cause, Fix, Recovery

### Root cause

Gjatë përpjekjes për të instaluar binaryni e ri (v2.1.1) me `run_powershell`
te gjithë fleet-i (~624 devices), skripti i parë (v1) dërgoi `sc.exe stop
TechiAgent` nga brenda i njëjti PowerShell proces që kishte lançuar vetë
agjenti. Kur agjenti ndalet, Windows mund të kill-ojë child process-in
(PowerShell-in) si pjesë e i njëjtit job object. Ky kill ndodhte MES dy
`Move-Item` operacioneve (rename old → backup, rename new → current):
- `techi-agent.exe` u fshi (mov-uar te `techi-agent-old.exe`)
- `techi-agent-new.exe` nuk arriti të vendoset në vend
- Rollback-u nuk funksionoi (procesi ishte vrarë)
- Shërbimi nuk mund të rifillonte (exe mungonte)
- 175 device kaluan offline ndërmjet 13:39–13:42 (peak: 80 @ 13:40, 73 @ 13:41)

Problemi dytë: binari origjinal i vjetër (v2.1.0, SHA256 `5ee07dff...`,
instaluar nga MSI me 26 qershor) kishte kodin e vjetër të `update.go` me
`msiexec /i` dhe jo binary-swap. Ai shkruante helperin PS1 (`self-update-*.ps1`)
por PS1-i thirrte `msiexec` mbi një `.exe` — komanda dështonte pa log
(deploy.log mungonte). Kjo shpjegon pse `self_update` komanda tregonte
"Completed" por asgjë nuk ndodhte.

Gjithashtu: loop-i i pritjes pas `sc stop` dilte kur statusi bëhej
`StopPending` (jo `Stopped`) — procesi ishte akoma gjallë dhe mbante
lock-un mbi exe-n. `Move-Item` dështonte, catch block bënte rollback.

### Çfarë u fiksua

**`agent/update.go` commit `bcf0c24`:**
- Loop ndryshoi nga `while status != 'Running'` në
  `while status not in ('Stopped','missing')` — pret plotësisht
- `Stop-Process -Name techi-agent -Force` + 3 sekonda pas loop-it
- Kontroll eksplicit i file lock para rename-it

**Bootstrap manual njëherësh për DESKTOP-IM4V3G4 (device 11):**
Skript manual (jo nëpërmjet agjentit) i dërguar direkt; stop → kontroll
lock → swap → start. SHA256 `3f0917e245...` konfirmuar. v2.1.1 online.

**Bootstrap v2 (Scheduled Task) për fleet-in:**
Skript i ri me dy faza: (1) shkarkon binary-n dhe regjistron Scheduled Task
SYSTEM — pastaj del menjëherë pa pritur. (2) Task-u (SYSTEM, i pavarur)
kryen stop→swap→start. Kështu kill-i i agjentit nuk prek swap-in.
Rezultat: 186/440 completed ✅ (127 failed + 127 timeout = download overload
— 440 device njëkohësisht nga i njëjti backend endpoint i vogël).

### Gjendja pas incidentit (DB query 14:10)

```
online   : 430  (192 = v2.1.1 ✅,  236 = v2.1.0 akoma)
offline  : 286  (207 nga v2.1.0 batch v1,  6 v2.1.1 temp gjatë swap)
Datat e incidentit: 13:39–13:42 peak; 24 offline në 30 min e fundit
                    (scheduled tasks nga batch v2 duke bërë swap temp)
```

Të gjithë 430 online kanë `rustdesk_id` valid — RS funksionon.

### Recovery për device-t offline

**Script recovery (qasje fizike / RDP / mjet tjetër):**
```powershell
$d='C:\ProgramData\TechiAgent'
$exe="$d\techi-agent.exe"; $old="$d\techi-agent-old.exe"; $new="$d\techi-agent-new.exe"
if(-not(Test-Path $exe)){
    if(Test-Path $new){Move-Item $new $exe -Force}
    elseif(Test-Path $old){Move-Item $old $exe -Force}
}
net.exe start TechiAgent
```

**GPO Startup Script `techi-recovery.ps1`:**
Të shtuar te Metropol domain GPO → Computer Configuration → Scripts →
Startup: kontrollon nëse exe ekziston, e rivendos nga `*-new.exe` ose
`*-old.exe`, riniset shërbimi. Ekzekutohet automatikisht në reboot.

**Nëse asnjë exe nuk ekziston:**
```
msiexec /i \\METROPOLGROUP.LOCAL\NETLOGON\TECHI-Agent-2.1.0.msi /quiet
```

### Mësimet

- Kurrë mos ndalo shërbimin nga brenda child process-it të tij (run_powershell
  ekzekutohet si child i TechiAgent). Gjithmonë detach (Scheduled Task SYSTEM)
  para `sc stop`.
- Batch i madh njëkohësisht (440 download × 7MB) overload-on backend-in.
  Dërgo në grupe ≤50, prit 2 min mes grupeve.
- Testoji skriptet e reja te 1–2 device para dërgimit te gjithë fleet-i.

## [2026-07-02] Deploy stable/phase-2-heartbeat → prodhim (rdp.techi.com.al)

### Commits të deployu

- `e5d11f3` feat: binary-only self_update + Agent Binary tab
- `8a08665` fix: TOML read-only pas repair (rustdesk_repair_count)
- `1df0d46` fix: enrollment_token self-heal për device-t e bllokuara
- `137ecfb` fix: restore Windows Service TECHI Remote Support

### Hapat e deploy-it

```
git pull origin stable/phase-2-heartbeat   # 12 skedarë të re
docker compose build backend               # Python:3.12-slim, kodi i ri i ngarkuar
docker compose up -d backend               # Recreated → healthy
docker compose build frontend              # Node:20-alpine + npm run build (19s)
docker compose up -d frontend              # Recreated → healthy
```

### Health checks

- `curl http://127.0.0.1:8000/health` → `{"status":"ok","environment":"production"}`
- `docker compose ps` → të tre containers healthy (postgres, backend, frontend)
- `python3 -c "from app.schemas.agent_package import AgentFileType"` → OK
- `GET /api/v1/agent-packages/agent-binary/download` → HTTP 404 (endpoint aktiv, paketë e ngarkimit pritet)

### Hapi tjetër

Ngarko `techi-agent.exe` v2.1.1 te UI → Agent Packages → **Agent Binary tab** → Activate.
Dërgo `self_update` nga Command Center → device 11 → verifiko RS.exe SHA256 i pandryshuar.

## [2026-07-02] Binary-Only self_update: techi-agent.exe Swapped Without Touching TECHI Remote Support

### Arkitektura e re

Dy kategori të ndara paketash:
- **MSI** (`file_type=msi`): GPO, fresh install, PC të reja.
  Përmban techi-agent.exe + TECHI Remote Support bashkë.
- **Agent Binary** (`file_type=agent_binary`): vetëm techi-agent.exe.
  Përdoret nga komanda `self_update` përmes UI.
  TECHI Remote Support nuk preket kurrë.

### Ndryshimet

**Backend** (`agent_package_service.py`, `agent_package.py`,
`agent_packages.py`, `agent_command_service.py`):
- Shtohet `AgentFileType` enum (`msi` | `agent_binary`) te skema.
  Nuk nevojitet Alembic — hapësira e paketave është file-based (JSON
  manifest), jo tabelë DB.
- `upload()` pranon `file_type` (default `msi`); manifest-i ruan vlerën
  në çdo hyrje të re; hyrjet ekzistuese pa `file_type` lexohen si `msi`.
- `latest_active(platform, *, file_type=None)` mund të filtrojë sipas
  llojit; `set_active()` çaktivizon vetëm paketat e së njëjtës
  `platform + file_type` (kështu aktivizimi i MSI nuk çaktivizon
  binary-n dhe anasjelltas).
- Endpoint i ri `GET /api/v1/agent-packages/agent-binary/download` —
  kthen binary-n aktiv `agent_binary / windows-amd64`, publik (pa token).
  Vendoset para `/{package_id}/download` në router kështu FastAPI nuk
  e trajton `agent-binary` si një package_id.
- `_build_self_update_payload()` tani merr paketën `agent_binary` aktive
  dhe ndërton URL-në drejt endpointit të ri.

**Frontend** (`agentPackages.ts`, `AgentPackages.tsx`,
`AgentCommandsPanel.tsx`):
- `AgentPackage` interface fiton `file_type: AgentFileType`.
- `uploadAgentPackage()` dërgon `file_type` si form field.
- `AgentPackages.tsx` ka tani dy tab: **MSI Packages** dhe
  **Agent Binary** — secilit i shfaqen vetëm paketat e llojit të vet;
  upload-i ndryshon `accept` dhe dërgon `file_type` automatikisht.
- Modal i `self_update` te `AgentCommandsPanel` tani tregon paketën
  `agent_binary` aktive (jo MSI-n) dhe teksti i paralajmërimit
  është ndryshuar: "~30 sekonda" (jo "~2 minuta"),
  "TECHI Remote Support nuk preket".

**Agent Go** (`update.go`):
- `performSelfUpdate()` tani shkarkon `.exe` (jo `.msi`) dhe lançon
  një helper PowerShell të shkëputur (`binary-swap-*.ps1`) që bën:
  stop service → backup old exe → move new exe → start service →
  rollback automatik nëse start dështon. MSI (`msiexec`) nuk thirret
  kurrë gjatë self_update. TECHI Remote Support.exe nuk preket.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` — clean.
- `pytest` — 229 passed (4 gabime pre-ekzistuese DB, jo lidhur me
  ndryshimet tona).
- `tsc --noEmit` — pa gabime TypeScript.
- Deploy: backend `docker compose build backend && up -d backend`;
  frontend `npm run build` + sync; agent binary: shpërndarje vetëm
  e binarit Go (nuk kërkon MSI rebuild).

## [2026-07-02] RustDesk Periodically Wiped custom-rendezvous-server, Accumulating 40 000+ Repairs on Servers

### Root cause

The agent correctly repaired the managed `[options]` keys in
`TECHI Remote Support.toml` (custom-rendezvous-server, relay-server,
key) but left the file writable after every repair. When the
"TECHI Remote Support" Windows Service restarted (e.g., via the SCM
failure-recovery policy the agent itself sets -- 15 s/15 s/60 s),
RustDesk overwrote its own config, wiping those keys. The 30-minute
cooldown meant a repair every ~33 minutes; on long-running servers
this accumulated rustdesk_repair_count in the tens of thousands.

### Fix

`agent/rustdesk_readonly.go` (new, no build tag -- `os.Chmod` is
cross-platform):
- `setTomlReadOnly(path)` -- `os.Chmod(path, 0444)`, maps to
  `FILE_ATTRIBUTE_READONLY` on Windows. Logged on error, never
  propagated.
- `removeTomlReadOnly(path)` -- `os.Chmod(path, 0644)`, clears it.

`agent/rustdesk_manage.go`:
- `writeRustDeskConfig`: for each existing repaired file, calls
  `removeTomlReadOnly` immediately before `os.WriteFile` and
  `setTomlReadOnly` immediately after. Fresh file initialisation
  intentionally does NOT set read-only -- RustDesk must be able to
  write its own identity fields (id, enc_id, key_pair) on first run;
  the next heartbeat cycle patches and protects the file then.
- `setRustDeskPassword`: same remove-write-set pattern so UI password
  updates are not blocked by the read-only bit.

### Checks

`agent/rustdesk_readonly_test.go` (new):
- Patch + setReadOnly + simulate RustDesk overwrite -- write blocked,
  content unchanged.
- setReadOnly + removeReadOnly + write -- write succeeds.
- Two consecutive remove-patch-setReadOnly cycles -- file correct and
  read-only after both rounds.
- helpers on non-existent path -- no panic, only logs.
- `go test ./...` clean. No MSI rebuild needed -- binary-only fix.

## [2026-07-01] Device Aliases and Domain-to-Client Mapping

### Root cause

Some devices enrolled with generic Windows hostnames such as
`DESKTOP-...`, and some customer domains were very short, for example
`X`. The fleet tree used the automatically created client/domain name,
so operators could not safely present the real customer name without
risking future enrollments being assigned back to the old short domain
client.

The new Domain Mapping panel also showed existing trusted-domain
fallback rows with no explicit client mapping. Those rows appeared as
`Fallback by domain name`, which made the panel look like it contained
real mappings that operators had not configured.

### Fix

- Added editable device display names as UI aliases without renaming the
  Windows hostname or changing enrollment identity.
- Added trusted-domain-to-client mapping so a reported domain such as
  `x` can be mapped to the real client, for example `X-PlanStudio`.
- Kept fallback trusted domains working server-side, but hid fallback
  rows from the Domain Mapping panel unless they have a real `client_id`.
- Updated the Domain Mapping helper text and placeholder to use the
  exact domain value shown on devices, for example `x`, instead of
  suggesting `x.local` by default.

### Checks

- Added backend coverage for mapped trusted domains assigning new and
  existing devices to the configured client.
- Ran focused backend tests for trusted-domain mapping and Windows
  device classification.
- Ran the frontend production build.
- Deployed the mapping flow and the follow-up UI cleanup to production.
- Verified production containers are healthy and the frontend returns
  `200 OK`.

## [2026-06-30] Command Center Bulk Password Should Target Online Devices

### Root cause

Manual per-device `set_remote_password` worked, but several bulk
Command Center runs looked stuck as `running`. Production DB showed the
manual device-targeted batches completed, while older `all`/`client`
batches had `total=0` actions and therefore could never satisfy the
old `finished = total > 0 and done == total` check. Bulk password also
used a 30-second UI default timeout even though commands are delivered
on the next heartbeat, commonly every 60 seconds.

### Fix

Added an `online` bulk target. Operators can now send password rotation
to online devices only, avoiding offline devices that cannot pick up
the command until later. `set_remote_password` bulk timeout is now
raised to 300 seconds server-side even if an older UI sends a lower
value, and the UI default is also 300 seconds. Empty historical batches
now report `finished=true` with 100% progress instead of appearing to
run forever.
Batch creation is also atomic now: the backend no longer commits the
batch row before its per-device actions are added, so a transient error
cannot leave a new zero-target batch behind.
The confirm modal now submits as a real form, shows send errors inside
the modal, and refreshes Command History immediately after a batch is
created.
Large online batches now flush each `RemoteAction` through SQLAlchemy's
single-row insert path inside the same transaction. This avoids a
Postgres enum cast failure where the ORM's multi-row insert bound
`remote_actions.status` as `VARCHAR` instead of the `actionstatus` enum.

### Checks

- Added `backend/tests/test_agent_command_service.py` for online-only
  targeting, password timeout normalization, empty-batch progress, and
  normal completed-batch progress.
- Added coverage that an empty online target creates no batch/actions.
- Ran the new backend test file and frontend production build.
- Verified the frontend production build emits a new JS asset after the
  modal/history refresh fix.
- Verified from production logs that the bulk failure was a Postgres
  `actionstatus` enum mismatch during multi-row insert.

## [2026-06-28] GPO Token Repair Must Write Canonical Config Without UTF-8 BOM

### Root cause

On RHGDC1, the scheduled task upgraded the agent to 2.1.0, repaired
`agent.config.json` with the GPO enrollment token, and started the
service. A manual `techi-agent.exe -once` still failed immediately with:

`config migration failed: invalid character 'ï' looking for beginning of value`

The repair step wrote JSON using Windows PowerShell `Set-Content
-Encoding UTF8`, which on Windows PowerShell 5 emits a UTF-8 BOM. The
agent's Go JSON parser then rejected the canonical config before it
could enroll or send heartbeat.

### Fix

`techi-deploy.cmd` now writes repaired canonical config with
`System.IO.File.WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`
so the file is UTF-8 without BOM. The repair also rewrites any
unenrolled config that already has a token, which lets existing BOM
configs self-heal on the next scheduled task run without reinstalling.
After a repair-triggered service restart, the script now waits briefly
before validation so `deploy.log` does not record a false `result=failed`
while the service is still transitioning.

### Checks

- Updated bootstrap script tests to reject the old PowerShell
  `Set-Content -Encoding UTF8` writer and require the no-BOM
  `UTF8Encoding` writer.
- Added a check that repair-triggered restarts wait before final
  validation.

## [2026-06-28] GPO Equal-Version Devices Could Stay Unenrolled Without a Token

### Root cause

After the GPO Scheduled Task fixes, a Metropol test machine showed the
new task running and `techi-deploy.cmd` logging `result=uptodate`
because registry version was already 2.1.0 and `TechiAgent` was
running. The device still never appeared online because the agent log
repeated:

`enrollment_token is required when trusted domain auto-enrollment is
disabled or domain is not trusted`

This is a distinct equal-version stuck state: since the package was
already 2.1.0, GPO did not run `msiexec /i` again, so the MSI did not
rewrite the legacy config with `ENROLLMENT_TOKEN=...`. The running
agent had a canonical config with no `device_id`/`agent_id` and no
`enrollment_token`; it kept retrying enrollment without credentials.

### Fix

`techi-deploy.cmd` generation now calls `:repair_unenrolled_config`
before taking the `VERSION_STATE=equal` / `:already_uptodate` branch.
The repair is narrowly scoped: if canonical config exists (or can be
copied from legacy), has no `device_id`, no `agent_id`, and no
`enrollment_token`, it injects the current GPO token into canonical
config and restarts `TechiAgent` so the already-running process reloads
the token immediately. Already-enrolled devices or devices that already
hold a token are left untouched.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  the repair runs before `:already_uptodate`, patches only missing
  `enrollment_token`, logs `enrollment_token_repaired`, and restarts
  `TechiAgent` when it acts.

## [2026-06-28] GPO UI Script Now Removes the Legacy `TECHI Agent Startup` GPO

### Root cause

Domains that had already run older deployment scripts could still have
the separate `TECHI Agent Startup` GPO linked and active. The current
deployment model uses only two GPOs (`TECHI Agent - Defender
Exclusions` and `TECHI Agent Deployment`) and relies on the scheduled
task's own boot trigger for startup execution. Because the new script
only updated the two current GPOs, it left the old startup-script GPO
behind, creating a parallel deployment path and noisy/ambiguous client
diagnostics.

### Fix

`backend/app/services/enrollment_bootstrap_service.py`: the generated
UI GPO script now checks for `TECHI Agent Startup` immediately after
domain discovery. If present, it disables the GPO and deletes it with
`Remove-GPO`; if absent, it continues normally. Cleanup failures are
logged as warnings and do not block creating/updating the two current
GPOs.

Follow-up from real DC run: `Set-GPO` is not a valid GroupPolicy
cmdlet, so the cleanup warninged and continued. The cleanup now uses
real cmdlets: it enumerates domain/OU links with `Get-GPInheritance`,
disables matching links with `Set-GPLink -LinkEnabled No`, then deletes
the legacy object with `Remove-GPO`.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  legacy GPO cleanup and to keep guarding against reintroducing
  `Machine\Scripts\Startup` / `scripts.ini` startup-script plumbing.

## [2026-06-28] GPO Scheduled Task Was Applied but Not Created on Windows Server 2016

### Root cause

Metropol ALPHADB showed `TECHI Agent Deployment` as an applied computer
GPO, and Group Policy logged successful Scheduled Tasks Extension
processing, but `schtasks /query /tn "TECHI Agent Deploy"` returned
"file not found". NETLOGON was reachable, the current MSI and
`techi-deploy.cmd` were present, and a manual
`cmd /c "\\metropolgroup.local\NETLOGON\techi-deploy.cmd"` installed
2.1.0 successfully and brought the device online. Extracting the inner
Task Scheduler XML from `ScheduledTasks.xml` and registering it manually
failed on ALPHADB with `LogonType:ServiceAccount`; a direct `schtasks
/create /ru SYSTEM ...` worked. The GPP wrapper was fine, but the inner
Task Scheduler XML used `NT AUTHORITY\System` plus
`<LogonType>ServiceAccount</LogonType>`, which Server 2016 rejected.

The same run also exposed a false negative in `techi-deploy.cmd`:
`for /f "tokens=3"` over `sc query` captured the numeric state `4`,
not the text `RUNNING`, so deploy logged `result=failed` even though
MSI exit code was 0, registry version was 2.1.0, the service was
actually running, and heartbeats were arriving.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`: generated
  GPP ScheduledTasks XML now keeps the outer GPP `runAs`/`logonType`
  wrapper, but the inner Task Scheduler principal uses the locale-safe
  SYSTEM SID (`S-1-5-18`) and omits the inner
  `<LogonType>ServiceAccount</LogonType>`. This matches the manual DC
  patch that immediately made ALPHADB create `TECHI Agent Deploy` with
  boot + 09:00/13:00/21:00 triggers.
- `techi-deploy.cmd` generation now normalizes `sc query` state `4` to
  `RUNNING` before success validation/logging, preventing false
  `result=failed` entries after successful installs.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  `S-1-5-18`, absence of the inner `LogonType`, and service-state
  normalization.

## [2026-06-28] Devices Stuck Without a device_id Stayed Stuck Forever, Even After a Fresh, Valid Enrollment Token Was Written

### Root cause

Testing the restored Remote Support service (see entry below) on NODE02
surfaced a second, independent bug: after a clean MSI upgrade with the
correct, healthy "Metropol" enrollment token passed via
`ENROLLMENT_TOKEN=`, the device still failed every heartbeat with
"enrollment_token is required" and never got a `device_id`. The
deploy log showed `service_before=not-installed` before this run,
meaning NODE02's prior install was already in a broken state with no
TechiAgent service registered at all -- so it had likely never
completed a single successful enrollment.

There are two `agent.config.json` locations: the MSI's
`WriteAgentConfig` custom action always writes to the "legacy" path
(`C:\ProgramData\TECHI\agent.config.json`), but the agent binary itself
only ever reads `C:\ProgramData\TechiAgent\agent.config.json` (the
"canonical" path, `agent/paths.go`). A one-time bridge
(`migrateConfigIfNeeded`) is supposed to copy legacy into canonical,
but it only ran the copy if the canonical file was completely absent.
For a device whose canonical file already existed in a broken,
never-enrolled state (no `device_id`, no token -- from any earlier
crashed or interrupted install), the bridge saw "file exists" and did
nothing, forever -- even though every later MSI run kept writing a
perfectly valid, fresh token into the legacy file right next to it.
This is the same failure NODE04 hit earlier in this engagement, fixed
there with a one-time manual edit; NODE02 showed it is not a one-off
but a fleet-wide class of bug for any device that ends up in this
specific broken state.

### Fix

`agent/paths.go`: added `refreshEnrollmentTokenIfNeeded`, called from
`migrateConfigIfNeeded` whenever the canonical config already exists.
It only acts when the canonical file has no `device_id` and no
`enrollment_token` of its own, and the legacy file has a usable token
-- in which case it patches just the `enrollment_token` field into the
canonical file, leaving everything else (including a device that is
already enrolled, or already holds its own token) completely
untouched. This lets a stuck, never-enrolled device self-heal on its
next service start/heartbeat cycle, without needing the kind of
manual one-time fix NODE04 needed.

### Checks

- Added `agent/paths_test.go` covering: legacy-to-canonical copy when
  canonical is absent (pre-existing behavior), an enrolled device
  (`device_id` set) is never touched, a stuck unenrolled device gets
  its token refreshed from legacy, a stuck device that already has its
  own token is left alone, and a no-op when the legacy file is also
  missing.
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- all clean.
- Manual one-time recovery script provided for NODE02 in the meantime
  (writes the live "Metropol" token directly into the canonical file
  and restarts the service), mirroring the earlier NODE04 fix --
  this code change prevents needing that manual step on future
  devices that hit the same stuck state.

## [2026-06-28] Restored the Windows Service for TECHI Remote Support: --tray Alone Has No Daemon to Accept Connections

### Root cause

After fixing the GPO/NETLOGON and enrollment issues, NODE04 came back
online correctly (heartbeat, version 2.1.0) but "connect" from the
platform still failed, and `sc query`/`Get-Service` showed no
"TECHI Remote Support" service at all -- only the Scheduled-Task-
launched tray process. Earlier in this engagement, the Windows Service
for Remote Support was deliberately dropped in favor of a Scheduled
Task running `--tray`, on the theory that a SYSTEM-context service
(Session 0) can't do interactive screen capture. That theory was
wrong: RustDesk's own source (`src/platform/windows.rs`,
`get_create_service`/`install_service`) creates exactly this kind of
service to run its real connection daemon, and `--tray` (`core_main.rs`,
`tray.rs`) is documented in RustDesk's own comments as only showing an
icon -- "the tray icon is only shown when the service is running." A
tray-only install looks installed/running in monitoring but has no
daemon listening for incoming connections at all, so every connect
attempt fails. This was flagged as an open question earlier in this
engagement and deliberately deferred; revisited now that the
password/enrollment issues are resolved and this is the one remaining
blocker.

### Fix

Restored the service as the real daemon, keeping the Scheduled Task
+ `--tray` as a cosmetic companion icon (matches RustDesk's own
`install_service()`, which creates the SCM service AND drops a
`--tray` shortcut for the logged-on user -- the same hybrid, just via
a Scheduled Task instead of a Startup-folder shortcut):

- `agent/rustdesk_manage.go`: restored `ensureRustDeskService` /
  `setRustDeskServiceRecovery` (creates/starts the SCM service if
  missing or stopped, with an auto-restart failure policy) and added
  `stopRustDeskServiceFn` / `startRustDeskServiceFn` for action
  handlers. `ensureRustDesk`'s heartbeat loop now ensures both the
  service (primary) and the tray (cosmetic) every cycle. Kept the
  TOML-based `setRustDeskPassword` from the earlier fix -- it works
  the same regardless of service vs. tray.
- `agent/actions_windows.go`: `restart_rustdesk`, `reinstall_rustdesk`,
  `reopen_rustdesk`, `repair_config_rustdesk`, `set_remote_password`,
  and `deploy_remote_support`'s Phase 6 all now stop/start the service
  as the primary action, with the tray restarted alongside it
  (non-fatal if the tray step fails).
- `agent/installer/installer.wxs`: restored the
  `ServiceControl Id="StopTechiRemoteSupport"` (stop-on-uninstall)
  that was removed earlier -- the service itself is still created at
  runtime by the agent (`sc create`), not declaratively by the MSI,
  matching how it has always worked. Updated the comments that
  asserted the now-corrected "no service, Session 0" rationale on
  `REMOTESUPPORTFOLDER`, `KillTechiRSBeforeInstall`,
  `RemoveRustDeskTrayArtifacts`, and `CreateRustDeskTrayTask`.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean.
- `wix build` against the modified `installer.wxs` (with fake
  `-d SourceDir`) produces the exact same `WIX0200`/`WIX0389` errors,
  same count, as the unmodified file on this macOS/mono host -- a
  known pre-existing host limitation, not a regression. A Python
  regex scan confirms zero literal `--` sequences inside any XML
  comment (the recurring WIX0104-class bug from earlier in this
  engagement).
- Not yet verified on a real machine with the new MSI -- pending CI
  build and a fresh test on NODE04.

## [2026-06-28] techi-deploy.cmd's :read_registry Was Silently Broken on Every Run, Forcing Unnecessary Reinstalls Fleet-Wide

### Root cause

The real explanation for "650 devices offline" on metropolgroup.local,
found by reproducing on NODE04 with a clean, non-wrapped invocation
(`& $DeployScript` directly from PowerShell, no `cmd.exe /c` involved
at all): `techi-deploy.cmd`'s `:read_registry` label printed "The
syntax of the command is incorrect." -- twice, matching its two call
sites -- on every single run, regardless of how the script was
invoked. Its one-liner nested three layers of quoting (batch
`for /f ... in ('...')` + a PowerShell `-Command` string + a regex
inside that), and that combination was malformed. Because the `for /f`
command itself failed to even parse, it produced no output to
capture, so `REG_VERSION`/`REG_PRODUCT_CODE`/`VERSION_STATE` always
kept their pre-set defaults (`missing`) -- even on machines where
TECHI Agent was correctly installed. `techi-deploy.cmd` then always
took the `:do_install` branch and ran `msiexec /i ... ENROLLMENT_TOKEN=...`
on every scheduled run (09:00/13:00/21:00), on every domain machine,
regardless of whether anything actually needed installing.

This single bug explains both incidents from today: the original mass
offline report (forced reinstalls fleet-wide since whenever this
`:read_registry` version was deployed) and the NODE04/DC device_id
loss after manually triggering `techi-deploy.cmd` for diagnosis --
both are the same forced-reinstall path firing when it never should
have. (An earlier theory blaming an expired "Internal gpo bootstrap"
token was wrong and retracted: the actual embedded token, "Metropol",
is healthy -- active, no expiry, 187/400 uses.)

### Fix

Replaced the single-line `-Command` with a `-EncodedCommand` (base64
UTF-16LE) invocation -- the same pattern already used safely elsewhere
in `installer.wxs` -- eliminating all nested-quoting risk entirely
(the encoded blob is pure base64, no characters that batch or
PowerShell could misinterpret). The script now writes its output to a
temp file (`%TEMP%\techi-read-registry.out`) instead of being captured
via `for /f in ('command')`, and batch reads that file directly.
`enrollment_bootstrap_service.py` keeps the literal PowerShell source
in a comment above the encoded constant (`_READ_REGISTRY_ENCODED_COMMAND`)
so it stays human-reviewable and regeneratable.

### Checks

- Generated the actual `techi-deploy.cmd` content locally via
  `EnrollmentBootstrapService._gpo_scheduled_task_setup` and confirmed
  the embedded command line decodes (base64 + UTF-16LE) back to the
  intended PowerShell source byte-for-byte; full line length 3198
  chars, well under cmd.exe's 8191 limit.
- `pytest tests/test_enrollment_bootstrap_script.py -q` -- 105 passed
  (two tests that asserted on the old inline PowerShell text now
  decode `_READ_REGISTRY_ENCODED_COMMAND` and assert against that).
  `pytest tests/ -k "bootstrap or enrollment"` -- 119 passed.
- Not yet re-verified on a real domain machine (this fix isn't on
  NETLOGON yet -- `techi-deploy.cmd` only gets rewritten when the GPO
  admin re-fetches `/api/v1/bootstrap/gpo-deploy.ps1?token=...`;
  pending explicit go-ahead before pushing that to metropolgroup.local
  again given today's history).

## [2026-06-28] GPO/NETLOGON Domain Deployment Was Silently Serving a Stale MSI (metropolgroup.local)

### Root cause

Urgent report: devices on the "metropolgroup.local" domain hadn't come
online via the scheduled GPO deployment, and a server that did enroll
via GPO had the wrong Remote Support password. Both traced to the same
cause: `_gpo_scheduled_task_setup`'s "Hapi 4b" only re-downloads the MSI
into `\\<domain>\NETLOGON\TECHI-Agent-<version>.msi` when the version
*string* differs from `techi-version.txt`, or the file is missing.
Since `ProductVersion` intentionally stayed at 2.1.0 through every fix
from the last two days (per standing instruction not to bump it), the
NETLOGON copy was never refreshed even though the GPO admin re-ran the
setup script today (confirmed: GPO objects and `techi-deploy.cmd` were
freshly rewritten at 00:41 today, but `Get-FileHash` on the NETLOGON
MSI showed `cd7a6d3d...`, last written 2026-06-26 17:49 -- two days
before today's password/Scheduled-Task fixes -- while the backend's
currently published MSI hashes to `a58e6702...`). Every domain machine
running off NETLOGON was therefore stuck on a build from before all of
today's fixes, regardless of how many times the platform itself was
redeployed.

### Fix

No code change -- this was an operational/process gap, not a bug in
this session's commits. Diagnosed via a read-only PowerShell script
(domain info, `techi-version.txt` + NETLOGON MSI hash/timestamp,
hash of the currently published backend MSI for comparison, GPO object
status) run directly on the domain's DC, then resolved by downloading
the current backend MSI and overwriting the NETLOGON copy + version
file directly (without touching GPO objects or `techi-deploy.cmd`).

### Checks

- Diagnostic script confirmed the hash mismatch (`cd7a6d3d...` vs.
  `a58e6702...`) conclusively before taking any action.
- After the refresh: `Get-FileHash` on
  `\\metropolgroup.local\NETLOGON\TECHI-Agent-2.1.0.msi` matches the
  backend's published hash exactly. The next scheduled GPO run
  (09:00/13:00/21:00) will install the current build on affected
  machines.
- Follow-up implemented same day (user approved): `_gpo_scheduled_task_setup`'s
  Hapi 4b now always downloads the current backend MSI to a temp path,
  hashes it, and only overwrites the NETLOGON copy when the hash
  differs from what's already there -- the version string is still
  used for the filename/cleanup, but no longer gates whether a refresh
  happens. This trap cannot recur regardless of whether ProductVersion
  changes. `pytest tests/test_enrollment_bootstrap_script.py -q` --
  105 passed (two tests updated for the new hash-compare flow).

## [2026-06-28] Password Write Found Nothing to Patch: the Identity File Gets Deleted, Then Never Waited For

### Root cause

Fourth real-machine test of the just-deployed TOML-write fix: zero log
lines from the password step at all -- not even the "skipped: no
password configured" fallback. The bootstrap script's own earlier
cleanup loop (`$TechiRoots` / `Get-ChildItemSafe -Path $ConfigDir |
... Remove-Item -Recurse`) deletes every file under each root's
`config\` directory, including the suffix-less identity TOML that
holds `password`/`salt`/`id`. Nothing in this script recreates that
file -- only RustDesk itself does, once it actually runs. The new
password-write block ran *before* the Scheduled Task was even
triggered, so every candidate path was missing, `Test-PathSafe`
returned false for all of them, and the function silently returned
`$false` with no logging at all -- exactly the silence observed.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`: moved the
  Scheduled Task start (now with a 6s wait, was 2s) to *before* the
  password-write block, since RustDesk needs to actually run once to
  recreate the identity file the cleanup loop just deleted. The
  password loop now retries once more after a 5s wait if nothing was
  found the first time, and logs explicitly either way ("identity TOML
  not found yet -- waiting... retrying" / a final WARNING if still not
  found after both attempts) instead of failing in total silence.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (ordering assertion flipped back, two new assertions
  for the retry/visibility logging).
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean (no Go changes this entry, re-verified
  anyway since the agent shares `rustDeskConfigDirs()`/file-patch
  logic conceptually).
- Generated the real script locally via
  `EnrollmentBootstrapService._rustdesk_force_migration_ps_lines` with
  a dummy payload to confirm the literal generated PowerShell matches
  what's described above, rather than trusting the Python source alone.
- Not yet verified on a real machine for this specific reorder -- this
  directly follows from the previous entry's real-machine test result.

## [2026-06-28] Set the Remote Support Password by Writing the Identity TOML Directly, Not via --password CLI

### Root cause

Third real-machine test: the Scheduled Task now registers and runs (the
GroupId/logging fix worked), but the password still didn't take effect.
Re-reading the actual RustDesk source (vendored locally) settled this
properly instead of guessing further:

- `--tray` (`core_main.rs`) only ever calls `tray::start_tray()` -- a thin
  UI client. The actual daemon only starts via `--service` (SCM) or
  `--server`. `tray.rs` even says outright: "The tray icon is only shown
  when the service is running." So today's earlier architecture change
  (dropping the Windows Service in favor of Scheduled-Task-launched
  `--tray`) left no daemon for the `--password` CLI to talk to over IPC
  at all -- explaining why it kept failing regardless of timing fixes.
  (Whether to bring the Service back is a separate, bigger decision the
  user wants to defer; not done in this entry.)
- Separately, and independent of the service question:
  `hbb_common/src/config.rs` shows `Config` (id/enc_id/password/salt/
  key_pair) loads from the **suffix-less** file
  (`Config::load_::<Config>("")`), while `Config2` (rendezvous_server/
  nat_type/serial/options) loads from the **"2"-suffixed** file
  (`Config::load_::<Config2>("2")`). Critically,
  `migrate_permanent_password_to_hashed_storage` runs on every config
  load/store: if `password` is plaintext (not already a recognized
  hashed/encrypted format), it computes the proper hash using `salt` and
  rewrites it -- meaning a plaintext password written directly into the
  TOML file gets picked up and hashed correctly the next time RustDesk
  loads or saves that file, with **no daemon and no IPC required**.

### Fix

- `agent/rustdesk_toml.go`: added `applyTOMLTopLevelPatch(content, key,
  value)` -- patches a single top-level `key = 'value'` pair that lives
  before any `[section]`, preserving everything else (including any
  `[options]` section). Inserts before the first section if the key is
  missing.
- `agent/rustdesk_manage.go`: `setRustDeskPassword` rewritten to use this
  to patch `password` into the suffix-less identity TOML across all of
  `rustDeskConfigDirs()`'s candidate locations, instead of shelling out to
  `<exe> --password <value>`.
- `backend/app/services/enrollment_bootstrap_service.py`: removed
  `Get-TechiExecutable` and the CLI-based password block entirely (no
  longer needed); added `Set-TechiPermanentPasswordSafe`, the PowerShell
  equivalent in-place patch, run against `TECHI Remote Support.toml`
  (not the "2" file) under every `$TechiRoots` candidate.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean. Added 4 new tests for
  `applyTOMLTopLevelPatch` (update existing key, no-op when unchanged,
  insert before first section, ignore a same-named key inside a
  `[section]`).
- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (CLI-based password assertions replaced with the new
  TOML-write ones); `pytest tests/ -k "bootstrap or enrollment"` -- 119
  passed.
- Not yet verified on a real machine for this specific change.
- Flagged but explicitly deferred per user request: `rustdesk_manage.go`'s
  config-repair (`managedRustDeskOptions`/`writeRustDeskConfig`) writes
  `rendezvous_server`/`[options]` into the suffix-less file too, but per
  the source mapping above those fields belong in the **"2"-suffixed**
  file (`Config2`) -- the agent's own repair pass may have been
  inert/no-op against a file RustDesk's `Config` struct doesn't define
  those fields on. The backend bootstrap script already targets the
  correct "2" file for those fields. Worth a dedicated look in a future
  session; out of scope here.

## [2026-06-27] Scheduled Task Silently Failed to Register; Password CLI Needs the Daemon Already Running

### Root cause

Second real-machine test (after the previous entry's fixes) showed the
orphaned service was correctly removed, the password CLI now found the
right executable, and logged "configured" -- but the password still
didn't take effect, and the log showed:
`WARNING: TECHI Remote Support Tray Scheduled Task not found`. Two
separate bugs, the first causing the second:

1. `CreateRustDeskTrayTask` (installer.wxs) used
   `New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users'`. This is the
   same class of bug already learned the hard way with `icacls` earlier
   in this session: friendly group names aren't reliable across
   locales/contexts, and the failure was completely invisible because
   the CustomAction has `Return="ignore"` and had no logging of its own.
2. Checking the actual RustDesk source (`src/core_main.rs` /
   `src/ipc.rs`, vendored locally) confirms `--password` connects to the
   *already-running* daemon over IPC (`set_permanent_password_with_ack_async`,
   1s timeout) and applies it there -- it does **not** write the config
   file directly. Critically, `core_main.rs`'s `--password` branch only
   `println!`s on failure; it never sets a non-zero process exit code.
   So when no daemon is running (exactly the situation here, since the
   Scheduled Task never got created), the CLI still exits 0 and our
   wrapper logs "configured" even though nothing happened. The bootstrap
   script's existing order (set password, *then* restart) was backwards
   for this reason regardless of bug #1.

### Fix

- `agent/installer/installer.wxs`: `CreateRustDeskTrayTask` rewritten as
  an `-EncodedCommand` (was a raw `-Command` one-liner) so it can
  properly try/catch and log every step to
  `C:\ProgramData\TECHI\logs\deploy.log` instead of failing in total
  silence. `-GroupId 'BUILTIN\Users'` replaced with the locale-safe SID
  `S-1-5-32-545` (the "Users" group). Also switched from the
  `[REMOTESUPPORTFOLDER]` WiX token to `$env:ProgramFiles` inside the
  script, since a property substitution into the middle of a base64
  blob wouldn't have worked anyway.
- `backend/app/services/enrollment_bootstrap_service.py`: swapped the
  order in `_rustdesk_force_migration_ps_lines` -- start the Scheduled
  Task first (4s wait for the daemon to come up), *then* attempt
  `--password`. Updated the log line to note the exit-0-on-failure
  caveat so it doesn't read as a false-positive guarantee again.
- `agent/rustdesk_manage.go`: `ensureRustDesk` now sleeps 4s before
  `setRustDeskPassword` specifically when `ensureRustDeskTrayRunning`
  just triggered a fresh start in the same call (not on every
  heartbeat) -- same IPC-needs-the-daemon-up reasoning, scoped to the
  one situation where it actually matters.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (re-ordering assertions flipped/renamed).
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean.
- Decoded the new `-EncodedCommand` base64 back to UTF-16LE text and
  diffed it against the intended script to confirm it matches exactly.
- `installer.wxs` re-verified well-formed, no `--`-in-comment regressions.
- Not yet verified on a real machine -- this is a same-day follow-up to
  a test that's still in progress.

## [2026-06-27] Bootstrap Script Still Assumed a Remote Support Windows Service After It Was Removed

### Root cause

Real-machine test of the "Safe one-time/manual command" bootstrap (and the
shared GPO bootstrap path -- both call the same
`_rustdesk_force_migration_ps_lines` generator in
`enrollment_bootstrap_service.py`) surfaced two bugs left over from
dropping the Remote Support Windows Service earlier today:

- `Get-TechiExecutable`'s candidate paths only listed `rustdesk.exe`,
  never the actual shipped binary name `TECHI Remote Support.exe` --
  log showed `WARNING: TECHI Remote Support password not set because
  rustdesk.exe was not found.` every time, on every device.
- The script still did `Stop-Service` / `Start-Service` against a
  `TECHI Remote Support` service name. On the test device this found
  an orphaned service left over from an earlier build *this session*
  (before the Program Files + Scheduled Task fix) and happily
  restarted it -- putting Remote Support right back into the broken
  Session 0 state the rest of today's work was meant to eliminate.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`:
  `Get-TechiExecutable`'s candidates now include
  `TECHI Remote Support.exe` (Program Files, both archs) ahead of the
  legacy `rustdesk.exe` names. The service stop-loop now deletes
  (`sc.exe delete`) any matched service instead of just stopping it --
  there's no legitimate reason for one to exist anymore. The final
  "restart" step no longer does `Start-Service`; it instead does
  `Get-ScheduledTask`/`Start-ScheduledTask` against the
  `TECHI Remote Support Tray` task installer.wxs creates.
- `agent/installer/installer.wxs`: `KillTechiRSBeforeInstall` (runs
  before `InstallFiles` on every install/upgrade, see the entry below)
  now also runs `sc.exe delete "TECHI Remote Support"`. This closes the
  same gap at the MSI level so it's covered regardless of which outer
  deployment path triggered msiexec (raw `msiexec /i`, GPO
  `techi-deploy.cmd`, or either bootstrap script) -- `RemoveRustDeskTrayArtifacts`
  only runs on a full uninstall, never on a normal upgrade, so without
  this the orphaned service would otherwise survive upgrades indefinitely.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (2 assertions updated for the new Scheduled-Task-based
  restart wording, 1 new test added for the orphaned-service deletion).
- `installer.wxs` re-verified well-formed, no `--`-in-comment regressions.
- Real-machine result that surfaced this: manual install of this MSI
  over an existing 2.1.0, then 2.0.0, then 2.1.0 again all completed
  without the device going offline (the InstallFiles fix from the entry
  below appears to be working) -- only the bootstrap script's own
  service-restart/password-exe-name bugs remained, both fixed here.

## [2026-06-27] Devices Going Offline During 2.0.0 -> 2.1.0 Upgrade: Kill Remote Support Before InstallFiles, Not Just Before Uninstall

### Root cause

User reported many devices going offline specifically because the
2.0.0 -> 2.1.0 upgrade fails to complete (fails to remove 2.0.0 / install
2.1.0). The 2.0.0 MSI (inspected directly via `msiinfo`) does not bundle
Remote Support at all -- on the real fleet, Remote Support was installed
separately via `TECHI-Remote-Support.iss` (Inno Setup), running as
`rustdesk.exe` in `C:\Program Files\TECHI Remote Support\`, always
running as a persistent tray app once a user has logged on.

2.1.0's `installer.wxs` bundles Remote Support in the *same* MSI
transaction as the agent, writing files (`librustdesk.dll`,
`flutter_windows.dll`, `data\*`) into that same Program Files directory.
`KillTechiRS` (which terminates the Remote Support process) was only
scheduled `Before="RemoveFiles" Condition="REMOVE~=\"ALL\""` -- i.e. only
during a *full uninstall*, never during a normal install/upgrade. Since
Remote Support is essentially always running on a real device, MSI's
`InstallFiles` standard action would try to overwrite DLLs that Windows
has locked open in the running `rustdesk.exe` process, causing the file
write to fail. A failure during `InstallFiles` can roll back the *entire*
MSI transaction -- including the agent's own file/service upgrade in the
same package -- which plausibly explains devices stuck mid-upgrade,
neither cleanly on 2.0.0 nor 2.1.0, and consequently offline. `KillTechiRS`
also only killed the branded `TECHI Remote Support.exe` name, never the
legacy `rustdesk.exe` name the existing Inno-installed fleet actually
runs under.

### Fix

`agent/installer/installer.wxs`:
- `KillTechiRS`'s `taskkill` now targets both `TECHI Remote Support.exe`
  and the legacy `rustdesk.exe` process name.
- Added `KillTechiRSBeforeInstall` (same kill logic, separate CustomAction
  Id since the same Id can't be scheduled twice), scheduled
  `Before="InstallFiles" Condition="NOT REMOVE"`. This runs on every
  fresh install (no-op, nothing running yet) and every upgrade (kills
  any already-running Remote Support -- whether from the Inno installer
  or a previous MSI build -- before the new files are written), removing
  the file-lock collision that could break the whole upgrade transaction.

### Checks

- XML re-verified well-formed, no `--`-inside-comment regressions.
- Not yet verified on a real machine / MSI build, intentionally (per
  explicit instruction not to trigger a build yet). Devices already
  stuck in a failed/offline state from a *past* upgrade attempt will
  need the fixed MSI redeployed (e.g. on next GPO retry cycle); this fix
  prevents the failure going forward, it does not retroactively repair
  an already-broken local install state.

## [2026-06-27] Remote Support "Not ready": Drop the SCM Service, Go Back to Program Files + Logon Scheduled Task

### Root cause

Earlier this session, "TECHI Remote Support" was moved from Program Files
to ProgramData, and a Windows Service (`sc create ... --service`) was added
so the agent could "ensure" it stays running. Both changes were wrong,
discovered by comparing against `TECHI-Remote-Support.iss` (the real,
proven Inno Setup installer used historically, found locally alongside the
actual RustDesk fork source) and `enrollment_bootstrap_service.py`'s own
exe-path candidates (`C:\Program Files\TECHI Remote Support\rustdesk.exe`):

- The proven installer puts the exe in **Program Files**, not ProgramData.
  Moving it to ProgramData (to match the agent's own, apparently
  outdated, assumption) went the wrong direction.
- The proven installer never creates a Windows Service for Remote Support
  at all. It only installs files and optionally adds a Startup-folder
  shortcut that launches `rustdesk.exe --tray` at user logon -- an
  interactive, per-session launch. A Service we added instead runs as
  SYSTEM in **Session 0**, which cannot do interactive screen capture,
  which is exactly why the app showed "Not ready. Please check your
  connection" even with heartbeats arriving fine, and why behavior
  differed between the tray icon and a Desktop-launched instance.

### Fix

- `agent/installer/installer.wxs`: `REMOTESUPPORTFOLDER` moved back under
  `ProgramFiles6432Folder` (was `CommonAppDataFolder`/ProgramData).
  `TECHI_RS_EXE` search path updated to match. Removed the
  `ServiceControl` for "TECHI Remote Support" (no service exists anymore).
  Added `CreateRustDeskTrayTask`: registers a Scheduled Task ("At Logon",
  runs as the interactive user via `BUILTIN\Users` principal,
  `ExecutionTimeLimit` 0 so it isn't killed after 72h) that launches
  `TECHI Remote Support.exe --tray`, then immediately does `schtasks /run`
  against it once so a manual/interactive install opens Remote Support
  right away (matching old behavior) instead of waiting for the next
  logon -- an "At Logon" trigger never fires for a session that's already
  active. On an unattended `/quiet` GPO install with nobody logged on,
  this `/run` is a harmless no-op; the task still fires normally at the
  next real logon. Renamed `DeleteTechiRSService` to
  `RemoveRustDeskTrayArtifacts`: unregisters the Scheduled Task on
  uninstall, and still runs the old `sc delete` as a no-op safety net for
  any device that already has the now-removed service registered from a
  build during this session.
- `agent/rustdesk_manage.go`: removed `ensureRustDeskService` /
  `setRustDeskServiceRecovery` and the `rustdeskServiceName` SCM
  machinery entirely. Added `isRustDeskProcessRunning` (tasklist-based),
  `ensureRustDeskTrayRunning` (nudges via `schtasks /run` against the
  installer's task if not running), and `stopRustDeskTray` /
  `startRustDeskTray` helpers used by the remote actions. Path constants
  changed back to Program Files.
- `agent/rustdesk.go`: `discoverRustDeskWindows`'s path candidate list
  reordered so Program Files is checked first; ProgramData/LOCALAPPDATA
  remain fallbacks for the brief window devices may have picked up the
  wrong location.
- `agent/actions_windows.go`: `handleRestartRustDesk`,
  `handleReinstallRustDesk`, `handleReopenRustDesk`,
  `handleRepairConfigRustDesk`, `handleSetRemotePassword`, and
  `handleDeployRemoteSupport`'s service-ensure phase all switched from
  `sc stop`/`sc start`/`ensureRustDeskService` to
  `stopRustDeskTray`/`startRustDeskTray`/`ensureRustDeskTrayRunning`.
  Protocol-handler registry value paths reverted to Program Files.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`, `go vet
  ./...` (native and Windows cross-compile) -- clean.
- `go test ./...` -- all existing tests pass unchanged.
- `installer.wxs` checked for the recurring `--`-inside-XML-comment bug
  (none found) and confirmed well-formed via `xml.dom.minidom`. A local
  `wix build` was attempted for schema validation but `wix.exe` only
  partially works on macOS (`WIX0000: only supports Windows`); confirmed
  via the *same* error appearing against the unmodified original file
  that this is a pre-existing host limitation, not a regression --
  real validation still requires the Windows CI build (not run yet, per
  explicit instruction, pending more items to batch).
- Not yet verified on a real machine / MSI build, intentionally.

## [2026-06-27] New Managed RustDesk Options Were Blocked by the 30-Minute Repair Cooldown

### Root cause

The previous entry added `enable-remote-config-modification = 'Y'` to
`managedRustDeskOptions`, but the user reported it had no effect after
upgrading and retesting. `ensureRustDesk`'s config-repair cooldown
(`cfg.RustDeskLastRepairAt`, 30 minutes) is persisted in
`agent.config.json` and survives MSI upgrades by design (so device_id and
other identity data aren't disturbed). Since this device had been
repaired/upgraded repeatedly within the same hour during testing, the
timestamp was always recent, so the cooldown silently skipped
`writeRustDeskConfig` every time -- the new agent code was correct and
deployed, but never actually got to run on this device. This is a real
bug, not just a testing artifact: it means *any* future change to
`managedRustDeskOptions` would take up to 30 minutes to reach
already-enrolled devices, fleet-wide, even in production.

### Fix

- `agent/rustdesk_toml.go`: added `rustDeskOptionsSchemaVersion` constant
  (bump whenever the managed-keys set changes).
- `agent/config.go`: added `Config.RustDeskOptionsSchemaVer` (persisted).
- `agent/rustdesk_manage.go`: `ensureRustDesk` now bypasses the cooldown
  once whenever `cfg.RustDeskOptionsSchemaVer != rustDeskOptionsSchemaVersion`
  (i.e. right after an agent upgrade that changed the managed-keys set),
  then persists the new schema version once the repair succeeds.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Immediate workaround for retesting on the affected device without
  waiting for this fix to ship: edit
  `C:\ProgramData\TECHI\agent.config.json`, clear
  `rustdesk_last_repair_at` to `""`, restart the `TechiAgent` service.

## [2026-06-27] Always Enable "Remote Configuration Modification" Permission

### Root cause

In the Remote Support permissions panel, "Enable remote configuration
modification" was the one permission left unchecked by default, requiring
someone physically at each PC to turn it on before an operator could adjust
that device's Remote Support settings remotely. This is a standard
RustDesk `[options]` key (`enable-remote-config-modification`), the same
mechanism already used for `custom-rendezvous-server`/`relay-server`/`key`.

Separately, the user asked about adding clipboard copy-paste / drag-and-drop
file transfer (today only the manual "file transfer" menu works). That is
not a config toggle -- it doesn't appear at all in this build's permissions
list (13 known permissions, ending at remote-config-modification), so it's
not compiled into this vendored RustDesk fork. It can't be enabled via
config; it would need a newer build of the binary itself.

### Fix

- `agent/rustdesk_toml.go`: `managedRustDeskOptions` now always includes
  `enable-remote-config-modification = 'Y'`, repaired the same way as the
  other managed keys (30-min cooldown, see `ensureRustDesk`).

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
  (updated 3 existing fixtures in `rustdesk_toml_test.go` that asserted
  "no repair needed" / "no change" without the new key)
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)

## [2026-06-27] Auto-Restart "TECHI Remote Support" Service on Failure (Tray "Exit" Can Kill It)

### Root cause

Once Remote Support could actually start (previous entry), the user found
that clicking "Exit" on its system-tray icon can stop the underlying SCM
service too, not just close a window -- and once that happens, heartbeats
for that device stop until something restarts it. For a platform that
monitors many PCs/servers unattended, an end-user/operator being able to
accidentally kill monitoring from the tray is a real operational risk, not
just a cosmetic one.

`ensureRustDeskService` (called every heartbeat) already restarts the
service if it's stopped, but that only happens on the *next* heartbeat tick
(up to `HeartbeatSeconds` later, default ~60s) -- there was no faster,
SCM-level recovery the way `TechiAgent`'s own service already has via the
installer's `SetServiceRecovery` custom action.

### Fix

- `agent/rustdesk_manage.go`: added `setRustDeskServiceRecovery()`, which
  runs `sc failure "TECHI Remote Support" reset= 86400 actions=
  restart/15000/restart/15000/restart/60000` every time
  `ensureRustDeskService` confirms the service exists (already running, just
  started, or just created) -- so SCM itself restarts the service within
  15-60s of any exit, regardless of cause, well before the next heartbeat's
  own check would catch it. Idempotent, safe to re-apply every call.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Still open: confirm with the user whether heartbeats resumed on their own
  after the previous ~60s self-heal window, or stayed down indefinitely --
  determines whether this SCM-level fix alone is sufficient or whether a
  second issue (e.g. the whole machine losing connectivity, not just
  Remote Support) is also in play.

## [2026-06-27] Remote Support Wouldn't Open: app.so Silently Excluded by .gitignore's `*.so` Rule

### Root cause

TECHI Remote Support exited immediately on every launch attempt (no window,
no Task Manager entry lasting more than an instant), confirmed via a direct
launch capturing stderr:

```
[ERROR:flutter/shell/platform/windows/flutter_project_bundle.cc(66)] Can't load AOT data from C:\ProgramData\TECHI Remote Support\data\app.so; no such file.
[ERROR:flutter/shell/platform/windows/flutter_windows_engine.cc(253)] Unable to start engine without AOT data.
Failed to create view controller.
```

TECHI Remote Support is a Flutter Windows app; `data\app.so` is the
AOT-compiled Dart bytecode the Flutter engine needs to start at all --
without it the engine can't initialize and the process exits before showing
anything. `data\app.so` (13 MB) existed on disk in
`agent/installer/TECHI-Remote-Support/data/` (copied from the user's
`agent.rar`) but was never actually committed to git: `.gitignore`'s
generic `*.so` rule (meant for Python C-extension shared objects, line 7)
silently matched and excluded it too, since gitignore patterns aren't
path-scoped by default. Every CI-built MSI since this repo adopted the real
`installer.wxs` shipped Remote Support's DLLs and Flutter assets but not
its actual application code -- explaining why the icon "does nothing": the
engine fails before any window is created.

Found via a PowerShell diagnostic script run on the affected machine that
killed any running instance, relaunched the exe directly with
`-RedirectStandardError`, and captured the message above.

### Fix

- `.gitignore`: added `!agent/installer/TECHI-Remote-Support/data/app.so`
  exception to the `*.so` rule (same pattern already used for
  `!agent/techi-agent.manifest` against the `*.manifest` rule).
- `git add -f` the file so it's actually tracked going forward.

### Checks

- `comm -23 <(find agent/installer/TECHI-Remote-Support -type f | sort) <(git ls-files agent/installer/TECHI-Remote-Support | sort)`
  -- confirmed `app.so` was the *only* file on disk missing from git tracking
  under that whole vendored directory.
- Expect the next CI artifact to grow from ~22 MB to ~30+ MB (the MSI
  previously shipped without this 13 MB file at all).

## [2026-06-27] Hide Remaining Console-EXE CustomActions, Embed BuildCommit for Test Traceability

### Root cause

After a from-scratch IObit-driven uninstall/reinstall, the user still saw
console windows flash during manual install. The previous `-WindowStyle
Hidden` pass (commit `20844ae`) only covered the seven `powershell.exe`
`CustomAction`s. Four others launch bare console executables directly --
`SetServiceRecovery` (`sc.exe failure ...`), `LockdownTechiDataDir`
(`icacls.exe ...`), `KillTechiRS` (`taskkill.exe ...`), and
`DeleteTechiRSService` (`sc.exe delete ...`) -- none of which accept a
`-WindowStyle` flag themselves, so they were never covered. `KillTechiRS`/
`DeleteTechiRSService` also run during the *old* product's uninstall step
of every MajorUpgrade transaction, i.e. during what looks to the user like
"installing the new version."

Separately, since `ProductVersion` intentionally stays `2.1.0` across every
iteration (per explicit instruction, to avoid version churn), there was no
way to tell from the installed machine which exact commit's MSI was
actually running -- repeated back-and-forth was needed each time to confirm
"which build did you test."

### Fix

- `agent/installer/installer.wxs`: wrapped the four bare console-EXE
  `CustomAction`s in `powershell.exe -WindowStyle Hidden ... Start-Process
  -WindowStyle Hidden -NoNewWindow -Wait`, consistent with the other seven.
- Added a `BuildCommit` WiX variable (`-d BuildCommit=<git short sha>`,
  defaults to `dev`/`local` when unset) written to
  `HKLM\SOFTWARE\TECHI\Agent\BuildCommit` alongside the existing `DataDir`
  value -- `reg query HKLM\SOFTWARE\TECHI\Agent /v BuildCommit` on the test
  machine now tells us exactly which commit is installed.
- `.github/workflows/build-agent-msi.yml`: passes `-d BuildCommit=$(git sha
  short)` to `wix build`.
- `agent/installer/build.sh` / `build.bat`: same, using local `git rev-parse
  --short HEAD` (suffixed `-dirty` in build.sh if the tree has uncommitted
  changes).

### Checks

- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML)
- `bash -n agent/installer/build.sh` (syntax check)
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-agent-msi.yml'))"`
- `grep -c "WindowStyle Hidden" agent/installer/installer.wxs` → 11 (7
  powershell.exe CAs + 4 newly-wrapped console-EXE CAs)

## [2026-06-27] Stop Spawning a Remote Support Process Every Heartbeat (Process Pile-up, Won't Open, Reconnect Loop)

### Root cause

After moving Remote Support to ProgramData, the user reported, on real
hardware: clicking the Remote Support icon does nothing at all (no process
ever appears in Task Manager, from either the Desktop shortcut or the exe in
`C:\ProgramData\TECHI Remote Support\`), several duplicate "TECHI Remote
Support" processes visibly running all the time (nested under "TECHI Platform
Endpoint Agent" in Task Manager), and connecting via our platform UI drops
and reconnects every 5-10 seconds. The user confirmed this is unrelated to
Defender/AppLocker and started with the first GitHub-CI-built MSI — i.e. it
traces back to this repo's agent code, not the installer or AV.

`rustdesk.go`'s `discoverRustDeskWindows` (called every heartbeat, default
every ~60s, from both the main loop and the on-demand `sync_remote_support`
action handler) unconditionally spawned a *second* instance of the exe twice
per call: `--version` (2s timeout) and `--get-id` (5s timeout), to refresh
telemetry. Remote Support is single-instance-locked, so a probe spawn either
exits almost immediately (forwarded to the existing instance) or, if it
doesn't, was only killed via `cmd.Process.Kill()` -- which kills just that
one PID, not any child process the exe itself spawned. Probing on every
heartbeat, indefinitely, is exactly what produced the pile of duplicate
processes the user saw in Task Manager: every ~60s added another spawn that
either left an orphaned child behind or briefly held the single-instance
lock, so the user's manual double-click attempts were silently forwarded to
one of these short-lived orphans (which has no UI to show, being headless)
instead of opening a window. The lock contention and repeated spawn/kill
cycles are also a plausible explanation for the periodic disconnects: each
new probe competes with whatever instance currently owns an active remote
session.

### Fix

- `agent/rustdesk.go`: added `cachedRustDeskVersion`/`shouldProbeRustDeskID`/
  `recordRustDeskIDProbe`, throttling both probes to once per
  `cliProbeInterval` (30 min) once a usable ID/version is already known,
  instead of every heartbeat. The ID probe still runs immediately if we
  don't have a usable ID yet (first-run bootstrap).
- Added `killProcessTree` (`taskkill /F /T /PID`) and use it instead of
  `cmd.Process.Kill()` on both probes' timeout paths, so a non-exiting probe
  can't leave orphaned children behind even in the rare case the throttle
  above still lets one through.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Manual cleanup still required once on already-affected machines: kill all
  existing `TECHI Remote Support.exe` processes (`taskkill /F /IM "TECHI
  Remote Support.exe"`), then retest opening Remote Support after updating
  to this agent build -- this fix prevents future pile-up, it doesn't clear
  processes that already accumulated under the old code.

## [2026-06-27] Remaining Program Files Reference, Visible PowerShell Windows During Install

### Root cause

After the ProgramData move (previous entry), the user still saw a `TECHI
Remote Support` folder under both `Program Files` and `ProgramData`, and
PowerShell console windows flashing during the token-based manual install.
Two separate issues:

1. `WriteAgentConfig`'s `CustomAction` (the one that also writes
   `agent.config.json`) created the Public Desktop shortcut with
   `TargetPath`/`WorkingDirectory` hardcoded to
   `C:\Program Files\TECHI Remote Support\...` — missed in the previous pass
   because it's a string inside a PowerShell snippet, not a WiX directory
   reference. This alone doesn't *create* the Program Files folder (a
   shortcut's target isn't validated at save time), but the `Program Files`
   folder the user saw is most likely a leftover from testing this repo's
   *earlier, incorrect* installer.wxs (before the real one was adopted),
   whose RustDesk binary ran from Program Files and left its own
   untracked runtime files (logs/identity/cache) there — those aren't part
   of any MSI component, so `RemoveExistingProducts` during the MajorUpgrade
   never removes them. One-time manual cleanup of that stale folder is
   needed on machines that were used for earlier testing; new/clean installs
   won't recreate it now that nothing in installer.wxs references it.
2. None of the seven `powershell.exe`-launching `CustomAction`s
   (`WriteAgentConfig`, `EnsureServiceCreated`, `BackupAgentConfigBeforeLegacyRemove`,
   `CleanupLegacyEndpointInstallerRegistry`, `RestoreAgentConfigAfterLegacyRemove`,
   `RestoreAgentConfigFromLegacyBackup`, `CleanupProgramData`) passed
   `-WindowStyle Hidden`, so each one could flash a console window even
   though the action itself runs silently in the background during `/qn`.

### Fix

- `agent/installer/installer.wxs`: `WriteAgentConfig`'s shortcut now points
  at `C:\ProgramData\TECHI Remote Support\TECHI Remote Support.exe`.
- Added `-WindowStyle Hidden` to all seven `powershell.exe` `ExeCommand`
  invocations.

### Checks

- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML after edits)
- `grep -c "WindowStyle Hidden" agent/installer/installer.wxs` → 7 (one per
  powershell.exe CustomAction)
- `grep "Program Files" agent/installer/installer.wxs` → only the explanatory
  comment remains, no executable reference

## [2026-06-27] Move TECHI Remote Support Install Path from Program Files to ProgramData

### Root cause

The real `installer.wxs` brought in from the field (previous entry below)
installed TECHI Remote Support under `ProgramFiles6432Folder` (`C:\Program
Files\TECHI Remote Support\`). After building and testing this MSI manually
on a Windows box (token-based enrollment), the new agent version showed up
correctly, but TECHI Remote Support would not open and the remote session
dropped every few seconds. The user found the existing/legacy install on that
same machine had TECHI Remote Support under `C:\ProgramData\TECHI Remote
Support\` instead — matching the rest of the live fleet — and the agent's own
Go code (`rustdesk_manage.go`, `rustdesk.go`, `actions_windows.go`) already
hardcoded `C:\Program Files\TECHI Remote Support\...` as the *primary* path
for service registration, password config, and protocol-handler registration,
while `backend/app/services/enrollment_bootstrap_service.py`'s legacy-migration
PowerShell already assumes `C:\ProgramData\TECHI Remote Support` is where the
existing fleet has it installed. So the new MSI created a second, disconnected
copy of TECHI Remote Support in a different folder than the one the agent
self-healing logic and the rest of the fleet actually use — explaining both
symptoms (wrong/orphaned binary won't launch correctly; agent's periodic
service/config healing fights with whichever copy is actually running).

### Fix

- `agent/installer/installer.wxs`: moved `REMOTESUPPORTFOLDER` from its own
  `ProgramFiles6432Folder` `StandardDirectory` to a `Directory` under the same
  `CommonAppDataFolder` `StandardDirectory` as `INSTALLFOLDER`/`TECHIDATADIR`
  (i.e. `C:\ProgramData\TECHI Remote Support\`). Updated `TECHI_RS_EXE`'s
  `DirectorySearch` path and the `techiremotesupport://` protocol handler's
  registry value to match (the Start Menu shortcut already referenced the
  `REMOTESUPPORTFOLDER` property, so it updates automatically).
- `agent/rustdesk_manage.go`: `rustdeskDefaultInstallPath` and
  `rustdeskLegacyExePath` now point at `C:\ProgramData\TECHI Remote
  Support\...` instead of `C:\Program Files\...`.
- `agent/actions_windows.go`: the two protocol-handler-writing PowerShell
  snippets (`ensureRustDeskProtocolHandler`, `handleRegisterTechiProtocol`)
  now write the `C:\ProgramData\...` path.
- `agent/rustdesk.go`: `discoverRustDeskWindows`'s candidate path list now
  checks `ProgramData` first, keeping `Program Files`/`LOCALAPPDATA` as
  fallbacks for any machine that ended up with a Program-Files copy during
  this transition.
- `agent/installer/build.sh` / `build.bat`: corrected stale "WiX v4" comments
  to "WiX v7" (matches the CI fix below) and documented the
  `wix eula accept wix7` step needed once per machine.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1` (pass)
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass,
  exercises the `//go:build windows` files: `rustdesk_manage.go`,
  `actions_windows.go`)
- Confirmed `backend/app/services/enrollment_bootstrap_service.py`'s legacy
  migration script already targets `C:\ProgramData\TECHI Remote Support` —
  this change makes the new MSI consistent with that existing assumption
  instead of contradicting it.
- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML after edits)

## [2026-06-27] Adopt Real Combined installer.wxs (Agent + Remote Support), Revert Explicit Uninstall

### Root cause

The previous entry (below) diagnosed an `UpgradeCode` mismatch by comparing the
live-deployed `2.0.0` MSI against this repo's `agent/installer/installer.wxs`
— but that comparison was against the **wrong** file. The actual source for
the live MSI lived only on a local Windows machine (never committed): a much
more complete WiX project with UI dialogs (enrollment token prompt), legacy
v1.0.4 migration, `agent.config.json`/`device_id` backup-and-restore across
upgrades, and `UpgradeCode=E6AD0A88-5F26-5665-9B1F-70B8C5EE8363` — which
*does* match production. That real installer was already locally built and
tested through three elevated scenarios (fresh→upgrade, same-version
reinstall, no-token GPO-style upgrade), all passing with `device_id`
preserved, using a **plain** `msiexec /i` (no explicit uninstall).

Given that, the explicit-uninstall logic added in the previous two entries
(`self_update`'s manual `msiexec /x` before `/i`, and `techi-deploy.cmd`'s
`:do_upgrade` uninstall-then-install) is actively harmful with the real
installer: a standalone `msiexec /x` does not set `UPGRADINGPRODUCTCODE`,
so `installer.wxs`'s `CustomAction CleanupProgramData` (condition
`REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE`) fires and deletes
`C:\ProgramData\TECHI\agent.config.json` — wiping `device_id` and causing the
device to re-enroll as a new device on every upgrade.

### Fix

- Brought the real `installer.wxs`, `EpCustomActDll.dll`, `banner.bmp`,
  `TECHI-branding-assets/`, `TECHI-Remote-Support/` (prebuilt RustDesk/Flutter
  bundle), `versioninfo.json`, and `techi-agent.manifest` into the repo under
  `agent/` — this is the single source of truth going forward, replacing the
  simplified agent-only installer this session had been building.
- Parameterized `installer.wxs`'s `Version` via `$(var.Version)` (same
  pattern as before), sourced from `agent/VERSION`.
- `agent/update.go` self_update reverted to a **plain** `msiexec /i
  $MsiPath /quiet /norestart` — no explicit `/x`. Removed the now-unused
  `Get-InstalledTechiAgentProductCode` helper.
- `techi-deploy.cmd` (`enrollment_bootstrap_service.py`) collapsed
  `:do_install`/`:do_upgrade` into a single `:do_install` path: any
  non-`equal` registry version state runs the same `msiexec /i` (relying on
  `MajorUpgrade` + `AllowSameVersionUpgrades`), with no `msiexec /x` and no
  `:wait_registry_removed`. Registry read is kept for logging/diagnostics
  only.
- `agent/installer/build.sh` and `build.bat` rewritten to mirror the real
  build process: patch `versioninfo.json`/`techi-agent.manifest` from
  `agent/VERSION`, generate `resource.syso` via `goversioninfo`, `go build
  -ldflags -X main.AgentVersion=... -trimpath`, then `wix build -arch x64
  -ext WixToolset.UI.wixext -d Version=<version>.0`.
- `.github/workflows/build-agent-msi.yml` updated to match (swapped
  `WixToolset.Util.wixext` for `WixToolset.UI.wixext`, added `-arch x64`,
  added the `goversioninfo`/manifest-patch steps).
- `.gitignore`: added `agent/installer/*.wixpdb`, `agent/installer/.wix/`,
  `agent/installer/*.log`, `agent/resource.syso`.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd backend && python3 -m pytest tests/` (326 passed; 1 pre-existing
  unrelated failure in `test_legacy_compat.py`)
- Locally verified (on macOS, cross-compile only — `wix build` itself
  requires Windows): version-metadata patch script is idempotent,
  `goversioninfo` + `go build -ldflags -X main.AgentVersion=...
  -trimpath` succeed and produce a valid `techi-agent.exe`.
- User's own local elevated test logs (`elevated-test-output.log`,
  `elevated-notoken-upgrade-output.log`) already validated the real
  `installer.wxs` end-to-end against the live `2.0.0` lineage before this
  integration.
- CI (`build-agent-msi.yml`) run for this change actually built the MSI
  end-to-end on `windows-latest` (artifact `TECHI-Endpoint-Deployment-2.1.0`,
  ~22 MB) after fixing three real CI-only issues found via failed runs:
  1. WiX tool version was pinned to `4.0.5`; the real `installer.wxs` needs
     WiX v7 (`WixToolset.UI.wixext` API surface). Pinned both the `wix`
     dotnet tool and `WixToolset.UI.wixext` to `7.0.0`.
  2. WiX v7 refuses to run (`WIX7015`) until the Open Source Maintenance Fee
     EULA is accepted — added `wix eula accept wix7` right after install
     (see https://docs.firegiant.com/wix/osmf/).
  3. The parameterized-`Version` comment block added to `installer.wxs`'s
     header contained two literal `--` sequences, which is invalid inside an
     XML comment (`WIX0104`). Reworded to avoid `--`.

## [2026-06-27] Self-Update — Stop Relying on MajorUpgrade, Mirror techi-deploy.cmd's Explicit Uninstall

### Root cause

Live verification on a test PC showed double-clicking the freshly built
`TECHI-Endpoint-Deployment-2.1.0.msi` (confirmed via `msiinfo`/WindowsInstaller
COM to correctly embed `ProductVersion=2.1.0`) had no effect on a machine
already at `2.0.0`. Inspecting the actually-deployed production `2.0.0` MSI
(pulled from `agent_packages` on `techi-server`) revealed it is a **different,
much larger build** (~27 MB vs ~7 MB) that bundles `TECHI Agent` together with
`TECHI Remote Support` (RustDesk/Flutter runtime — `librustdesk.dll`,
`flutter_windows.dll`, `app.so`) and uses
`UpgradeCode={E6AD0A88-5F26-5665-9B1F-70B8C5EE8363}`, `Manufacturer=TECHI
Solutions SH.P.K.` — neither matches `agent/installer/installer.wxs`
(`UpgradeCode={A1B2C3D4-E5F6-7890-ABCD-EF1234567890}`, `Manufacturer=TECHI`).
That MSI was never built from this repo's installer source. Because
`MajorUpgrade` keys off `UpgradeCode`, Windows Installer treats the two as
fully unrelated products — no version bump can ever make `MajorUpgrade` fire
against the currently-installed bundle. The previous fix (see entry below)
made `self_update`'s `msiexec /i` rely on `MajorUpgrade` alone, which cannot
work against this specific installed base.

### Fix

`agent/update.go`'s self-update helper no longer assumes `MajorUpgrade` will
fire. It now mirrors the registry-driven approach already used by
`techi-deploy.cmd`: looks up `DisplayName = TECHI Agent` under both native and
WOW6432Node uninstall hives, extracts the real installed `ProductCode` from
`UninstallString`, and runs `msiexec /x <ProductCode>` before `msiexec /i
$MsiPath` — regardless of whether the installed product's `UpgradeCode`
matches. This works for the current mismatched-UpgradeCode bundle and for any
future build, without depending on MSI version/UpgradeCode bookkeeping being
correct.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- Manually confirmed via `msiinfo export` against both the new `2.1.0` MSI and
  the live `2.0.0` MSI pulled from `agent_packages` on `techi-server`.

## [2026-06-27] MSI/GPO Deploy — Version Parameterization, Self-Update Parity, Redundant Boot GPO, Third Daily Trigger

### Root cause

- `agent/installer/installer.wxs` hardcoded `Version="2.0.0"`; neither
  `agent/installer/build.sh` nor `.github/workflows/build-agent-msi.yml` ever
  bumped it or passed `-d Version=`. Every MSI built from these scripts
  embedded ProductVersion `2.0.0` regardless of the release label. On machines
  already at `2.0.0`, Windows Installer's `MajorUpgrade` (which only removes
  strictly *older* versions under the same UpgradeCode) saw an equal version
  and refused the install with `ERROR_PRODUCT_VERSION (1638)`. Device
  telemetry confirmed exactly this split: 480 devices stuck at `2.0.0`, 148
  fresh-install devices (no prior version to conflict with) correctly on
  `2.1.0`, 48 with no agent at all.
- `agent/update.go`'s `self_update` helper ran
  `msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus`, which targets
  repair-reinstall of the *same* ProductCode and never triggers
  `RemoveExistingProducts` — same 1638 failure mode as above, making
  "update agent" from Command Center unsafe for real version upgrades.
- GPO scheduled-task deploy created two independent "run techi-deploy.cmd on
  boot" mechanisms: a `<BootTrigger>` inside the Scheduled Task XML, and a
  separate "TECHI Agent Startup" GPO (classic Group Policy startup script).
  Both fired on every boot — redundant, and a source of double-execution
  races during an actual upgrade.

### Fix

- `installer.wxs`: `Version` is now `$(var.Version)`, supplied via a
  build-time `-d Version=` parameter (falls back to `0.0.0` if omitted).
- New single source of truth `agent/VERSION` (currently `2.1.0`) feeds both
  the MSI `Version` and `-ldflags -X main.AgentVersion=` for the compiled
  binary, wired into `agent/installer/build.sh` and
  `.github/workflows/build-agent-msi.yml`.
- `update.go` self_update dropped `REINSTALL=ALL REINSTALLMODE=vomus`.
  **Correction (see entry above, same day):** relying on `MajorUpgrade` alone
  turned out to be insufficient against the live-deployed `2.0.0` bundle
  (different `UpgradeCode`) — self_update now does an explicit registry-driven
  uninstall before install, not a bare `/i`.
- Removed the redundant "TECHI Agent Startup" GPO and its
  `scripts.ini`/Startup-Scripts plumbing from `_gpo_scheduled_task_setup`;
  boot-time execution is now covered solely by the Scheduled Task's
  `<BootTrigger>`. Renumbered remaining setup steps.
- Added a third daily `<CalendarTrigger>` at `09:00` (alongside the existing
  `13:00`/`21:00`).

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py` (106 passed)
- `cd backend && python3 -m pytest tests/` (328 passed; 1 pre-existing unrelated
  failure in `test_legacy_compat.py`, confirmed present before this change via
  `git stash`)
- `cd agent && go build ./... && go vet ./... && go test ./...`
- `GOOS=windows GOARCH=amd64 go build -ldflags="-X main.AgentVersion=2.1.1" ...`
  to confirm ldflags wiring compiles

## [2026-06-27] GPO Deploy — Registry-Driven MSI Upgrade When ProductCode Changes

### Root cause

`techi-deploy.cmd` treated `msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus`
with exit code `0` as a successful upgrade. On Windows clients with TECHI Agent
2.0.0.0 installed under ProductCode
`{0460426B-FC27-41E3-9EAC-1272F9941D30}`, installing MSI 2.1.0.0 with a
different ProductCode did not update the registry product entry. The service
could remain running while `HKLM\...\Uninstall` still reported version 2.0.0.0.

### Fix

`techi-deploy.cmd` now treats MSI registry as the source of truth:

- reads `DisplayName = TECHI Agent` from both native and WOW6432Node uninstall
  registry hives;
- extracts `DisplayVersion` and ProductCode from `UninstallString`;
- if registry is missing, runs fresh install;
- if registry version equals `ACTIVE_VERSION`, skips install and only ensures
  `TechiAgent` is running;
- if registry version is older, stops `TechiAgent`, uninstalls the discovered
  ProductCode with `msiexec /x`, waits until the registry entry is removed,
  then installs the new NETLOGON MSI;
- no longer uses `REINSTALL=ALL` / `REINSTALLMODE=vomus`;
- considers deploy successful only when registry version matches
  `ACTIVE_VERSION` and service state is `RUNNING`.

### Checks

- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_enrollment_bootstrap_script.py backend/tests/test_agent_config.py`
- `cd agent && env GOCACHE=/private/tmp/techi-go-build-cache go test ./...`

## [2026-06-27] Windows Agent Bootstrap/GPO — Standardize TechiAgent ProgramData Path

### Root cause

Windows MSI 2.1.0 installs and runs `TechiAgent` from
`C:\ProgramData\TechiAgent\techi-agent.exe`, but some bootstrap paths still used
`C:\ProgramData\TECHI` as the primary agent/config/log location. This could make
one-step bootstrap logs reference the wrong binary and could make generated GPO
startup/scheduled deploy flows miss the real agent path.

### Fix

- One-step/token bootstrap and trusted-domain bootstrap now use
  `C:\ProgramData\TechiAgent` as the primary install/config/log root.
- `C:\ProgramData\TECHI` remains only as legacy config fallback/migration.
- Bootstrap scripts resolve `TechiAgent` executable from `Win32_Service.PathName`
  when the service already exists, then fall back to
  `C:\ProgramData\TechiAgent\techi-agent.exe`.
- Bootstrap scripts verify `Test-Path $AgentPath` before `install`, `start`, or
  `status`, logging a clear error instead of falling into `CommandNotFoundException`.
- GPO `ScheduledTasks.xml` now uses SYSTEM/ServiceAccount, highest privileges,
  `cmd.exe /c "\\domain\NETLOGON\techi-deploy.cmd"`, a boot trigger, and daily
  13:00/21:00 triggers.
- Agent runtime defaults now read/write config and logs under
  `C:\ProgramData\TechiAgent`; `C:\ProgramData\TECHI` is legacy fallback.

### Checks

- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_enrollment_bootstrap_script.py`
- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_agent_config.py`
- `cd agent && env GOCACHE=/private/tmp/techi-go-build-cache go test ./...`

<!-- Entries from here through 2026-06-21 were merged on 2026-07-05 from the
     former root-level CHANGELOG-SOLUTIONS.md (Albanian-format originals,
     preserved verbatim). They fill the 2026-06-19..26 gap. -->

## 2026-06-26 — Command Center: komanda "self_update" (backend + frontend)

**Qëllimi:** Të mund të dërgohet nga Command Center komanda `self_update`
që e bën agjentin v2.1.0 (i mbështetur te `agent/update.go`) të shkarkojë
dhe instalojë vetë versionin aktiv, pa operatorin ta shkruajë me dorë
URL-në/version-in/sha256-in.

### Backend
**Skedarë:** `backend/app/schemas/agent_command.py`,
`backend/app/schemas/remote_action.py`, `backend/app/services/agent_command_service.py`

1. `"self_update"` shtohet te `BULK_COMMAND_TYPES` dhe te
   `ADMIN_ONLY_COMMAND_TYPES` (kërkon admin/owner — si `reboot_pc`/`run_powershell`,
   pasi prek binarin e agjentit).
2. `ActionType.SELF_UPDATE` shtohet te enum-i (për konsistencë me
   sistemin e single-device actions), me label "Self Update Agent" dhe
   konflikt-grup me `RESTART_AGENT`/`IMMEDIATE_HEARTBEAT` (që të dy
   rinisin agjentin).
3. **`AgentCommandService._build_self_update_payload()`** (e re): kur
   `command_type == "self_update"`, payload-i i klientit injorohet
   plotësisht — backend merr paketën aktive nga `AgentPackageService
   .latest_active("windows-amd64")` dhe ndërton:
   `{"download_url": f"{PUBLIC_BACKEND_URL}{latest_download_url(...)}",
   "version": pkg.version, "sha256": pkg.sha256}`. Operatori nuk e shkruan
   kurrë me dorë. Nëse nuk ka paketë aktive → `ValueError` → HTTP 400.

**Validim:** 324 teste backend (1 dështim para-ekzistues i paalidhur,
`test_legacy_compat`, i konfirmuar edhe pa ndryshimet tona). `curl -X POST
/api/v1/commands/bulk` lokal me `command_type=self_update` → payload i
ruajtur në DB përputhet ekzakt me paketën aktive (2.1.0,
sha256 `cd7a6d3d...`).

**Deploy:** push → `git pull` + `docker compose build backend && up -d
backend` te `techi-server` (`/opt/techi/techi-platform`). Kontejneri healthy.

### Frontend
**Skedarë:** `frontend/src/api/agentCommands.ts`,
`frontend/src/components/AgentCommandsPanel.tsx`

1. `"self_update"` shtohet te `BulkCommandType`, `BULK_COMMAND_LABELS`
   ("Përditëso Agjentin"), `BULK_COMMAND_TYPES`, kategoria "Agent" te
   `BULK_COMMAND_CATEGORIES`, `BULK_COMMAND_DESCRIPTIONS`,
   `DESTRUCTIVE_BULK_COMMANDS` (hap modalin Faza B), dhe
   `ADMIN_ONLY_BULK_COMMANDS` (mirror i backend-it — komanda fshihet
   automatikisht te dropdown për jo-admin).
2. Modali i konfirmimit (`ConfirmModal`) për `self_update`: titull
   "Përditëso Agjentin", kuti paralajmërimi e kuqe ("Agjenti do të
   riniset gjatë instalimit. PC mund të dalë offline përkohësisht (~2
   minuta)."), kuti info "Version aktual → X.X.X" + "SHA256 → 8
   karaktere të para" (lazy-fetch nga `getAgentPackages()`, vetëm kur
   komanda është e zgjedhur), buton "Konfirmo përditësimin" (në vend
   të "Konfirmo dërgimin" gjenerik). Kutia e madhe "All devices" mbetet
   trajtimi ekzistues i përbashkët, automatikisht i vlefshëm.
3. `handleSend`, `sendBulkCommand`, `buildPayload` — **të paprekura**;
   `self_update` nuk ka fusha payload (backend e mbush vetë), `PayloadEditor`
   shfaq vetëm një `InfoNote` shpjeguese.
4. Timeout default 180s (si `reboot_pc`, pasi shkarkim+instalim+rinisje
   zgjat më shumë se komandat e thjeshta).

**Validim:** `tsc --noEmit` pa gabime. Playwright lokal (backend lokal
SQLite + paketë test 2.1.0): komanda shfaqet te dropdown te kategoria
"Agent", klikimi "Send" hap modalin me titull/paralajmërim/version/sha256
korrekte, "Konfirmo përditësimin" dërgon batch-in (DB konfirmon payload
ekzakt me `download_url`/`version`/`sha256`), veprimi shfaqet te Command
History.

**Kufizime respektuara:** `self_update` nuk prek TECHI Remote Support.exe
(payload-i prek vetëm agjentin); testuar fillimisht vetëm me
`device_ids` specifik, jo `target=all`; heartbeat/enrollment/komanda
ekzistuese të paprekura.

**Deploy:** push → `git pull` + `docker compose build frontend && up -d
frontend` te `techi-server`. Kontejneri healthy.

---

## 2026-06-26 — Devices: kolonë "Agent" me badge versioni + filtër i shpejtë

**Skedar:** `frontend/src/components/DevicesTable.tsx`

**Qëllimi:** Të shihet menjëherë versioni i agjentit për çdo PC te lista
`/devices`, pa hyrë në detajet e device-it.

**Ndryshime:**
1. Kolona "Agent" (mes "OS" dhe "Last Seen", ekzistonte pjesërisht) tani
   përdor saktësisht ngjyrat e specifikuara: badge jeshil `#22c55e/20`
   kur `device.agent_version` përputhet me `active_agent_version` nga
   fleet overview, badge portokalli `#f97316/20` kur është i ndryshëm/i
   vjetër, dhe badge gri (jo më tekst i thjeshtë) me "—" kur
   `agent_version` është null/bosh.
2. Dropdown i ri "Agent version" te rreshti i filtrave (krahas Status /
   Health / Lifecycle / Signals): "All versions" + çdo version distinkt
   i pranishëm te devices (p.sh. "2.1.0", "2.0.0") + "Unknown". Filtron
   `displayDevices` lokalisht (state i ri `agentVersionFilter`, brenda
   komponentit) — **nuk kryen fetch të ri** drejt backend-it.
3. Paneli "Device Groups" (`DeviceTree.tsx`) është thjesht pemë
   client/grup me numërues, jo lista e device-ve individuale — nuk ka
   rresht "emër device-i" ku të vendosej badge, kështu që ndryshimi
   mbetet vetëm te lista e plotë `/devices`, sipas rrugës alternative
   të kërkuar.
4. Logjika e heartbeat/enrollment/komandave nuk u prek.

**Validim (lokal, Playwright + backend lokal me SQLite):**
- Dropdown gjeneron saktë `["All versions","2.1.0","2.0.0","Unknown"]`
  nga 4 devices testues (1 me `2.1.0`, 1 me `2.0.0`, 2 me `agent_version`
  null).
- Badge-et e tabelës: jeshil për `2.1.0` (= active), portokalli për
  `2.0.0`, gri "—" për null — verifikuar me screenshot.
- Ndërrimi i filtrit nuk gjeneron asnjë XHR/fetch të ri (Network tab —
  0 requests të reja për secilin ndryshim filtri).
- `npx tsc --noEmit` pa gabime.

**Deploy:** frontend-only, pas konfirmimit të userit.

---

## 2026-06-26 — techi-deploy.cmd: fix bug kritik — service fshihej para verifikimit të MSI

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`
(gjeneron `techi-deploy.cmd` te NETLOGON brenda PowerShell here-string-it).

**Bug i konfirmuar live:** te `:do_install` (rrugë e përbashkët për instalim
të freskët **dhe** për `:do_reinstall_lan`), `sc.exe delete TechiAgent`
ekzekutohej **para** se script-i të verifikonte nëse `%NETLOGON_MSI%`
ekziston në të vërtetë. Nëse MSI-ja mungonte nga NETLOGON (version i
fshirë/i papërditësuar), `msiexec` dështonte, rruga e fallback-ut
(`:manual_replace_lan`) dështonte gjithashtu (MSI nuk ekziston për ta
ekstraktuar), dhe `:install_failed` thërriste `net start TechiAgent` mbi
një service që **tashmë ishte fshirë** — PC mbetej përgjithmonë pa
TechiAgent të instaluar, edhe pse versioni i mëparshëm po punonte.

**Fix:**
1. Shtohet kontroll `if not exist "%NETLOGON_MSI%"` **para** rreshtit
   `sc.exe stop TechiAgent` te `:do_install` — nëse MSI mungon, loget
   `result=msi-not-found-abort` dhe kërcen te `:ensure_service_running`
   pa prekur service-in ekzistues.
2. Label i ri `:ensure_service_running` (para `:install_done`) — rikrijon
   service-in TechiAgent (`sc.exe create` + `description` + `failure`
   restart policy, si te `:manual_replace_lan`) **vetëm nëse** nuk
   ekziston më, pastaj `net start`. Kjo garanton që asnjë rrugë e re
   dështimi nuk e lë PC-në pa service, qoftë instalim i freskët apo
   reinstall.

**Validim:** `pytest backend/tests/test_enrollment_bootstrap_script.py
backend/tests/test_enrollment_token_workflow.py` — **101 + 5 = 106 teste
PASS** (asnjë test ekzistues prekur, vetëm shtim rreshtash në script).

**Deploy:** direkt në `stable/phase-2-heartbeat` pas testeve.

---

## 2026-06-24 — Command Center /agent-config: Faza B — gate konfirmimi para dërgimit

**Skedarë:**
- `frontend/src/api/agentCommands.ts`
- `frontend/src/components/AgentCommandsPanel.tsx`

**Qëllimi:** Shtresë sigurie UI para se Command Center të dërgojë komanda që
ekzekutohen si SYSTEM te ~605 PC. **`handleSend`, `sendBulkCommand`,
`buildPayload`, `startPolling`, `getBatchProgress`, çdo endpoint dhe çdo
komandë mbetën plotësisht të paprekura** — modal-i ndërhyn vetëm mes klikut
"Send" dhe thirrjes ekzistuese `handleSend()`.

**Ndryshime:**
1. **Lista e komandave "të rrezikshme" u zgjerua** (`DESTRUCTIVE_BULK_COMMANDS`,
   vetëm klasifikim UI — vendos kur hapet `ConfirmModal`, jo logjikë dërgimi):
   shtohen `set_remote_password`, `restart_rustdesk`, `change_heartbeat_interval`
   pranë 4 ekzistuesve (`restart_device`, `restart_agent`, `reboot_pc`,
   `run_powershell`) → 7 gjithsej. `ping`, `collect_inventory`, `sync_rustdesk`,
   `register_protocol` dërgohen direkt, pa modal, si më parë.
2. **Numër pajisjesh real PARA dërgimit** — `deviceCount` te `AgentCommandsPanel.tsx`
   nuk vjen më nga `activeBatch?.total` (që ishte `null` në dërgimin e parë,
   para çdo batch-i), por nga `fleetOverview` (AppDataContext, **zero fetch i
   ri**): `stats.total` për "All devices", `agents_outdated` për "Devices
   needing agent update", `tree_counts.by_client[clientId]` për "By client",
   numërim i ID-ve të parsuara për "Specific device IDs". "By group" mbetet
   `null` (s'ka count të para-llogaritur client-side pa endpoint të ri — jashtë
   scope).
3. **Theksim vizual "All devices" + komandë e rrezikshme** — `ConfirmModal`
   merr prop të ri `target`; kur `target === "all"`, bordura bëhet e kuqe
   (2px) dhe shfaqet banner i dedikuar me numrin e madh + "Kjo do dërgohet te
   të gjitha pajisjet".
4. **Script preview për `run_powershell`** — `ConfirmModal` merr prop të ri
   `scriptPreview` (= `payload["script"]`), shfaqur read-only në `<pre>`
   scroll-ueshëm brenda modal-it, përpara konfirmimit.
5. **Butona të riemërtuar**: "Send command" → **"Konfirmo dërgimin"**,
   "Cancel" → **"Anulo"**.
6. **Mbyllje universale me Escape** — `ConfirmModal` tani ka `window`
   keydown-listener (si `OutputModal` i Faza A.1), në vend të vetëm
   `onKeyDown` te input-i i step 2 (që s'funksiononte në step 1 ose pa focus).

**Bug-fix sigurie i zbuluar gjatë punës (jashtë kërkesës fillestare, por brenda
frymës "Faza B"):** te konfirmimi 2-hapësh i `reboot_pc`, nëse `deviceCount`
ishte `null` (numër i panjohur), fusha "shkruaj numrin" me input bosh **e
kalonte automatikisht kontrollin** (`"" === ""`). Tani `canConfirm` kërkon
domosdoshmërisht një numër real (`expectedText !== ""`) përpara se input-i i
përdoruesit të mund të përputhet.

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy ende —
verifikim manual te `/agent-config` (provo `reboot_pc`/`run_powershell` me
target "All devices" dhe me një klient specifik) mbetet për review.

---

## 2026-06-24 — Command Center /agent-config: Faza A.1 — progress bar live + full output modal

**Skedar:** `frontend/src/components/AgentCommandsPanel.tsx` (vetëm frontend, asnjë ndryshim backend/agjent).

**Qëllimi:** Vizualizim mbi të dhëna që tashmë vinin nga API (diagnoza e
konfirmoi: `/commands/{batch_id}/progress` poll-ohet çdo 3s dhe rikthen
`completed/failed/total/percent` live; `action.output`/`error` përmbajnë
PowerShell stdout/stderr të plotë, vetëm UI i fshihte pas tooltip 160px).
**`getBatchProgress`, `startPolling`, `POLL_INTERVAL`, `sendBulkCommand`, dhe
çdo endpoint/komandë mbetën plotësisht të paprekura.**

**Ndryshime:**
1. **Progress bar me tekst live** — nën `<ProgressBar>`, shtohet rresht i ri
   `"X/Y completed · Z failed · W timeout"` (krahas `percent%`), llogaritur
   direkt nga fushat ekzistuese të `activeBatch` (`completed/failed/timeout/total`),
   përditësohet automatikisht me çdo poll 3s ekzistues.
2. **Status final i diferencuar** kur `finished===true` — `batchOverallStatus()`
   (helper ekzistues, përdorur tashmë te tabela e History) u **gjeneralizua në
   tip** (`{finished, failed, timeout}` në vend të `BatchSummary` specifik) që
   të ripërdoret edhe për `activeBatch` (`BatchProgressResponse`) — sjellja për
   History mbetet identike. "Batch complete" tani bëhet "Batch complete" (gjelbër)
   / "Batch failed (n)" (kuq) / "Batch timeout (n)" (gri), në vend të një teksti
   të vetëm gjithmonë gjelbër.
3. **Modal "view full output"** (`OutputModal`, i ri, pranë `ConfirmModal`) —
   te per-device list, output/error i shkurtuar (160px) tani është buton me
   ikonë `Eye`; klikimi hap modal me `<pre>` monospace + scroll, stdout dhe
   stderr ndarë qartë (jo më i prerë te 160px/tooltip). Mbyllet me X, klik
   jashtë, **ose Escape** (`keydown` listener, hequr në cleanup).

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy ende —
verifikim manual te `/agent-config` (dërgo `run_powershell`, p.sh. `ipconfig`,
kontrollo progress bar live + modal output) mbetet për review.

---

## 2026-06-24 — Command Center /agent-config: Ridizajn Faza A (strukturë + grupim, pa logjikë)

**Skedarë:**
- `frontend/src/api/agentCommands.ts`
- `frontend/src/components/AgentCommandsPanel.tsx`
- `frontend/src/pages/AgentConfig.tsx`
- `backend/app/schemas/agent_command.py`
- `backend/app/services/agent_command_service.py`

**Qëllimi:** Ridizajn vizual i Command Center te `/agent-config` (Faza A) —
grupim i komandave, përshkrime, Command History i dukshëm by-default, layout
2-kolonësh. **Logjika e dërgimit të komandave (endpoint, payload, target,
konfirmimet ekzistuese) mbeti plotësisht e paprekur.**

**Ndryshime:**
1. **Grupim vizual i 11 komandave** (`BULK_COMMAND_CATEGORIES` te `agentCommands.ts`)
   në 4 kategori, render-uar si `<optgroup>` te `<select>` ekzistues (vlerat/
   `value=` identike me ato ekzistuese):
   - Diagnostikë: `ping`, `collect_inventory`
   - Agent: `restart_agent`, `change_heartbeat_interval`, `run_powershell`
   - Pajisje: `reboot_pc`, `restart_device`
   - RustDesk / Remote: `sync_rustdesk`, `restart_rustdesk`, `set_remote_password`, `register_protocol`
2. **Përshkrim 1-rresht për çdo komandë** (`BULK_COMMAND_DESCRIPTIONS`,
   anglisht për tani) — shfaqet nën select-in e Command-it, sipas komandës
   aktualisht të zgjedhur.
3. **Command History i dukshëm by-default** — hiqet accordion-i i mbyllur
   (`historyOpen`, `ChevronDown`/`ChevronUp`); ngarkohet automatikisht në mount
   (i njëjti `getCommandHistory(20)` ekzistues, vetëm thirrur më herët, pa
   polling të ri). Riorganizohet si tabelë: Time, Command, Target, Status, By.
   - Kolona "Status" vjen nga `batchOverallStatus()` — derivim UI i ri, vetëm
     nga fushat ekzistuese `finished/failed/timeout` (Running / Completed /
     Failed (n) / Timeout (n)), pa logjikë biznesi të re.
   - Kolona "By" vjen nga `created_by_name` (shih ndryshimin backend poshtë).
4. **Layout 2-kolonësh** (`grid xl:grid-cols-2`): majtas Send Command + Active
   Batch (e pandryshuar), djathtas Command History (tabela e re).
5. **Gjerësia e faqes** (`AgentConfig.tsx`): containeri kryesor `max-w-2xl` →
   `max-w-6xl`; Header/Agent notice/Heartbeat Policy/Rollout Scripts u
   mbështjellën në një `<div className="mx-auto max-w-2xl">` të brendshëm —
   **përmbajtja e tyre mbetet 100% e pandryshuar**, vetëm Command Center
   përdor gjerësinë e re.

**Backend (minimal, read-only, vetëm history — jo endpoint-i i dërgimit):**
- `backend/app/schemas/agent_command.py`: shtohet `created_by_name: Optional[str]`
  te `BatchSummary`.
- `backend/app/services/agent_command_service.py`: te `get_history()`, bashkon
  `operators` për `batch.created_by` (FK ekzistuese në `agent_command_batches`,
  s'ishte e ekspozuar më parë) → `display_name or username`. **`create_bulk()`
  (endpoint-i `/api/v1/commands/bulk`, dërgimi real i komandave) NUK u prek.**

**Jashtë scope (qëllimisht, Faza B):** asnjë konfirmim i ri për komanda të
rrezikshme, asnjë ndryshim te Heartbeat Policy/Rollout Scripts, asnjë ndryshim
te endpoint/payload/target i dërgimit.

**Validim:** `npx tsc --noEmit` kalon pa gabime; `python3 -m py_compile`
(ast parse) OK për 2 skedarët backend. Pa build/deploy ende në këtë hap —
verifikim manual te `/agent-config` mbetet për review.

---

## 2026-06-24 — Race condition në /devices: device catalog rikthehet te "All" pas zgjedhjes së klientit

**Skedarë:**
- `frontend/src/pages/Devices.tsx`
- `frontend/src/api/devices.ts`
- `frontend/src/api/client.ts`

**Problem:** Te `/devices`, kur klikohej një klient/grup në Fleet tree, tabela e
device-ve riorientohej pas disa sekondash te "All" ose te një klient tjetër.
Konfirmuar live në network trace: requests për `client_id=7` dhe `client_id=3`
të mbivendosura, përgjigja që mbërrin e fundit fitonte pavarësisht cilës
selektim i përkiste — zero console errors (jo crash, race e pastër).

**Root cause:**
1. `loadTableData()` (te `Devices.tsx`) thërriste `getDevices(...)` pa
   `AbortController` — request-i i mëparshëm (p.sh. për `client_id=3`) vazhdonte
   në background edhe pasi përdoruesi kishte zgjedhur `client_id=7`, dhe çfarëdo
   që mbërrinte e fundit mbishkruante `tableDevices`.
2. `scheduleDevicesRefresh()` krijonte një `setTimeout` një-herësh (5s debounce
   pas event-eve WS "Live") që mbante closure stale mbi `refreshBoth` —
   nëse përdoruesi ndërronte selektimin brenda atyre 5s, timeout-i ekzekutohej
   sërish me `filters`/`client_id` e VJETËR (closure i kapur në momentin e
   planifikimit, jo në momentin e ekzekutimit).
3. Klikë të shpeshtë në fleet tree shumëzonin numrin e request-ve konkurrente.

**Zgjidhje (vetëm request lifecycle, pa prekur backend/layout/Command Center):**
- **AbortController**: `loadTableData()` anulon request-in paraardhës
  (`tableAbortRef`) para se të nisë një të ri; `getDevices()` (te `devices.ts`)
  pranon tani `signal?: AbortSignal` opsional dhe ia kalon `fetchJson`.
  `AbortError` trajtohet në heshtje (mos e trajto si gabim të rrjetit).
- **Fallback fix te `client.ts`**: `fetchJson` rihedh `AbortError`-in
  menjëherë te `catch`, në vend që të provojë base URL-in tjetër (loop-i
  ekzistues fallback mes disa base URLs do ta anashkalonte abort-in).
- **Selection guard (latest-selection-wins)**: `tableRequestKeyRef` ruan
  `cacheKey` e selektimit aktual (page+limit+search+quickFilter+filters,
  pra përfshin `client_id`/`smart_folder`); pas çdo `await getDevices(...)`,
  nëse `tableRequestKeyRef.current !== cacheKey` (selektimi ka ndryshuar
  ndërkohë), përgjigja hidhet poshtë pa shkruar state. I zbatuar gjithashtu
  te `finally` (mos e fik skeleton loading-un e selektimit të ri për shkak
  të një request-i të vjetër që po mbyllet).
- **Ref për polling "Live"**: `refreshBothRef` mban referencën më të fundit
  të `refreshBoth`; `scheduleDevicesRefresh`'s `setTimeout` thërret tani
  `refreshBothRef.current()` (lexim në kohën e ekzekutimit) në vend të
  `refreshBoth()` direkt (closure i kapur në kohën e planifikimit).
  `usePollingRefresh` (60s fallback) NUK u prek — ai hook rikrijon interval-in
  vetë kur identiteti i `refreshBoth` ndryshon, pra s'kishte bug stale-closure.
- **Debounce 200ms te Fleet tree**: `handleTreeSelect` jep feedback vizual
  menjëherë (`setSelectedTreeKey`), por debouncon (200ms, `treeSelectTimerRef`)
  pjesën që prek `setFilters`/URL/fetch, që klikë të shpeshtë të kolapsohen
  në një fetch të vetëm. Timer-i pastrohet te cleanup effect-i ekzistues
  (krahas `refreshTimerRef`/`drawerCloseTimerRef`/`searchTimerRef`).

**`getDeviceTableDetails` (table-details) NUK u prek** — tashmë i mbrojtur
me `detailsRequestRef` (request id incremental).

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy — verifikim
manual te `/devices` (klikim i shpeshtë mes klientëve) mbetet për review.

---

## 2026-06-23 — Agent Path Consistency & HTTPS/WSS Fix

**Skedarë:**
- `agent/paths.go`
- `agent/agent.go`
- `agent/config.go`
- `agent/main.go`
- `agent/service_windows.go`
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/app/api/v1/endpoints/agent.py`
- `backend/app/api/v1/endpoints/agent_config.py`
- `backend/tests/test_agent_config.py`
- `backend/tests/test_enrollment_bootstrap_script.py`
- `backend/tests/test_agent_enroll_urls.py`
- `agent/config_test.go`

**Problem:** Deployment/GPO/MSI bootstrap shkruante ose kontrollonte config/log te
`C:\ProgramData\TechiAgent`, ndërsa `techi-agent.exe` në runtime lexonte
config nga `C:\ProgramData\TECHI`. Si rezultat, agent-i nisej me config bosh
ose default dhe heartbeat dështonte gjatë enrollment-it edhe pse install/service
ishin OK.

**Root cause:** Path-et e agent runtime dhe script-eve të deployment-it kishin
devijuar:
- Runtime: `C:\ProgramData\TECHI\agent.config.json`
- Deployment legacy: `C:\ProgramData\TechiAgent\agent.config.json`

Ky mismatch fshihte token-in real të enrollment-it nga runtime. Në të njëjtën
kohë, disa rrugë bootstrap/enrollment mund të gjeneronin URL me `http://` ose
`ws://` kur request-i kalonte përmes proxy/HTTP.

**Zgjidhje:**
- Standardizohet storage zyrtar i agent-it:
  - `C:\ProgramData\TECHI\agent.config.json`
  - `C:\ProgramData\TECHI\logs\agent.log`
- Shtohet migrim automatik në startup/install:
  - nga `C:\ProgramData\TechiAgent\agent.config.json`
  - te `C:\ProgramData\TECHI\agent.config.json`
  - krijohet `C:\ProgramData\TECHI\logs` nëse mungon
  - log-ohet migrimi pa ekspozuar secrets
- Bootstrap/GPO/rollout scripts shkruajnë te path-i zyrtar dhe mbajnë legacy
  fallback vetëm për migrim/compatibility.
- Heartbeat URL gjenerohet me HTTPS:
  - `https://api-rdp.techi.com.al/api/v1/agent/heartbeat`
- WebSocket URL gjenerohet me WSS:
  - `wss://api-rdp.techi.com.al/ws/devices?tenant_id=default`
- Runtime normalizon endpoint-et production:
  - `http://api-rdp.techi.com.al` → `https://api-rdp.techi.com.al`
  - `ws://api-rdp.techi.com.al` → `wss://api-rdp.techi.com.al`
- Startup diagnostics shtohen për:
  - resolved config path
  - resolved log path
  - backend URL
  - API URL
  - device ID
  - agent ID present/missing
  - enrollment token present/missing

**Validation:**
- Agent tests: `go test ./...`
- Backend targeted tests:
  - `backend/tests/test_agent_config.py`
  - `backend/tests/test_enrollment_bootstrap_script.py`
  - `backend/tests/test_agent_enroll_urls.py`
- Verifikuar që config template gjeneron HTTPS heartbeat URL dhe WSS websocket URL.
- Verifikuar migrimi automatik nga legacy path te path-i zyrtar.
- Verifikuar në production machine ku heartbeat dështonte më parë; heartbeat
  funksionoi pas migrimit të path-it.

---

## 2026-06-23 — gpo-deploy.ps1 download: Invoke-WebRequest → WebClient.DownloadFile

**Skedarë:**
- `backend/app/services/enrollment_token_service.py`
- `backend/tests/test_enrollment_token_workflow.py`

**Problem:** Komanda e gjeneruar nga UI për shkarkimin e `gpo-deploy.ps1` përdorte `Invoke-WebRequest` i cili dështon në Windows Server 2016 pa WMF 5.1 të plotë ose me proxy settings të caktuara.

**Zgjidhje:** Zëvendëso në `safe_gpo_deploy_command()`:
```
Para:  Invoke-WebRequest -Uri "{url}" -OutFile $f -UseBasicParsing
Pas:   (New-Object Net.WebClient).DownloadFile("{url}", $f)
```
`Net.WebClient.DownloadFile` funksionon në .NET 3.5+ (Windows Server 2008+) dhe nuk varet nga cmdlet-et e PowerShell.

**Teste:** 5 passed (1 assertion e re: `DownloadFile in gpo_deploy_command` + `Invoke-WebRequest not in gpo_deploy_command`).

---

## 2026-06-23 — Uninstall eksplicit i v1.0.4 (TECHI Endpoint Deployment) para install v2.0.0

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Root cause i konfirmuar:** PC-të me v1.0.4 kishin `UpgradeCode` identik me v2.0.0 (`{E6AD0A88-5F26-5665-9B1F-70B8C5EE8363}`) por MSI nuk mund ta uninstalonte v1.0.4 automatikisht gjatë upgrade kur shërbimi ishte running + file locked. Rezultati: `msiexec REINSTALL=ALL` kthente 1603.

**Zgjidhja — tre shtresa në `:do_install`, para `set PRODUCT_INSTALLED=`:**

**1. Fshi service para uninstall** (eliminon file-lock dhe service-conflict):
```bat
sc.exe stop TechiAgent 2>nul
sc.exe delete TechiAgent 2>nul
timeout /t 3 /nobreak >nul
```

**2. Uninstall registry-based** (dinamik — gjen çdo paketë "TECHI Endpoint Deployment"):
```bat
for /f "tokens=*" %%i in ('reg query ... "TECHI Endpoint Deployment" ...') do (
    for /f "tokens=2 delims={}" %%j in ('... findstr /i "HKEY"') do (
        msiexec /x "{%%j}" /quiet /norestart 2>nul
    )
)
```

**3. Uninstall direkt me ProductCode** (failsafe — ProductCode-et e njohura të v1.0.4):
```bat
msiexec /x "{134568B7-BCB0-4341-933B-C24DA78DEF6E}" /quiet /norestart 2>nul
msiexec /x "{110919C6-83C4-444F-821F-61F755FE5081}" /quiet /norestart 2>nul
timeout /t 10 /nobreak >nul
```

Pas këtij blloku, `set PRODUCT_INSTALLED=` kërkon "TECHI Agent" (v2.0.0) — nëse u uninstalua, do ta instalojë si fresh. Nëse UpgradeCode u gjet ende, bën REINSTALL=ALL.

**Teste:** 32 passed (2 teste të reja: `test_deploy_cmd_deletes_service_before_uninstall`, `test_deploy_cmd_uninstalls_old_v104_before_install`).

---

## 2026-06-23 — :manual_replace_lan krijon Windows Service nëse mungon (v1.0.4 skip-install bug)

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Problem:** Disa PC me v1.0.4 kishin kaluar nëpër upgrade të mëparshëm ku `ServiceInstall` u skip-ua — skedari `techi-agent.exe` ekzistonte por Windows Service `TechiAgent` nuk ekzistonte fare. Rrjedhimisht `:manual_replace_lan` kopjonte executable-in me `copy /y` dhe pastaj `net start TechiAgent` dështonte me "service not found".

**Zgjidhje:** Shtohen 4 rreshta pas `copy /y`, para `net start`:
```bat
sc query TechiAgent >nul 2>&1
if errorlevel 1 (
    sc.exe create TechiAgent binPath= "%AGENT_EXE%" start= auto DisplayName= "TECHI Agent"
    sc.exe description TechiAgent "TECHI Solutions endpoint monitoring and management service"
    sc.exe failure TechiAgent reset= 60 actions= restart/60000/restart/60000/restart/300000
)
```
`sc query` kthen errorlevel 1 nëse service nuk ekziston → krijimi bëhet vetëm kur nevojitet (idempotent).

**Teste:** 30 passed (1 test i ri: `test_deploy_cmd_manual_replace_lan_creates_service_if_missing`).

---

## 2026-06-23 — manual_replace_lan fallback në :do_install kur msiexec REINSTALL kthen 1603

**Skedarë:**
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/tests/test_enrollment_bootstrap_script.py`

**Problem:** `techi-deploy.cmd` (arkitektura LAN) dështonte me `exit /b 1` kur `msiexec /i REINSTALL=ALL` kthente error 1603 (file lock gjatë upgrade — shërbimi aktiv mban `techi-agent.exe` të bllokuar). Nuk kishte asnjë fallback.

**Zgjidhje:** Shtohet `:manual_replace_lan` fallback pas REINSTALL=ALL:
1. Msiexec REINSTALL=ALL dështon → `goto :manual_replace_lan`
2. `:manual_replace_lan`: ekstrakton MSI nga NETLOGON me `msiexec /a /qn TARGETDIR=%EXTRACT_DIR%`
3. Ndalon shërbimin + `taskkill`, kopjon `CommApp\TechiAgent\techi-agent.exe` me `copy /y`
4. Rinis shërbimin, log `result=0-manual`
5. Nëse copy dështon → `:install_failed` → `result=1603`, `exit /b 1`

**Ndryshim CMD strukturor:** Hiqet `if/else` me kllapa (për shkak të `%ERRORLEVEL%` expansion bug-it të CMD brenda kllaPave). Struktura e re me goto:
```bat
if defined PRODUCT_INSTALLED goto :do_reinstall_lan
msiexec ... ENROLLMENT_TOKEN...
set MSI_EXIT=%ERRORLEVEL%
if not "%MSI_EXIT%"=="0" goto :install_failed
goto :install_done

:do_reinstall_lan
msiexec ... REINSTALL=ALL...
set MSI_EXIT=%ERRORLEVEL%
if not "%MSI_EXIT%"=="0" goto :manual_replace_lan

:install_done → :done
:manual_replace_lan → :done ose :install_failed
:install_failed → exit /b 1
:done → exit /b 0
```

**Teste:** 29 passed (6 teste të reja).

---

## 2026-06-23 — Eliminim i false positive-ve AV (Kaspersky/Symantec) në GPO deploy

**Skedarë:**
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/tests/test_enrollment_bootstrap_script.py`
- `backend/app/services/device_heartbeat_service.py`

**Problem:** `techi-deploy.cmd` e gjeneruar nga `gpo-deploy.ps1` dhe e shkruar në SYSVOL/NETLOGON
detektohej si `HEUR:Trojan-Downloader.PowerShell.Agent.gen` nga Kaspersky (dhe Symantec/Cybereason).
Shkaku rrënjësor: CMD-ja kishte "dropper pattern" klasik — shkarkon MSI nga interneti
(`curl.exe`/`Net.WebClient`/`Invoke-WebRequest`) me token plaintext, pastaj ekzekuton `msiexec`.
Kaspersky e karantinonte menjëherë pas shkrimit në SYSVOL.

**Zgjidhje:** MSI pozicionohet në `\\domain\NETLOGON\` nga `gpo-deploy.ps1` (admin, 1 herë në DC).
PC-të instalojnë vetëm nga LAN — zero download nga interneti, zero pattern dropper, zero detektim AV.

Dy ndryshime kryesore:

**1. Hapi 4b i ri në `gpo-deploy.ps1`** (`_gpo_scheduled_task_setup`):
- Shkarkon MSI aktiv nga API → `\\domain\NETLOGON\TECHI-Agent-X.Y.Z.msi` (3 retries, TLS 1.2)
- Shkruan `\\domain\NETLOGON\techi-version.txt` me versionin aktiv
- Fshin MSI-të e vjetra nga NETLOGON (pastrim automatik)
- Shfaq SHA256 të MSI-t të shkarkuar
- `Test-Path` verifikime pas çdo shkrimie kritike (mësim nga "bug Adpascucci")

**2. `techi-deploy.cmd` i ri — vetëm LAN:**
```bat
:: Lexo version aktiv nga NETLOGON (LAN -- jo internet)
for /f "tokens=*" %%i in ('type "%NETLOGON_VERSION%" 2^>nul') do set ACTIVE_VERSION=%%i

:do_install
  reg query "HKLM\...\Uninstall" ... | findstr "TECHI Agent" → PRODUCT_INSTALLED
  if defined PRODUCT_INSTALLED → REINSTALL=ALL REINSTALLMODE=vomus
  else                         → ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL%
  logs: deploy.log (timestamp + result + version)

:already_uptodate
  sc query TechiAgent | findstr "RUNNING" >nul 2>&1
  if errorlevel 1 → net start TechiAgent

:fresh_install  (fallback nëse NETLOGON_VERSION nuk lexohet)
  instalo MSI me ENROLLMENT_TOKEN
```

**Rregullime shtesë:**
- `reg query ... 2^>nul` (jo `2^>/dev/null` — `/dev/null` nuk ekziston në CMD Windows)
- `sc query ... >nul 2>&1` (i njëjti korrigjim)
- Testim i label ordering me `re.search(r"^:label", script, re.MULTILINE)` — `.index()` gjente `goto :label` para labelit aktual
- `from __future__ import annotations` në `device_heartbeat_service.py` — fix pre-ekzistues për Python 3.9 (`str | None` syntax)

**Rezultati:**
```
23 passed, 3 warnings in 0.99s
```

**Arsye:** Pattern-i dropper (download+exec) është firma e malware-it sipas heuristikës AV.
LAN-only eliminon firmën dhe do të gjitha benefitet e security-t të AD (nuk ka token në CMD).

---

## 2026-06-21 — Simplifiko path-detection për :manual_replace në techi-deploy.cmd

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Problem:** Seksioni `:manual_replace` përdorte `if/else if` chain me 4 path-e alternative
për të gjetur `techi-agent.exe` pas `msiexec /a` (administrative install/extract):

```bat
set EXTRACTED_AGENT=
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\TechiAgent\techi-agent.exe"
)
```

**Zgjidhje:** Konfirmuar me 3×3 teste në makina të ndryshme Windows se path-i i vetëm i qëndrueshëm
është `CommApp\TechiAgent\techi-agent.exe`, i dokumentuar gjithashtu në `installer.wxs` si i garantuar
nga MSI packaging. U hoqën 3 `else if` të tjerë; u standardizua inicializimi i variablit me kuota.

```bat
set "EXTRACTED_AGENT="
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
)
```

**Arsye:** Heqja e path-eve alternative eliminon ambiguitetin, zvogëlon sipërfaqen e gabimeve,
dhe e bën kodin konsistent me strukturën e garantuar nga MSI-ja.

## [2026-06-18] MSI Deploy — Force TLS 1.2 for Windows Server 2016 (.NET WebClient)

### Root cause

Windows Server 2016 (dhe versione më të vjetra) nuk aktivizojnë automatikisht
TLS 1.2 për `.NET WebClient` në CMD/PowerShell context. Rezultati:
`"Could not create SSL/TLS secure channel"` kur `DownloadFile`, `DownloadString`
ose `Invoke-WebRequest` tenton të lidhej me HTTPS endpoints.

### Fix

**1. TLS force block** — shtohet pas Defender exclusions dhe para çdo download:
```cmd
:: Force TLS 1.2 per .NET WebClient (Windows Server 2016)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ...
    Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\.NETFramework\v4.0.30319'
    -Name SchUseStrongCrypto -Value 1 ..." >nul 2>&1
```
Vendos `SchUseStrongCrypto=1` në dy regjistrat (64-bit dhe 32-bit WoW64).

**2. TLS prefix në çdo PowerShell fallback command:**
- `DownloadString` (active-version check)
- `DownloadFile` (MSI download, `:do_upgrade` dhe `:fresh_install`)
- `Invoke-WebRequest` (MSI download, `:do_upgrade` dhe `:fresh_install`)

Secili tani fillon me:
`[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;`

### Checks

- `test_deploy_cmd_forces_tls12_after_exclusions_before_downloads`: verifikon
  praninë e TLS block, rendin (pas exclusions, para Case 0) dhe `SchUseStrongCrypto`/`Wow6432Node`.
- `test_deploy_cmd_active_version_fallback_has_tls12`: TLS prefix në `DownloadString`.
- `test_deploy_cmd_msi_download_has_powershell_fallback`: TLS prefix në
  `DownloadFile` dhe `Invoke-WebRequest` për të dy seksionet.

## [2026-06-18] MSI Deploy — curl.exe Fallback for Windows Server 2016 and Older

### Root cause

`techi-deploy.cmd` i gjeneruar përdorte `curl.exe` si i vetmi mjet download.
`curl.exe` nuk ekziston si built-in në Windows Server 2016 dhe versione
më të vjetra (u shtua si built-in vetëm në Windows 10 1803+). Rezultati:
silent fail pa download MSI dhe pa feedback.

### Fix

Tre check-e të reja, të gjitha brenda `techi-deploy.cmd` të gjeneruar:

**1. Active-version check — `where` guard + PowerShell fallback:**
```cmd
set ACTIVE_VERSION=
where curl.exe >nul 2>&1
if not errorlevel 1 (
    for /f ... curl.exe -s -f "%ACTIVE_VERSION_URL%" ...
)
if not defined ACTIVE_VERSION (
    for /f ... powershell.exe ... DownloadString("%ACTIVE_VERSION_URL%") ...
)
```

**2. MSI download (`:do_upgrade` dhe `:fresh_install`) — tre-shtresa fallback:**
```cmd
set DOWNLOAD_OK=0
where curl.exe >nul 2>&1
if not errorlevel 1 ( curl.exe ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" ( Net.WebClient.DownloadFile ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" ( Invoke-WebRequest ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" goto :cleanup_fail
```

Rendi: `curl.exe` (nëse ekziston) → `Net.WebClient` → `Invoke-WebRequest`.

### Checks

- `test_deploy_cmd_active_version_has_powershell_fallback`: verifikon `where` guard
  dhe `DownloadString` fallback për version check.
- `test_deploy_cmd_msi_download_has_powershell_fallback`: verifikon tri shtresat
  e download (`curl`, `DownloadFile`, `Invoke-WebRequest`) dhe `DOWNLOAD_OK` guard
  në të dy seksionet `:do_upgrade` dhe `:fresh_install`.

## [2026-06-18] MSI Deploy — Fresh PC Fix: EXIT 1603 in do_upgrade on Uninstalled Product

### Root cause

`:do_upgrade` përdorte `REINSTALL=ALL REINSTALLMODE=vomus` në çdo rast, duke
përfshirë PC-të e reja ku produkti nuk ishte instaluar fare. Windows MSI kthen
`EXIT 1603` kur `REINSTALL=ALL` zbatohet mbi një produkt të painstaluar.

### Fix

Para `msiexec`, `:do_upgrade` tani:

1. Kontrollon regjistrin `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
   me `reg query /s /f "TECHI Agent" /d` për të zbuluar nëse produkti ekziston.
2. Nëse `PRODUCT_INSTALLED` është i definuar → upgrade path me
   `REINSTALL=ALL REINSTALLMODE=vomus` (sjellja e mëparshme).
3. Nëse `PRODUCT_INSTALLED` nuk është i definuar → fresh install path me
   `ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL%` (e njëjta si `:fresh_install`).

### Checks

- Test strukturor `test_deploy_cmd_do_upgrade_detects_product_installed` verifikon:
  - `set PRODUCT_INSTALLED=` dhe `reg query ... findstr` janë brenda `:do_upgrade`
  - `if defined PRODUCT_INSTALLED (` bloku ekziston
  - Të dy path-et (REINSTALL dhe ENROLLMENT_TOKEN) janë brenda `:do_upgrade`

## [2026-06-18] MSI Deploy — Use ENROLLMENT_TOKEN and API_URL Properties

### Root cause

Bootstrap scripts kalonin MSI properties `TOKEN` dhe `BACKEND_URL`, ndërsa
installer-i pret `ENROLLMENT_TOKEN` dhe `API_URL`. Fresh install mund të
dështonte me `AbortNoToken` / MSI error `1603`.

### Fix

Të tre MSI install paths tani përdorin:

- `ENROLLMENT_TOKEN=<token>`
- `API_URL=<backend-url>`

Kjo përfshin token bootstrap PowerShell, GPO bootstrap PowerShell dhe
`techi-deploy.cmd` fresh install. Upgrade path nuk kalon token.

### Checks

- Teste strukturore për property names në të tre generatorët.
- Test që MSI invocation i vjetër `TOKEN=%TOKEN%` nuk gjenerohet më.

## [2026-06-18] GPO Deploy — Prioritize CommApp Agent Path

MSI administrative extract vendos agentin real te:
`CommApp\TechiAgent\techi-agent.exe`.

Manual fallback në `techi-deploy.cmd` tani kontrollon këtë path si zgjedhjen e
parë, përpara fallback-eve `PFiles64`, `CommonAppData` dhe `TechiAgent`.
Testi strukturor verifikon praninë dhe prioritetin e `CommApp`.

## [2026-06-18] GPO Deploy — Select Agent EXE from Known MSI Paths

### Root cause

Manual MSI fallback përdorte `for /R` për të kërkuar `techi-agent.exe`.
Kur MSI extract përmbante kopje të tjera brenda TECHI Remote Support
`flutter_assets`, variabla `EXTRACTED_AGENT` merrte rezultatin e fundit dhe
mund të kopjonte executable-in e gabuar.

### Fix

Kërkimi recursive u hoq. `techi-deploy.cmd` zgjedh vetëm path-et e njohura,
në këtë rend:

1. `CommApp\TechiAgent\techi-agent.exe`
2. `PFiles64\TECHI Agent\techi-agent.exe`
3. `CommonAppData\TechiAgent\techi-agent.exe`
4. `TechiAgent\techi-agent.exe`

Nëse asnjë nuk ekziston, manual fallback dështon pa kopjuar një binary të
pasaktë.

### Checks

- Test që `for /R` nuk gjenerohet më.
- Test për të tre path-et specifike dhe rendin e tyre.

## [2026-06-18] GPO Deploy — Defender Exclusions Before Agent Deployment

### Fix

- `gpo-deploy.ps1` shton menjëherë në Domain Controller exclusions lokale për:
  - `C:\ProgramData\TechiAgent`;
  - `C:\Windows\Temp\TechiDeploy`;
  - procesin `techi-agent.exe`.
- GPO `TECHI Agent - Defender Exclusions` vendos registry policy për të dy
  paths dhe procesin, dhe lidhet në domain root në mënyrë idempotente.
- `techi-deploy.cmd` ekzekuton `Add-MpPreference` për të njëjtat exclusions
  përpara version check, download dhe `msiexec`.
- Backend cleanup scheduler nuk nis më cleanup të madh menjëherë në çdo
  container restart; pret dritaren e planifikuar në `03:00 UTC`. Kjo shmang
  request starvation kur pajisjet reconnect-ojnë pas deploy-it.

### Checks

- Test që exclusions lokale në DC vendosen para import/deploy steps.
- Test që GPO registry përmban Paths dhe Processes dhe është linked në domain.
- Test që CMD exclusion command vjen para Case 0 dhe para MSI download.
- Post-deploy health kontrollohet pa startup cleanup concorrente.

## [2026-06-18] GPO Deploy — Verify Installed EXE After MSI Upgrade

### Root cause

`msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus` mund të kthente exit code
`0`, por të linte versionin e vjetër të
`C:\ProgramData\TechiAgent\techi-agent.exe`. MSI e përmbante executable-in e
ri, sepse administrative extract + manual copy funksiononte.

### Fix

- `:do_upgrade` tani ekzekuton `taskkill /f /im techi-agent.exe` pasi ndalon
  service-in dhe para `msiexec`.
- Pas një MSI exit `0`, script-i lexon përsëri versionin real nga
  `%AGENT_EXE% --version`.
- Nëse versioni mungon ose nuk përputhet me `ACTIVE_VERSION`, rrjedha kalon te
  `:manual_replace`.
- Manual fallback:
  - ekstrakton MSI-n me `msiexec /a`;
  - gjen `techi-agent.exe`;
  - ndalon service-in dhe vret çdo proces të mbetur;
  - kopjon executable-in e ri mbi `%AGENT_EXE%`;
  - rinis `TechiAgent`.

### Checks

- Test strukturor për `taskkill` para MSI.
- Test strukturor për version verification pas MSI exit `0`.
- Test strukturor që stop/taskkill ndodhin para manual copy.

## [2026-06-17] GPO Deploy — Robust Outdated-Agent Upgrade Path

### Root cause

Pas shtimit të version check në `techi-deploy.cmd`, dy raste mbetën të
rrezikshme:

- Nëse versioni lokal nuk lexohej nga `--version` ose `agent.config.json`,
  `CURRENT_VERSION` mbetej bosh dhe krahasimi CMD nuk e detyronte upgrade-in
  në mënyrë të besueshme.
- Upgrade MSI mbi një instalim ekzistues mund të dështonte me `1603` kur
  `TechiAgent` ishte ende `RUNNING`.

### Fix

- `CURRENT_VERSION` bosh trajtohet si `0.0.0`, kështu çdo paketë aktive më e
  re shkakton upgrade.
- `:do_upgrade` ndalon `TechiAgent` para `msiexec`.
- Upgrade MSI përdor:
  `REINSTALL=ALL REINSTALLMODE=vomus /quiet /norestart`.
- Pas upgrade-it, script-i tenton `net start TechiAgent`.
- Nëse `msiexec` dështon, script-i bën fallback manual:
  - ekstrakton MSI-n me `/a`;
  - gjen `techi-agent.exe` në extract dir;
  - kopjon executable-in mbi path-in ekzistues;
  - rinis service-in.

### Checks

- Test strukturor për fallback `CURRENT_VERSION=0.0.0`.
- Test strukturor për stop/start service dhe `REINSTALLMODE=vomus`.
- Test strukturor për fallback manual `msiexec /a` + copy të `techi-agent.exe`.

## [2026-06-17] GPO Deploy — Agent MSI Upgrade When Installed Agent Is Outdated

### Root cause

`techi-deploy.cmd` dilte me `exit /b 0` kur `agent.config.json` kishte
`device_id` dhe `TechiAgent` ishte `RUNNING`. Kjo e bënte GPO deployment
idempotent, por bllokonte upgrade-in e agjentëve ekzistues p.sh. nga `1.0.4`
në paketën aktive `2.0.0`.

### Fix

- Shtuar endpoint publik plain-text:
  `GET /api/v1/agent-packages/active-version`.
- Endpoint-i kthen versionin aktiv të paketës `windows-amd64`, p.sh. `2.0.0`,
  me `Cache-Control: no-store`.
- `techi-deploy.cmd` i gjeneruar nga `gpo-deploy.ps1` tani ka **Case 0** para
  idempotency exit:
  - lexon versionin aktual nga `techi-agent.exe --version`;
  - fallback: lexon `agent_version` nga config nëse ekziston;
  - merr versionin aktiv nga serveri;
  - nëse versionet ndryshojnë, shkarkon MSI dhe bën upgrade silent.
- Fresh install kalon `ENROLLMENT_TOKEN=%TOKEN%` dhe `API_URL=%BACKEND_URL%`;
  upgrade ruan konfigurimin ekzistues dhe nuk e ri-enroll-on pajisjen.

### Checks

- Test për `active-version` plain-text success/404.
- Test strukturor që `Case 0` shfaqet para `Case 1` në script-in e GPO deploy.
- Test strukturor që ekzistojnë të dy path-et: upgrade MSI pa token dhe fresh
  install MSI me token.

## [2026-06-17] Agent Version UI — Kolona, Filter, Dashboard, Command Center

### Çfarë u shtua

**Backend:**
- `DeviceBase` schema merr `agent_version: Optional[str] = None` — ekspozohet
  automatikisht nga `/api/v1/devices/` response.
- `DeviceFleetOverview` merr dy fusha të reja: `agents_outdated: int` dhe
  `active_agent_version: Optional[str]`.
- `DeviceOverviewService._compute_overview()` llogarit `agents_outdated` duke
  krahasuar `device.agent_version` me versionin aktiv nga `AgentPackageService
  .latest_active("windows-amd64")`.

**Frontend — DevicesTable:**
- Tip `QuickFilter` dhe array `QUICK_FILTERS` marrin `"needs_agent_update"`.
- Props të reja: `activePackageVersion` dhe `agentsOutdated`.
- Fleet Health Panel zgjerohet nga 6 → 7 karta; karta "Agent Update" (vjollcë)
  filtroi sipas `needs_agent_update`.
- Kolona "Agent" (desktop-only) shfaqet pas kolonës "OS":
  - Badge jeshile nëse `agent_version === activePackageVersion`
  - Badge portokalli nëse versioni është i vjetër
  - "—" gri nëse null
- `DeviceMobileCard` merr prop `activePackageVersion` dhe shfaq
  `Agent v{version} ⚠️` (portokalli) ose `Agent v{version}` (jeshile) në Row 4.

**Frontend — DashboardMobile:**
- Prop `agentsOutdated` i ri; shfaqet si `"Agent updates pending: N →"` në
  seksionin "Needs Attention" (link → `/devices?filter=needs_agent_update`).

**Frontend — AgentCommandsPanel:**
- Target select merr opsionin `"Devices needing agent update"`.
- Zgjidhet si `"all"` në API call (agjentët vetë kontrollojnë versionin).
- InfoNote shpjegon sjelljen.

### Files
- `backend/app/schemas/device.py`
- `backend/app/services/device_overview_service.py`
- `frontend/src/api/devices.ts`
- `frontend/src/components/DevicesTable.tsx`
- `frontend/src/components/DeviceMobileCard.tsx`
- `frontend/src/pages/DashboardMobile.tsx`
- `frontend/src/components/AgentCommandsPanel.tsx`
- `frontend/src/pages/Devices.tsx`
- `frontend/src/pages/Dashboard.tsx`

## [2026-06-16] Agent Update Plan — Dokumentuar

- Krijuar `docs/AGENT-UPDATE-PLAN.md` me planin e plotë teknik
- Filozofia: MSI instalohet 1 herë, gjithçka tjetër kontrollohet nga UI
- 3 faza: Backend/UI Command Center → Agent v2.0 Golang → MSI final deploy via GPO

## 2026-06-13 - Mobile "Command Center" Redesign — BottomNav, DashboardMobile, FilterSheet, Load More

### Problem

Mobile UX (<768px) ishte i papërdorshëm: Dashboard shfaqte tabela me 10 kolona,
`/devices` kishte DeviceTree + 6 stats cards + filter dropdowns që zinin gjithë
ekranin. Nuk kishte navigim persistent në fund (BottomNav). Filter-at ishin
të paarritshëm pa scroll.

### Zgjidhja

**Arkitekturë e ndryshuar (breakpoint shift):**
- `AppShell.tsx`: kalim nga `sm:` (640px) te `md:` (768px) për sidebar dhe
  grid layout. Range 640–767px tani shfaq mobile layout (BottomNav) jo desktop
  sidebar. `<main>` merr `pb-16 md:pb-0` për hapësirë mbi BottomNav.

**Komponentë të rinj:**

1. `components/BottomNav.tsx` — nav i fiksuar poshtë (4 tabs: Dashboard, Devices,
   Alerts me badge, Menu). `md:hidden`. Alert badge nga `useAppData()`. Active
   state sipas `useLocation()`. `env(safe-area-inset-bottom)` padding.
   "Menu" tab → hap mobile sidebar ekzistues (callback nga AppShell).

2. `pages/DashboardMobile.tsx` — SVG health ring (% online, ngjyrë sipas
   threshold: emerald ≥90% / amber ≥70% / red <70%), grid 2×2 stat tiles
   (Total/Online/Critical/Alerts, çdo tile Link → /devices?filter=...), seksioni
   "Needs Attention" (listë çështjesh me count + link, ose "✅ All systems healthy").
   Nuk bën fetch shtesë — konsumon të dhëna nga `fleetOverview` + `alertCount`
   të AppDataContext-it.

3. `components/FilterSheet.tsx` — bottom sheet slide-up (82vh max), `md:hidden`.
   Kapaku (backdrop) mbyll me tap. Permban: quick filter pills (9 opsione),
   connection state pills, listë klientësh tap-able → aplikon `client_id` filter.
   `body.style.overflow = hidden` kur është hapur.

**Ndryshime ekzistuese:**

4. `contexts/AppDataContext.tsx` — shtohen `alertCount`, `totalOpenAlerts`,
   `alerts` duke integruar `useAlerts` brenda providerit. Kjo shmang double-polling
   (ishte i thirrur veçmas në `Devices.tsx`, tani 1 instancë globale).
   `Devices.tsx` tani konsumon `alerts`/`alertCount` nga `useAppData()`.

5. `pages/Dashboard.tsx` — split `md:hidden` (DashboardMobile) /
   `hidden md:block space-y-4` (desktop layout i paprekur).

6. `pages/Devices.tsx` — mobile header minimal (titull + alert badge `md:hidden`);
   desktop header card, DeviceTree, stat cards (4+2), info panels → `hidden md:block`
   / `hidden md:grid` / `hidden md:flex`. `mobileExtraLimit` ref + `handleMobileLoadMore`
   callback: rrit limitin e API call-it (20→40→60) pa prek URL pagination.

7. `components/DevicesTable.tsx`:
   - Fleet health mini-cards (6 butonë): `hidden md:grid`
   - "Devices catalog" card (search + filter dropdowns): `hidden md:block`
   - Mobile branch: shtohet sticky search bar (top-0 z-10) + active filter chip
     + "⚙ Filters" buton → FilterSheet
   - Load More buton poshtë kartave (shfaqet kur `mobileHasMore`)
   - Footer (pagination) → `hidden md:flex`
   - Props të reja: `clients`, `onMobileLoadMore`, `mobileHasMore`, `mobileLoadingMore`

### Vendime arkitekturore

- **Single polling**: `useAlerts` zhvendoset te `AppDataContext` — jo më thirrje
  dyfishe. `Devices.tsx` fsheh `import { useAlerts }`.
- **Load More si limit-growth**: jo accumulator array, jo URL param ndryshim.
  Desktop pagination mbetet e paprekur (konsumon URL `?page=N&limit=N`).
  Mobile konsumon tërë `tableDevices` me limit në rritje.
- **Breakpoint md: (768px)**: konsistente me deklaratën e userit "mobile <768px".
  Range 640-767px: ishte desktop (sidebar), tani: mobile (BottomNav).
- **FilterSheet**: vetëm client list (pa DeviceTree me subgroups) — DeviceTree
  mbetet desktop-only për kompleksitet të reduktuar.
- **"Needs Attention"**: listë çështjesh sipas kategorive (offline/critical/updates
  /alerts) pa fetch shtesë — të dhënat nga `fleetOverview`.

### Testim Manual

**Mobile (390px viewport):**
1. Dashboard → shihen: SVG ring + 2×2 tiles + Needs Attention lista; nuk shihen: tabela, cards
2. BottomNav → 4 tabs të dukshëm fixed poshtë; Alerts tab ka badge nëse ka alerts
3. Devices → shihet: sticky search + "Filters" buton, kartat e device-ve; nuk shihen: DeviceTree, stat cards, filter dropdowns
4. "Filters" tap → FilterSheet slide-up me client list dhe quick filters
5. "Load More" → shfaqet kur ka devices shtesë, rrit listën pa reload
6. "Menu" tab → hap mobile sidebar me të gjithë nav items

**Desktop (1440px viewport):**
1. Dashboard → identik me para (nuk ka ndryshim)
2. Devices → sidebar, stat cards, DeviceTree, DevicesTable identike
3. Filter dropdowns, pagination → të paprekura

## 2026-06-13 - Mobile responsive DevicesTable (card view) + PWA "Add to Home Screen"

### Problem

`/devices` në mobile (~390px) shfaqte tabelën e plotë me 10 kolona duke
shkaktuar scroll horizontal. Butoni Connect ishte i fshehur jashtë ekranit.
Gjithashtu nuk kishte asnjë manifest PWA, kështu që iPhone Safari nuk ofronte
"Add to Home Screen" me ikonë dhe emër korrekt — hapej si faqe web normale.

### Zgjidhja

**DevicesTable responsive:**
- Krijohet `DeviceMobileCard.tsx` — komponent i veçantë, ripërdor të gjithë
  logjikën badge/status/health nga DevicesTable pa duplikim fetch/filter.
  Karta: status dot + hostname + Connect (40×40 px touch target) inline djathtas,
  pastaj badges, Client/Group · Domain, User · IP · Last seen.
- Në `DevicesTable.tsx`: shtuar `<div className="md:hidden">` me listën e
  kartave dhe `<div className="hidden md:block">` që wraps tabelën ekzistuese.
  **Zero ndryshime** në desktop layout — tabela mbetet identike bit-për-bit.
- Checkbox bulk-select hiqet në mobile (nuk ka kuptim pa hover/selection).
- Footer (pagination) mbetet i përbashkët dhe i dukshëm në të dyja.

**PWA:**
- `public/manifest.json` me name/short_name/theme_color/icons.
- 3 ikona PNG të gjeneruara nga `apple-touch-icon.png` me Pillow: 192×192,
  512×512, dhe maskable-512 (ikonë në 80% canvas #0a0a0a për safe-zone Android).
- `index.html`: `<link rel="manifest">`, `<meta name="theme-color">`, dhe meta
  tags iOS (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-mobile-web-app-title`).
- `public/sw.js`: service worker minimal network-first, pa cache agresiv të API
  (dashboard live data). Fallback te cache vetëm nëse rrjeti është plotësisht
  i padisponueshëm.
- `main.tsx`: regjistrim SW pas `window load`.
- `nginx.conf`: location blocks të dedikuara — `manifest.json` dhe `/icons/`
  me `max-age=86400`, `/sw.js` me `no-cache` (browser duhet ta kontrollojë
  çdo herë). Shtuar `worker-src 'self'` në CSP për Firefox.

### Testim manual

1. **iPhone Safari / mobile 390px** — hap `/devices`, verifiko:
   - Secili device shfaqet si kartë, pa scroll horizontal
   - Butoni Connect është gjithmonë i dukshëm inline djathtas hostname
   - Tap kartë → hapet DeviceDrawer
   - Tap Connect → hapet RustDesk (direkt, pa alert)

2. **PWA — iPhone Safari** — hap `https://rdp.techi.com.al`, Share →
   "Add to Home Screen":
   - Ikona TECHI shfaqet saktë
   - Emri tregon "TECHI"
   - Hapja nga Home Screen → standalone mode (pa adresë bar)

3. **Desktop ≥ 768px** — hap `/devices`:
   - Tabela identike si para ndryshimit
   - Asnjë ndryshim vizual a funksional

## 2026-06-13 - Connect button: iOS bypass — shkoni direkt te RustDesk, pa alert

### Problem

Në iOS Safari, butoni Connect provonte `techiremotesupport://` si hap të parë.
Meqë TECHI Remote Support nuk ekziston si app iOS, Safari shfaqte alertin nativ
"Cannot Open Page — the address is invalid". Fallback-i i vonuar (`setTimeout`
1200 ms) për `rustdesk://` nuk ekzekutohej kurrë: iOS Safari kërkon që çdo
navigim me custom scheme të jetë rezultat DIREKT i një user gesture (tap) —
navigimi nga `setTimeout` konsiderohet jashtë stack-ut të gestit dhe bllokohet
në heshtje pa asnjë gabim.

### Zgjidhja

`rustdeskLaunch.ts` fitoi dy shtesa:

- `isIOS()` — helper privat që kontrollon `navigator.userAgent` dhe detekton
  edhe iPadOS (shumë touch points + MacIntel platform).
- `launchConnect(techiUrl, rustdeskUrl, onFallback?)` — wrapper i ri i
  eksportuar që bëhet `entry point` i vetëm për butonin Connect:
  - **iOS**: kapërcen plotësisht `techiremotesupport://`, thërret
    `clickProtocolUrl(rustdeskUrl)` brenda stack-ut të gestit (pa delay), pastaj
    thërret `onFallback?.()` për toast-in "Opening with RustDesk instead".
  - **Çdo platformë tjetër**: delegon te `launchWithFallback()` — sjellja
    ekzistuese me blur-detection nuk preket fare.

`DevicesTable.tsx` dhe `DeviceDrawer.tsx` ndërruan vetëm emrin e thirrjes:
`launchWithFallback` → `launchConnect`. Parametrat identikë.

### Testim manual

- **iPhone/iPad Safari**: kliko Connect → RustDesk hapet menjëherë (pa asnjë
  alert "Cannot Open Page"), shfaqet toast "Opening with RustDesk instead".
- **PC me TECHI Remote Support**: kliko Connect → TECHI Remote Support hapet
  brenda ~300 ms, nuk shfaqet RustDesk, nuk shfaqet toast.
- **PC pa TECHI Remote Support / Android**: kliko Connect → pas ~1200 ms hapet
  RustDesk, shfaqet toast.

## 2026-06-13 - Connect button: TECHI Remote Support first, RustDesk fallback

### Problem

The Connect button always launched `techiremotesupport://` via `window.open()`.
On mobile devices (and any PC without TECHI Remote Support installed) nothing
happened — the protocol was not registered and the browser silently did nothing.
Users on mobile had to use RustDesk manually.

### Solution

`rustdeskLaunch.ts` gained two new exports:

- `buildRustDeskFallbackUrl(id)` — builds `rustdesk://{id}` (same RustDesk ID,
  different scheme).
- `launchWithFallback(techiUrl, rustdeskUrl, onFallback?)` — attempts
  `techiremotesupport://` first via a hidden anchor click (no page navigation),
  then listens for a window `blur` event within 1200 ms. If the OS accepted the
  protocol it hands app focus over and the tab blurs — the listener fires and
  the fallback is suppressed. If no blur arrives the tab remained focused,
  meaning no app handled the protocol, so `rustdesk://` is attempted and the
  optional `onFallback` callback fires (used for toasts). Module-level
  timer/listener state ensures rapid re-clicks cancel any in-flight attempt.

`DevicesTable.tsx` and `DeviceDrawer.tsx` both switched their Connect button
`onClick` from `launchRustDesk()` to `launchWithFallback()` with the
appropriate toast callback (bulk toast / `rsToast`) so users see "Opening with
RustDesk instead" when the fallback fires.

### Manual verification

1. On a PC with TECHI Remote Support installed: click Connect — TECHI Remote
   Support opens within ~100–300 ms, no RustDesk, no toast.
2. On a mobile device or a PC without TECHI Remote Support: click Connect —
   after ~1200 ms RustDesk opens and a brief toast "Opening with RustDesk
   instead" appears.
3. Rapid double-click: only one protocol launch occurs (the second click cancels
   the first attempt's pending timer).

Note: on first use browsers may show an "Open this link in [App]?" confirmation
dialog before handing off — the dialog itself triggers a blur so the heuristic
correctly treats this as success and no fallback fires.

## 2026-06-12 - Token usage warnings: page banner, table badges, and alerts feed

### Problem

Nothing surfaced a token approaching its enrollment limit. Operators found
out only when agents started failing with "token exhausted" — historically
made worse by the (now fixed) re-enrollment inflation.

### Solution

`EnrollmentToken` gained a computed `usage_warning` property: `critical` when
`use_count >= max_uses`, `warning` at 90%+ (constant
`TOKEN_USAGE_WARNING_THRESHOLD = 0.9` in the model), `null` otherwise. Only
`active`/`used` tokens report it; revoked/expired stay silent. The field
rides along on every endpoint that serializes a token, including the list the
Enrollment Bootstrap page loads.

The alerts feed integration is computed on read — no new table, no background
job. `device_alerts.device_id` is NOT NULL, so instead of a migration, the
new `token_usage_alert_service.build_token_usage_alerts` synthesizes alert
rows (kind `token_usage_warning`/`token_usage_critical`, negative ids equal
to `-token_id`, `device_id` null, internal bootstrap tokens excluded) and the
`/alerts/` and `/alerts/count` endpoints merge them in. They cannot be
resolved manually and disappear on their own once `max_uses` is raised.

Enrollment Bootstrap page: an amber banner at the top lists affected tokens
with `use_count/max_uses (percent%)`, the Uses column shows a "⚠️ 90%" or
"🔴 FULL" badge, and clicking either opens a new "Raise Max Uses" modal — the
first UI for the existing PATCH endpoint, whose service layer already
reactivates a `used` token when the limit rises above the use count. The
notification bell (Devices page) routes token alerts to
`/enrollment-bootstrap` instead of a device drawer and hides their resolve
button.

### Verification

New backend tests `test_usage_warning_thresholds` and
`test_build_token_usage_alerts` (thresholds, internal/revoked exclusion,
message format, negative ids); all 16 enrollment tests pass under Python 3.12
in a throwaway backend container. Frontend `tsc --noEmit` is clean — the
nullable `device_id` on alerts required a guard in the Devices page alert
map, which now skips synthetic alerts.

## 2026-06-12 - Exhausted enrollment tokens no longer block re-enrollment of existing devices

### Problem

Once a token reached `max_uses` (status `used`), every enrollment with it was
rejected at `validate_for_enrollment` — including re-enrollments of devices
that were originally enrolled with that token. Since the previous fix made
re-enrollments free (they no longer consume a use slot), rejecting them on an
exhausted token was inconsistent: a PC that reinstalled its agent could be
locked out even though it claimed no new capacity.

### Root cause and solution

`AgentEnrollmentService.enroll` enforced token status before it knew whether
the request matched an existing device; `find_reenrollment_match` only ran
later, inside `_upsert_device`. The order is now: resolve the token without a
status check (`get_for_enrollment`, new method that still rejects unknown
tokens), run the device match on the payload's agent_id / rustdesk_id /
hostname / IPs, and only then enforce status. A matched device accepts
`active` or `used` tokens; a genuinely new device still requires `active`.
Revoked and expired tokens remain rejected on both paths so revocation stays
an effective kill switch. The `/enroll` endpoint now returns "Enrollment
token exhausted, max_uses reached" for the `used` rejection; audit reasons
(`token_used`, `token_invalid`, ...) are unchanged.

### Verification

New regression tests: `test_exhausted_token_still_allows_reenrollment_of_existing_device`
(token forced to `use_count == max_uses`, status `used`; the same payload
re-enrolls to the same device and `use_count` stays at max) and
`test_exhausted_token_rejects_new_device` (unmatched payload on the same
exhausted token fails with `token_used` audit). All 14 enrollment tests pass
under Python 3.12 in a throwaway backend container on techi-server.

## 2026-06-12 - Enrollment token use_count no longer increments on re-enrollment

### Problem

Every agent `POST /api/v1/agent/enroll` incremented the enrollment token's
`use_count`, including re-enrollments that matched an existing device
(`reenrollment_match`). A single physical PC could consume 2-7 token uses over
its lifetime, so tokens approached `max_uses` far ahead of real deployments.
Production audit data showed the inflation clearly: "Global Fast Food Albania"
had `use_count` 251 against 38 distinct devices and only 1 `device_created`
audit event in the audited window; "Metropol" had 181 against 31 devices.

### Root cause and solution

In `AgentEnrollmentService.enroll`, `mark_enrollment_used(token)` ran
unconditionally after `_upsert_device`, regardless of whether the upsert
created a new device or reconciled to an existing one via
`find_reenrollment_match` (agent_id/rustdesk_id/hostname/IP matching). The
trusted-domain path was unaffected because it never touches a token, and the
operator-facing `/enrollment-tokens/verify` endpoint already used the
non-incrementing `peek()`.

The fix gates the increment on the existing `reenrollment_matched` flag:
`mark_enrollment_used` is now called only when a new device record was
created. Re-enrollments still update the device, write the
`updated_existing`/`reenrollment_match` audit event, and bump the device's
own `enrollment_count`.

### Verification

New regression test `test_reenrollment_does_not_increment_use_count` enrolls
the same payload twice and asserts the second call reconciles to the same
device with `use_count` still 1. Full enrollment test files (12 tests) pass
under Python 3.12 in a throwaway backend container on techi-server with the
patched files volume-mounted; the production container was not modified.

Existing inflated `use_count` values in production were not reset; audit data
is incomplete for older history, so any correction needs an operator decision
on the baseline (for example distinct audited devices per token).

### Problem

Top-level client counts came from `/api/v1/devices/overview`, but the nested
`Servers` and `Client PC` counts were calculated from the currently loaded,
paginated Devices table. A client with 122 devices could therefore initially
show `Client PC: 1` or `0`. Clicking the folder changed the table filter and
made the number appear to correct itself from the newly loaded page.

The same partial dataset caused `Show empty groups` to display populated
folders with a zero count.

### Root cause and solution

`DeviceTree` mixed two count sources: complete overview counts for clients and
partial page data for child folders. The overview aggregation now includes a
`by_client_category` breakdown using the same canonical group and OS rules as
the server/workstation filters. It remains part of the existing count query,
so the overview still uses two database statements.

All tree levels now render from the same cached overview snapshot. Paginated
table data is retained only for row rendering and realtime maintenance
indicators, never for folder counts.

Persisted overview snapshots from the older response format are discarded
once, ensuring the first reload after deployment fetches the category
breakdown instead of briefly rendering zero subgroup counts.

## 2026-06-12 - Persistent session and shared fleet overview architecture

### Problem

Navigating through Dashboard, Clients, Operators, Audit, and Devices could
produce a visible `Loading session...` gate followed by empty tree counts and
stat-card skeletons. Devices table data arrived first, but fleet cards could
take 8 seconds or substantially longer.

Production access logs showed full document requests during the affected
navigation sequence. A document reload destroys module-level React caches, so
the previous in-memory auth cache could not prevent another auth bootstrap.
The bootstrap also made two sequential requests:

- `/api/v1/auth/me`
- `/api/v1/auth/permissions/me`

The fleet cards and tree depended on `/api/v1/devices/summary`. That endpoint
loads complete device records, telemetry, inventory, alerts, health details,
and patch details for the whole fleet even when the UI only needs a handful of
counts.

### Before

Production measurements taken on 2026-06-12:

| Request | Time | Payload |
| --- | ---: | ---: |
| `/api/v1/auth/me` | 1.70 s | 244 B |
| `/api/v1/auth/permissions/me` | 1.15 s | 352 B |
| `/api/v1/devices/?skip=0&limit=20` | 0.32 s | 41 KB |
| `/api/v1/devices/tree` | 0.31 s | 142 B |
| `/api/v1/devices/summary` | 22.81 s | 1.16 MB |

Consequences:

- auth bootstrap blocked the route for roughly 2.85 seconds after a document
  reload;
- the table could render while fleet cards and tree counts remained pending;
- Dashboard and Devices maintained separate caches for the same fleet data;
- Dashboard, Devices, and Remote Support could create separate device
  WebSocket connections as pages mounted and unmounted.

### Backend solution

`GET /api/v1/auth/session` now returns the authenticated operator and effective
permissions in one request.

`GET /api/v1/devices/overview` now returns:

- total, online, stale, and offline counts;
- tree totals and per-client counts;
- critical and warning health counts;
- average fleet health;
- devices needing updates;
- overview load timestamp.

The overview uses two database statements:

1. one grouped aggregation for freshness stats and client tree counts;
2. one joined, minimal health-input query for latest telemetry, inventory, and
   open alert counts.

The response is cached per operator scope for 30 seconds. The existing full
`/devices/summary` endpoint remains available for detailed reports, but it is
not used during Dashboard or Devices page mount.

A local SQLite benchmark with 700 devices completed the uncached overview in
44.5 ms with a 226-byte JSON payload. Production timing must be measured after
deployment, but this is well below the previous full-summary work and payload.

### Frontend solution

`sessionStore.ts` is a module singleton backed by `useSyncExternalStore`.

- user and permissions persist in `sessionStorage`;
- a page reload hydrates auth synchronously;
- one `bootstrapPromise` deduplicates concurrent session requests;
- auth data is removed only by logout or an HTTP 401;
- transient request failures do not erase the stored session.

`AppDataContext.tsx` is mounted once above the routed application.

- fleet overview persists in `sessionStorage`;
- fresh data renders synchronously;
- stale data renders immediately and refreshes in the background;
- concurrent overview requests are deduplicated;
- one shared device WebSocket publishes status and the latest event;
- Dashboard, Devices, and Remote Support no longer create page-owned device
  WebSocket connections.

Devices now loads its paginated table independently and reads all six large
cards plus top-level tree counts from the shared overview. Dashboard reads the
same overview and loads only its small recent-activity datasets.

Row-level health and patch badges load in the background from
`/api/v1/devices/table-details` for only the IDs on the current page. This
preserves table filters and badges without putting the full summary back on the
page-mount critical path.

### Expected behavior

- `Loading session...` appears only when a valid token exists but no persisted
  session has ever been loaded in the current browser tab.
- Route navigation never re-runs auth bootstrap.
- Reloading a tab with persisted session data does not show the auth gate.
- Devices cards and tree use one compact overview request.
- The Devices table remains independently paginated and can render without
  waiting for overview refresh.

### Verification

- Backend application modules compile successfully.
- The overview service smoke test confirms two SQL statements and cache reuse.
- The 700-device overview benchmark completes in 44.5 ms locally.
- The combined auth-session contract returns user and permissions together.
- `npm run build` succeeds after the AuthContext, AppDataProvider, Dashboard,
  Devices, and Remote Support refactor.
- The repository's local pytest environment uses Python 3.9 while existing
  backend code requires Python 3.10+ syntax, so focused pytest collection must
  run in the production-compatible backend environment.

## 2026-06-12 - Devices stat cards stay loading after a hard refresh

### Symptom

After an F5 reload on the Devices page, the paginated table loaded but the
Total, Online, Stale, Offline, Critical, and Warnings cards could remain in
their loading state until the user clicked Refresh.

### Investigation

- `loadTableData()` and `loadSnapshot()` own separate state. The table loader
  does not overwrite snapshot stats, health, patches, or snapshot loading.
- `loadSnapshot()` already handled an empty in-memory cache correctly: a cache
  miss continues to `getDevicesSummary()`.
- The six large cards all use `snapshotLoading` to decide whether to display
  their values or skeletons.
- `getDevicesSummary()` could successfully populate `snapshotStats`,
  `allDevices`, and `healthMap` while `snapshotLoading` remained true.
- The loading flag was cleared only after a `Promise.all()` containing both
  `getDevicesSummary()` and a redundant `getDeviceTree()` request. If the tree
  request remained pending, the summary-backed values existed but the cards
  continued to render skeletons.

### Fix

The snapshot loader now:

- waits only for `getDevicesSummary()` before clearing `snapshotLoading`;
- uses `snapshot.tree_counts` for the tree, which was already part of the
  summary response;
- no longer makes the redundant `getDeviceTree()` request.

```tsx
const snapshotPromise = getDevicesSummary().then((snapshot) => {
  setSnapshotStats(snapshot.stats);
  setTreeCounts({
    total: snapshot.tree_counts.total,
    unassigned: snapshot.tree_counts.unassigned,
    byClient: new Map(
      Object.entries(snapshot.tree_counts.by_client).map(([id, count]) => [Number(id), count])
    ),
  });
  setHealthMap(Object.fromEntries(snapshot.health.map((item) => [item.device_id, item])));
});

await snapshotPromise;
```

### Expected flow

1. The Devices page mounts.
2. `loadSnapshot()` starts one summary request for cards, health, patches, and
   tree counts.
3. `loadTableData()` independently starts the paginated devices request.
4. Each request updates only its own loading and data state.

### Verification

- Run `npm run build` from `frontend`.
- Hard-refresh `/devices` with the browser network panel open.
- Confirm one initial `/api/v1/devices/summary` request, no redundant
  `/api/v1/devices/tree` request, and one paginated `/api/v1/devices/` request.
- Confirm the stat cards populate without clicking Refresh.
