# Real-time Agent Channel — Proposal (NOT implemented)

Status: **proposal, deferred by the owner on 2026-10-12** ("we will look at it
another time"). Nothing here is approved or implemented. Roadmap entry:
[INIT-RT-001](../IMPLEMENTATION-ROADMAP.md#4-initiative-register).

Related: [heartbeat-storage-redesign.md](heartbeat-storage-redesign.md) (2026-07
proposal on heartbeat storage), [heartbeat-interval.md](heartbeat-interval.md),
RISK-CAP-001/003 and RISK-SEC-002 in [PROJECT_STATE.md](../PROJECT_STATE.md).

## Përmbledhje e thjeshtë (për pronarin)

- **Sot:** çdo PC "troket" te serveri një herë në 5 minuta. Serveri nuk mund ta
  thërrasë PC-në, prandaj një komandë nga console pret **deri në ~5.5 minuta**.
- Çdo troketje dërgon gjithë listat (programe, shërbime, procese) edhe kur s'ka
  ndryshuar asgjë, dhe çdo PC Windows hap PowerShell çdo 5 minuta.
- Butoni **"Refresh inventory"** nuk ngarkon asgjë; inventari ndryshon vetëm në
  troketjen e radhës.
- Troketje më e shpeshtë **nuk** është zgjidhja: në gusht (çdo 3 minuta) serveri ra.
- **Zgjidhja:** një "linjë e hapur" (WebSocket) nga çdo agjent për komanda të
  menjëhershme (<1 s); troketja mbetet për gjendjen, por më e lehtë; të dhëna
  live (çdo 5 s) **vetëm** për PC-në që po shikon dikush.
- Ky është modeli standard i RMM-ve profesionale. Bëhet "enterprise" vetëm me
  siguri, rikthim nëse bie linja, rilidhje e shpërndarë, futje graduale dhe matje
  (§5).

## 1. Current state (measured 2026-10-12)

### 1.1 Production numbers

| Measure | Value |
|---|---|
| Devices | 918 (525 online, 393 offline at 20:15) |
| Heartbeat interval | p50 300 s, p90 309 s (policy 300 s Windows, 250 s Linux; ±10% jitter) |
| Heartbeat rate | ~105 / minute (~1.75 / s) |
| Host | 1 vCPU, 2 GB RAM; 1 uvicorn worker; backend `mem_limit` 800 MB (155 MB used) |
| CPU snapshot | backend ~33%, postgres ~16%, load average ~1.3–1.9 |
| `HEARTBEAT_TIMEOUT_SECONDS` | 600 in production `.env` |
| `AGENT_HEARTBEAT_AUTH_MODE` | `observe` (agent identity not enforced) |
| Largest tables | `device_heartbeats` 650 MB / 1.18M rows (7 days kept), `device_telemetry` 306 MB, `device_alerts` 292 MB / 989k, `device_status_history` 231 MB |

History: a 180 s interval (~4.4 req/s) collapsed the host on 2026-08-03
(RISK-CAP-001).

### 1.2 Agent cycle (Go, `agent/`)

Each cycle, in order (`agent/main.go:78-193`), then wait interval ±10% (the
timer restarts only after the cycle ends, `agent/agent.go:94-95`):

1. Inventory, including an outbound call to `api.ipify.org` for the public IP
   (`inventory.go:51-97`, `utils.go:54-75`).
2. RustDesk self-healing and discovery (`rustdesk_manage.go`, `rustdesk.go`).
3. Telemetry: CPU (100 ms sample), RAM, disk, uptime (`telemetry.go:23-51`); a
   TCP dial to measure latency (`telemetry.go:53-67`).
4. Processes (top 50), services (**uncapped**), software (≤500) when
   `collect_*` is on (`processes.go`). **The Windows MSI bootstrap turns all
   three on** (`bootstrap_windows.go:88-90`), so every Windows heartbeat
   re-sends them.
5. Patch status, always: on Windows `powershell` Windows Update search (20 s
   timeout), 3× `reg query`, `Get-HotFix` (`processes.go:389-432`) — **every
   5 minutes on every PC**.
6. One POST `/api/v1/agent/heartbeat`, plain JSON, no compression
   (`heartbeat.go:151-199`); new HTTP client per call; 3 retries with a fixed
   delay.
7. Pending actions from the response run **sequentially inside the cycle**
   (`actions.go:56-64`), each with ack/running/complete POSTs.

### 1.3 How commands reach the agent

- **Main path:** the heartbeat response's `pending_actions`
  (`backend/app/api/v1/endpoints/agent.py:146-179`), so worst-case latency is
  one interval + jitter + cycle time: **~330 s on Windows**, ~275 s on Linux.
- **Push path:** `/ws/agent/commands` exists but is **Linux-only**
  (`agent/command_channel_linux.go`; Windows `runCommandChannel` is a no-op,
  `command_channel_other.go:15`) and only the terminal uses it
  (`backend/app/api/v1/endpoints/terminal.py:87-135`). Server registry is an
  in-process dict (`backend/app/websocket/agent_channel.py`).
- `immediate_heartbeat` forces one extra cycle (`actions.go:200-204`,
  `main.go:185-190`); it is still delivered by the slow path.
- **`refresh_inventory` / `sync_inventory` / `collect_inventory` upload
  nothing**: `handleRefreshInventory` collects locally and returns a message
  string (`agent/actions.go:178-198`). The drawer/table buttons
  (`DeviceDrawer.tsx`, `DevicesTable.tsx`) therefore mislead operators.

### 1.4 Server work per heartbeat

From reading the code (not instrumented): ~30 SQL statements and 6–7 commits
for a typical online device (`device_heartbeat_service.py:135-374`):

- the device row is written **twice** (payload update, then the RustDesk sync
  rewrites `rustdesk_*_at` every time, `rustdesk_service.py:119-162`);
- 2 rows appended (`device_heartbeats`, `device_telemetry`);
- `device_inventory` JSON blobs overwritten whenever any list or patch status
  is present (always, because patch status is always sent);
- telemetry: `get_latest` ×2, health score ×2, ~7 alert-resolve SELECTs.

### 1.5 Browser fan-out

Every heartbeat publishes `heartbeat_received` (no dedupe) and
`telemetry_updated` (0.75 s dedupe, effectively none) to **every admin browser
socket**, unfiltered by page or device (`websocket/manager.py:94-171`,
`publisher.py`). ≈3–6 events/s per open browser.

## 2. Problems

| # | Problem | Effect |
|---|---|---|
| P1 | Commands only ride the heartbeat response on Windows | Up to ~5.5 min per command |
| P2 | Full lists + PowerShell every 5 min | Server writes and client-PC CPU for unchanged data |
| P3 | "Refresh inventory" uploads nothing | Operators think data is fresh when it is not |
| P4 | ~30 statements and 2 device-row writes per heartbeat | Headroom on 1 vCPU spent on duplicates |
| P5 | Every heartbeat broadcast to every browser | Fan-out load with no viewer benefit |
| P6 | Agent identity not enforced (`observe`) | Must be closed before any instant command path |

## 3. Proposal

**Principle:** push for commands, periodic check-in for state, live data only
while someone is looking. Do **not** shorten the heartbeat interval.

1. **Persistent command channel for every agent (Windows included).** Port the
   Linux `/ws/agent/commands` client to Windows; push every queued action, not
   only the terminal. The heartbeat keeps delivering anything not pushed.
   Estimated cost: ~525 idle connections, a ping every 60–120 s (~5–9 small
   messages/s fleet-wide), tens of MB of memory (estimate, to be measured in
   the pilot). Bonus: a dropped connection tells us within seconds that a
   server went away.
2. **Live mode on demand.** Opening a device in the console asks that agent
   (over the channel) for telemetry every ~5 s under a 2–3 min lease the
   browser renews; readings stay in memory and go only to subscribed
   browsers — no DB writes. ~10 staff → at most ~10 live devices.
3. **Inventory when it changes or when asked.** Agent sends lists only when
   their hash changes, or every few hours; patch status every ~6 h; "Refresh
   inventory" uploads immediately via the channel.
4. **Lighter server path (no agent change).** One device-row write per
   heartbeat; drop duplicate reads; broadcast only state changes, and
   per-device telemetry only to browsers viewing that device; review
   `device_heartbeats` retention/shape (see heartbeat-storage-redesign.md).

## 4. Phases

| Phase | Scope | Agent change | Outcome |
|---|---|---|---|
| 1 | §3.4 server path + browser fan-out; map "Refresh inventory" buttons to `immediate_heartbeat` | No | Less CPU now; buttons honest (still next-heartbeat latency) |
| 0 (before 2) | Enforce agent identity (`AGENT_HEARTBEAT_AUTH_MODE` beyond `observe`, RISK-SEC-002) and apply it to the channel | Maybe | Instant command path is not an open door |
| 2 | §3.1 Windows command channel + §3.3 lists on change, patch every 6 h; pilot ~10 PCs, then fleet | Yes | Commands < 1 s; less load on server and client PCs |
| 3 | §3.2 live mode | Small | Real-time CPU/RAM/disk while viewing |

Rollout of an agent change goes through MSI/GPO: the backend currently always
returns `agent_update: None` (`agent.py:177`), so there is no self-update path.

## 5. What makes it enterprise (acceptance rules)

1. **Security first:** enforced agent identity on heartbeat and channel; every
   command audited (who, when, which device); TLS only.
2. **Graceful degradation:** channel down → actions still delivered by the
   heartbeat; nothing lost.
3. **No reconnect storm:** after a server restart agents reconnect with
   randomized backoff (seconds to 1–2 min), never all at once.
4. **Staged rollout:** ~10-PC pilot with measured CPU/memory/latency, then the
   fleet; rollback = previous MSI.
5. **Measured:** connected-agent count, command delivery latency, server CPU
   and memory on the dashboard / system status.

To verify at implementation time: nginx-proxy-manager WebSocket timeouts on
`api-rdp.techi.com.al` must exceed the ping interval (nginx's default
`proxy_read_timeout` is 60 s).
