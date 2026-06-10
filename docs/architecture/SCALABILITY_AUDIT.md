# TECHI Platform — Audit Teknik Skalabilitetit
**Datë**: Qershor 2026 | **Gjendja**: 448 pajisje aktive | **Target**: 1000+ pajisje

---

## Kontekst

- **448 pajisje** aktive aktualisht, target **1000+**
- **5–6 operatorë** punojnë njëkohësisht real-time
- Heartbeat interval: **300 sekonda** (5 min)
- Ngarkesa steady-state: **1000 ÷ 300 = ~3.3 heartbeats/sek**
- Ngarkesa burst (reboot server): **~16.7 heartbeats/sek**

---

## 1. WebSocket Architecture

### Si funksionon
- **Endpoint**: `GET /ws/devices` — `backend/app/websocket/routes.py:62`
- **Model**: 1 WS lidhje per **operator browser tab** (jo per pajisje)
- **5–6 operatorë = 5–6 lidhje WS aktive**
- Pajisjet (agjentët) nuk hapen WS — vetëm postojnë HTTP heartbeat
- **Manager**: `RealtimeConnectionManager` — singleton in-memory Python dict (`websocket/manager.py`)

### Filtering
Operatorët me rol të kufizuar (`operator/readonly`) marrin vetëm eventet e pajisjeve brenda scope-it të tyre (`client_id/group_id`). Owner/admin marrin të gjitha.

### Payload per mesazh WS
Funksioni `device_payload()` dërgon **42 fusha** per pajisje (hostname, status, rustdesk info, assignment, maintenance etj.) + metadata event.
- **~900–1400 bytes** JSON per event
- **~1.3 KB** mesatare

### Batching dhe Throttling
- **Asnjë batching** — çdo heartbeat → 1–2 evente individuale
- **Dedupe window**: `0.75 sekonda` — parandalon dyfishim brenda 750ms
- **Queue**: `asyncio.Queue(maxsize=1000)` — nëse mbushet, eventet hidhen pa gabim

### Ngarkesa 1000 pajisje
```
3.33 hb/sek × 2 evente = 6.7 evente/sek
× 6 operatorë = ~40 WS sends/sek
≈ 55 KB/sek output total
```

---

## 2. Heartbeat Pipeline — Rruga e Plotë

```
POST /api/v1/agent/heartbeat
        │
        ▼
process_heartbeat_core()  ← BLLOKON response HTTP
│
├── SELECT devices WHERE agent_id=?          (indexed)
├── expire_if_needed()                        (maintenance check)
├── device_repo.update()                      (UPDATE + COMMIT + REFRESH)
├── mark_online_from_heartbeat()              (UPDATE status + INSERT history nëse ndryshoi)
├── apply_heartbeat_sync()                    (rustdesk sync)
├── reconcile_trusted_domain_assignment()     (client/group assignment)
├── heartbeat_repo.create()                   (INSERT device_heartbeats)
└── collect_pending_for_delivery()            (SELECT remote_actions)
        │
        ▼ Response kthehet menjëherë
        │
_heartbeat_side_effects()  ← BackgroundTask (async, pa bllokuar response)
│
├── Publish "heartbeat_received" WS           (~1.3KB queue push)
├── Publish "device_updated" WS (nëse ndryshoi inventory)
├── _process_telemetry()                      (SELECT latest + INSERT telemetry + health score + 1-3 WS events)
├── _process_inventory()                      (INSERT/UPDATE device_inventory)
└── _evaluate_post_heartbeat_alerts()         (3+ SELECT queries)
```

### DB ops per heartbeat
| Path | Writes | Reads |
|------|--------|-------|
| Fast (steady state) | 2 (UPDATE device + INSERT heartbeat) | 3–5 |
| Fast (status change) | 4 (+ UPDATE status + INSERT history) | 3–5 |
| Background (side effects) | 2–3 (telemetry + inventory) | 3–6 |
| **Total** | **4–7 writes** | **6–11 reads** |

### Ngarkesa 1000 pajisje
```
3.33 hb/sek × ~10 DB ops = ~33 DB ops/sek (steady state)
16.7 hb/sek × ~10 DB ops = ~167 DB ops/sek (burst)
3.33 INSERT/sek = 288,000 rreshta/ditë = ~2M rreshta/7 ditë (device_heartbeats)
```

---

## 3. In-Memory State

**Asnjë cache in-memory në backend.** Çdo heartbeat lexon device record nga DB fresh.

```python
device = device_repo.get_by_agent_id(agent_id)  # SELECT çdo herë
```

### Online/Offline tracking
- `status` (ONLINE/OFFLINE) — **kolonë DB**, ndryshon me UPDATE
- `freshness_state` (online/stale/offline) — **Python @property**, llogaritur nga `last_seen`:
  - **online**: last_seen < 5 min
  - **stale**: 5–15 min
  - **offline**: > 15 min

