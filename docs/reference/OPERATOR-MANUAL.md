# TECHI PLATFORM — OPERATOR MANUAL

| | |
|---|---|
| **Audience** | Operators using TECHI in production (not developers). |
| **Scope** | Describes exactly how the platform behaves as implemented, for the live-validation window. |
| **Version basis** | Backend/frontend of prod branch `stable/phase-2-heartbeat` (Platform Expansion Phases 0–7 deployed). **Agent baseline: 2.1.6** (released 2026-07-09; GPO rollout in progress — mixed fleet until 100%). |
| **Feature flags** | Some features are hidden behind flags (`FEATURE_*`). This manual marks each flag-gated feature with 🚩 and the flag name. **When a flag is OFF, that feature does not appear at all** — the platform behaves exactly as the classic Windows RMM. |

**How to read the flag notes:** Windows management (Dashboard, Devices,
Enrollment, Remote Support, Command Center, Packages, Alerts, Teams) is always
available. Linux, the Connect menu, the Web Terminal, the Credential Vault, and
MikroTik appear only when their flags are enabled.

---

## 1. Signing in

Open `https://rdp.techi.com.al`. Sign in with your operator username and
password. Your **role** (Owner / Admin / Operator / Read-only) decides what you
see and can do (see §26 Permissions). Sessions use a JWT; a light/dark theme
toggle is in the top bar (remembered per browser).

Left sidebar navigation (items appear based on your permissions): **Dashboard,
Devices, Clients, Deployment, Enrollment, Packages, Inventory, Operators, Teams,
Audit Log, Agent Config**. On mobile (<768px) navigation is a bottom bar with
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
- Windows deployment runs through **AD GPO / NETLOGON**: the generated MSI +
  `techi-deploy` bootstrap installs the combined MSI (agent + TECHI Remote
  Support), which enrolls with the token.
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
| **MikroTik** | Experimental | `FEATURE_MIKROTIK` | **RouterOS Script** (deployment + registration only) — select RouterOS 6.x or 7.x, then copy/paste into RouterOS; generated from the Platform Registry template with the token injected; supported arches chr/x86/arm/arm64/mipsbe/mmips/ppc/tile |
| **Synology DSM** | Planned | `FEATURE_STORAGE` | placeholder — Package / SSH Installer |
| **QNAP QTS** | Planned | `FEATURE_STORAGE` | placeholder — Package / SSH Installer |
| **VMware ESXi** | Planned | `FEATURE_HYPERVISOR` | placeholder |
| **Hyper-V** | Planned | `FEATURE_HYPERVISOR` | placeholder |
| **Proxmox** | Planned | `FEATURE_HYPERVISOR` | placeholder |

The **Windows** block is byte-identical to the original dialog and its scripts are
never modified. Placeholders reserve the UI only — no commands, no backend. Adding
a future platform is metadata-only: register the platform + its deployment metadata
entry + an icon; the dialog needs no rewrite.

---

## 9. Agent Installation (Windows)

The **combined MSI** installs the Windows service `TechiAgent` (LocalSystem) and
TECHI Remote Support. The agent then: sends heartbeats, applies its config,
self-updates from the UI, and self-heals Remote Support. **Do not reinstall the
MSI manually** unless instructed — "the MSI installs once, everything else from
the UI."

### 9a. Agent Startup Lifecycle (agent ≥ 2.1.6)

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

- Windows: three package types — **MSI** (combined, for GPO/new PCs),
  **Agent Binary** (`techi-agent.exe` for self-update), **Update MSI (bridge)**
  (agent-only for legacy agents). Upload, set active, download, delete.
- **SHA-alignment rule**: the "active" agent binary's SHA is what "Needs Agent
  Update" compares against. Always upload the exe extracted from the active MSI
  (Go builds are not reproducible). Do not rebuild MSIs without need.
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
   capabilities. It lists the available methods per platform (see §16). During
   this validation build, selecting a method shows the method's metadata —
   **the launchers (actually opening Winbox/WebFig/SSH) are a later phase**.

The operator always uses one Connect entry point; the platform decides which
methods exist.

---

## 13. Remote Support (Windows)

