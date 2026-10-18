"""Which client reports exist, what they need and the formats they render to.

Pure data: the request schemas validate against it, so it imports nothing.
"""

SECURITY_AGENT_VERSION = "2.1.31"

# key, title, description, formats, needs, preview
CATALOG = (
    ("executive", "Executive summary",
     "The monthly summary for the client: headline numbers from every report, the top issues and plain recommendations.",
     ("pdf",), None, True),
    ("patch_compliance", "Patch compliance",
     "Devices with pending Windows updates, waiting for a restart or not updated for 30 days or more.",
     ("pdf", "csv"), None, True),
    ("lifecycle", "OS lifecycle & hardware",
     "Operating systems past or near Microsoft's end of support, and devices with too little memory or disk.",
     ("pdf", "csv"), None, True),
    ("availability", "Availability & outages",
     "How long servers were online (24/7) and workstations during working hours, with every server outage.",
     ("pdf", "csv"), None, True),
    ("capacity", "Disk capacity",
     "Full disks now and disks forecast to reach 90% from their growth.",
     ("pdf", "csv"), None, True),
    ("access_audit", "Access audit",
     "Who connected to which device and for how long: Remote Support, PowerShell, terminal and SSH sessions, "
     "scripts run, refused logins and revealed credentials.",
     ("pdf", "csv"), None, True),
    ("security_posture", "Security posture",
     "Antivirus, firewall, BitLocker, UAC, Secure Boot and local administrators on every device, with a score.",
     ("pdf", "csv"), f"agent {SECURITY_AGENT_VERSION}", True),
    ("full", "Full fleet report",
     "The fleet summary, device inventory and alert activity of the period (the original client report).",
     ("pdf", "csv"), None, False),
)

CLIENT_REPORT_TYPES = tuple(item[0] for item in CATALOG)
FORMATS = {item[0]: item[3] for item in CATALOG}
TITLES = {item[0]: item[1] for item in CATALOG}


def format_allowed(report_type: str, report_format: str) -> bool:
    return report_format in FORMATS.get(report_type, ())


def catalog_items() -> list:
    return [
        {"key": key, "title": title, "description": description, "formats": list(formats),
         "needs": needs, "preview": preview}
        for key, title, description, formats, needs, preview in CATALOG
    ]
