# Runtime & Testing

## Service Ports

| Service | URL | Notes |
|---------|-----|-------|
| FastAPI backend | `http://localhost:8000` | uvicorn, `--reload` in dev |
| React frontend | `http://localhost:5173` | Vite dev server |
| WebSocket | `ws://localhost:8000/ws/devices` | devices channel |
| WebSocket | `ws://localhost:8000/ws/deployments` | deployments channel (unused) |
| API docs | `http://localhost:8000/api/v1/docs` | Swagger UI |

---

## Starting Services

### Backend
```bash
cd ~/techi-platform/backend
source venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend
```bash
cd ~/techi-platform/frontend
npm run dev -- --host 0.0.0.0 --port 5173
```

### Agent (one-shot heartbeat)
```bash
cd ~/techi-platform/agent
go run .
```

The agent exits after one successful heartbeat. Run it again to send another.

---

## Health Checks

```bash
# Backend alive
curl http://localhost:8000/api/v1/health
# → {"status":"ok","environment":"development"}

# List all devices
curl http://localhost:8000/api/v1/devices/ | python3 -m json.tool

# Activity feed for device 8
curl http://localhost:8000/api/v1/devices/8/activity | python3 -m json.tool

# RustDesk health for device 8
curl http://localhost:8000/api/v1/devices/8/rustdesk/health | python3 -m json.tool

# WebSocket (requires wscat: npm i -g wscat)
wscat -c ws://localhost:8000/ws/devices
```

---

## TypeScript Check
```bash
cd ~/techi-platform/frontend
npx tsc --noEmit
# Zero output = zero errors
```

---

## Python Import Check
```bash
cd ~/techi-platform/backend
source venv/bin/activate
python -c "
from app.schemas.activity import ActivityEvent
from app.services.device_activity_service import DeviceActivityService
from app.websocket.events import RealtimeEventType
print('All imports OK')
"
```

---

## Environment Variables

### Backend (`backend/.env` or shell env)
| Variable | Default | Purpose |
|----------|---------|---------|
| `HEARTBEAT_TIMEOUT_SECONDS` | ~90 | Seconds before device goes offline |
| `RECONCILIATION_BATCH_SIZE` | configurable | Devices reconciled per run |
| `DATABASE_URL` | `sqlite:///./techi.db` | DB connection |

### Frontend (`frontend/.env`)
| Variable | Default | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `http://localhost:8000` | Backend URL |
| `VITE_REALTIME_DEBUG` | `false` | Set `true` for WS debug logs in console |

### Agent (shell env)
| Variable | Default | Purpose |
|----------|---------|---------|
| `TECHI_API_URL` | `http://localhost:8000` | Backend URL |

---

## Known Working Test Device

- **Device ID:** 8
- **Hostname:** mario.lika's Mac
- **RustDesk ID:** rustdesk-placeholder
- **RustDesk status:** not_installed (Mac, expected)
- **Current user:** mario.lika
- **Activity:** heartbeats, online/offline transitions accumulating since first run

---

## Backend venv

The backend has a `venv` already created at `backend/venv/`. Do not recreate it.
Always activate before running Python commands:
```bash
source ~/techi-platform/backend/venv/bin/activate
```

---

## SQLite Database

File: `backend/techi.db`
Not committed to git (gitignored). Contains all dev data.
To reset: delete the file and run Alembic migrations.

```bash
cd ~/techi-platform/backend
source venv/bin/activate
alembic upgrade head
```

---

## Go Agent Build
```bash
cd ~/techi-platform/agent
go build -o techi-agent .
./techi-agent
```

Module: defined in `agent/go.mod`. Run `go mod tidy` if dependencies are missing.

---

## Realtime Debug

To watch live WebSocket events in the browser console:
```
# In browser console while frontend is open:
# Set VITE_REALTIME_DEBUG=true in frontend/.env, then restart Vite
# You'll see [device-realtime] connected / [device-realtime] message logs
```
