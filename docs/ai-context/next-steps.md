# Next Steps

Candidate phases for continued development. Each is independent and additive — none require breaking existing architecture.

---

## Phase 4 — Device Assignment + Fleet Management

**Goal:** Allow operators to assign unassigned devices to clients and device groups from the dashboard.

**Scope:**
- Assign device to client (`client_id`)
- Assign device to group (`group_id`)
- Inline edit from Devices table row or DeviceDrawer
- Rename hostname override
- `PUT /api/v1/devices/{id}` already exists — just needs frontend UI

**What already exists:**
- `Client` and `DeviceGroup` models + tables
- `client_id` / `group_id` on `Device`
- `DeviceTree` sidebar already filters by client/type
- `updateDevice()` API call exists in `frontend/src/api/devices.ts`

**What needs building:**
- Client + group list endpoints (`GET /api/v1/clients/`, `GET /api/v1/device-groups/`)
- Assignment UI in DeviceDrawer (dropdowns)
- Optimistic update in drawer after save

---

## Phase 5 — Operator Notes / Device Labels

**Goal:** Let operators attach notes or tags to devices.

**Scope:**
- Free-text notes field on device
- Read/write from DeviceDrawer
- Timestamps on notes
- No auth yet — single-operator assumption

**What needs building:**
- `notes` field on `Device` model (migration required)
- `PUT /api/v1/devices/{id}` already handles partial updates
- Notes editor component in DeviceDrawer

---

## Phase 6 — Deployment Tracking (Placeholder → Real)

**Goal:** Track software deployments pushed to devices.

**Scope:**
- Deployment model (device, package, version, status, timestamps)
- Deployment list endpoint
- Deployment status badge in DeviceDrawer
- No actual execution — tracking only

**What already exists:**
- `deployment_event` in `RealtimeEventType`
- `/ws/deployments` WebSocket channel (registered, unused)
- `deployments` router stub in `backend/app/api/v1/endpoints/`

---

## Phase 7 — Pagination + Large Fleet Support

**Goal:** Support fleets beyond 100 devices without performance degradation.

**Scope:**
- Cursor-based or offset pagination on `GET /api/v1/devices/`
- Frontend pagination controls in DevicesTable
- Lazy-load activity timeline (load more button or virtual scroll)
- Index audit on `devices` table

**What already exists:**
- `skip` and `limit` params already on `GET /api/v1/devices/`
- Pagination placeholder UI in DevicesTable footer

---

## Phase 8 — Auth + Operator Login

**Goal:** Secure the dashboard with operator authentication.

**Scope:**
- `Operator` model already exists (`backend/app/models/operator.py`)
- JWT token auth (FastAPI + python-jose)
- Login page
- Protected routes in frontend
- Token refresh

**Note:** This is a larger scope change that touches every endpoint and the frontend router. Leave for later.

---

## Known Limitations to Address

| Issue | Impact | Fix |
|-------|--------|-----|
| RustDesk ID is `rustdesk-placeholder` on Mac | Mac agent doesn't find RustDesk | Mac-specific RustDesk path detection in `agent/rustdesk.go` |
| Agent is one-shot | Must be run manually or via cron | Wrap as launchd service (Mac) or Windows Service |
| No agent auto-update | Manual redeploy on changes | Agent version field + update check endpoint |
| SQLite in production | Not suitable for multi-user | Swap `DATABASE_URL` to PostgreSQL (no code changes needed, just config) |
| No WS auth | Any client can connect | Add token param to WS URL once auth is implemented |
| DeviceDrawer freshness label doesn't auto-update | Shows stale label until next render | Add a 30s interval to force re-render freshness display |

---

## Deferred / Out of Scope

- Remote shell / terminal execution
- File transfer to remote devices
- Script execution on endpoints
- Automated RustDesk password management
- Multi-tenant isolation (current: single `tenant_id = "default"`)
