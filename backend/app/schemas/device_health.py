"""Device health reported by the Windows agent (>= 2.1.33).

The agent reads it hourly with one PowerShell script and sends it in the
heartbeat as ``device_health`` when it changed, or every six hours:

- every physical disk Windows sees, with its health, SMART failure prediction
  and the reliability counters the drive exposes (temperature, wear, power-on
  hours, uncorrected errors);
- whether a restart is pending, and why;
- critical System events of the last 25 hours (unexpected restarts, blue
  screens, fatal hardware errors, disk and file-system errors, crashed
  services) — only the (source, id) pairs in EVENT_CATALOG, never free text
  beyond a short message.

Everything here is defensive like app.schemas.security_posture: unknown keys
are dropped, lists bounded, out-of-range numbers become null, and a payload
that does not fit is ignored (logged) — it never fails the heartbeat.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional, Tuple

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

logger = logging.getLogger(__name__)

MAX_DISKS = 32
MAX_EVENTS = 100
MAX_MESSAGE_CHARS = 300

HealthState = Literal["healthy", "warning", "unhealthy", "unknown"]
EventCategory = Literal["crash", "hardware", "disk", "service"]

# (provider, event id) → (category, level, title). Providers are matched
# case-insensitively; anything else the agent sends is dropped.
EVENT_CATALOG: dict[Tuple[str, int], Tuple[EventCategory, str, str]] = {
    ("microsoft-windows-kernel-power", 41): ("crash", "critical", "Restarted without a clean shutdown"),
    ("microsoft-windows-wer-systemerrorreporting", 1001): ("crash", "critical", "Blue screen (stop error)"),
    ("bugcheck", 1001): ("crash", "critical", "Blue screen (stop error)"),
    ("eventlog", 6008): ("crash", "error", "Unexpected shutdown"),
    ("microsoft-windows-whea-logger", 18): ("hardware", "critical", "Fatal hardware error"),
    ("disk", 7): ("disk", "error", "Bad block on a disk"),
    ("disk", 11): ("disk", "error", "Disk controller error"),
    ("disk", 51): ("disk", "warning", "Paging error on a disk"),
    ("disk", 153): ("disk", "warning", "Disk I/O retried"),
    ("ntfs", 55): ("disk", "error", "File system corruption"),
    ("microsoft-windows-ntfs", 55): ("disk", "error", "File system corruption"),
    ("ntfs", 98): ("disk", "error", "Volume needs a disk check"),
    ("microsoft-windows-ntfs", 98): ("disk", "error", "Volume needs a disk check"),
    ("ntfs", 137): ("disk", "error", "File system transaction error"),
    ("microsoft-windows-ntfs", 137): ("disk", "error", "File system transaction error"),
    ("service control manager", 7031): ("service", "error", "Service stopped unexpectedly"),
    ("service control manager", 7034): ("service", "error", "Service stopped unexpectedly"),
}

# Categories the "critical events" monitor counts. A crashed service is shown
# but alerts through the service monitor, which knows which services matter.
ALERTING_CATEGORIES = ("crash", "hardware", "disk")

REBOOT_REASONS = {
    "windows_update": "Windows Update",
    "cbs": "Component servicing",
    "file_rename": "Pending file operations",
    "rename": "Computer rename",
}
# Reasons the pending-restart monitor counts: an installer leaving a file
# rename behind is routine, an update waiting for a restart is not.
ALERTING_REBOOT_REASONS = ("windows_update", "cbs", "rename")


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


def _text(value: Any, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())[:limit].strip()
    return text or None


def _bounded_int(value: Any, lo: int, hi: int) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
        number = int(value)
        return number if lo <= number <= hi else None
    return None


def _utc(value: Any) -> Optional[datetime]:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class PhysicalDisk(_Lenient):
    name: str = "Disk"
    media: Optional[str] = None  # SSD, HDD, SCM, Unspecified
    bus: Optional[str] = None  # NVMe, SATA, SAS, RAID, USB, Virtual …
    size_gb: Optional[float] = None
    health: HealthState = "unknown"
    operational: Optional[str] = None
    predict_failure: Optional[bool] = None
    temperature_c: Optional[int] = None
    wear_pct: Optional[int] = None
    power_on_hours: Optional[int] = None
    read_errors: Optional[int] = None  # uncorrected
    write_errors: Optional[int] = None  # uncorrected

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, value: Any) -> str:
        return _text(value, 128) or "Disk"

    @field_validator("media", "bus", mode="before")
    @classmethod
    def _short(cls, value: Any) -> Optional[str]:
        return _text(value, 16)

    @field_validator("operational", mode="before")
    @classmethod
    def _operational(cls, value: Any) -> Optional[str]:
        if isinstance(value, (list, tuple)):
            value = ", ".join(str(v) for v in value[:4] if isinstance(v, (str, int)))
        return _text(value, 64)

    @field_validator("health", mode="before")
    @classmethod
    def _health(cls, value: Any) -> str:
        text = value.strip().lower() if isinstance(value, str) else ""
        return text if text in ("healthy", "warning", "unhealthy") else "unknown"

    @field_validator("size_gb", mode="before")
    @classmethod
    def _size(cls, value: Any) -> Optional[float]:
        if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if math.isnan(value) or math.isinf(value) or not (0 < value < 1_000_000):
            return None
        return round(float(value), 1)

    @field_validator("predict_failure", mode="before")
    @classmethod
    def _bool(cls, value: Any) -> Optional[bool]:
        return value if isinstance(value, bool) else None

    @field_validator("temperature_c", mode="before")
    @classmethod
    def _temperature(cls, value: Any) -> Optional[int]:
        # 0 is what many drives report when they have no sensor.
        number = _bounded_int(value, 1, 150)
        return number

    @field_validator("wear_pct", mode="before")
    @classmethod
    def _wear(cls, value: Any) -> Optional[int]:
        return _bounded_int(value, 0, 100)

    @field_validator("power_on_hours", mode="before")
    @classmethod
    def _hours(cls, value: Any) -> Optional[int]:
        return _bounded_int(value, 0, 1_000_000)

    @field_validator("read_errors", "write_errors", mode="before")
    @classmethod
    def _errors(cls, value: Any) -> Optional[int]:
        return _bounded_int(value, 0, 10**12)

    @property
    def problem(self) -> Optional[str]:
        """Why this disk needs attention, or None."""
        if self.predict_failure:
            return "SMART predicts failure"
        if self.health == "unhealthy":
            return "Unhealthy"
        if self.health == "warning":
            return "Warning"
        if self.read_errors or self.write_errors:
            total = (self.read_errors or 0) + (self.write_errors or 0)
            return f"{total} uncorrected error{'s' if total != 1 else ''}"
        if self.wear_pct is not None and self.wear_pct >= 90:
            return f"{self.wear_pct}% worn"
        return None


class HealthEvent(_Lenient):
    record_id: int
    source: str
    event_id: int
    at: datetime
    message: Optional[str] = None
    # Filled from EVENT_CATALOG; whatever the agent sent is not trusted.
    category: Optional[EventCategory] = None
    level: Optional[str] = None
    title: Optional[str] = None

    @field_validator("source", mode="before")
    @classmethod
    def _source(cls, value: Any) -> str:
        return _text(value, 64) or ""

    @field_validator("message", mode="before")
    @classmethod
    def _message(cls, value: Any) -> Optional[str]:
        return _text(value, MAX_MESSAGE_CHARS)

    @field_validator("at", mode="before")
    @classmethod
    def _at(cls, value: Any) -> Any:
        return _utc(value) or value

    def model_post_init(self, __context: Any) -> None:
        entry = EVENT_CATALOG.get((self.source.lower(), self.event_id))
        if entry is not None:
            self.category, self.level, self.title = entry


class DeviceHealth(_Lenient):
    collected_at: Optional[datetime] = None
    disks: List[PhysicalDisk] = []
    reboot_pending: Optional[bool] = None
    reboot_reasons: List[str] = []
    events: List[HealthEvent] = []
    # Kept by the platform: when it first saw the restart pending.
    reboot_pending_since: Optional[datetime] = None

    @field_validator("collected_at", "reboot_pending_since", mode="before")
    @classmethod
    def _time(cls, value: Any) -> Optional[datetime]:
        return _utc(value)

    @field_validator("disks", mode="before")
    @classmethod
    def _disks(cls, value: Any) -> List[Any]:
        if not isinstance(value, list):
            return [value] if isinstance(value, dict) else []
        return [d for d in value[:MAX_DISKS] if isinstance(d, dict)]

    @field_validator("reboot_pending", mode="before")
    @classmethod
    def _pending(cls, value: Any) -> Optional[bool]:
        return value if isinstance(value, bool) else None

    @field_validator("reboot_reasons", mode="before")
    @classmethod
    def _reasons(cls, value: Any) -> List[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            return []
        out: List[str] = []
        for item in value[:10]:
            if isinstance(item, str) and item in REBOOT_REASONS and item not in out:
                out.append(item)
        return out

    @field_validator("events", mode="before")
    @classmethod
    def _events(cls, value: Any) -> List[Any]:
        if not isinstance(value, list):
            return []
        out = []
        for item in value[: MAX_EVENTS * 2]:
            if not isinstance(item, dict):
                continue
            try:
                event = HealthEvent.model_validate(item)
            except ValidationError:
                continue
            if event.category is not None:
                out.append(event)
        return out[:MAX_EVENTS]


def parse_device_health(raw: Any, *, device_id: Optional[int] = None) -> Optional[DeviceHealth]:
    """The normalised report, or None (logged) when ``raw`` does not fit."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        logger.warning("device %s: device_health is not an object — ignored", device_id)
        return None
    try:
        return DeviceHealth.model_validate(raw)
    except ValidationError as exc:
        logger.warning("device %s: invalid device_health ignored (%d errors)", device_id, exc.error_count())
        return None
