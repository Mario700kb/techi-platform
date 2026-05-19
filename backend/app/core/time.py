from datetime import datetime, timezone
from typing import Optional


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
