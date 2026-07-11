# TECHI PLATFORM — OPERATOR MANUAL

| | |
|---|---|
| **Audience** | Operators using TECHI in production (not developers). |
| **Scope** | Describes exactly how the platform behaves as implemented, for the live-validation window. |
| **Version basis** | Backend/frontend of prod branch `stable/phase-2-heartbeat`. **Agent 2.1.8 split-deployment hotfix** supersedes broken 2.1.7, but standalone/domain 2.1.8 canaries exposed Agent/Remote Support coupling, helper-lifecycle, MSI registration-drift, marker-sequencing, and artifact-lineage defects; Windows packages remain pinned to the production-proven 2.1.6 fallback until the fixed 2.1.8 canary passes. |
| **Feature flags** | Some features are hidden behind flags (`FEATURE_*`). This manual marks each flag-gated feature with 🚩 and the flag name. **When a flag is OFF, that feature does not appear at all** — the platform behaves exactly as the classic Windows RMM. |

**How to read the flag notes:** Windows management (Dashboard, Devices,
Enrollment, Remote Support, Command Center, Packages, Alerts, Teams) is always
available. Linux, the Connect menu, the Web Terminal, the Credential Vault,
Notifications, and MikroTik appear only when their flags are enabled.

---

## 1. Signing in

Open `https://rdp.techi.com.al`. Sign in with your operator username and
password. Your **role** (Owner / Admin / Operator / Read-only) decides what you
see and can do (see §26 Permissions). Sessions use a JWT; a light/dark theme
toggle is in the top bar (remembered per browser).

Left sidebar navigation (items appear based on your permissions): **Dashboard,
Devices, Clients, Deployment, Enrollment, Packages, Inventory, Operators, Teams,
Audit Log, Reports, Agent Config**. On mobile (<768px) navigation is a bottom bar with
Dashboard / Devices / Alerts / More.

---

## 2. Dashboard

The landing page — a triage view of the whole fleet.

- **Top metrics**: Total Devices, Online, Stale, Offline. "Availability %" and a
  Realtime/Polling indicator show live status. Data refreshes over a WebSocket
  (falls back to 15s polling if the socket is blocked).
- **Quick-access cards**: My Devices (favorites ★), Critical Health, Offline Now,
  Needs Updates — each click jumps to Devices with that filter applied.
- **Fleet Health**: average health score of active (non-archived) devices.
- **Recent Devices / Recent Deployments / Operators / Activity** panels.
- 🚩 **Infrastructure Overview card** (`FEATURE_LINUX`): platform distribution
  (Windows / Linux / …) with per-platform counts; only appears when a platform
  flag is on and that platform has devices.

Freshness definitions used everywhere: **Online** = seen ≤ 6 min ago,
**Stale** = ≤ 25 min, **Offline** = > 25 min (or never seen).

---

## 3. Device Tree (navigation only)

Left panel on the Devices page — **the "Device Explorer" / Fleet tree**. It is
**navigation only; devices never appear inside the tree** — clicking a node
filters the Device Catalog on the right.

Structure:
```
All Devices
No Client
<Client>                     ← expand
  ├── Servers                ← Windows servers (device type / OS based)
  │     └── 🚩 Windows / Linux   (platform sub-folders — FEATURE_LINUX)
  ├── Client PC              ← Windows workstations
  │     └── 🚩 Windows / Linux
  ├── 🚩 Network             ← MikroTik etc.  (FEATURE_MIKROTIK)
  ├── 🚩 Storage             ← Synology / QNAP (FEATURE_STORAGE)
  └── 🚩 Hypervisors         ← VMware/Hyper-V/Proxmox (FEATURE_HYPERVISOR)
```
- "Show empty groups" toggle at the bottom reveals clients/folders with no
  devices.
- Category and platform sub-folders **appear only when they contain devices**.
  With all flags off you see only the classic **Servers** and **Client PC**
  folders — identical to before Platform Expansion.
- **Automatic placement**: you never choose a folder. The backend classifies each
  device from its platform and OS/type (see §7).

---

## 4. Device Catalog

The main device table. Columns: status dot + health, Hostname, Client / Group,
User, Domain, IP, OS, Agent version, Last Seen, Actions.

- 🚩 A **platform icon** appears before the hostname when `FEATURE_LINUX` is on
  (🪟 Windows, 🐧 Linux, etc.). With the flag off, no icon — the row is unchanged.
- The **OS cell** shows the OS; for Linux it shows distribution + version, with
  kernel + architecture underneath.
- **Agent version badge** (Version Service, 2026-07-10): green = matches the
  active version for that device's platform, orange = older, blue = newer
  than the platform's declared latest (rare). Windows compares against the
  active Agent Binary package (unchanged mechanism); MikroTik and future
  connector platforms compare against their OWN platform's latest version
  (Platform Registry), not the Windows fleet's — MikroTik no longer shows a
  permanent false "outdated" orange.
- Sort by Hostname / Client / Last Seen / Health. Select rows with checkboxes for
  bulk actions.
- Row actions: open the device (Drawer), Connect (Remote Support), and a "⋯" menu.

---

## 5. Search & Filters

- **Search** box: matches hostname, display name, RustDesk ID, user, public/local
  IP. The empty-search state keeps your query (no dead ends).
- **Filters**: status (online/offline), freshness (online/stale/offline), health
  band, agent version, "duplicates only", maintenance, and the tree-driven
  client/group/smart-folder filters.
- 🚩 A `platform` filter (e.g. Linux) and a `category` filter (Network/Storage/
  Hypervisors) are applied automatically when you click platform/category
  sub-folders in the tree.

---

## 6. Device Drawer (universal workspace)

Click a device to open the **Drawer** — the single workspace for every platform.
There is no separate "details page" per platform.

Tabs (rendered from what the device supports):
- **Overview** — identity (hostname, FQDN, domain, IPs, OS), assignment
  (client/group/source), hardware (CPU/RAM/disk), health, and:
  - 🚩 **Kernel / Architecture** rows and a **Capabilities** chip row
    (`FEATURE_LINUX`) — real data reported by the Linux agent; Windows never
    reports these, so its Overview is unchanged.
  - 🚩 **Connect** row with the Connect menu (`FEATURE_PLATFORM_CORE`) — see §12.
