"""OS lifecycle & hardware: where each device's operating system stands against
Microsoft's end of support, and devices below the hardware baseline.

The end-of-support dates are a dated table in code (LIFECYCLE_SOURCE): update
it when Microsoft publishes new versions. A device whose OS is not in the table
(Linux, macOS, an Insider build) is "Unknown", never guessed.
"""
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from app.models.device import Device
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports.common import (
    CRIT, INFO, WARN, Built, Issue, Recommendation, ReportContext, col, device_cells, device_columns,
    iso, is_windows, nice_date, os_build_number, parse_ram_gb, parse_storage, pct, plural,
)

KEY = "lifecycle"
LIFECYCLE_SOURCE = "Microsoft lifecycle, as of 2026-10"

# Windows 10 Home / Pro / Enterprise / Education (22H2, the last version; every
# earlier version had already ended). Extended Security Updates are not tracked.
WIN10_END = date(2025, 10, 14)
# Windows 10 Enterprise LTSB/LTSC by build.
WIN10_LTSC = {
    10240: ("Windows 10 Enterprise LTSB 2015", date(2025, 10, 14)),
    14393: ("Windows 10 Enterprise LTSB 2016", date(2026, 10, 13)),
    17763: ("Windows 10 Enterprise LTSC 2019", date(2029, 1, 9)),
    19044: ("Windows 10 Enterprise LTSC 2021", date(2027, 1, 12)),
}
WIN10_IOT_LTSC = {
    14393: ("Windows 10 IoT Enterprise LTSB 2016", date(2026, 10, 13)),
    17763: ("Windows 10 IoT Enterprise LTSC 2019", date(2029, 1, 9)),
    19044: ("Windows 10 IoT Enterprise LTSC 2021", date(2032, 1, 13)),
}
WIN11_VERSIONS = {22000: "21H2", 22621: "22H2", 22631: "23H2", 26100: "24H2", 26200: "25H2"}
# Windows 11 Home / Pro (also Pro Education, Pro for Workstations, SE) by build.
WIN11_HOME_PRO = {
    22000: date(2023, 10, 10), 22621: date(2024, 10, 8), 22631: date(2025, 11, 11),
    26100: date(2026, 10, 13), 26200: date(2027, 10, 12),
}
# Windows 11 Enterprise / Education by build.
WIN11_ENTERPRISE = {
    22000: date(2024, 10, 8), 22621: date(2025, 10, 14), 22631: date(2026, 11, 10),
    26100: date(2027, 10, 12), 26200: date(2028, 10, 10),
}
WIN11_LTSC = {26100: ("Windows 11 Enterprise LTSC 2024", date(2029, 10, 9))}
WIN11_IOT_LTSC = {26100: ("Windows 11 IoT Enterprise LTSC 2024", date(2034, 10, 10))}
SERVER_END = {
    "2008": date(2020, 1, 14), "2008 R2": date(2020, 1, 14), "2012": date(2023, 10, 10),
    "2012 R2": date(2023, 10, 10), "2016": date(2027, 1, 12), "2019": date(2029, 1, 9),
    "2022": date(2031, 10, 14), "2025": date(2034, 11, 14),
}
SERVER_BY_BUILD = {14393: "2016", 17763: "2019", 20348: "2022", 26100: "2025"}
OLD_WINDOWS = {"Windows 7": date(2020, 1, 14), "Windows 8.1": date(2023, 1, 10), "Windows 8": date(2016, 1, 12)}

LOW_RAM_GB = 8
# Windows reports a little less than what is installed ("7.9 GB" on 8 GB).
LOW_RAM_BELOW = 7.5
LOW_DISK_FREE_PCT = 20
SOON_DAYS = 365

UNSUPPORTED, ENDING, SUPPORTED, UNKNOWN = "Unsupported", "Ends within 12 months", "Supported", "Unknown"
TONE = {UNSUPPORTED: "crit", ENDING: "warn", SUPPORTED: "ok", UNKNOWN: "neutral"}


@dataclass(frozen=True)
class OsLifecycle:
    product: str          # "Windows 11 Pro 24H2"
    family: str           # what a recommendation groups by: "Windows 11 24H2"
    end: Optional[date]
    action: str           # "replace" | "feature_update" | "migrate" | "none"


def _edition(caption: str) -> str:
    match = re.search(r"\b(Home|Pro for Workstations|Pro Education|Pro|Enterprise|Education|IoT Enterprise|SE)\b", caption)
    return match.group(1) if match else ""


