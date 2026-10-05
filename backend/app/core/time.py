from datetime import datetime, timezone
from functools import lru_cache
from typing import Optional
from zoneinfo import ZoneInfo


def utcnow() -> datetime:
    """Return current UTC time as a timezone-aware datetime.

    Use this everywhere instead of datetime.utcnow() so that Pydantic v2
    serialises the value with a +00:00 suffix and browsers parse it as UTC
    rather than local time.
    """
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@lru_cache(maxsize=None)
def _zone(name: str) -> ZoneInfo:
    return ZoneInfo(name)


def to_display(dt: Optional[datetime]) -> Optional[datetime]:
    """UTC (aware or naive-as-UTC) → the operators' timezone, DST-aware.

    The database stores naive UTC; anything a person reads (PDF, CSV) must be
    shown in DISPLAY_TIMEZONE (Europe/Tirane), not UTC.
    """
    from app.core.config import settings

    utc = ensure_utc(dt)
    return utc.astimezone(_zone(settings.DISPLAY_TIMEZONE)) if utc else None


def format_display(dt: Optional[datetime], fmt: str = "%Y-%m-%d %H:%M %Z") -> str:
    local = to_display(dt)
    return local.strftime(fmt) if local else ""
