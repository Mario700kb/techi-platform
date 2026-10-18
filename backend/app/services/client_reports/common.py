"""What every client report builder shares: the client's fleet, its inventory
rows, parsing of the strings agents report, and the result shape.

Device category (server vs workstation) comes from the Unified Classification
Engine in platform_core; this is the one module of the package that imports it.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, List, Optional, Sequence

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.time import ensure_utc, to_display, utcnow
from app.models.device import Device
from app.models.device_inventory import DeviceInventory
from app.platform_core.classification import classify_category
from app.platform_core.versioning import parse_version
from app.repositories.device_repository import DeviceRepository
from app.schemas.client_report import ReportColumn, ReportDocument, ReportKpi, ReportSection
from app.services.offline_alerts import ALWAYS_ON_CATEGORIES

CRIT, WARN, INFO = 3, 2, 1
TONE_OF = {CRIT: "crit", WARN: "warn", INFO: "info"}


@dataclass(frozen=True)
class Issue:
    """One line of the executive summary's "Top issues"."""
    severity: int  # CRIT / WARN / INFO
    text: str
    report: str
    count: int = 1


@dataclass(frozen=True)
class Recommendation:
    priority: int  # higher first
    text: str


@dataclass
class Built:
    document: ReportDocument
    issues: List[Issue] = field(default_factory=list)
    recommendations: List[Recommendation] = field(default_factory=list)
    facts: Dict[str, object] = field(default_factory=dict)  # numbers the executive summary reuses


class ReportContext:
    """The client, the period and lazily-loaded data shared by the builders,
    so the executive summary reads each source once."""

    def __init__(self, db: Session, *, client_id: int, client_name: str, start: datetime, end: datetime,
                 now: Optional[datetime] = None, devices: Optional[Sequence[Device]] = None):
        self.db = db
        self.client_id = client_id
        self.client_name = client_name
        self.start = ensure_utc(start)
        self.end = ensure_utc(end)
        self.now = ensure_utc(now) if now is not None else utcnow()
        self._devices = list(devices) if devices is not None else None
        self._inventories: Optional[Dict[int, DeviceInventory]] = None
        self.cache: Dict[str, object] = {}

    @property
    def today(self) -> date:
        return to_display(self.now).date()

    @property
    def devices(self) -> List[Device]:
        if self._devices is None:
            scope = AllowedScope(client_ids=frozenset({self.client_id}))
            self._devices = DeviceRepository(self.db).get_multi(client_id=self.client_id, limit=10000, scope=scope)
        return self._devices

    def inventories(self) -> Dict[int, DeviceInventory]:
        if self._inventories is None:
            ids = [d.id for d in self.devices]
            rows = self.db.query(DeviceInventory).filter(DeviceInventory.device_id.in_(ids)).all() if ids else []
            self._inventories = {row.device_id: row for row in rows}
        return self._inventories

    def document(self, *, key: str, title: str, subtitle: Optional[str], summary: List[ReportKpi],
                 sections: List[ReportSection], notes: Optional[List[str]] = None) -> ReportDocument:
        return ReportDocument(
            key=key, title=title, subtitle=subtitle, client_id=self.client_id, client_name=self.client_name,
            period_start=self.start, period_end=self.end, generated_at=self.now,
            summary=summary, sections=sections, notes=notes or [],
        )


# ── devices ─────────────────────────────────────────────────────────────────

def device_name(device: Device) -> str:
    return device.display_name or device.hostname or f"Device #{device.id}"


def category(device: Device) -> str:
    return classify_category(device)


def is_always_on(device: Device) -> bool:
    """Servers, network, storage and hypervisors are expected online 24/7."""
    return classify_category(device) in ALWAYS_ON_CATEGORIES


def is_windows(device: Device) -> bool:
    platform = (device.platform or "windows").lower()
    return "windows" in platform or platform == ""


def os_label(device: Device) -> str:
    return (device.os_caption or device.os_name or "Unknown OS").replace("Microsoft ", "")


def agent_at_least(device: Device, version: str) -> bool:
    have = parse_version(device.agent_version)
    want = parse_version(version)
    if have is None or want is None:
        return False
    width = max(len(have), len(want))
    return have + (0,) * (width - len(have)) >= want + (0,) * (width - len(want))


# ── parsing ─────────────────────────────────────────────────────────────────

def json_dict(raw) -> dict:
    if not raw:
        return {}
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


_UNIT = {"tb": 1024.0, "gb": 1.0, "mb": 1 / 1024}
_SIZE = re.compile(r"([\d]+(?:[.,]\d+)?)\s*(TB|GB|MB)", re.I)
_STORAGE = re.compile(r"([\d]+(?:[.,]\d+)?)\s*(TB|GB|MB)\s*free\s*/\s*([\d]+(?:[.,]\d+)?)\s*(TB|GB|MB)\s*total", re.I)


def _gb(number: str, unit: str) -> float:
    return float(number.replace(",", ".")) * _UNIT[unit.lower()]


def parse_ram_gb(text: Optional[str]) -> Optional[float]:
    """"13 GB" → 13.0; None for anything unreadable."""
    match = _SIZE.search(text or "")
    return round(_gb(match.group(1), match.group(2)), 1) if match else None


def parse_storage(text: Optional[str]) -> Optional[tuple]:
    """"109 GB free / 237 GB total" → (free_gb, total_gb)."""
    match = _STORAGE.search(text or "")
    if not match:
        return None
    free, total = _gb(match.group(1), match.group(2)), _gb(match.group(3), match.group(4))
    return (round(free, 1), round(total, 1)) if total > 0 else None


def os_build_number(device: Device) -> Optional[int]:
    """The Windows build: "10.0.19045" / "19045.4170" / "10.0.26100.1" → 19045 / 26100."""
    for raw in (device.os_build, device.os_version):
        numbers = [int(n) for n in re.findall(r"\d+", raw or "")]
        if len(numbers) >= 3 and numbers[0] == 10 and numbers[1] == 0:
            return numbers[2]
        if numbers and numbers[0] >= 7600:
            return numbers[0]
    return None


def parse_day(value) -> Optional[date]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


# ── values ──────────────────────────────────────────────────────────────────

def iso(dt: Optional[datetime]) -> Optional[str]:
    return ensure_utc(dt).isoformat() if dt else None


def pct(part: float, whole: float) -> Optional[float]:
    return round(100.0 * part / whole, 1) if whole else None


def nice_date(day: Optional[date]) -> str:
    return f"{day.day} {day:%b %Y}" if day else "unknown"


def human_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "—"
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds} s"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min"
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f"{hours} h {minutes} min" if minutes else f"{hours} h"
    days, hours = divmod(hours, 24)
    return f"{days} d {hours} h" if hours else f"{days} d"


def plural(count: int, singular: str, many: Optional[str] = None) -> str:
    return f"{count} {singular if count == 1 else (many or singular + 's')}"


def col(key: str, label: str, kind: str = "text", align: Optional[str] = None) -> ReportColumn:
    right = kind in ("number", "percent", "duration")
    return ReportColumn(key=key, label=label, kind=kind, align=align or ("right" if right else "left"))


def device_columns() -> List[ReportColumn]:
    return [col("device", "Device"), col("os", "OS")]


def device_cells(device: Device) -> dict:
    return {"device": device_name(device), "os": os_label(device), "_device_id": device.id}

