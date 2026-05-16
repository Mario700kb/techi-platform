# Completed Phases

All phases listed here are verified working on branch `stable/phase-2-heartbeat`.

---

## Phase 1 — Core Device Registry

**What was built:**
- SQLAlchemy ORM models: `Device`, `Client`, `DeviceGroup`, `Operator`
- Pydantic schemas for all models
- FastAPI CRUD endpoints for devices: list, get, create, update, delete
- Device filtering by `status`, `device_type`, `client_id`, `group_id`, `search`
- Alembic migration infrastructure
- SQLite dev database (`backend/techi.db`)
- React/Vite frontend scaffold with Tailwind dark theme
- Devices page with table, search, filters
- DeviceTree sidebar component for fleet navigation (by client / device type)

**Key decisions:**
- SQLite for dev (no Docker dependency)
- `device_type` auto-classified from OS name + domain (Windows Server → server, Windows 10/11 → client, else unassigned)
- `WORKGROUP` domain → unassigned type

---

## Phase 2 — Heartbeat Pipeline + Online/Offline Reconciliation

**What was built:**

### Go Agent
- Collects: hostname, current user, domain, public IP, local IP, OS name/version, platform, CPU, RAM, storage
- Discovers RustDesk: install status, runtime status, version, install path
- Sends `POST /api/v1/agent/heartbeat` with full payload
- Retry logic: 3 attempts, 5s between retries
- Exits after one successful heartbeat (designed for cron / service loop)

**Agent files:**
- `agent/main.go` — entry, retry loop
- `agent/heartbeat.go` — HTTP POST, response parsing
- `agent/inventory.go` — system info collection
- `agent/rustdesk.go` — RustDesk discovery
- `agent/config.go` — configuration (endpoint URL, timeouts)
- `agent/utils.go` — shared utilities

### Backend Heartbeat Processing
- `POST /api/v1/agent/heartbeat` endpoint (agent router)
- `DeviceHeartbeatService.process_heartbeat()` — creates or updates device, creates `DeviceHeartbeat` record
- `DeviceStatusService.mark_online_from_heartbeat()` — transitions device to online, records `DeviceStatusHistory`
- `RustDeskIdentityService.apply_heartbeat_sync()` — syncs RustDesk metadata, detects conflicts
- Reconciliation worker: background task marking stale devices offline (heartbeat timeout = configurable, default ~90s)

**New models:**
- `DeviceHeartbeat` — snapshot of each heartbeat
- `DeviceStatusHistory` — log of online/offline transitions with reason

### Realtime WebSocket Infrastructure
- `RealtimeConnectionManager` — manages WS connections, broadcast, stale connection cleanup
- `RealtimeEventPublisher` — async queue-based event publishing with 750ms deduplication TTL
- WebSocket route: `ws://localhost:8000/ws/devices`
- Event types: `connection_ready`, `device_online`, `device_offline`, `device_updated`, `heartbeat_received`, `rustdesk_updated`, `rustdesk_online`, `rustdesk_offline`, `sync_failed`, `server_ping`, `deployment_event`
- All events include: `event_id` (uuid4), `version`, `type`, `tenant_id`, `occurred_at`, `reason`, `data`

### Frontend Realtime Client
- `DeviceRealtimeClient` — WebSocket client class
  - Reconnect delays: `[1s, 2s, 5s, 10s, 15s, 30s]`
  - Stale detection: closes after 45s without message
  - Client ping: every 20s
  - Status: `connecting | connected | disconnected | fallback`
- `useDeviceRealtime` hook — lifecycle wrapper, stable refs for callbacks
- `usePollingRefresh` hook — polling fallback, 15s interval, deduplicates in-flight requests
- `Devices.tsx` — merges WS events into device list via `mergeDeviceEvent()`, schedules REST refresh 600ms after any event

---

## Phase 2.5 — RustDesk Identity + Sync Pipeline

**What was built:**
- `RustDeskIdentityService` — ID validation, normalization, conflict detection, manual override, heartbeat sync
- Conflict detection: if two devices report the same RustDesk ID, `rustdesk_conflict_detected = true` on both
- Manual override: operator can set `rustdesk_id` with reason, sets `rustdesk_manual_override = true`
- Sync states: `unknown`, `synced`, `failed`
- Install states: `not_installed`, `installed`, `unknown`
- Runtime states: `running`, `stopped`, `not_running`, `unknown`
- `GET /api/v1/devices/{id}/rustdesk/health` — detailed RustDesk status
- `POST /api/v1/devices/{id}/rustdesk/verify` — ID validation
- `PUT /api/v1/devices/{id}/rustdesk` — manual override
- Frontend: RustDesk sync badge, runtime display, connect button (launches `rustdesk://` URI)

---

## Phase 3 — Device Detail Drawer + Live Activity Timeline

See [current-phase.md](current-phase.md) for full details.

**Summary:**
- Slide-over drawer with full device details
- Live activity timeline (heartbeats + status transitions, newest first)
- Realtime updates via existing WS infrastructure — no new WS code
- `GET /api/v1/devices/{id}/activity` endpoint merging heartbeats + status history
- `useDeviceActivity` hook with REST load + WS prepend + deduplication
