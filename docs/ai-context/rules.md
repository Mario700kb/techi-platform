# Development Rules

These rules govern all AI-assisted development on this project. Read before making any changes.

---

## Hard Rules (Never Violate)

### Repository
- Work ONLY in `~/techi-platform/` (main repo)
- Do NOT touch `copilot-worktree*`, `techi-platform.worktrees/*`, or any temporary worktrees
- Do NOT auto-commit. Only commit when explicitly asked (an approved deploy includes its commits).
- Production branch: `backport/platform-components-92a521c` (see [../PROJECT_STATE.md](../PROJECT_STATE.md)); `stable/phase-2-heartbeat` and `main` are not production.

### Architecture Preservation
- Do NOT rewrite or redesign the existing architecture
- Do NOT rewrite the WebSocket infrastructure (`backend/app/websocket/`)
- Do NOT rewrite the heartbeat pipeline (`DeviceHeartbeatService`, `DeviceStatusService`)
- Do NOT redesign the frontend dashboard layout or design system
- Do NOT modify `useDeviceRealtime`, `DeviceRealtimeClient`, or `usePollingRefresh` unless the task specifically requires it

### UI Design
- Preserve the TECHI dark MSP UI design language
- Preserve the Friday palette: single coral accent (`--th-accent` / `techi-orange` #E85A3C, bright #FF6B47); colors only via `--th-*` tokens or Tailwind classes (which map onto those tokens) — never hex/rgba literals in components
- Preserve `.premium-card`, `.premium-kicker`, `.premium-metric`, `.premium-card-soft` patterns
- Do NOT introduce external component libraries (no shadcn, no radix, no MUI)
- Do NOT redesign the Devices page layout, Sidebar, or Topbar

### Time
- Every human-facing time is Tirana time (`Europe/Tirane`, DST-aware), on any device: frontend formats with `timeZone: APP_TIME_ZONE` and parses API values with `parseUTC`; form inputs go through `tiranaInputToUtcIso` / `utcToTiranaInput`; backend reports use `format_display` / `to_display`. Storage, APIs and the PostgreSQL server stay UTC — never store local time.

### Data
- No fake/mock data. All data must come from real backend state.
- No hardcoded device IDs or placeholder values in production code

### Features that need the owner's approval first

The May list of "forbidden" features is history: authentication (cookie
sessions, 2FA), the web terminal and deployment exist now. Still not to be
started without the owner: file transfer, and the WebSocket agent-channel
redesign (INIT-RT-001, deferred 2026-10-12).

---

## Strong Preferences

### Backend
- Keep services thin — orchestration in service layer, queries in repositories
- New endpoints go in the appropriate router file in `backend/app/api/v1/endpoints/`
- New services go in `backend/app/services/`
- New schemas go in `backend/app/schemas/`
- Use `build_event()` + `realtime_publisher.publish_threadsafe()` for any new WS event
- Do not bypass the publisher queue — no direct `realtime_manager.broadcast()` from services

### Frontend
- New components → `frontend/src/components/`
- New hooks → `frontend/src/hooks/`
- New API calls → `frontend/src/api/` using `fetchJson` from `client.ts`
- New types → `frontend/src/types/`
- Realtime events flow: WS → `Devices.tsx` onEvent → state/refs → props → child components
- Do NOT create new WebSocket connections for child components. Reuse parent's `useDeviceRealtime`.

### Code Quality
- No comments explaining what code does — code should be self-explanatory
- No error handling for impossible scenarios
- No feature flags
- No backwards-compatibility shims
- Prefer editing existing files over creating new ones when appropriate
- TypeScript must compile with zero errors (`npx tsc --noEmit`)

---

## Safe Development Workflow

1. Read the relevant files before editing (never guess at structure)
2. Check `docs/ai-context/` for current state before starting
3. Make targeted edits — avoid touching files unrelated to the task
4. Verify backend imports after adding new files:
   ```bash
   cd ~/techi-platform/backend && source venv/bin/activate && python -c "from app.services.new_service import X; print('OK')"
   ```
5. Verify frontend TypeScript after any edits:
   ```bash
   cd ~/techi-platform/frontend && npx tsc --noEmit
   ```
6. Test the endpoint with curl before declaring complete:
   ```bash
   curl http://localhost:8000/api/v1/devices/8/new-endpoint | python3 -m json.tool
   ```
7. Do NOT restart the backend unless necessary — uvicorn `--reload` picks up changes automatically
8. Report changed files explicitly at the end of each task

---

## Alembic Migrations

When adding a new database model or column:
1. Create the model in `backend/app/models/` and import it (and list it in `__all__`) in `backend/app/models/__init__.py`
2. Write the migration in `backend/alembic/versions/` (autogenerate as a draft at most; read every line); one head only
3. Nullable new columns without defaults on large tables (no rewrite); indexes on large or busy tables
   (`devices`, `device_alerts`, `device_status_history`, heartbeats, telemetry) are created or dropped
   `CONCURRENTLY` inside `op.get_context().autocommit_block()`
4. Prove it on PostgreSQL before production: `upgrade head`, `downgrade -1`, `upgrade head` on a scratch database
5. Tests that build their own table lists must include any table a joined relationship needs

Do NOT modify existing migration files.

## Database conventions (2026-10-15 review)

- Never `index=True` on a primary key, a column with a unique constraint, or a column that leads a
  composite index — PostgreSQL already has that index; the duplicates were dropped in `j0k1l2m3n4o5`.
- Lists of ids in hot queries go through `app.db.sql.id_in()` (`= ANY($1)` on PostgreSQL): an `IN`
  list is a new statement for every length and once filled pg_stat_statements with 356 MB of text.
- Times are stored as naive UTC (`utcnow_naive`); JSON as text unless it must be queried.
- Retention lives in `app/tasks/cleanup.py` (nightly 03:00): heartbeats/telemetry, resolved alerts
  90 days, enrollment audit 180 days, and others; a new high-volume table needs its own rule there.
- `platform_core` (classification) is imported only by the approved modules
  (`tests/test_platform_core.py` enforces it); category counts go through the repository.

## UI conventions

- Colours only through `--th-*` tokens; components from `components/ui` (`Button`, `Select`,
  `SelectField`, `Modal`, `ConfirmationModal`, `EmptyState`) and the shared pieces
  (`SiteLine`, `CountryTag`, `LocationFormModal`, `LocationPicker`, `useFillHeight`).
- Table headings line up with what their cells show, on the side they are aligned to;
  `e2e/table-alignment.spec.ts` measures ten tables — add a new table to it.
- Loaders: the shared shimmer rows (`th-alerts-skeleton`); a reload keeps the full-screen
  preloader until the page's chunk arrives.
- State that should survive a reload or a shared link lives in the URL (e.g. Devices `?folder=`).
- Cache keys must include every filter that changes the rows (`deviceTableCacheKey`).
- Check every visual change in dark and light, desktop and phone (Playwright screenshots).

## Production deploys

Only on the owner's explicit word ("deploy", "po" to a deploy question). Sequence: `techi-deploy-guard`;
`pg_dumpall` to `/opt/backups/techi/pre-<name>-<ts>.sql.gz` verified with `gzip -t` when the database or
backend changes; `docker tag … :pre-<name>-<sha>` rollback images; `git pull --ff-only`; build only the
changed service; `nginx -t` in a new frontend image; migrations with the new image while the old backend
serves; `up -d --no-deps` one service at a time; readiness polled from inside the backend container; guard
and `scripts/smoke.sh`; then the changelog entry and the `PROJECT_STATE.md` rows, committed, pushed and
pulled on the server. Wrap server steps in `timeout`; watch free disk (root ~87–88%).

---

## Adding a New Realtime Event Type

1. Add to `RealtimeEventType` enum in `backend/app/websocket/events.py`
2. Add to `DeviceRealtimeEventType` union in `frontend/src/services/deviceRealtime.ts`
3. Add handling in `frontend/src/hooks/useDeviceActivity.ts` `EVENT_SUMMARIES` map
4. Add icon config in `frontend/src/components/ActivityTimeline.tsx` `EVENT_CONFIG`