### Reconciliation Worker
- Gjen pajisje stale çdo **30 sekonda** (`device_reconciliation_worker.py`)
- `SELECT FROM devices WHERE status=ONLINE AND last_seen < cutoff`
- Batch size: **500 pajisje** per kalim
- Nëse 1000 pajisje shkojnë offline njëkohësisht → 1000 UPDATE + 1000 INSERT history

---

## 4. Database — Gjendja Aktuale (448 pajisje)

### Madhësia e tabelave
| Tabelë | Rreshta | Madhësia | Shkaku |
|--------|---------|----------|--------|
| `device_heartbeats` | 1,609,475 | **780 MB** | 1 INSERT/hb × 7 ditë retention |
| `device_telemetry` | 1,618,677 | **302 MB** | 1 INSERT/hb × 7 ditë retention |
| `device_activity_events` | ~99,981 | 28 MB | Events historike |
| `device_alerts` | 33,012 | 9 MB | Alert history |
| `devices` | 448 | 2.4 MB | Tabela kryesore |

### Top queries me frequencë (nga pg_stat_user_indexes)
| Index | Scans | Tabelë | Çfarë e bën |
|-------|-------|--------|-------------|
| `ix_devices_id` | 14.8M | devices | Lookup by PK çdo heartbeat |
| `ix_device_alerts_device_kind_state` | 11.4M | device_alerts | Alert eval çdo hb |
| `ix_device_inventory_device_id` | 4.6M | device_inventory | Inventory lookup |
| `ix_device_telemetry_created_at` | 3.47M | device_telemetry | **948M tuples read — i shtrenjtë!** |
| `ix_device_heartbeats_id` | 2.85M | device_heartbeats | Heartbeat row lookup |

### Probleme N+1 / query patterns

**`DeviceSummaryService.get_summary()`** — endpoint `/devices/summary`:
```python
devices = DeviceService(db).get_devices(limit=5000)   # 1 query — të gjitha pajisjet
# Pastaj O(N) Python loop:
for device in devices:
    score, state = compute_device_health_score(device, telemetry, alerts, inventory)
```
- 1000 pajisje → ~800ms–1.5 sekonda per request
- 5 operatorë të hapin faqen njëkohësisht = 5 queries paralele × 1.5s = DB ngopet

**`collect_pending_for_delivery`** — seq scan:
- Çdo heartbeat bën scan të `remote_actions` (29 rreshta)
- Mungon index composite `(device_id, status)`

---

## 5. Frontend WebSocket

### Lidhja
- **1 `DeviceRealtimeClient`** per browser tab (`services/deviceRealtime.ts`)
- Ping çdo **20 sekonda** (client_ping mesazh)
- Stale detection: asnjë mesazh në **45 sekonda** → reconnect
- Reconnect backoff: `[1s, 2s, 5s, 10s, 15s, 30s]`
- Auth token dërgohet si query param: `?token=JWT`

### Re-renders per WS mesazh (Devices.tsx)
```
Çdo event:        setLatestEvent()           → 1 re-render
telemetry_updated: setHealthMap()            → 1 re-render shtesë
action events:    setActiveActionMap()        → 1 re-render shtesë
device events:    setAllDevices() + setTableDevices() → 2 re-renders shtesë
─────────────────────────────────────────────────────
Worst case:       4–5 React state updates per WS mesazh
```

### React optimizime ekzistuese
- `useMemo`: `visibleDevices`, `fleetQuickCounts`, `alertsMap`, `treeDevices`, `drawerDevice` ✓
- `useCallback`: `loadSnapshot`, `loadTableData`, `mergeDeviceEvent` etj. ✓
- **Problem**: `setAllDevices()` ndryshon reference array çdo heartbeat → të gjitha `useMemo` të varura nga `allDevices` ri-llogaritin

### Ngarkesa 1000 pajisje
```
3.33 hb/sek × 4 state updates = ~13 setState/sek
50 rreshta × ~35 DOM elementë/row = ~1750 DOM nodes potencialisht
```

---

## 6. Konfigurimi i Serverit

### Uvicorn
```dockerfile
# backend/Dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
```
- **1 worker process, 1 asyncio event loop**
- Background tasks, WS broadcasting, reconciliation worker, HTTP requests — të gjitha ndarë event loop

### DB Connection Pool
```python
# app/db/session.py:20
pool_size=30, max_overflow=50, pool_timeout=30, pool_recycle=1800
# Max: 80 lidhje njëkohësisht
```

