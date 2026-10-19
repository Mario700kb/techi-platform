"""What to do about an alert: why it matters, the steps, and the commands.

Curated and reviewed, so it is instant, free and the same for everyone; the
AI analysis takes it as its starting point and fits it to the device's own
evidence. Commands are Windows PowerShell 5.1 and run in the console only
when a person runs them (2FA, recorded). Each carries a risk:

- read_only: reads state, changes nothing
- changes_settings: changes configuration, no restart
- needs_restart: takes effect after (or causes) a restart
- data_risk: can lose data or availability; think first
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import List, Optional


@dataclass(frozen=True)
class Command:
    label: str
    script: str
    risk: str = "read_only"


@dataclass(frozen=True)
class Runbook:
    key: str
    why: str
    steps: List[str]
    commands: List[Command] = field(default_factory=list)
    escalate: Optional[str] = None

    def as_dict(self) -> dict:
        return asdict(self)


_EVENTS_7D = """Get-WinEvent -FilterHashtable @{{ LogName = 'System'; Id = {ids}; StartTime = (Get-Date).AddDays(-7) }} -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Id, ProviderName, LevelDisplayName, Message |
  Format-List"""

RUNBOOKS = {
    "evt:shutdown": Runbook(
        "evt:shutdown",
        "Windows restarted without shutting down cleanly. Power was cut, the power button was held, or the system froze.",
        [
            "Read the Kernel-Power 41 details: BugcheckCode 0 and PowerButtonTimestamp 0 mean power loss; a non-zero PowerButtonTimestamp means the button was held.",
            "Look for blue screens (1001) and hardware errors (WHEA 18) on the same days.",
            "Power loss: check the UPS, the power strip and the PSU, and ask whether the site lost power. Button held: ask the user when the PC freezes.",
        ],
        [
            Command("Kernel-Power 41 details, last 7 days", """Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; StartTime = (Get-Date).AddDays(-7) } -ErrorAction SilentlyContinue |
  ForEach-Object {
    $d = ([xml]$_.ToXml()).Event.EventData.Data
    [pscustomobject]@{
      Time         = $_.TimeCreated
      BugcheckCode = ($d | Where-Object Name -eq 'BugcheckCode').'#text'
      PowerButton  = ($d | Where-Object Name -eq 'PowerButtonTimestamp').'#text'
    }
  }"""),
            Command("Freezes before the restarts (Application Hang)", """Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Hang'; StartTime = (Get-Date).AddDays(-7) } -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Message -First 10"""),
        ],
        "The same restart on several devices of one site at the same time: the site's power, not the PC.",
    ),
    "evt:bsod": Runbook(
        "evt:bsod",
        "Windows stopped with a blue screen. One can be a one-off; repeated ones are almost always a driver, memory or disk.",
        [
            "Read the stop code and the driver named in the 1001 event.",
            "Update or roll back that driver (graphics, network, storage and antivirus drivers are the usual ones).",
            "Repeated with different stop codes: test the memory and check the disk health.",
        ],
        [
            Command("Blue screens, last 30 days", """Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1001; ProviderName = 'Microsoft-Windows-WER-SystemErrorReporting'; StartTime = (Get-Date).AddDays(-30) } -ErrorAction SilentlyContinue |
  Select-Object TimeCreated, Message | Format-List"""),
            Command("Crash dumps on disk", "Get-ChildItem C:\\Windows\\Minidump -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object Name, LastWriteTime, Length -First 10"),
            Command("Test the memory at the next restart", "mdsched.exe", "needs_restart"),
        ],
        "Two or more on a server, or with WHEA errors: hardware; plan a replacement with the vendor.",
    ),
    "evt:hardware": Runbook(
        "evt:hardware",
        "The processor, memory or PCIe bus reported a fatal hardware error (WHEA 18). The machine may crash again.",
        [
            "Read the component named in the event (processor core, memory bank, PCIe device).",
            "Check firmware/BIOS and chipset driver versions; update from the vendor.",
            "On a server: open a hardware case with the vendor; move critical workloads if it repeats.",
        ],
        [Command("Hardware errors, last 30 days", _EVENTS_7D.replace("AddDays(-7)", "AddDays(-30)").format(ids="18, 19, 47"))],
        "Always on a server; on a PC when it repeats.",
    ),
    "evt:disk_bad": Runbook(
        "evt:disk_bad",
        "The disk reported bad blocks or a controller error. Data on it is at risk.",
        [
            "Make sure a recent backup of the device exists before anything else.",
            "Read the disk's health and reliability counters.",
            "Plan the disk replacement; do not run a full chkdsk /r on a failing disk before the backup.",
        ],
        [
            Command("Disk health and wear", """Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus, Size
Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId, Temperature, Wear, ReadErrorsUncorrected, WriteErrorsUncorrected, PowerOnHours"""),
            Command("Disk errors, last 7 days", _EVENTS_7D.format(ids="7, 11, 51, 153")),
        ],
        "Bad blocks on a server disk: replace it; on a RAID, check the array state now.",
    ),
    "evt:disk_retry": Runbook(
        "evt:disk_retry",
        "Disk reads or writes had to be retried. On USB drives and busy VMs this is common; on an internal disk it can be the first sign of failure.",
        [
            "See which disk (Harddisk number) the events name; Harddisk0 is usually the system disk.",
            "Check the disk's health counters and the cable or USB port.",
        ],
        [
            Command("Retry and paging errors, last 7 days", _EVENTS_7D.format(ids="51, 153")),
            Command("Disk numbers and names", "Get-Disk | Select-Object Number, FriendlyName, BusType, HealthStatus, Size"),
        ],
    ),
    "evt:filesystem": Runbook(
        "evt:filesystem",
        "NTFS found corruption and asks for a repair.",
        [
            "Scan the volume online first (no downtime).",
            "If the scan finds errors, schedule the repair: on the system drive it runs at the next restart.",
        ],
        [
            Command("Online scan of C:", "Repair-Volume -DriveLetter C -Scan"),
            Command("Repair at the next restart (C:)", "Repair-Volume -DriveLetter C -SpotFix", "needs_restart"),
        ],
        "Corruption that comes back after a repair: check the disk health.",
    ),
    "high_cpu": Runbook(
        "high_cpu",
        "The processor stayed busy long enough to slow the device down.",
        [
            "See which process uses the CPU (the alert names the busiest one when the agent reported it).",
            "Antivirus scans, Windows Update and backups are usual and pass; a stuck process or malware is not.",
            "On a server, compare with its normal load before acting.",
        ],
        [Command("Top processes by CPU", """Get-Counter '\\Process(*)\\% Processor Time' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CounterSamples |
  Where-Object InstanceName -notin '_total', 'idle' |
  Sort-Object CookedValue -Descending |
  Select-Object -First 10 InstanceName, @{ n = 'CPU%'; e = { [math]::Round($_.CookedValue / $env:NUMBER_OF_PROCESSORS, 1) } }""")],
    ),
    "high_ram": Runbook(
        "high_ram",
        "Memory stayed nearly full; Windows starts paging and everything slows down.",
        [
            "See which processes hold the memory.",
            "A browser with many tabs or a leaking application is usual on a PC; on a server, check the service's own memory limits (SQL Server takes all it may).",
        ],
        [Command("Top processes by memory", "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 Name, Id, @{ n = 'MB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } }")],
    ),
    "low_disk": Runbook(
        "low_disk",
        "The volume is almost full. Windows Update, logins and databases fail when it fills.",
        [
            "See what takes the space.",
            "Clear temporary files and the component store; empty the recycle bins.",
            "On a server, move or rotate logs and backups; grow the volume if the data is legitimate.",
        ],
        [
            Command("Free space per volume", "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, @{ n = 'FreeGB'; e = { [math]::Round($_.SizeRemaining / 1GB, 1) } }, @{ n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } }"),
            Command("Largest folders in C:\\ (top level)", """Get-ChildItem C:\\ -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $size = (Get-ChildItem $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  [pscustomobject]@{ Folder = $_.FullName; GB = [math]::Round($size / 1GB, 1) }
} | Sort-Object GB -Descending | Select-Object -First 10"""),
            Command("Clean the Windows component store", "Dism.exe /Online /Cleanup-Image /StartComponentCleanup", "changes_settings"),
            Command("Delete temp files older than 7 days", "Get-ChildItem $env:windir\\Temp, C:\\Users\\*\\AppData\\Local\\Temp -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force -ErrorAction SilentlyContinue", "data_risk"),
        ],
    ),
    "disk_forecast": Runbook(
        "disk_forecast",
        "At the current rate the volume fills within the forecast window.",
        ["Find what grows (logs, backups, mailbox caches, databases) and clean or move it before it fills."],
        [Command("Files changed in the last 7 days, largest first", "Get-ChildItem C:\\ -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object LastWriteTime -gt (Get-Date).AddDays(-7) | Sort-Object Length -Descending | Select-Object -First 20 FullName, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB) } }, LastWriteTime")],
    ),
    "service_stopped": Runbook(
        "service_stopped",
        "A service set to start automatically is not running; what depends on it does not work.",
        [
            "Read why it stopped (Service Control Manager 7031/7034 and the application's own log).",
            "Start it again; if it stops again, fix the cause (credentials, disk, a dependency) before restarting it in a loop.",
        ],
        [
            Command("Service crashes, last 7 days", _EVENTS_7D.format(ids="7023, 7024, 7031, 7034")),
            Command("Stopped automatic services", "Get-CimInstance Win32_Service -Filter \"StartMode='Auto' AND State<>'Running'\" | Select-Object Name, DisplayName, State, ExitCode"),
            Command("Start the service (replace NAME)", "Start-Service -Name 'NAME'", "changes_settings"),
        ],
        "Backup, database and hypervisor services on servers: act now.",
    ),
    "disk_health": Runbook(
        "disk_health",
        "The disk itself reports a problem (SMART failure prediction, unhealthy state, uncorrected errors or wear).",
        [
            "Confirm a recent backup exists and works.",
            "Order the replacement disk; on a RAID, check the array and the hot spare.",
        ],
        [Command("Disk health and reliability counters", """Get-PhysicalDisk | Select-Object FriendlyName, MediaType, HealthStatus, OperationalStatus
Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object DeviceId, Temperature, Wear, ReadErrorsUncorrected, WriteErrorsUncorrected""")],
        "Always: a failing disk loses data without more warning.",
    ),
    "reboot_pending": Runbook(
        "reboot_pending",
        "Updates are installed but not active until the server restarts.",
        ["Plan the restart in the maintenance window and warn the users of the services it runs."],
        [
            Command("Why a restart is pending", """$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
$keys | ForEach-Object { [pscustomobject]@{ Key = $_; Pending = Test-Path $_ } }"""),
            Command("Restart in 5 minutes (warns users)", "shutdown.exe /r /t 300 /c \"Planned restart for updates (TECHI)\"", "needs_restart"),
        ],
    ),
    "security_posture": Runbook(
        "security_posture",
        "A protection that was on is now off: antivirus, real-time protection, firewall or UAC.",
        [
            "Find out who or what switched it off (a new antivirus? a user? malware?).",
            "Switch it back on, then scan the device.",
        ],
        [
            Command("Defender and firewall state", """Get-MpComputerStatus | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge
Get-NetFirewallProfile | Select-Object Name, Enabled"""),
            Command("Turn the firewall back on (all profiles)", "Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled True", "changes_settings"),
            Command("Turn Defender real-time protection back on", "Set-MpPreference -DisableRealtimeMonitoring $false", "changes_settings"),
            Command("Quick scan", "Start-MpScan -ScanType QuickScan", "read_only"),
        ],
        "Protection switched off on several devices at once: treat it as a security incident.",
    ),
    "device_offline": Runbook(
        "device_offline",
        "The device stopped reporting: it is off, without network, or the agent stopped.",
        [
            "Check whether other devices of the same site are offline too (site power or internet).",
            "Ask someone on site whether it is on; if it is, check the network cable and the TECHI agent service.",
        ],
        [Command("Agent service state (when reachable)", "Get-Service -Name 'TECHI*' | Select-Object Name, Status, StartType")],
        "A server or several devices of one site: call the site.",
    ),
    "packet_loss": Runbook(
        "packet_loss",
        "Packets to the gateway are being lost; calls, Remote Support and file shares suffer.",
        ["Check the cable or Wi-Fi signal, then the switch port; several devices of one site: the router or the line."],
        [Command("Ping the gateway 50 times", """$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop
Test-Connection $gw -Count 50 -ErrorAction SilentlyContinue | Measure-Object ResponseTime -Average -Maximum""")],
    ),
    "network_latency": Runbook(
        "network_latency",
        "The gateway answers slowly.",
        ["Usually Wi-Fi or a saturated line; compare with other devices of the site."],
        [Command("Network adapters and link speed", "Get-NetAdapter | Where-Object Status -eq 'Up' | Select-Object Name, InterfaceDescription, LinkSpeed, MediaType")],
    ),
    "disk_busy": Runbook(
        "disk_busy",
        "The disk was busy almost all the time; everything that reads or writes waits.",
        ["See which process reads and writes; a backup, antivirus scan or indexing is usual, constant load on an HDD is a reason to move to SSD."],
        [Command("Disk activity per process", """Get-Counter '\\Process(*)\\IO Data Bytes/sec' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty CounterSamples | Where-Object InstanceName -notin '_total', 'idle' |
  Sort-Object CookedValue -Descending | Select-Object -First 10 InstanceName, @{ n = 'MB/s'; e = { [math]::Round($_.CookedValue / 1MB, 1) } }""")],
    ),
    "telemetry_missing": Runbook(
        "telemetry_missing",
        "The device is online but its monitoring data stopped arriving.",
        ["Check the TECHI agent service and its log; restart the service if it hangs."],
        [Command("Restart the TECHI agent service", "Get-Service -Name 'TECHI*' | Restart-Service -Force", "changes_settings")],
    ),
    "repeated_reconnects": Runbook(
        "repeated_reconnects",
        "The device keeps losing and regaining its connection to the platform.",
        ["Usually unstable Wi-Fi or a sleeping network adapter; check the adapter's power management."],
        [Command("Network adapter power saving", "Get-NetAdapterPowerManagement | Select-Object Name, AllowComputerToTurnOffDevice")],
    ),
    "rustdesk_sync_failure": Runbook(
        "rustdesk_sync_failure",
        "Remote Support could not be configured on the device.",
        ["Repair Remote Support from the device's Remote Support tab; check the service if it fails again."],
        [Command("Remote Support service", "Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType")],
    ),
    "archived_checkin": Runbook(
        "archived_checkin",
        "An archived device still runs the agent.",
        ["Restore the device if it is in use again, or uninstall the agent from it."],
    ),
}


def runbook_for(kind: str, fingerprint: str = "") -> Optional[Runbook]:
    kind = getattr(kind, "value", kind)
    if fingerprint and fingerprint in RUNBOOKS:
        return RUNBOOKS[fingerprint]
    return RUNBOOKS.get(kind)
