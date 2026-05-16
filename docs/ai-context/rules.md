# Development Rules

These rules govern all AI-assisted development on this project. Read before making any changes.

---

## Hard Rules (Never Violate)

### Repository
- Work ONLY in `~/techi-platform/` (main repo)
- Do NOT touch `copilot-worktree*`, `techi-platform.worktrees/*`, or any temporary worktrees
- Do NOT auto-commit. Only commit when explicitly asked.
- Current branch: `stable/phase-2-heartbeat`

### Architecture Preservation
- Do NOT rewrite or redesign the existing architecture
- Do NOT rewrite the WebSocket infrastructure (`backend/app/websocket/`)
- Do NOT rewrite the heartbeat pipeline (`DeviceHeartbeatService`, `DeviceStatusService`)
- Do NOT redesign the frontend dashboard layout or design system
- Do NOT modify `useDeviceRealtime`, `DeviceRealtimeClient`, or `usePollingRefresh` unless the task specifically requires it

### UI Design
- Preserve the TECHI dark MSP UI design language
- Preserve orange/pink accents (`techi-orange` #FF553F, `techi-pink` #FF3F32)
- Preserve `.premium-card`, `.premium-kicker`, `.premium-metric`, `.premium-card-soft` patterns
- Do NOT introduce external component libraries (no shadcn, no radix, no MUI)
- Do NOT redesign the Devices page layout, Sidebar, or Topbar

### Data
- No fake/mock data. All data must come from real backend state.
- No hardcoded device IDs or placeholder values in production code

### Forbidden Features (not yet scoped)
- Auth implementation (no login, sessions, JWT)
- Deployment execution (no script running on remote devices)
- Remote shell / terminal
- File transfer
- WebSocket channel redesign

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
1. Create the model in `backend/app/models/`
2. Import it in `backend/app/models/__init__.py`
3. Generate migration: `cd backend && alembic revision --autogenerate -m "description"`
4. Review the generated migration file in `backend/alembic/versions/`
5. Apply: `alembic upgrade head`
6. Verify the table exists before proceeding

Do NOT modify existing migration files.

---

## Adding a New Realtime Event Type

1. Add to `RealtimeEventType` enum in `backend/app/websocket/events.py`
2. Add to `DeviceRealtimeEventType` union in `frontend/src/services/deviceRealtime.ts`
3. Add handling in `frontend/src/hooks/useDeviceActivity.ts` `EVENT_SUMMARIES` map
4. Add icon config in `frontend/src/components/ActivityTimeline.tsx` `EVENT_CONFIG`
