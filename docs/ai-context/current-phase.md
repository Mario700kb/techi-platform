# Current Phase

**Branch:** `stable/phase-2-heartbeat`
**Phase:** 3 — Device Detail Drawer + Live Activity Timeline
**Status:** Complete

---

## What Was Built (Phase 3)

### Device Detail Drawer
- Slide-over panel opened by clicking any device row in the Devices table
- Shows: hostname, online/offline state, current user, RustDesk ID, OS/platform, local/public IP, last heartbeat timestamp, heartbeat freshness indicator, RustDesk sync state, install/runtime status
- Realtime connectivity indicator (Live / Connecting / Polling) tied to WS status
- Smooth CSS slide animation (translate-x, 300ms ease-out)
- ESC key closes drawer, click on backdrop closes drawer
- Drawer device data auto-updates from `allDevices` via `useMemo` — no manual sync needed
- Mobile-responsive (max-w-[480px], full height, scrollable body)

### Live Activity Timeline
- Inside the drawer, shows newest-first activity stream
- Event types: `heartbeat_received`, `device_online`, `device_offline`, `rustdesk_updated`, `sync_failed`, `device_updated`, `reconnect_detected`
- Initial load via REST: `GET /api/v1/devices/{device_id}/activity`
- Realtime prepend: incoming WS events matching `device.id` are prepended instantly via `useDeviceActivity` hook
- Deduplication: `seenIds` ref prevents duplicate entries from REST + WS overlap
- Capped at 60 events in memory

### Backend Activity Layer
- `GET /api/v1/devices/{device_id}/activity?limit=40` — new endpoint
- `DeviceActivityService` merges `device_heartbeats` + `device_status_history` into unified feed
- No new tables — reuses existing data
- Sorted newest-first, limited server-side

---

## Files Changed in Phase 3

### New backend files
- `backend/app/schemas/activity.py`
- `backend/app/services/device_activity_service.py`

### Modified backend files
- `backend/app/repositories/device_heartbeat_repository.py` — added `get_recent_by_device()`
- `backend/app/repositories/device_status_history_repository.py` — added `get_recent_by_device()`
- `backend/app/api/v1/endpoints/devices.py` — added activity endpoint

### New frontend files
- `frontend/src/types/activity.ts`
- `frontend/src/api/activity.ts`
- `frontend/src/hooks/useDeviceActivity.ts`
- `frontend/src/components/ActivityTimeline.tsx`
- `frontend/src/components/DeviceDrawer.tsx`

### Modified frontend files
- `frontend/src/components/DevicesTable.tsx` — clickable rows, `onDeviceSelect` prop, removed unused imports
- `frontend/src/pages/Devices.tsx` — drawer state, `wsStatus` capture, `latestEvent` threading

---

## Verified Working (Phase 3)

```bash
# Activity endpoint responds with real data
curl http://localhost:8000/api/v1/devices/8/activity | python3 -m json.tool

# TypeScript compiles clean (zero errors)
cd ~/techi-platform/frontend && npx tsc --noEmit

# Backend imports resolve
python -c "from app.schemas.activity import ActivityEvent; print('OK')"
```
