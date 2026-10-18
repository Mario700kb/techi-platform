"""Security posture reported by the Windows agent (>= 2.1.31).

The agent sends it in the heartbeat as ``security_posture`` when it changed or
every six hours. Everything here is defensive: unknown keys are dropped, lists
are trimmed and bounded, out-of-range numbers become null, and a payload that
still does not fit is ignored (logged) — it never fails the heartbeat.
A probe the agent could not read is null ("unknown"), never a guess.
"""
from __future__ import annotations

import logging
import math
import re
from datetime import datetime, timezone
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

logger = logging.getLogger(__name__)

MAX_LOCAL_ADMINS = 50
MAX_THIRD_PARTY_AV = 10
MAX_NAME_CHARS = 128
# Upper bound on list items even looked at, so a hostile payload cannot make
# the normaliser walk a million entries.
_MAX_ITEMS_SCANNED = 500
_DRIVE = re.compile(r"^[A-Z]:$")


def _bounded_names(value: Any, limit: int, *, skip: Optional[str] = None) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        raise ValueError("expected a list of names")
    out: List[str] = []
    seen: set[str] = set()
    for item in value[:_MAX_ITEMS_SCANNED]:
        if not isinstance(item, str):
            continue
        name = item.strip()[:MAX_NAME_CHARS].strip()
        if not name or (skip and skip in name.lower()):
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(name)
        if len(out) >= limit:
            break
    return out


class _Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


class DefenderPosture(_Lenient):
    present: bool = False
    antivirus_enabled: Optional[bool] = None
    realtime_enabled: Optional[bool] = None
    signature_age_days: Optional[int] = None

    @field_validator("signature_age_days", mode="before")
    @classmethod
    def _age_in_range(cls, value: Any) -> Any:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)) and not (0 <= value <= 3650):
            return None
        return value


class FirewallPosture(_Lenient):
    domain: Optional[bool] = None
    private: Optional[bool] = None
    public: Optional[bool] = None


class BitLockerPosture(_Lenient):
    system_drive: str = "C:"
    protection: Literal["on", "off", "unknown"] = "unknown"
    encryption_percent: Optional[float] = None

    @field_validator("system_drive", mode="before")
    @classmethod
    def _drive(cls, value: Any) -> str:
        drive = value.strip().upper() if isinstance(value, str) else ""
        return drive if _DRIVE.match(drive) else "C:"

    @field_validator("protection", mode="before")
    @classmethod
    def _protection(cls, value: Any) -> str:
        text = value.strip().lower() if isinstance(value, str) else ""
        return text if text in ("on", "off") else "unknown"

    @field_validator("encryption_percent", mode="before")
    @classmethod
    def _percent(cls, value: Any) -> Any:
        if value is None or isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            if math.isnan(value) or math.isinf(value):
                return None
            return round(max(0.0, min(100.0, float(value))), 1)
        return value


class SecurityPosture(_Lenient):
    collected_at: Optional[datetime] = None
    defender: DefenderPosture = DefenderPosture()
    third_party_av: List[str] = []
    firewall: FirewallPosture = FirewallPosture()
    bitlocker: BitLockerPosture = BitLockerPosture()
    uac_enabled: Optional[bool] = None
    secure_boot: Optional[bool] = None
    local_admins: List[str] = []

    @field_validator("defender", "firewall", "bitlocker", mode="before")
    @classmethod
    def _object_or_default(cls, value: Any) -> Any:
        return {} if value is None else value

    @field_validator("third_party_av", mode="before")
    @classmethod
    def _third_party_av(cls, value: Any) -> List[str]:
        return _bounded_names(value, MAX_THIRD_PARTY_AV, skip="defender")

    @field_validator("local_admins", mode="before")
    @classmethod
    def _local_admins(cls, value: Any) -> List[str]:
        return _bounded_names(value, MAX_LOCAL_ADMINS)

    @field_validator("collected_at", mode="before")
    @classmethod
    def _collected_at(cls, value: Any) -> Any:
        # An unreadable timestamp is dropped (the server's receive time is used).
        if value is None or isinstance(value, datetime):
            return value
        if not isinstance(value, str):
            return None
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None

    @field_validator("collected_at")
    @classmethod
    def _utc(cls, value: Optional[datetime]) -> Optional[datetime]:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def model_post_init(self, __context: Any) -> None:
        if not self.defender.present:
            # Nothing can be enabled in a Defender that is not there.
            self.defender = DefenderPosture(present=False)


def parse_security_posture(raw: Any, *, device_id: Optional[int] = None) -> Optional[SecurityPosture]:
    """The normalised posture, or None (logged) when ``raw`` does not fit."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        logger.warning("device %s: security_posture is not an object — ignored", device_id)
        return None
    try:
        return SecurityPosture.model_validate(raw)
    except ValidationError as exc:
        logger.warning(
            "device %s: invalid security_posture ignored (%d errors: %s)",
            device_id,
            exc.error_count(),
            "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['type']}" for e in exc.errors()[:5]),
        )
        return None