def os_lifecycle(device: Device) -> OsLifecycle:
    caption = (device.os_caption or device.os_name or "").replace("Microsoft ", "").strip()
    lower = caption.lower()
    build = os_build_number(device)
    if not is_windows(device) or (not caption and build is None):
        return OsLifecycle(caption or "Unknown OS", caption or "Unknown OS", None, "none")

    if "server" in lower:
        year = re.search(r"server\s+(\d{4}(?:\s+R2)?)", caption, re.I)
        version = re.sub(r"\s+", " ", year.group(1)).upper() if year else SERVER_BY_BUILD.get(build or 0)
        if version is None:
            return OsLifecycle(caption, caption, None, "none")
        return OsLifecycle(caption or f"Windows Server {version}", f"Windows Server {version}",
                           SERVER_END.get(version), "migrate")

    for name, end in OLD_WINDOWS.items():
        if re.search(rf"\b{re.escape(name)}\b", caption):
            return OsLifecycle(caption, name, end, "replace")

    ltsc = "ltsc" in lower or "ltsb" in lower
    iot = "iot" in lower
    windows11 = "windows 11" in lower or (build is not None and build >= 22000)
    edition = _edition(caption)
    if windows11:
        version = WIN11_VERSIONS.get(build or 0)
        if ltsc:
            entry = (WIN11_IOT_LTSC if iot else WIN11_LTSC).get(build or 0)
            return OsLifecycle(entry[0], entry[0], entry[1], "replace") if entry else OsLifecycle(caption, caption, None, "none")
        enterprise = edition in ("Enterprise", "Education", "IoT Enterprise")
        end = (WIN11_ENTERPRISE if enterprise else WIN11_HOME_PRO).get(build or 0)
        label = f"Windows 11 {edition}".strip()
        if version is None:
            return OsLifecycle(f"{label} (build {build})" if build else label, label, None, "none")
        return OsLifecycle(f"{label} {version}", f"{label} {version}", end, "feature_update")

    if "windows 10" in lower or (build is not None and build >= 10240):
        if ltsc:
            entry = (WIN10_IOT_LTSC if iot else WIN10_LTSC).get(build or 0)
            return OsLifecycle(entry[0], entry[0], entry[1], "replace") if entry else OsLifecycle(caption, caption, None, "none")
        label = f"Windows 10 {edition}".strip()
        return OsLifecycle(label, "Windows 10", WIN10_END, "replace")
    return OsLifecycle(caption or "Unknown OS", caption or "Unknown OS", None, "none")


def support_status(end: Optional[date], today: date) -> str:
    if end is None:
        return UNKNOWN
    if end < today:
        return UNSUPPORTED
    if end <= today + timedelta(days=SOON_DAYS):
        return ENDING
    return SUPPORTED


