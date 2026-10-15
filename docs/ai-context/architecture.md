# Architecture

> **Scope of this document.** The diagrams and layer maps below describe the
> core as built in spring 2026 and remain accurate for it (heartbeat pipeline,
> realtime flow, drawer). Later layers are summarised in
> [Additions since May 2026](#additions-since-may-2026); the deploy-by-deploy
> detail is in [../CHANGELOG-SOLUTIONS.md](../CHANGELOG-SOLUTIONS.md).

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Go Agent (Mac/Windows endpoints)                                   │
│  Collects: hostname, user, IPs, OS, CPU/RAM, RustDesk metadata      │
│  POST /api/v1/agent/heartbeat  (retry 3x, 5s gap)                  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTP
┌───────────────────────────▼─────────────────────────────────────────┐
│  FastAPI Backend  (port 8000)                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Agent Router  POST /api/v1/agent/heartbeat                  │   │
│  │    DeviceHeartbeatService.process_heartbeat()                │   │
│  │      DeviceRepository (upsert by rustdesk_id)                │   │
│  │      DeviceStatusService.mark_online_from_heartbeat()        │   │
│  │      RustDeskIdentityService.apply_heartbeat_sync()          │   │
│  │      DeviceHeartbeatRepository.create()                      │   │
│  │      RealtimeEventPublisher (HEARTBEAT_RECEIVED etc.)        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Devices Router  /api/v1/devices/                            │   │
│  │    GET /            list with filters + search               │   │
│  │    GET /count       filtered count                           │   │
│  │    POST /           create device                            │   │
│  │    GET /{id}        single device                            │   │
│  │    PUT /{id}        update device                            │   │
│  │    DELETE /{id}     delete device                            │   │
│  │    GET /{id}/activity          activity feed (Phase 3)       │   │
│  │    GET /{id}/rustdesk/health   RustDesk status               │   │
│  │    POST /{id}/rustdesk/verify  ID validation                 │   │
│  │    PUT  /{id}/rustdesk         manual override               │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Reconciliation Worker (background, starts with app)         │   │
│  │  Scans online devices with stale last_seen → marks offline   │   │
│  │  Publishes DEVICE_OFFLINE events                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  WebSocket  ws://localhost:8000/ws/devices                   │   │
│  │  RealtimeConnectionManager — fan-out to all clients          │   │
│  │  RealtimeEventPublisher — async queue, 750ms dedupe TTL      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  Database: SQLite  (backend/techi.db)                               │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ REST + WebSocket
┌───────────────────────────▼─────────────────────────────────────────┐
│  React Frontend  (port 5173)                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  DeviceRealtimeClient   WS lifecycle + reconnect             │   │
│  │  useDeviceRealtime      React hook wrapper                   │   │
│  │  usePollingRefresh      15s REST polling fallback            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Devices page           fleet table, tree nav, search        │   │
│  │  DevicesTable           clickable rows, filters              │   │
│  │  DeviceDrawer           slide-over detail + WS indicator     │   │
│  │  ActivityTimeline       live event feed inside drawer        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Backend Layer Map

### Models (`backend/app/models/`)
| File | Table | Purpose |
|------|-------|---------|
| `device.py` | `devices` | Core device record + all RustDesk fields |
| `device_heartbeat.py` | `device_heartbeats` | Snapshot per heartbeat |
| `device_status_history.py` | `device_status_history` | Online/offline transition log |
| `client.py` | `clients` | Customer/organization |
| `device_group.py` | `device_groups` | Sub-grouping within a client |
| `operator.py` | `operators` | Dashboard user (auth not yet implemented) |

### Key `Device` model fields
- Identity: `rustdesk_id` (unique index), `hostname`, `current_user`, `domain`, `public_ip`, `local_ip`, `os_name`, `os_version`, `platform`, `cpu`, `ram`, `storage`
- Status: `status` (online/offline enum), `last_seen` (DateTime), `device_type` (server/client/unassigned enum)
- RustDesk: `rustdesk_install_status`, `rustdesk_status`, `rustdesk_version`, `rustdesk_install_path`, `rustdesk_sync_state`, `rustdesk_sync_message`, `rustdesk_manual_override` (bool), `rustdesk_conflict_detected` (bool), `rustdesk_synced_at`, `rustdesk_verified_at`, `rustdesk_last_seen_at`
- Relations: `client_id` (FK → clients), `group_id` (FK → device_groups)

### Services (`backend/app/services/`)
| File | Purpose |
|------|---------|
| `device_heartbeat_service.py` | Orchestrates full heartbeat processing pipeline |
| `device_status_service.py` | Online/offline transitions + stale reconciliation |
| `rustdesk_service.py` | RustDesk ID sync, conflict detection, manual override |
| `device_service.py` | Device CRUD with validation |
| `device_activity_service.py` | Unified activity feed (merges heartbeats + status history) |

### Repositories (`backend/app/repositories/`)
All take `db: Session`, thin query layer, no business logic.
- `device_repository.py` — `get_online_stale(cutoff, limit)` used by reconciliation
- `device_heartbeat_repository.py` — `get_recent_by_device(device_id, limit)` added Phase 3
- `device_status_history_repository.py` — `get_recent_by_device(device_id, limit)` added Phase 3

### Schemas (`backend/app/schemas/`)
| File | Key types |
|------|-----------|
| `device.py` | `Device`, `DeviceCreate`, `DeviceUpdate`, `RustDeskHealth` |
| `agent.py` | `AgentHeartbeatPayload`, `DeviceHeartbeatCreate`, `AgentHeartbeatResponse` |
| `activity.py` | `ActivityEvent` (id, type, occurred_at, summary, detail, device_id) |
| `client.py` | `Client`, `ClientCreate` |
| `health.py` | `HealthResponse` |

### WebSocket (`backend/app/websocket/`)
| File | Purpose |
|------|---------|
| `events.py` | `RealtimeEventType` enum + `build_event()` + `device_payload()` |
| `manager.py` | `RealtimeConnectionManager` — connections dict, broadcast, stale cleanup |
| `publisher.py` | `RealtimeEventPublisher` — async queue (maxsize 1000), 750ms dedupe TTL |
| `routes.py` | `/ws/devices` and `/ws/deployments` FastAPI WS routes |

**Standard event shape:**
```json
{
  "event_id": "<uuid4>",
  "version": 1,
  "type": "heartbeat_received",
  "tenant_id": "default",
  "occurred_at": "2026-05-11T11:32:27.384149",
  "reason": "heartbeat_received",
  "data": { "id": 8, "status": "online", "hostname": "...", ... }
}
```

**Event types currently published:**
- `heartbeat_received` — on every heartbeat
- `device_online` — when device transitions offline → online
- `device_offline` — when reconciliation marks device stale
- `device_updated` — when device inventory changes
- `rustdesk_updated` — when RustDesk metadata changes
- `sync_failed` — on RustDesk sync failure
- `connection_ready` — sent to new WS clients on connect
- `server_ping` — periodic server keepalive

---

## Frontend Layer Map

### Key files
| File | Purpose |
|------|---------|
| `src/services/deviceRealtime.ts` | `DeviceRealtimeClient` class — full WS lifecycle |
| `src/hooks/useDeviceRealtime.ts` | React hook, stable callback refs, returns `DeviceRealtimeStatus` |
| `src/hooks/usePollingRefresh.ts` | Polling with in-flight dedup, configurable interval |
| `src/hooks/useDeviceActivity.ts` | REST load + WS prepend + seenIds dedup |
| `src/api/client.ts` | `fetchJson<T>()` with error extraction |
| `src/api/devices.ts` | All device REST calls |
| `src/api/activity.ts` | `getDeviceActivity(deviceId, limit)` |
| `src/types/activity.ts` | `ActivityEvent`, `ActivityEventType` |
| `src/components/DevicesTable.tsx` | Fleet table + search/filter + `onDeviceSelect` prop |
| `src/components/DeviceDrawer.tsx` | Slide-over panel, consumes `useDeviceActivity` |
| `src/components/ActivityTimeline.tsx` | Event list with icon+color per type |
| `src/components/DeviceTree.tsx` | Left-nav tree (client / device type filter) |
| `src/pages/Devices.tsx` | Top-level page, owns all device + drawer + realtime state |

### Realtime data flow (frontend)
```
DeviceRealtimeClient (WebSocket)
  └── onEvent callback
        └── Devices.tsx handler
              ├── mergeDeviceEvent()    patches devices[] / allDevices[] in place
              ├── scheduleDevicesRefresh()   debounced REST refresh (600ms)
              └── setLatestEvent()     flows as prop:
                    └── DeviceDrawer
                          └── useDeviceActivity
                                └── filters by device.id, prepends to events[]
```

### Drawer state pattern (Devices.tsx)
```typescript
const [drawerDeviceId, setDrawerDeviceId] = useState<number | null>(null);
const [drawerOpen, setDrawerOpen] = useState(false);
// drawerDevice is DERIVED from allDevices — auto-reflects realtime patches
const drawerDevice = useMemo(
  () => allDevices.find(d => d.id === drawerDeviceId) ?? null,
  [drawerDeviceId, allDevices]
);
```

### Design system classes (index.css)
| Class | Use |
|-------|-----|
| `.premium-card` | Dark gradient card with subtle coral glow |
| `.premium-card-soft` | Lighter card, less glow |
| `.premium-kicker` | Coral ALL-CAPS label, 0.62rem, tracking-wide |
| `.premium-accent-text` | Coral gradient text |
| `.premium-metric` | Stat card with radial corner glow |
| `.premium-status-online` | Friday "OK" green tint, used for online badges |
| `.premium-status-offline` | Neutral grey tint |

Palette: Friday chat palette (dark, single coral accent). Source of truth is the `--th-*` tokens in `frontend/src/index.css` (dark + light), documented in `docs/reference/MOBILE-DESIGN-SPEC.md` → Design System/Colors.

Tailwind colours (`tailwind.config.js`) all resolve to `--th-*` tokens: `techi-*` (orange = `--th-accent`, card/surface/hover = surface tokens), `status-*`, and every built-in hue (red→critical, amber→warning, emerald→online, sky/blue→info, teal→maint, violet→agent, orange→accent, slate→Friday neutrals). Existing classes therefore follow the palette in dark and light; no per-class `html.light` overrides are needed for hue/slate text.

---

## Go Agent Architecture

```
agent/
├── main.go        entry point, retry loop (3 attempts, 5s gap, exit on success)
├── config.go      TECHI_API_URL env var (default: http://localhost:8000)
├── inventory.go   hostname, current user, IPs, OS name/version, platform, CPU/RAM/storage
├── rustdesk.go    RustDesk discovery: install status, version, path, runtime state
├── heartbeat.go   HTTP POST to /api/v1/agent/heartbeat, parses AgentHeartbeatResponse
└── utils.go       shared helpers
```

**Device type classification (server-side, not in agent):**
- Domain = empty or "WORKGROUP" → `unassigned`
- OS contains "Windows Server" → `server`
- OS contains "Windows 10" or "Windows 11" → `client`
- Otherwise → `unassigned`

---

## Database

- **Production:** PostgreSQL 15 in Docker (`techi-platform-postgres-1`, loopback only), application
  role `techi_app` (no superuser), tuned in `docker-compose.yml` for the 2 GB host (shared_buffers
  256 MB, max_connections 100, jit off, pg_stat_statements). Request pool 30 + 50 overflow with a
  statement timeout; a separate maintenance pool (2 + 2) for the nightly cleanup and reports.
- **Dev / tests:** SQLite (`backend/techi.db`, in-memory in tests)
- **ORM:** SQLAlchemy (sync sessions)
- **Migrations:** Alembic (`backend/alembic/versions/`), one head
- **Session factory:** `backend/app/db/session.py` → `get_db()` FastAPI dependency
- **Conventions:** see [rules.md](rules.md) → Database conventions

---

## API Router Registration (`backend/app/api/v1/api.py`)

```python
api_router.include_router(health.router,       prefix="",            tags=["health"])
api_router.include_router(agent.router,        prefix="/agent",      tags=["agent"])
api_router.include_router(devices.router,      prefix="/devices",    tags=["devices"])
api_router.include_router(deployments.router,  prefix="/deployments",tags=["deployments"])
```

---

## Additions since May 2026

Summaries only; each line names where to look.

| Area | Backend | Frontend |
|---|---|---|
| Authentication | Cookie sessions with refresh rotation, 2FA, operator roles and team permissions (`core/auth.py`, `services/permission_service.py`, team scopes) | `auth/AuthContext.tsx`, `routes/guards.tsx` |
| Client profile | `endpoints/clients.py` (`/clients/{id}/profile`, `/activity`, `/documents`, `/locations`) | `pages/ClientProfile.tsx`, `components/ClientDocuments.tsx`, `components/ClientLocations.tsx` |
| Client locations | Tables `client_locations`, `client_location_rules`; `devices.location_id` / `location_source` ("rule" or "manual"); `services/location_service.py` (RuleMatcher: IP+LAN > LAN > IP, suggestions, apply, assign); `sweep_location_rules` every 15 min from `main.py`; overview `tree_counts.locations` / `by_client_location`; device filter `location_ids` (-1 = none) | Explorer site levels in `components/DeviceTree.tsx` (tree keys `client-N-loc-<id>[-cat[-platform]]`, `client-N-locs-<ids>`), `utils/location.ts`, `SiteLine`, `CountryTag`, `LocationFormModal`, `LocationPicker` |
| Fleet insights | `services/fleet_insights_service.py` (availability from status history, alert trend, problem devices; SWR cache 30 min) | `components/InsightCharts.tsx`, Dashboard and the profile's Analytics |
| SQL helpers | `db/sql.py` → `id_in()` (`= ANY($1)` on PostgreSQL) | — |
| Retention | `tasks/cleanup.py`, nightly 03:00 | — |
| Device presentation | Device schema carries `location_*`, `os_build`, `windows_product_type` | `utils/system.ts` (OS release from build, CPU microarchitecture from `PROCESSOR_IDENTIFIER`, storage share), drawer split Connect via `ConnectMenu` `onMain` |