- **Remote Support** — RustDesk connection + self-heal status (Windows).
- 🚩 **Terminal** (`FEATURE_TERMINAL` **and** the device reports the `terminal`
  capability) — the embedded Web Terminal (see §14).
- **Management** — remote actions (restart agent, sync/repair, power, etc.),
  subject to your permissions.
- **Notes** — free-text notes on the device (see §23).
- **Timeline** — chronological activity/events for the device (see §24).

Mobile devices open Device Details as a page (`/devices/:id`) with the same
information in a mobile layout.

> **Registry-driven Drawer (in progress).** The Drawer is being completed into a
> fully registry-rendered workspace: tabs, Connect methods and Management actions
> are generated from the Platform / Capability / **Action** registries and the
> device's reported capabilities — not from platform assumptions. A device that
> reports capabilities (e.g. Linux) shows only the tabs its capabilities enable
> (Services, Packages, Docker, Logs, Network, …), exposes its **native Connect
> methods** (SSH / Web Terminal) instead of the Windows Remote Support panel, and
> its Management actions come from the Action Registry. **Windows is unchanged** —
> devices that report no capabilities (today's entire Windows fleet) resolve to
> Windows' declared surface and render exactly as before.
>
> **Live now:** a capability-reporting device (e.g. the Linux agent) opens the
> generic Drawer — Overview with **Connect** as the primary action, capability tabs
> (Services / Packages / Docker / Logs / Network / …), a Management tab whose buttons
> come from the Action Registry, Terminal when the device is terminal-capable, plus
> Notes and Timeline. It shows **no Remote Support** unless the device reports the
> `remote_support` capability. Windows devices continue to open the classic Drawer,
> unchanged. (Desktop; the mobile Device Details page still uses the classic layout.)

**Generic Drawer Overview — the enterprise standard for every non-Windows
platform.** Visually polished 2026-07-10 (larger type, per-section color
accents, a primary Connect button, richer resource meters) — same 5 compact
sections, no long lists, in priority order:
- **Connect** — the primary way to reach the device (§16), a highlighted
  card with a filled Connect button, not a plain dropdown.
- **Identity** — Device ID, hostname, OS/version, kernel, architecture,
  board (when reported). Platform is already shown in the Drawer header.
- **Status** — last seen, local/public IP, current user (when reported), and
  the **Connector** version badge (Version Service, above). Health is shown
  in the Drawer header (score + state), not repeated here.
- **Resources** — CPU / Memory / Storage utilization meters (current usage
  only — no monitoring graphs); turns amber ≥75%, red ≥90%.
- **Assignment** — Client, Group, Assignment Source, and (with permission)
  editable Assign Client / Assign Group — the exact same controls and API
  calls as the classic Windows Drawer's Client Assignment section.

---

## 7. Automatic Classification

You never place a device manually. On enrollment/heartbeat the backend classifies:
- **Windows Server** → Servers ▸ Windows. **Windows 10/11** → Client PC ▸ Windows.
- 🚩 **Linux Server** → Servers ▸ Linux. **Linux Desktop** → Client PC ▸ Linux.
- 🚩 **RouterOS (MikroTik)** → Network ▸ MikroTik.
- 🚩 **Synology/QNAP** → Storage. **VMware/Hyper-V/Proxmox** → Hypervisors.

A legacy device with no recorded platform is treated as **Windows**. The
enrollment token also carries the target Client/Group, so a new device lands in
the right place with no manual move.

---

## 8. Enrollment (Windows)

Windows devices enroll via **Enrollment / Deployment**:
- The **Enrollment** page ("Enrollment Bootstrap") creates enrollment **tokens**
  (name, target Client/Group, max uses, expiry) and generates the deployment
  command/script.
- Windows deployment runs through **AD GPO / NETLOGON**: the generated
  `techi-deploy` bootstrap installs only the product that needs action:
  TECHI Agent MSI for first install/explicit repair, and TECHI Remote Support
  MSI through its own independent lifecycle/version file.
- Tokens are shown once (copy immediately). Enrollment is audited.
- After enrollment the device appears under its Client automatically.
- **Default Group is optional.** A token carries a Client and an *optional* Default
  Group. If you set a group, the device goes there. If you leave it empty, the
  device is auto-placed in the correct standard group (**Servers** / **Client PC**)
  based on what the agent reports — for **any** platform, with no manual step.
  Platform identity always comes from the agent, never the token.

Requires the **Deployment** permission.

### 8a. Platform-aware Deployment dialog

The token **Deployment** dialog (Deployment page ▸ token row ▸ **View**) is
platform-aware. **One enrollment token is shared by every platform** — generating
or regenerating a token updates all sections at once; there are no duplicate
deployments. Sections are metadata-driven and appear only when their Platform
Expansion flag is enabled (Windows is always shown):

| Platform | Status | Visible when | Deployment |
|----------|--------|--------------|------------|
| **Windows** | **Production** | always | Safe one-time command · GPO Startup · GPO Scheduled Task · Bootstrap URL · Download PS1 *(unchanged, production-proven)* |
| **Linux** | Experimental | `FEATURE_LINUX` | One-Time Install (`curl … \| sudo bash`) · Manual URL · arches (amd64/arm64/armhf) · active Linux package |
| **macOS** | Planned | `FEATURE_MACOS` (not yet defined) | placeholder only |
| **MikroTik** | Experimental | `FEATURE_MIKROTIK` | **RouterOS Script** (Connector v1) — select RouterOS 6.x or 7.x, then copy/paste into RouterOS; generated from the Platform Registry template with the token injected; supported arches chr/x86/arm/arm64/mipsbe/mmips/ppc/tile |
| **Synology DSM** | Planned | `FEATURE_STORAGE` | placeholder — Package / SSH Installer |
| **QNAP QTS** | Planned | `FEATURE_STORAGE` | placeholder — Package / SSH Installer |
| **VMware ESXi** | Planned | `FEATURE_HYPERVISOR` | placeholder |
| **Hyper-V** | Planned | `FEATURE_HYPERVISOR` | placeholder |
| **Proxmox** | Planned | `FEATURE_HYPERVISOR` | placeholder |

The **Windows** block remains the production deployment path; its scripts evolve
only for installer safety/repair work. Placeholders reserve the UI only — no
commands, no backend. Adding a future platform is metadata-only: register the
platform + its deployment metadata entry + an icon; the dialog needs no rewrite.

---

## 9. Agent Installation (Windows)

The **TECHI Agent MSI** installs only the Windows service `TechiAgent`
(LocalSystem) and Agent files/registry metadata. TECHI Remote Support is a
separate MSI with its own ProductCode/UpgradeCode, version file, lock, verbose
log, and package type. In the 2.1.8 canary path, the bootstrap/NETLOGON script
writes/preserves `agent.config.json`, runs Agent MSI only for first install or
explicit repair, and starts `TechiAgent` only after `msiexec` returns. It then
requires a fresh `operational` lifecycle state from the current SCM service PID
before Agent deployment is considered healthy. A healthy running Agent whose EXE
was upgraded by UI/self-update is **not** reinstalled merely because MSI ARP
registration is older.

Installer helper subcommands (`installer-marker create/remove`,
`installer-start-service`, `installer-ensure-service`,
`installer-health-check`, `rs-tray-task`, etc.) are utility-only: they must exit
promptly and must never start the Agent runtime, send heartbeat, reconcile
Remote Support, install watchdog state, or write `state=operational`. The Agent
then sends heartbeats, applies its config, and self-updates from the UI.
Remote Support install/update/repair is handled by the Remote Support MSI path,
not by reinstalling the Agent MSI. **Do not reinstall the Agent MSI manually**
unless instructed — "the Agent MSI installs once, normal Agent upgrades come
from the UI/self-update path."

For domain/NETLOGON installs, verbose logs are product-specific:
`C:\ProgramData\TechiAgent\logs\msi-agent-<agent-version>.log` and
`C:\ProgramData\TechiAgent\logs\msi-remote-support-<remote-version>.log`.
If another TECHI MSI transaction is active, bootstrap reports
`installer-busy-retryable` (including MSI exit `1618`) and does not launch a
second uncontrolled install.

### 9a. Agent Startup Lifecycle (agent ≥ 2.1.8)

The agent runs an explicit startup state machine; "service RUNNING" alone no
longer says whether the agent is healthy:

| State | Meaning |
|---|---|
| **Installing** | MSI / `bootstrap-config` phase — outside the agent process. |
| **LoadingConfig** | Reading/migrating `agent.config.json`. Failures (e.g. a transient `Access is denied` from AV/EDR at first boot) are **retried forever** with exponential backoff (5 s → 5 min cap); every retry is logged in `agent.log`. |
| **Enrolling** | Config loaded, device has no identity yet — heartbeat cycles run until enrollment succeeds. |
| **FirstHeartbeat** | Enrolled, waiting for the first successful heartbeat. |
| **Operational** | First heartbeat succeeded. Later transient heartbeat failures never leave this state (the regular interval keeps retrying). |
| **Faulted** | The loop exited with an unexpected error. The service process deliberately **crashes** (exit 2) so the SCM failure actions (restart 1 m/1 m/5 m) restart it — a dead loop never hides behind a RUNNING service. |

The current state is mirrored to `agent.state.json` **next to the config
file** — Windows: `C:\ProgramData\TechiAgent\agent.state.json`, Linux:
`/etc/techi-agent/agent.state.json` (`state`, `detail`, `updated_at`, `pid`).
For Windows deployment health, only a fresh state from the current live PID
with `state=operational` is healthy. MSI success, equal version, or a RUNNING
service alone are insufficient. Config detail is classified without secrets as
`config_missing`, `config_access_denied`, `config_invalid`,
`config_migration_failed`, or `config_ready`.

On Windows, `state=operational` is owned only by the real SCM service runtime.
If a helper process is visible in Task Manager or WMI with a command line like
`techi-agent.exe installer-marker create`, that process is a bug and must not be
trusted as lifecycle authority. The health check must compare the state-file
PID with the current `TechiAgent` SCM PID.

Windows runtime config is canonical at
`C:\ProgramData\TechiAgent\agent.config.json`. The old
`C:\ProgramData\TECHI\agent.config.json` is read only as a validated, one-time
migration/bootstrap source when canonical config is absent.
The **TECHI Agent Watchdog** task (Windows) reads it every 5 minutes and
distinguishes *Service Running* / *Agent Initializing* / *Agent Operational* /
*Agent Faulted*: it restarts the service when the state is Faulted, or stuck
initializing with a stale state file (> 30 min). Operational agents produce no
watchdog log noise. Nothing in the installer, enrollment, deployment scripts,
or the config format changed — the state file is a new, purely diagnostic
artifact.

**One lifecycle engine for every platform.** Windows and Linux run the exact
same state machine, retry policy, and recovery semantics; only the supervisor
differs — Windows uses SCM failure actions (restart 1 m/1 m/5 m), Linux uses
systemd `Restart=always` (10 s). Future platforms (macOS, MikroTik proxy,
storage adapters) reuse this engine; platform code implements platform
operations only.

---

## 10. Linux One-Line Installation 🚩 `FEATURE_LINUX`

On the **Enrollment** page, choose **Platform = Linux**. The generated command is
a single line:

```
curl -fsSL "https://api-rdp.techi.com.al/api/v1/install/linux?token=<TOKEN>" | sudo bash
```

Run it as root on the Linux host. The installer detects the architecture,
downloads the Linux agent, writes `/etc/techi-agent/agent.config.json`, installs
the `techi-agent.service` systemd unit, and enrolls with the token. The device
then appears automatically under Client ▸ Servers/Client PC ▸ Linux.

> If `FEATURE_LINUX` is OFF the Linux option produces the legacy script and the
> `/install/linux` endpoint returns 404.

---

## 11. Packages

**Packages** page manages agent packages (requires Deployment permission).

- Windows: four package types — **Agent MSI** (first install / explicit repair),
  **Agent Binary** (`techi-agent.exe` for UI/self-update), **Update MSI
  (bridge)** (agent-only for legacy agents), and **Remote Support MSI**
  (independently versioned/deployed RustDesk package). Upload, set active,
  download, delete.
- **SHA-alignment rule**: the "active" agent binary's SHA is what "Needs Agent
  Update" compares against. CI must prove the standalone Agent EXE is
  byte-for-byte identical to the Agent EXE embedded in the Agent MSI. Do not
  rebuild MSIs without need.
- 🚩 **Linux tab** (`FEATURE_LINUX`): a Windows | Linux toggle; the Linux panel
  uploads/activates Linux agent binaries per architecture (`linux-amd64`,
  `linux-arm64`, `linux-armhf`). With the flag off, only the Windows packages UI
  exists.

---

## 12. Connect

Two things share the name "Connect":

1. **Existing Connect button** (Windows, always on): on a device row / drawer,
   Connect opens **TECHI Remote Support** (branded RustDesk) — see §13. This is
   unchanged.
2. 🚩 **Connect Framework menu** (`FEATURE_PLATFORM_CORE`): in the Drawer Overview,
   a **Connect** dropdown built dynamically from the device's platform +
   capabilities. It lists the available methods per platform (see §16).
   **Launchers are live (2026-07-10):** selecting Winbox navigates to its
   `scheme://<device-ip>` protocol link; selecting a browser method (WebFig)
   opens `http://<device-ip>/webfig/` in a new tab. **Selecting SSH now opens
   the Embedded SSH Connect terminal (§14a)** instead of a protocol link —
   your own OS SSH client remains available as a secondary option inside
   that panel. The connect action is permission-gated
   (`remote_support_connect`, plus `terminal_open`/`vault_use` for Embedded
   SSH Connect specifically) and audited, the same as the Windows Remote
   Support connect flow.

The operator always uses one Connect entry point; the platform decides which
methods exist.

---

## 13. Remote Support (Windows)

TECHI Remote Support is a branded RustDesk client, installed/updated by the
independent Remote Support MSI lifecycle and configured/observed by the Agent:
- Click **Connect** on a Windows device → opens Remote Support to that device.
- Per-device Remote Support **password** is server-generated, encrypted at rest,
  delivered to the agent each heartbeat (agents ≥ 2.1.5 apply it). Set/reset via
  Command Center or device actions (admin/owner).
- Remote Support package upgrades, for example `1.4.6` → `1.4.7`, are
  independent from Agent upgrades. NETLOGON/GPO should run the Remote Support
  MSI only when Remote Support requires install/update/repair.

---

## 14. Web Terminal 🚩 `FEATURE_TERMINAL` (+ rollout scope + `terminal` capability)

An in-browser terminal inside the Device Drawer (a **Terminal** tab), for Linux
devices that report the `terminal` capability. Production-ready as of
2026-07-10; not yet enabled in production (see Availability note).

- The operator opens the Terminal tab → the backend creates a one-time session
  (short-lived ticket) → the agent opens a PTY (bash/sh) and streams it to your
  browser (xterm.js). No inbound ports; the agent connects outbound only.
- **Resize**: the terminal follows your browser window size automatically
  (sent as a control frame over the same channel — no separate connection).
- **Reconnect**: if the connection drops unexpectedly, the terminal
  auto-retries (up to 2 attempts) before falling back to a manual
  **Reconnect** button. A reconnect always opens a **new** shell session —
  there is no mid-session state to resume, so anything mid-command is lost;
  the terminal shows a `[reconnected — new session]` marker so this is
  never silent.
- **Timeout**: idle sessions close automatically after 15 minutes of no
  activity; any session is hard-capped at 60 minutes regardless of
  activity. A background sweep (every 30 s) also cleans up a session where
  only one side ever connected (e.g. the device went offline mid-session),
  so a forgotten tab never keeps a session open indefinitely.
- Sessions are authenticated, operator-scoped (admin+), and every open,
  deny, and close (by either side or by timeout) is written to the Audit
  Log.
- **Rollout scope**: even with the flag ON, Web Terminal is only reachable
  for devices within the configured rollout scope
  (`FEATURE_TERMINAL_SCOPE` = none/device/group/client/fleet — an owner
  `.env` setting, not visible in the UI). A device outside scope still
  shows the Terminal tab (capability-driven) but the session request is
  denied. This is the same generic mechanism future staged rollouts
  (Remote Actions, SSH Relay, future connector platforms) will reuse.
- **Availability note:** with `FEATURE_TERMINAL` OFF, the Terminal tab does
  not appear and the terminal endpoints return 404 / close. The prior "edge
  WebSocket route" caveat no longer applies — production's proxy already
  supports it, verified 2026-07-10.

---

## 14a. Embedded SSH Connect 🚩 `FEATURE_TERMINAL` (same flag as §14)

**Connect ▸ SSH now opens an Embedded TECHI Terminal by default** — an
in-browser terminal, same look as the Web Terminal above, but for **any**
device whose Connect menu offers an `ssh` method (Linux, MikroTik, and future
Storage/Hypervisor platforms — not just devices with the `terminal`
capability). Code complete as of 2026-07-10; not yet enabled in production
(same `FEATURE_TERMINAL` flag as §14, still off).

- **How it connects**: unlike the Linux Web Terminal (the device's own agent
  dials out), here the **backend itself** opens the SSH connection to the
  device using a credential resolved from the **Credential Vault** — no agent
  or persistent process is required on the device side. This is what makes
  it work for MikroTik and other non-agent connector platforms.
- **Credential resolution** (never guesses, never silently prompts):
  - Exactly one matching Vault credential (Device → Group → Client → Global,
    same precedence used everywhere else in the Vault) → connects
    automatically.
  - More than one → you choose from a list.
  - None → a clear "No SSH credential is available for this device" message,
    with two options: add one in the Credential Vault, or click
    **Temporary Session** to enter a one-time username/password (used once
    for this connection only, never saved to the Vault).
- **Session info panel** above the terminal shows: device, client, operator,
  username, authentication source (Device/Group/Client/Global/Temporary
  Session), start time, duration, idle timer, and status.
- **Errors** are shown in plain language, not a generic "connection closed":
  no credential available, device unreachable, authentication failed,
  connection timed out, host key could not be verified, connection refused,
  or a network error.
- **Secondary option**: "Open in your own SSH client instead" stays one click
  away inside the same panel — same `ssh://<device-ip>` launcher as before.
- **Audit**: every session start/end, credential resolution/miss, and
  connection/authentication failure is written to the Audit Log.
- **Vault**: a credential that has actually connected shows **"Used by:
  Embedded SSH"** and updates **Last Used** in the Credential Vault list —
  distinct from the static "future consumer" hint shown for credentials that
  have never been used yet.
- **Known limitation**: the backend must be able to reach the device's IP
  directly (no NAT traversal) — the same constraint documented for MikroTik
  SSH below. Host key verification is not enforced in this release.

---

## 15. MikroTik 🚩 `FEATURE_MIKROTIK`

MikroTik is the first **Connector** platform (not a native agent). TECHI is an
RMM, not a Winbox replacement: the connector provides operational visibility
only; advanced RouterOS management always happens through **Connect**
(Winbox / WebFig / SSH). The RouterOS script is deliberately tiny (~49 lines,
no loops) and its two scheduled scripts are self-contained, so they keep
working after a router reboot.

**Connector v1.** On the **Deployment** dialog (token ▸ View),
the MikroTik section shows a **RouterOS Version** selector (**RouterOS 6.x** or
**RouterOS 7.x**) and a **RouterOS Script** — generated server-side from the
Platform Registry template with the enrollment token injected (never hardcoded).
Copy the matching script into the router's terminal (or import as a script). It
POSTs the router's identity + token to the standard enrollment endpoint and
installs two RouterOS scheduler items: `TECHI-Heartbeat` and `TECHI-Inventory`.
Both intervals come from **Agent Config** at generation time; default RouterOS
heartbeat is 250 seconds and default inventory is 1800 seconds. The router
self-detects its architecture (chr/x86/arm/arm64/mipsbe/mmips/ppc/tile — an
unknown arch is rejected). The device appears automatically under **Client ▸
Network ▸ MikroTik** (no manual placement), with Connect methods **Winbox /
WebFig / SSH** (metadata only).

The RouterOS heartbeat is minimal (identity + version + local IP; public IP is
inferred at the edge; **health is computed entirely by the backend**) and
updates Last Seen/freshness/status/health. RouterOS inventory is slower
(default every 30 min) and reports only: board, model, serial, firmware,
uptime, architecture, CPU/RAM/storage, bridge count, wireless present (yes/no)
and default-route present (yes/no) — it deliberately does NOT enumerate
interfaces, packages, routes, firewall rules, DHCP leases or DNS; for those,
use Connect. MikroTik uses the compact Generic Drawer with **no capability
tabs**: Overview / Management / Notes / Timeline. The Overview shows Device
ID, identity, RouterOS version, board, architecture, Last Seen, Health,
local/public IP, connector version, **CPU/Memory/Storage utilization meters**
(current usage only — turns amber ≥75%, red ≥90%) and an **editable
Client/Group assignment** (same assign flow as every platform);
Remote Support and Web Terminal are absent; actions are Refresh Inventory,
Restart Connector, and Re-enroll. The Timeline records Device Registered,
Heartbeat Received (only on first heartbeat or offline→online recovery — not
every beat), Inventory Updated, and assignment changes.

**Enrollment reliability (2026-07-10):** if the router's `/agent/enroll` call
fails (expired/reused token, network issue), the script now halts immediately
— it will NOT install the heartbeat/inventory scheduler or create a device.
A device that appears in the platform is guaranteed to have gone through a
successful enrollment, inheriting the token's Client/Group automatically
(Client ▸ Network ▸ MikroTik, no manual placement). If a router paste
produces a "TECHI enrollment failed" log entry, check the token (not expired/
revoked) and outbound HTTPS, then re-paste the script.

**Current user (2026-07-10):** Inventory now also reports the active RouterOS
admin session (if any) — a single extra query, collected on the Inventory
cadence only, not on every heartbeat, to keep the connector's load minimal.
An idle router with no logged-in session is normal, not a health problem.

**Not in this build:** RouterOS API (firewall edits, interface changes,
wireless/VPN/backups/scripting) is a later phase that adds adapter action
execution + capability renderers, with no Drawer/Tree/UI redesign. With the
flag off there are no MikroTik surfaces. Winbox/WebFig/SSH launchers
themselves are live — see §16-19.

---

## 16. Connect Framework 🚩 `FEATURE_PLATFORM_CORE`

The Connect menu is generated entirely from platform + capability metadata — no
hardcoded per-platform menus. Each method has a name, a surface (Desktop or
Browser), a required capability (or none), and a priority. Declared methods per
platform:

| Platform | Connect methods |
|---|---|
| Windows | TECHI Remote Support |
| Linux | Web Terminal, SSH, (Remote Support if a GUI) |
| MikroTik | Winbox, WebFig, SSH |
| Synology | DSM, SSH |
| QNAP | QTS, SSH |
| VMware | vSphere, SSH |
| Proxmox | Web UI, SSH, Web Terminal |
| Hyper-V | TECHI Remote Support |

Rules that matter operationally:
- **SSH is generic**, not Linux-only — any device reporting the `terminal`
  capability offers SSH.
- **Winbox / WebFig / DSM / QTS / vSphere are just methods**, not special
  features — they appear because the platform declares them.
- Adding a future platform means declaring its methods here + an adapter + an
  icon; **no UI redesign**. Launchers (2026-07-10): desktop methods (scheme
  set, e.g. Winbox/SSH) navigate to `scheme://<device-ip>`; browser methods
  with a declared `web_path` (WebFig) open `http://<device-ip><web_path>` in
  a new tab; browser methods with no `web_path` fall back to
  `http://<device-ip>/`. `remote_support`/`web_terminal` keep their own
  dedicated flows and are not launched from this generic mechanism. SSH's
  default action is the Embedded SSH Connect terminal (§14a).
- **Every method is always shown (2026-07-11)** — never hidden just because
  a credential is missing. Each one carries a status:
  - **Ready** — usable now; shows which Vault scope resolved its credential
    (Device/Group/Client/Global credential).
  - **Credential required** — the method exists for this platform, but no
    compatible Vault credential resolves yet. Clicking it opens the
    Credential Vault's "Add credential" form, pre-filled with this device,
    scope, and the matching credential type.
  - **Unavailable on this operating system** — shown disabled with the
    reason, not hidden. Winbox is a Windows-only desktop app; the Connect
    menu detects this from YOUR browser (not the device) and disables it
    with an explanation on macOS/Linux, offering WebFig/SSH instead.
- **Credential matching is type-specific** — SSH matches SSH credentials,
  Winbox matches Winbox credentials, WebFig matches WebFig credentials (or a
  Generic username/password credential, but only when its Purpose field
  explicitly mentions "WebFig"). A credential is never borrowed across an
  unrelated method.
- **"Always use this method"**: pin any Ready method as your default for
  that platform (or a specific device, which takes priority over the
  platform-wide choice) — shown with a "Default" badge afterward. View or
  reset your defaults from **Settings ▸ Connect Defaults**. These are
  per-operator, never shared or global. If your pinned method stops being
  Ready (e.g. its credential was disabled), Connect automatically falls back
  to the platform's own priority order or the next Ready method.

---

## 17. Winbox / 18. WebFig / 19. SSH (MikroTik) 🚩

These are **connection methods** exposed by the MikroTik Connect menu (§16), not
separate features. **Launchers are live (2026-07-10)**: Winbox and SSH open
`winbox://<device-ip>` / `ssh://<device-ip>`; WebFig opens
`http://<device-ip>/webfig/` in a new tab. SSH additionally appears for any
platform reporting `terminal`. Winbox is shown **disabled with an
"Unavailable on this operating system" reason** on macOS/Linux operators
(§16) rather than hidden. Each method's Vault credential is resolved by type
(Winbox → a Winbox credential, WebFig → a WebFig or purpose-marked generic
credential) — if none resolves yet, the method still shows in the menu as
"Credential required" with a one-click "Add credential" action.

**SSH's default action is now the Embedded SSH Connect terminal (§14a)** — a
click on SSH in the Connect menu opens the in-browser terminal, not your own
operating system's SSH client. Your own OS SSH client (`ssh://<device-ip>`)
remains one click away as a secondary option inside that panel.

---

## 20. Credential Vault 🚩 `FEATURE_VAULT`

An enterprise secret store, separate from the Remote Support password system.
Upgraded 2026-07-10 from a flat password list into a full enterprise secret
manager — same encryption, same storage layer, no rewrite.

- **Location**: sidebar ▸ Credential Vault (Admin+, `system_settings` gate for
  the page; the API additionally supports 7 granular permissions below).
- **Credential types** (one metadata-driven form, not per-type pages): SSH
  (username/password or private key + optional passphrase), Windows
  administrator, Winbox, WebFig, API token, SMTP, Webhook, SNMP v2c, SNMP v3,
  generic username/password. Legacy types from the original 2026-07-07 release
  (password, SSH key, SNMP, certificate) still work — every pre-existing
  credential keeps resolving with **no migration required**. Each type
  declares its own required/optional fields, which secret fields it needs, and
  which future integration it's meant for — the create/edit form renders
  itself from this registry (`GET /api/v1/vault/types`), it does not hardcode
  a form per type.
- **Purpose** is a separate, free-text field from Type — e.g. Type =
  "SSH (username/password)", Purpose = "Embedded Terminal". Purpose is
  filterable and shown in the list; it does not affect encryption or scope.
- **Scope**: Global / Client / Group / Device — all four fully supported in
  the create/edit form with searchable pickers (type to search Client/Group/
  Device by name; the Device picker also shows its Client, Group, platform,
  and Device ID). Global is platform-wide (permission-gated); Client/Group/
  Device are restricted to that target — picking a scope shows only the
  relevant picker(s) and clears every other scope's fields. A Device- or
  Group-scoped credential's Client/Group are derived and shown read-only
  ("Client: TECHI shpk (derived context)") — they're joined from the
  device/group at read time, never stored on the credential row itself.
  **Live consumers**: Embedded SSH Connect (§14a) and the Connect menu's
  Winbox/WebFig status (§16) both resolve credentials through this same
  Device → Group → Client → Global precedence — no longer just a
  future-consumer service.
- **Assignments**: beyond a credential's primary scope, it can be explicitly
  linked ("assigned") to one or more additional clients/devices from its
  detail panel — this documents where a credential's blast radius reaches and
  is included in the delete-reference guard below. Assigning/unassigning is
  audited and requires the `vault_assign` permission (or Admin+).
- **Lifecycle/status**: Active / Disabled (toggle, audited) plus computed
  display badges — Expiring soon / Expired (from an optional `expires_at`) and
  Validation failed (from the last Test Connection result). Optional
  `rotation_due_at`/`last_rotated_at`/`last_tested_at` fields are stored but
  **no automatic rotation or expiry action runs anywhere** — these are
  informational badges/filters only.
- Secrets are encrypted (AES-256-GCM envelope, same cipher/master key as
  2026-07-07 — untouched); the UI never shows a stored secret except an
  explicit **Reveal** (requires a reason ≥5 characters; every reveal is
  audited, one credential at a time, never cached, never logged in plaintext).
  A credential with multiple secret fields (e.g. SSH private key + passphrase)
  reveals all of them together, each individually labeled.
- **Test Connection**: real, not simulated — SMTP credentials get a real
  SMTP connect (+ STARTTLS + auth if a password is set, no email actually
  sent); Webhook credentials get a real HTTP POST to the stored URL (reusing
  the Notification Engine's own webhook sender). Every other type honestly
  reports "Connection testing will become available when this credential type
  is connected to a supported integration" — there is no SSH/SNMP/RouterOS
  client in this codebase to test against yet.
- **Deletion**: an unused credential deletes immediately with confirmation. A
  credential still referenced — its own scope target still exists, or it has
  an explicit assignment — returns **409** and lists exactly what blocks it;
  the operator can force-delete after seeing that list (audited as
  `vault_credential_deleted_forced`, distinct from a normal delete). There is
  no silent orphaning.
- **Current integrations** (honest, not aspirational): **Embedded SSH
  Connect (§14a) is now a real, live consumer** of `ssh_password`/
  `ssh_private_key`/legacy `ssh_key` credentials — a credential used to
  authenticate a connection shows **"Used by: Embedded SSH"** and updates
  **Last Used**. Every other credential type still shows only its static
  "future consumers" hint from the type registry (e.g. "Winbox Connect",
  "SNMP Monitoring") — a roadmap hint, not a claim that it works today.
  Notifications (SMTP/Webhook channels) has its **own separate** encrypted
  secret storage; it does not read from the Vault.
- **RBAC**: `vault_view`/`vault_create`/`vault_edit`/`vault_reveal`/
  `vault_delete`/`vault_test`/`vault_assign` — assignable per-Team permission,
  purely additive on top of the existing Admin+ floor (a team can grant one of
  these to a non-admin operator; it never restricts what Admin/Owner already
  have).
- With the flag off, the Vault page/route/endpoints do not exist (404).

---

## 20a. Notifications 🚩 `FEATURE_NOTIFICATIONS`

Sends platform events to Email and/or a generic Webhook — not enabled by
default. Production-ready as of 2026-07-10; not yet enabled in production.

- **Location**: sidebar ▸ Notifications (Admin+, `system_settings`
  permission — same gate as Credential Vault).
- **Channels**: Email (SMTP host/port/TLS/from/to, optional auth) and
  Webhook (URL + custom headers + an optional shared secret sent as
  `X-TECHI-Signature`). Each channel has a **Test** button that sends a
  real message immediately and records the result in Delivery History —
  use it right after creating or editing a channel.
- **Rules**: bind an event type to one channel. Scope is **Global** (fires
  for every client) or **Client** (fires only for that client's devices).
  Optional **minimum severity** (Info+/Warning+/Critical only), **cooldown**
  (suppress repeats of the same rule for N seconds), and a **rate limit**
  (max sends per hour). A rule can be toggled on/off without deleting it.
  **An event with no matching rule notifies nobody** — creating a channel
  alone does nothing until at least one rule points to it.
- **Events covered**: Device Offline, Device Online, Critical Alert (any
  alert opened at Critical severity — CPU/RAM/disk/etc., not just offline),
  Agent Update Completed/Failed, Remote Action Completed/Failed,
  Enrollment Failed, Maintenance Finished, Terminal Session Started/Ended.
- **Delivery History**: every attempt (manual test or rule-triggered),
  with status (Sent / Pending / Retrying / Failed), attempt count, and the
  last error if any. A failed send retries automatically on a fixed
  backoff (1, 5, 15, then 30 minutes) before being marked Failed for good.
- With the flag off, the Notifications page/route/endpoints do not exist
  (404) and no events are ever dispatched — identical to Vault/Terminal's
  darkness contract.

---

## 20b. Client Reports 🚩 `FEATURE_REPORTING`

**Reports** turns existing Dashboard and Alerts data into a client-facing
deliverable. It does not collect a second copy of fleet data.

- **Location:** sidebar ▸ Reports. Requires `view_devices`.
- **Generate now:** select a Client, PDF or CSV, and a reporting period (7,
  30, 90, or 365 days). The report is generated immediately, added to Report
  History, and downloaded.
- **Contents:** client and reporting-period metadata; current Total/Online/
  Stale/Offline counts; average/critical/warning health; pending OS updates
  and outdated-agent totals; device inventory; and alert activity created
  during the selected period.
- **PDF:** paginated, selectable text, suitable for delivery to the client.
  **CSV:** UTF-8 spreadsheet export containing the summary, devices, and alert
  rows.
- **Schedules (Admin/Owner):** create daily, weekly, or monthly UTC schedules.
  Scheduled results appear in the same Report History and remain downloadable.
  A failed run is shown with its error; the schedule advances normally rather
  than retrying every minute.
- **Scope safety:** a report contains the client's complete fleet. A restricted
  operator can generate/download it only when their team grants full access to
  that Client. Group-only or device-only scope is intentionally insufficient.
- **Audit/retention:** generation, failure, download, and schedule changes are
  audited. Generated files are retained for 365 days in persistent backend
  storage, then pruned with their run metadata.
- With `FEATURE_REPORTING` off, the navigation, route, worker, and endpoints
  are absent/inert; the flag remains the production rollback switch.

---

## 21. Platform Icons 🚩 `FEATURE_LINUX`+

A single `PlatformIcon` component renders the per-platform icon (Windows 🪟,
Linux 🐧, MikroTik, generic). It appears in the Catalog (before hostname), tree
platform sub-folders, and the Connect menu — only when a platform flag is on.
Adding a platform = one new icon entry.

---

## 22. Platform Categories

Top-level tree categories are decided automatically by platform class:
**Servers / Client PC** (Windows/Linux agents), **Network** (MikroTik and other
network gear), **Storage** (Synology/QNAP), **Hypervisors** (VMware/Hyper-V/
Proxmox). You never assign a category; the backend does. Categories appear only
when they contain devices.

---

## 23. Alerts

The **Alerts** view lists open alerts across the fleet (single count everywhere).
Alerts come from the alert engine evaluating heartbeat/telemetry (e.g. device
offline, disk/health thresholds). Dismiss with UNDO. A per-platform icon appears
on alert rows when platform flags are on. Alert thresholds are configured in
Agent Config (per-group where applicable).

---

## 24. Notes

In the Device Drawer ▸ **Notes**: add, edit, and delete free-text notes on a
device (requires the Notes permissions). Notes are per-device and retained with
the device.

---

## 25. Timeline

In the Device Drawer ▸ **Timeline**: a chronological feed of the device's
activity/events (enrollment, regrouping, status changes, actions, RustDesk
repairs, user changes, etc.). Read-only.

---

## 26. Teams & Permissions

TECHI uses roles + teams + operator scopes (the current model — no IAM matrix
yet).

**Roles:**
- **Owner** — full control; the only role for the most sensitive commands
  (e.g. **Run PowerShell**).
- **Admin** — almost everything, including admin-gated commands
  (**Set Remote Password, Reboot PC, Self-Update**, and 🚩 **Run Command** for
  Linux).
- **Operator** — day-to-day: view devices, remote support, device actions within
  scope; no platform/security configuration.
- **Read-only** — view only.

**Teams / scopes**: operators can be scoped to specific **clients/groups**; they
only see and act on devices in their scope. Manage under **Operators** and
**Teams** (requires manage_operators / manage_teams).

**Granular permissions** (assigned via teams): view_devices, remote_support_
connect/manage, restart_device, restart_agent, reinstall_remote_support,
maintenance_mode, diagnostics, view/edit_notes, view_inventory, view_patch,
deployment, manage_clients/groups/operators, audit_log, system_settings.

---

## 27. Command Center

**Agent Config ▸ Command Center** (also reachable per the Agent Config page).
Send commands to targets: All, Online, a Client, a Group, or Selected devices.

Available commands (visible per your role):
- **Ping**, **Collect Inventory** — diagnostics.
- **Restart Agent**, **Change Heartbeat Interval**, **Self-Update** (admin+).
- **Reboot PC** (admin+, 2-step confirm), **Restart Device**.
- **Sync/Restart TECHI Remote**, **Set Remote Password** (admin+),
  **Register Protocol**.
- **Run PowerShell** (Owner only) — runs a script as SYSTEM on Windows targets.
- 🚩 **Run Command** (`FEATURE_LINUX`, admin+) — runs a shell script on Linux
  targets via a selected **engine** (Bash / sh / BusyBox / Python 3). Windows
  targets use Run PowerShell; the engine auto-resolves per platform. Only appears
  when `FEATURE_LINUX` is on.

Each command shows live progress, exit code, and per-device output in the batch
view. Destructive commands require confirmation; some (reboot) require typing the
device count. Everything is audited.

The **Heartbeat interval** is a single global policy (currently 250 s), changed
in Agent Config; every device adopts it on its next heartbeat.

---

## 28. Troubleshooting

- **A device shows Offline / Stale**: it hasn't sent a heartbeat within 6 / 25
  min. Check the endpoint's network and that the TechiAgent service (Windows) or
  `techi-agent.service` (Linux) is running.
- **Service RUNNING but the device never appears in the platform**: check
  `C:\ProgramData\TechiAgent\agent.state.json` (§9a) — `loading_config` with a
  growing retry count in `agent.log` means the config is unreadable (AV/EDR or
  ACL; verify `icacls C:\ProgramData\TECHI\agent.config.json` shows `SYSTEM:(F)`).
  On agents ≤ 2.1.5 this state was silent and permanent — restart the TechiAgent
  service to recover; ≥ 2.1.6 retries and self-recovers automatically.
- **"Needs Agent Update" won't clear**: confirm the active Agent Binary matches
  the deployed exe (SHA-alignment). Re-upload the exe extracted from the active
  MSI.
- **Remote Support won't connect**: the agent self-heals RustDesk each heartbeat;
  give it a cycle. Verify the per-device password was applied (agents ≥ 2.1.5).
- **Device in the wrong folder**: classification is automatic from OS/platform;
  it re-evaluates on heartbeat. A server misread as a client PC updates on the
  next classification.
- **Catalog won't load / an endpoint errors**: report it as a production bug —
  do not work around it. (The deploy gate `scripts/smoke.sh` catches 500s.)
- **A Linux/MikroTik/Connect/Vault/Terminal feature is missing**: its flag is
  OFF. These appear only when enabled.

---

## 29. FAQ

- **Do I ever pick a device's folder?** No — placement is automatic.
- **Is SSH only for Linux?** No — SSH is a generic capability; any device
  reporting `terminal` (or, for MikroTik, `connect`) offers it, and clicking
  it opens `ssh://<device-ip>` directly.
- **Can I run a bash script on Linux from the UI?** Yes 🚩 — Command Center ▸
  Run Command (Linux, admin+).
- **Where are secrets stored?** 🚩 In the Credential Vault (encrypted); the
  Remote Support password is a separate, older system.
- **Why don't I see Linux/MikroTik devices?** Their flags are off, or none are
  enrolled yet.
- **Does enabling Platform Expansion change Windows?** No — with flags off the
  platform is identical to the classic Windows RMM; Windows behavior is the
  reference implementation and is not modified.

---

## 30. Known Limitations (this build)

- **Connect launchers**: Winbox/WebFig open now (2026-07-10); SSH's default
  action is the Embedded SSH Connect terminal (2026-07-10, §14a), with the
  raw `ssh://<device-ip>` launcher demoted to a secondary option. DSM/QTS/
  vSphere/Web UI (Synology/QNAP/VMware/Proxmox) fall back to a generic
  `http://<device-ip>/` link since those platforms have no live devices yet —
  refine per platform when they onboard. Windows Remote Support (RustDesk)
  works today via its own dedicated flow.
- **MikroTik**: Connector v1 heartbeat/inventory/capability reporting +
  resource utilization; **no RouterOS API** yet (firewall/interface/DHCP
  edits stay in Winbox/WebFig/Embedded SSH Connect).
- **Winbox/WebFig credential-aware status (2026-07-11)**: the Connect menu
  shows Ready/Credential required per method and matches the correct Vault
  credential type, but launching Winbox/WebFig still opens the plain
  `winbox://`/`http://` link — the credential is not auto-injected into
  Winbox's own login screen or WebFig's HTTP auth. Only Embedded SSH Connect
  actually establishes an authenticated session end-to-end.
- **Web Terminal / Embedded SSH Connect**: both production-ready (2026-07-10);
  both require `FEATURE_TERMINAL` + a rollout scope, neither enabled by
  default. Reconnect always opens a new shell/SSH session (no mid-session
  state resume). Session recording is prepared but not implemented. Embedded
  SSH Connect additionally requires the backend to have direct network
  reachability to the device (no NAT traversal) and does not verify SSH host
  keys yet.
- **Notifications**: production-ready (2026-07-10); requires `FEATURE_NOTIFICATIONS`,
  not enabled by default, and at least one channel + rule configured before
  anything actually sends. Email and generic Webhook only — Slack/Teams/
  Telegram/Discord/PagerDuty are supported by the architecture but not built yet.
- **Reporting v1**: fleet health and alert activity only. It intentionally does
  not claim SLA/uptime monitoring, billing, license/warranty, or inventory-change
  history because those data sources do not exist yet. Schedules generate into
  TECHI Report History; automatic email attachment delivery is a later additive
  integration with the Notification Engine.
- **Linux**: certified **Experimental** — validate on a canary before broad use.
  Tier-1 distros: Ubuntu LTS, Debian, RHEL family.
- **IAM**: the granular permission matrix / sessions manager is a future phase;
  the current owner/admin/operator/read-only model + team scopes is what's live.
- **Deployments page** shows sample data (`/deployments/recent`).
- Storage / Hypervisor platforms: declared in the Connect Framework and
  classification, but their adapters are a future phase.

---

*This manual reflects the implementation as deployed for the live-validation
window. Report any behavior that differs from this document as a production bug.*