def build(ctx: ReportContext) -> Built:
    today = ctx.today
    unsupported, ending, hardware = [], [], []
    overview = defaultdict(lambda: {"count": 0, "end": None, "status": UNKNOWN})
    groups = defaultdict(list)  # family -> [OsLifecycle] of unsupported devices
    soon_groups = defaultdict(list)
    counts = defaultdict(int)
    low_ram = low_disk = 0
    for device in ctx.devices:
        life = os_lifecycle(device)
        status = support_status(life.end, today)
        counts[status] += 1
        entry = overview[life.product]
        entry["count"] += 1
        entry["end"], entry["status"] = life.end, status
        build_no = os_build_number(device)
        base = {**device_cells(device), "product": life.product, "build": str(build_no) if build_no else None,
                "end": life.end.isoformat() if life.end else None, "last_seen": iso(device.last_seen)}
        if status == UNSUPPORTED:
            unsupported.append({**base, "days_since": (today - life.end).days, "_tone": "crit"})
            groups[life.family].append(life)
        elif status == ENDING:
            ending.append({**base, "days_left": (life.end - today).days, "_tone": "warn"})
            soon_groups[life.family].append(life)

        ram = parse_ram_gb(device.ram)
        storage = parse_storage(device.storage)
        free_pct = round(100 * storage[0] / storage[1], 1) if storage else None
        problems = []
        if ram is not None and ram < LOW_RAM_BELOW:
            problems.append(f"RAM under {LOW_RAM_GB} GB")
            low_ram += 1
        if free_pct is not None and free_pct < LOW_DISK_FREE_PCT:
            problems.append(f"System disk under {LOW_DISK_FREE_PCT}% free")
            low_disk += 1
        if problems:
            hardware.append({**device_cells(device), "ram_gb": ram, "disk_free_pct": free_pct,
                             "disk_free_gb": storage[0] if storage else None, "cpu": device.cpu or None,
                             "issue": " · ".join(problems), "_tone": "warn"})

    unsupported.sort(key=lambda r: (r["end"] or "", r["device"].lower()))
    ending.sort(key=lambda r: (r["days_left"], r["device"].lower()))
    hardware.sort(key=lambda r: (r["ram_gb"] if r["ram_gb"] is not None else 999, r["disk_free_pct"] or 100))
    order = {UNSUPPORTED: 0, ENDING: 1, SUPPORTED: 2, UNKNOWN: 3}
    overview_rows = sorted(
        ({"product": product, "status": data["status"], "end": data["end"].isoformat() if data["end"] else None,
          "count": data["count"], "_tone": TONE[data["status"]]} for product, data in overview.items()),
        key=lambda r: (order[r["status"]], r["end"] or "9999", -r["count"]),
    )

    known = counts[UNSUPPORTED] + counts[ENDING] + counts[SUPPORTED]
    supported_pct = pct(counts[SUPPORTED] + counts[ENDING], known)
    summary = [
        ReportKpi(label="Unsupported OS", value=counts[UNSUPPORTED], tone="crit" if counts[UNSUPPORTED] else "ok",
                  hint="No more security updates from Microsoft"),
        ReportKpi(label="Support ends within 12 months", value=counts[ENDING], tone="warn" if counts[ENDING] else "ok",
                  hint=f"By {nice_date(today + timedelta(days=SOON_DAYS))}"),
        ReportKpi(label="Supported", value=supported_pct, kind="percent",
                  tone="neutral" if supported_pct is None else "ok" if supported_pct >= 95 else "warn" if supported_pct >= 80 else "crit",
                  hint=f"Still receiving updates, of {known} devices with a known OS"
                       + (f"; {counts[UNKNOWN]} unknown" if counts[UNKNOWN] else "")),
        ReportKpi(label=f"RAM under {LOW_RAM_GB} GB", value=low_ram, tone="warn" if low_ram else "ok",
                  hint=f"{plural(low_disk, 'device')} with system disk under {LOW_DISK_FREE_PCT}% free"),
    ]
    device_os = [*device_columns()[:1], col("product", "Operating system"), col("build", "Build", align="right")]
    sections = [
        ReportSection(
            key="unsupported", title="Unsupported OS",
            description="Microsoft no longer ships security updates for these systems.",
            columns=[*device_os, col("end", "Support ended", "date"), col("days_since", "Days since", "number"),
                     col("last_seen", "Last seen", "datetime")],
            rows=unsupported, empty="Every device runs a supported operating system.",
        ),
        ReportSection(
            key="ending_soon", title="Support ending soon",
            description="Support ends within the next 12 months: plan the upgrade or replacement now.",
            columns=[*device_os, col("end", "Support ends", "date"), col("days_left", "Days left", "number"),
                     col("last_seen", "Last seen", "datetime")],
            rows=ending, empty="No operating system reaches its end of support in the next 12 months.",
        ),
        ReportSection(
            key="hardware", title="Low memory or disk space",
            description=f"RAM under {LOW_RAM_GB} GB or a system disk with less than {LOW_DISK_FREE_PCT}% free.",
            columns=[*device_columns(), col("ram_gb", "RAM (GB)", "number"), col("disk_free_pct", "Disk free", "percent"),
                     col("cpu", "CPU"), col("issue", "Issue", "badge")],
            rows=hardware, empty="Every device meets the memory and disk baseline.",
            note=f"RAM from {LOW_RAM_BELOW} GB counts as {LOW_RAM_GB} GB: Windows reports slightly less than is installed.",
        ),
        ReportSection(
            key="os_overview", title="OS overview",
            description="Devices per operating system and the date its support ends.",
            columns=[col("product", "Operating system"), col("status", "Status", "badge"),
                     col("end", "End of support", "date"), col("count", "Devices", "number")],
            rows=overview_rows, empty="No devices.",
        ),
    ]
    document = ctx.document(
        key=KEY, title="OS lifecycle & hardware", subtitle=f"Support status as of {nice_date(today)}",
        summary=summary, sections=sections,
        notes=[f"End-of-support dates: {LIFECYCLE_SOURCE}. Windows 10 Extended Security Updates are not tracked.",
               "Unknown: an operating system the table does not cover (Linux, macOS, preview builds)."],
    )

    issues, recs = [], []
    for family, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        life = items[0]
        n = len(items)
        issues.append(Issue(CRIT, f"{plural(n, 'device')} on {family}, unsupported since {nice_date(life.end)}", KEY, n))
        if life.action == "feature_update":
            newest = max(WIN11_VERSIONS.items())[1]
            text = f"Update the {plural(n, 'device')} on {family} to Windows 11 {newest} (support ended {nice_date(life.end)})."
        elif life.action == "migrate":
            text = f"Plan the migration of the {plural(n, 'server')} on {family} (unsupported since {nice_date(life.end)})."
        else:
            text = f"Replace or upgrade the {plural(n, 'device')} on {family} (unsupported since {nice_date(life.end)})."
        recs.append(Recommendation(90 + min(n, 9), text))
    for family, items in sorted(soon_groups.items(), key=lambda kv: kv[1][0].end):
        life = items[0]
        n = len(items)
        issues.append(Issue(WARN, f"{plural(n, 'device')} on {family}: support ends {nice_date(life.end)}", KEY, n))
        recs.append(Recommendation(50, f"Plan the upgrade of the {plural(n, 'device')} on {family} before {nice_date(life.end)}."))
    if low_ram:
        issues.append(Issue(INFO, f"{plural(low_ram, 'device')} with less than {LOW_RAM_GB} GB RAM", KEY, low_ram))
        recs.append(Recommendation(20, f"Consider more memory for the {plural(low_ram, 'device')} with less than {LOW_RAM_GB} GB RAM."))
    facts = {"unsupported": counts[UNSUPPORTED], "ending": counts[ENDING], "supported_pct": supported_pct,
             "low_ram": low_ram}
    return Built(document, issues, recs, facts)
