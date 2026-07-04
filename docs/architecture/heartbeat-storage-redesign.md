# Heartbeat Storage Redesign — Technical Proposal (NOT implemented)

Status: **proposal only — requires owner approval before any implementation.**
Date: 2026-07-04

This document describes the current heartbeat implementation end-to-end, the
storage/write problems it causes, the proposed redesign, expected benefits,
migration plan, and risks. Nothing in this document has been implemented.

---

## 1. Current implementation (verified in code, not assumed)

### 1.1 Interval configuration and control flow

| Aspect | Current behavior | Where |
|---|---|---|
| Agent default | 60 s (`heartbeat_interval_seconds` in `agent.config.json`) | `agent/config.go:64` |
| Platform policy | **Global** (one value for the whole fleet), default 300 s, clamped 60–600 | `backend/app/services/agent_config_service.py` |
| Policy storage | JSON file `/app/data/agent_policy.json` (Docker volume `backend_data`) — **not** in Postgres, **not** per device | same |
| UI control | Admin page `AgentConfig.tsx` → `PUT /api/v1/agent-config` | `frontend/src/pages/AgentConfig.tsx` |
| Delivery to agent | Every heartbeat **response** carries `heartbeat_interval_seconds`; the agent stores it in `pendingIntervalChange` and resets its ticker after the current cycle | `backend/.../agent.py:109,124`, `agent/main.go:169-171`, `agent/agent.go:95-106` |
| Real-time change | Operator saves in UI → every device adopts the new interval on its **next** heartbeat (≤ 1 old interval of delay). No reinstall, no script needed | — |
| Per-device override | `change_heartbeat_interval` bulk action (clamped 30–3600 s) sets `pendingIntervalChange` | `agent/actions.go:150-168` |
| Persistence agent-side | The dynamic interval is **in-memory only**; after a service restart the agent uses the config-file value (60 s) until the first heartbeat response re-applies the policy (300 s) | — |
| GPO script | `GET /api/v1/agent-config/heartbeat-script` writes the interval into the config file (persistent path) | `agent_config.py` |

Two behaviors worth knowing (current-state facts, not bugs introduced here):

1. **The per-device `change_heartbeat_interval` action is effectively overridden
   within the same cycle.** `processActions` runs first (action stores the
   per-device value), then `hbResp.HeartbeatIntervalSecs > 0` — which the
   backend always sends — overwrites `pendingIntervalChange` with the global
   policy (`agent/main.go:151,169-171`). So per-device intervals only survive
   until the same heartbeat's response is parsed, i.e. they don't survive at all.
