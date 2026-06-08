# TECHI Agent Heartbeat Interval

## Configuration

The heartbeat interval is defined per-agent in the JSON config file on each Windows endpoint:

```
C:\ProgramData\TECHI\agent.config.json
```

**Key:** `heartbeat_interval_seconds`  
**Current target value:** `180` (3 minutes)  
**Default (if key absent):** `60` (1 minute, hardcoded in `agent/config.go`)

The interval is read once at agent startup. It cannot be changed without restarting the agent process.

---

## Freshness Thresholds

Backend thresholds must be at least 2× the heartbeat interval to tolerate one missed beat.

| State   | Threshold         | Rule                                             |
|---------|-------------------|--------------------------------------------------|
| Online  | last_seen ≤ 6 min | Within 2× the 180 s interval + 60 s buffer      |
| Stale   | last_seen ≤ 25 min| Reachable but slow / missed several beats        |
| Offline | last_seen > 25 min| No heartbeat for over 4 consecutive intervals    |

**Source files:**
- `backend/app/models/device.py` — `Device.freshness_state` property
- `backend/app/repositories/device_repository.py` — `_apply_freshness_filter()`, `count_stats()`
- `backend/app/services/device_offline_analysis_service.py` — `_ONLINE_MAX`, `_STALE_MAX`

---

## Rollout Procedure

### Prerequisites
- Active Windows domain with Group Policy
- TECHI dashboard access (for `restart_agent` remote action)
- No MSI rebuild required

### Step 1 — Prepare the config file

Create `agent.config.json` with the new interval:

```json
{
  "backend_url": "https://<your-backend>/api/v1/agent/heartbeat",
  "timeout_seconds": 10,
  "retries": 3,
  "retry_delay_seconds": 5,
  "heartbeat_interval_seconds": 180
}
```

### Step 2 — Distribute via GPO (recommended)

1. Open **Group Policy Management** on your domain controller.
2. Create or edit a GPO linked to the OU containing TECHI-managed computers.
3. Navigate to:  
   `Computer Configuration → Preferences → Windows Settings → Files`
4. Create a new File preference:
   - **Action:** Replace
   - **Source:** `\\<DC>\NETLOGON\techi\agent.config.json` (place the file in NETLOGON)
   - **Destination:** `C:\ProgramData\TECHI\agent.config.json`
5. Apply the GPO. It takes effect on the next `gpupdate` cycle (default ~90 min) or immediately after `gpupdate /force`.

### Step 3 — Restart agents to pick up new interval

After GPO has propagated, dispatch the `restart_agent` remote action from the TECHI dashboard:

1. Go to **Devices** → select all (or batch by client).
2. Remote Action → `restart_agent`.
3. The agent service restarts within ~15 seconds and reads the new config.

Stagger the `restart_agent` dispatch in batches of ~100 devices to avoid a burst of simultaneous reconnects.

### Step 4 — Verify

After ~10 minutes, confirm in the dashboard:
- Devices remain **Online** (last_seen within 6 min window).
- Dashboard stat cards show expected counts.
- No flood of "device offline" alerts.

---

## Rollback Procedure

If problems are observed after rollout:

1. **Revert config via GPO:** Update the GPO File preference to restore  
   `"heartbeat_interval_seconds": 60` (or remove the key entirely).
2. **Force GPO update:** `gpupdate /force` on affected machines, or dispatch a domain script.
3. **Restart agents:** `restart_agent` remote action via dashboard.
4. **Revert backend thresholds:** Change the three backend files back to `minutes=2` (online) and `minutes=15` (stale), then redeploy backend.

Backend and agent rollback are independent — the backend thresholds are safe at either value as long as they exceed the actual heartbeat interval.

---

## Load Impact

Measured as sustained requests/second across the fleet at steady state.

| Devices | Interval 60 s | Interval 180 s | Reduction |
|---------|--------------|----------------|-----------|
| 414     | 6.9 req/s    | 2.3 req/s      | −66 %     |
| 700     | 11.7 req/s   | 3.9 req/s      | −66 %     |
| 1 000   | 16.7 req/s   | 5.6 req/s      | −66 %     |

DB connection pool (`pool_size=30`, `max_overflow=50`) is safe at all fleet sizes with 180 s interval.

---

## Remote Action Latency

Actions (restart, sync, etc.) are delivered on the agent's next scheduled heartbeat.

| Interval | Worst-case action delivery |
|----------|---------------------------|
| 60 s     | ~60 s                     |
| 180 s    | ~180 s (3 min)            |

For time-sensitive remote actions, the `immediate_heartbeat` action causes the agent to fire an extra beat immediately after receiving it — but delivery of that command still waits for the next scheduled tick.