### Reconciliation
```python
# app/core/config.py
HEARTBEAT_TIMEOUT_SECONDS = 300      # pajisja = offline pas 5 min pa hb
RECONCILIATION_INTERVAL_SECONDS = 30  # kontrollohet çdo 30 sek
RECONCILIATION_BATCH_SIZE = 500       # max pajisje per kalim
```

### Cleanup (çdo natë 03:00)
- Fshin rreshta > 7 ditë nga `device_heartbeats`, `device_telemetry`, `device_activity_events`
- Bën `VACUUM ANALYZE` — **bllokues** — ndikon queries aktive

---

## 7. Agent — Capabilities

### Heartbeat Response Schema
```python
class AgentHeartbeatResponse:
    device_id: int
    heartbeat_id: int
    rustdesk_id: Optional[str]
    device_type: DeviceType
    status: DeviceStatus
    last_seen: Optional[datetime]
    heartbeat_at: datetime
    pending_actions: List[PendingActionDelivery]   # KOMANDAT
    heartbeat_interval_seconds: Optional[int]       # INTERVAL DINAMIK
```

### Çfarë mund të bëjë serveri me agjentin
- **Dërgon komanda** nëpërmjet `pending_actions` (restart, install, custom command)
- **Ndryshon intervalin** e heartbeat dinamikisht me `heartbeat_interval_seconds`
- **Nuk ka self-update** — asnjë fushë për update URL ose version të ri
  → MSI duhet shpërndarë manualisht nëpërmjet GPO ose mjete të tjera

---

## 8. Scalability Gaps

| Gap | Skedari | Impakt 1000 devices |
|-----|---------|---------------------|
| Single uvicorn worker | `backend/Dockerfile` | 1 CPU, jo horizontal scale |
| In-process WS manager | `websocket/manager.py` | Multi-worker = WS broken |
| Asnjë Redis/pub-sub | — | Shkallëzim i pamundur |
| asyncio.Queue(1000) | `websocket/publisher.py:23` | Burst → event drop |
| Asnjë cache device state | — | 33 DB ops/sek steady-state |
| Full 42-fushë WS payload | `websocket/events.py:45` | Bandwidth i panevojshëm |
| VACUUM mid-operation | `tasks/cleanup.py` | Bllokon queries ~1-3 sek |
| Asnjë index `remote_actions(device_id,status)` | — | Seq scan çdo heartbeat |
| `DeviceSummaryService` pa cache | `services/device_summary_service.py` | 1-2s per load, pa cache |

---

## 9. Severity Ratings

| # | Problemi | Severity | Shpjegim |
|---|----------|:--------:|----------|
| 1 | **Single uvicorn worker** | 🔴 CRITICAL | 1 CPU, asnjë horizontal scale; WS i lidhur me process |
| 2 | **Asnjë cache device state backend** | 🔴 CRITICAL | 33 DB ops/sek steady-state, 167 ops/sek burst |
| 3 | **`DeviceSummaryService` pa cache** | 🔴 CRITICAL | 1–2 sek/request @ 1000 devices, 5 operators = DB ngopet |
| 4 | **WS payload 42 fusha pa delta** | 🟠 HIGH | 56 KB/sek output, shumica data statike |
| 5 | **`device_heartbeats` 780MB, rritje 288K/ditë** | 🟠 HIGH | @ 1000 devices: ~1.7 GB/javë |
| 6 | **Seq scan `remote_actions` pa index** | 🟠 HIGH | Mungon index `(device_id, status)` |
| 7 | **WS pa batching** | 🟡 MEDIUM | Event individual per heartbeat, queue overflow risk |
| 8 | **4–5 React re-renders per WS mesazh** | 🟡 MEDIUM | UI lag @ 1000 devices, 13 setState/sek |
| 9 | **VACUUM ANALYZE gjatë operimit** | 🟡 MEDIUM | Bllokues 1–3 sek çdo natë 03:00 |
| 10 | **Asnjë agent self-update** | 🟢 LOW | MSI manual deployment i nevojshëm |

---

## 10. Çfarë thyhet i pari @ 1000 devices

**Rend i thyerjes nën ngarkesë burst (p.sh. server reboot → 1000 reconnects/60sek)**:

1. **WS broadcast loop** — `asyncio.gather` pret 6 sends × 5s timeout = 30s bllokues potencialisht
2. **asyncio.Queue(1000)** mbushet → eventet hidhen në heshtje
3. **DB pool** (80 lidhje max) saturates nën burst 16.7 hb/sek × 5 connections = 83 > 80
4. **`DeviceSummaryService`** — 5 operators të ngarkojnë faqen njëkohësisht × 2s = 10s total wait

---

*Audit kryer: Qershor 2026 — Gjenerohet nga analiza e kodit + pg_stat_user_indexes + docker stats*