2. The docstring in `agent_config.py` ("the agent does NOT support
   apply_agent_config") is stale: interval propagation via heartbeat response
   works and is the primary mechanism today.

### 1.2 What is written to the database on every heartbeat

Per beat, per device (`DeviceHeartbeatService.process_heartbeat_core`):

1. `UPDATE devices` — full-row update (`last_seen` + payload fields). Postgres
   MVCC: one dead tuple of the wide devices row per beat.
2. `INSERT device_heartbeats` — a **full snapshot row** (~25 columns).
3. `INSERT device_telemetry` — cpu/ram/disk %, uptime, latency (small row).
4. Occasionally: `device_activity_events`, `device_alerts` (change-driven — fine).
5. `device_inventory` upsert — only when the agent sends inventory (collect
   flags default false today).

### 1.3 Field-by-field analysis of `device_heartbeats`

| Field | Changes? | Needed per beat? | Correct frequency |
|---|---|---|---|
| `device_id` | key | — | — |
| `status` | on transition | no — `device_status_history` already records transitions | on change |
| `current_user` | occasionally | no — `devices.current_user` + activity event on change | on change |
| `public_ip`, `local_ip` | rarely | no | on change |
| `hostname`, `domain` | almost never | no | enrollment + on change |
| `os_name`, `os_version`, `os_caption`, `os_build`, `windows_product_type`, `platform` | ~never (patch cycles) | no | enrollment + 24 h reconcile |
| `cpu`, `ram`, `storage` (hardware strings) | ~never | no | enrollment + 24 h reconcile |
| `rustdesk_id` | ~never | no | on change |
| `rustdesk_install_status/status/version/install_path` | rarely | no — also duplicated on `devices` | on change |
| `device_type` | ~never | no | on change |
| `created_at` | per row | — | — |

Conclusion: **every column except `created_at`/`device_id` is either static or
already persisted elsewhere on change.** The table is a 7-day sliding window
of ~95% redundant data whose only real consumer is "when did this device last
check in" — which `devices.last_seen` already answers.

### 1.4 Measured cost (60 s interval)

Per device: ~1 MB/day (heartbeat + telemetry rows incl. index entries), plus
~2–3× that in WAL, plus the devices-table dead-tuple churn.

| Fleet | 1 day | 30 days (7-day retention steady state) | 1 year of writes |
|---|---|---|---|
| 50 devices | ~50 MB | ~350 MB on disk | ~18 GB written |
| 200 devices | ~200 MB | ~1.4 GB on disk | ~73 GB written |

At the policy default of 300 s all numbers divide by 5.

---

## 2. Problems

1. **Storage**: the largest table in the system stores almost no information
   per row that isn't in the previous row.
2. **WAL/I-O**: 3 writes + 1 wide-row update per device per minute; WAL volume
   is a multiple of the logical data.
3. **Vacuum pressure**: nightly bulk DELETE + daily autovacuum of dead tuples
   from the devices-row updates.
4. **The wire payload repeats static identity** (OS strings, hardware strings,
   RustDesk paths) every beat — bandwidth and JSON parse cost.

## 3. Proposed redesign

### Phase A — stop persisting redundant snapshots (backend only, no agent change)

- Keep the heartbeat **endpoint contract identical** (same request, same
  response) — zero agent compatibility risk.
- Stop inserting a `device_heartbeats` row per beat. Instead:
  - `devices.last_seen` update (already happens),
  - `device_telemetry` insert (already happens),
  - `device_status_history` on transitions (already happens),
  - a new lightweight `device_checkin_stats` (device_id, day, beat_count)
    if per-day check-in counts are wanted for the UI (optional).
- The response's `heartbeat_id` field: return the device id or a synthetic
  value; the agent ignores it today (verified — `HeartbeatResponse` consumers
  never read it beyond logging).
- UI audit: the only readers of heartbeat history are the device drawer
  "history" views backed by `device_heartbeat_repository` — replace with
  status-history + telemetry + activity events (all already stored).

**Effect**: removes ~60–70% of all row inserts and the biggest table entirely.

### Phase B — delta heartbeats on the wire (agent ≥ 2.1.6, backward compatible)

- Agent computes a SHA-256 over the static block (identity/hardware/OS/RustDesk
  fields) and sends the full block only when the hash changes, on service
  start, or every 24 h; otherwise sends the light beat
  (agent_id, status, telemetry, current_user) + `static_hash`.
- Backend: if `static_hash` matches the stored one → skip the devices-row
  field reconciliation entirely (update `last_seen` only); if it differs or
  fields are present → current full path. Old agents keep sending full
  payloads and hit the current path — **fully compatible**.

### Phase C — telemetry downsampling (optional)

Raw 60 s telemetry for 48 h; 5-minute averages for 30 days (a small rollup
job in the existing 03:00 scheduler). ~80% telemetry reduction.

### Not proposed to change

- Global policy file, UI page, PUT endpoint, response-driven interval delivery
  (all work well and are cheap).
- Suggested small fix while in the area (needs approval): apply the response
  interval only when no per-device action set one in the same cycle, so
  `change_heartbeat_interval` actually works per device.

## 4. Benefits

- Postgres inserts/min: from ~3×N devices to ~1×N.
- Steady-state disk for check-in data: −85% or more.
- WAL volume: roughly −60%.
- Wire payload (Phase B): from ~1.5–2 KB to ~300 B for the common case.
- Vacuum/cleanup: nightly DELETE shrinks to telemetry-only.

## 5. Migration plan

1. Phase A behind a settings flag `HEARTBEAT_SNAPSHOT_PERSISTENCE=true|false`
   (default true = current behavior). Flip on staging, watch the device
   drawer/history UI, then flip in prod.
2. After 7 days with the flag off, the retention job has emptied
   `device_heartbeats`; `DROP TABLE` in a later release.
3. Phase B ships with agent 2.1.6 through the existing self-update pipeline;
   backend accepts both payload shapes indefinitely.
4. Phase C is an isolated job + one query change in the telemetry chart API.

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| A UI view or report reads `device_heartbeats` directly | medium | repo-wide audit of `device_heartbeat_repository` usages before Phase A; the settings flag allows instant rollback |
| `heartbeat_id` consumed by an integration we don't know about | low | keep the field, return synthetic id |
| Delta beat hides a real change if hash collides / bug in hash scope | low | 24 h forced full beat bounds staleness to one day |
| Mixed fleet (old agents) | none | both payload shapes accepted; old agents = current behavior |
| Telemetry rollups change chart granularity beyond 48 h | low | acceptable by design; raw window configurable |