TECHI Remote Support is a branded RustDesk client, installed by the combined MSI
and self-healed by the agent every heartbeat:
- Click **Connect** on a Windows device → opens Remote Support to that device.
- Per-device Remote Support **password** is server-generated, encrypted at rest,
  delivered to the agent each heartbeat (agents ≥ 2.1.5 apply it). Set/reset via
  Command Center or device actions (admin/owner).
- The agent repairs install/config/service/password automatically; you rarely
  need to intervene.

---

## 14. Web Terminal 🚩 `FEATURE_TERMINAL` (+ `terminal` capability)

An in-browser terminal inside the Device Drawer (a **Terminal** tab), for Linux
devices that report the `terminal` capability.

- The operator opens the Terminal tab → the backend creates a one-time session
  (short-lived ticket) → the agent opens a PTY (bash/sh) and streams it to your
  browser (xterm.js). No inbound ports; the agent connects outbound only.
- Sessions are authenticated, operator-scoped, time-limited (idle/max caps), and
  audited.
- **Availability note:** this feature needs its edge WebSocket route configured
  and the flag enabled. If `FEATURE_TERMINAL` is OFF, the Terminal tab does not
  appear and the terminal endpoints return 404 / close.

---

## 15. MikroTik 🚩 `FEATURE_MIKROTIK`

MikroTik is the first **proxy-managed** platform (not a native agent). A proxy
adapter reports RouterOS devices into the same catalog/drawer.

**Deployment + registration (live).** On the **Deployment** dialog (token ▸ View),
the MikroTik section shows a **RouterOS Version** selector (**RouterOS 6.x** or
**RouterOS 7.x**) and a **RouterOS Script** — generated server-side from the
Platform Registry template with the enrollment token injected (never hardcoded).
Copy the matching script into the router's terminal (or import as a script). It
POSTs the router's identity + token to the standard enrollment endpoint; the
router self-detects its architecture (chr/x86/arm/arm64/mipsbe/mmips/ppc/tile —
an unknown arch is rejected). The device then appears automatically under
**Client ▸ Network ▸ MikroTik** (no manual placement), with Connect methods
**Winbox / WebFig / SSH** (metadata only).

**Not in this build:** RouterOS API, Winbox/WebFig/SSH launchers, and all RouterOS
management (monitoring, firewall, interfaces, wireless, VPN, backups, scripting) —
a later phase that adds only a Platform Adapter + Action Registry entries, with no
Drawer/Tree/UI changes. With the flag off there are no MikroTik surfaces.

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
| MikroTik | Winbox, WebFig, SSH, Web Terminal |
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
  icon; **no UI redesign**. Launchers for these methods are the next phase.

---

## 17. Winbox / 18. WebFig / 19. SSH (MikroTik) 🚩

These are **connection methods** exposed by the MikroTik Connect menu (§16), not
separate features. In this build they are listed by the Connect Framework;
**actually launching them (winbox://, WebFig web UI, SSH) is the next phase.**
SSH additionally appears for any platform reporting `terminal`.

---

## 20. Credential Vault 🚩 `FEATURE_VAULT`

An enterprise secret store, separate from the Remote Support password system.

- **Location**: Settings ▸ Security ▸ Credential Vault (Admin+).
- **Types**: password, SSH key, API token, SNMP, Winbox, certificate.
- **Scope**: Global / Client / Group / Device (most specific wins).
- Secrets are encrypted (AES-256-GCM envelope); the UI never shows a stored
  secret except an explicit **Reveal** (requires a reason; every reveal is
  audited). Rotation and connection testing are supported.
- With the flag off, the Vault page/route/endpoints do not exist (404).

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
  reporting `terminal` offers it (once launchers ship).
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

- **Connect launchers not implemented**: the Connect menu lists methods (Winbox/
  WebFig/SSH/DSM/…) but does not yet open them — that is the next phase. Windows
  Remote Support (RustDesk) works today.
- **MikroTik**: adapter framework + classification only; **no RouterOS API** yet.
- **Web Terminal**: requires its edge WebSocket route + `FEATURE_TERMINAL`; not
  enabled by default. Session recording is prepared but not implemented.
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
