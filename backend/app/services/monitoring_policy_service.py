"""Monitoring policies: what each device measures and when it raises an alert.

A device gets the settings of the most specific enabled policy that matches it
(group > client > device type > default) and the monitors of every matching
policy, a more specific one replacing a broader one's monitor with the same
key. The effective version ("<id>.<version>" of each matching policy) changes
whenever any of them is edited, so an agent knows when to reload.

Policies are few and read on every heartbeat, so they are cached in memory and
the cache is dropped on every change.
"""
import threading
import time
from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.time import utcnow_naive
from app.models.device import Device
from app.models.telemetry_pipeline import DeviceTelemetryState, MonitoringPolicy
from app.schemas.telemetry_pipeline import EffectivePolicy, Monitor, PolicyBody, PolicyOut

SPECIFICITY = {"default": 0, "device_type": 1, "client": 2, "group": 3}

# A "device type" policy follows the category the console shows everywhere
# (classify_category: the standard group first, then the OS), not the legacy
# device_type column — HV-PROD-01 is in Servers but its column says
# UNASSIGNED, so a column match never gave it the Servers monitors.
DEVICE_CATEGORIES = ("servers", "clientpc", "network", "storage", "hypervisors", "printers", "iot", "other")
_LEGACY_TYPES = {"server": "servers", "client": "clientpc"}


def device_category_value(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    return _LEGACY_TYPES.get(value, value)
_CACHE_TTL = 60.0
_cache_lock = threading.Lock()
_cache: Tuple[float, List[dict]] = (0.0, [])

# Server-side monitors: the platform evaluates these, the agent skips them.
SERVER_METRICS = {"disk_forecast_days", "no_data"}

FALLBACK = EffectivePolicy(
    version="0", sample_seconds=60, upload_seconds=900, buffer_mb=50, keep_days=7, monitors=[], policies=[],
)


def _snapshot(p: MonitoringPolicy) -> dict:
    return {
        "id": p.id, "name": p.name, "scope": p.scope, "scope_value": p.scope_value, "enabled": p.enabled,
        "version": p.version, "sample_seconds": p.sample_seconds, "upload_seconds": p.upload_seconds,
        "buffer_mb": p.buffer_mb, "keep_days": p.keep_days, "monitors": list(p.monitors or []),
    }


def invalidate_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = (0.0, [])


def _policies(db: Session) -> List[dict]:
    global _cache
    with _cache_lock:
        at, rows = _cache
        if rows and time.monotonic() - at < _CACHE_TTL:
            return rows
    rows = [_snapshot(p) for p in db.query(MonitoringPolicy).filter(MonitoringPolicy.enabled.is_(True)).all()]
    with _cache_lock:
        _cache = (time.monotonic(), rows)
    return rows


def _matches(policy: dict, device: Device) -> bool:
    scope, value = policy["scope"], policy["scope_value"]
    if scope == "default":
        return True
    if scope == "device_type":
        from app.platform_core.classification import classify_category

        return value is not None and classify_category(device) == device_category_value(value)
    if scope == "client":
        return device.client_id is not None and value == str(device.client_id)
    if scope == "group":
        return device.group_id is not None and value == str(device.group_id)
    return False


def effective_policy(db: Session, device: Device) -> EffectivePolicy:
    matching = sorted(
        (p for p in _policies(db) if _matches(p, device)),
        key=lambda p: (SPECIFICITY.get(p["scope"], 0), p["id"]),
    )
    if not matching:
        return FALLBACK
    monitors: dict = {}
    for policy in matching:  # broad to specific: specific overrides by key
        for raw in policy["monitors"]:
            monitor = Monitor.model_validate(raw)
            monitors[monitor.key] = monitor
    top = matching[-1]
    return EffectivePolicy(
        version=",".join(f"{p['id']}.{p['version']}" for p in matching),
        sample_seconds=top["sample_seconds"],
        upload_seconds=top["upload_seconds"],
        buffer_mb=top["buffer_mb"],
        keep_days=top["keep_days"],
        monitors=list(monitors.values()),
        policies=[p["name"] for p in matching],
    )


class MonitoringPolicyService:
    def __init__(self, db: Session):
        self.db = db

    def list(self) -> List[PolicyOut]:
        policies = self.db.query(MonitoringPolicy).order_by(MonitoringPolicy.id).all()
        devices = self.db.query(Device).filter(Device.is_archived.is_(False)).all()
        states = {s.device_id: s.policy_version for s in self.db.query(DeviceTelemetryState).all()}
        out = []
        for policy in policies:
            snap = _snapshot(policy)
            covered = [d for d in devices if _matches(snap, d)] if policy.enabled else []
            current = reporting = 0
            for device in covered:
                reported = states.get(device.id)
                if reported:
                    reporting += 1  # agent 2.1.29+: it reports the policy it runs
                    if f"{policy.id}.{policy.version}" in reported.split(","):
                        current += 1
            out.append(PolicyOut(
                id=policy.id, name=policy.name, description=policy.description, scope=policy.scope,
                scope_value=policy.scope_value, enabled=policy.enabled, version=policy.version,
                sample_seconds=policy.sample_seconds, upload_seconds=policy.upload_seconds,
                buffer_mb=policy.buffer_mb, keep_days=policy.keep_days,
                monitors=[Monitor.model_validate(m) for m in (policy.monitors or [])],
                updated_at=policy.updated_at, updated_by=policy.updated_by,
                devices=len(covered), devices_current=current, devices_reporting=reporting,
            ))
        return out

    def get(self, policy_id: int) -> Optional[MonitoringPolicy]:
        return self.db.get(MonitoringPolicy, policy_id)

    def _validate_scope(self, body: PolicyBody) -> None:
        if body.scope == "default":
            if body.scope_value:
                raise ValueError("The default policy has no scope value")
            return
        if not body.scope_value:
            raise ValueError("Choose what the policy applies to")
        if body.scope == "device_type" and device_category_value(body.scope_value) not in DEVICE_CATEGORIES:
            raise ValueError("Choose a device category")
        if body.scope in ("client", "group") and not body.scope_value.isdigit():
            raise ValueError("Scope value must be an id")
        keys = [m.key for m in body.monitors]
        if len(keys) != len(set(keys)):
            raise ValueError("Each monitor needs its own key")

    def create(self, body: PolicyBody, operator: str) -> MonitoringPolicy:
        self._validate_scope(body)
        if body.scope == "default" and self.db.query(MonitoringPolicy).filter(MonitoringPolicy.scope == "default").first():
            raise ValueError("There is already a default policy")
        policy = MonitoringPolicy(
            **body.model_dump(exclude={"monitors"}),
            monitors=[m.model_dump() for m in body.monitors],
            version=1, updated_at=utcnow_naive(), updated_by=operator,
        )
        self.db.add(policy)
        self.db.commit()
        self.db.refresh(policy)
        invalidate_cache()
        return policy

    def update(self, policy: MonitoringPolicy, body: PolicyBody, operator: str) -> MonitoringPolicy:
        self._validate_scope(body)
        if policy.scope == "default" and body.scope != "default":
            raise ValueError("The default policy keeps its scope")
        for field, value in body.model_dump(exclude={"monitors"}).items():
            setattr(policy, field, value)
        policy.monitors = [m.model_dump() for m in body.monitors]
        policy.version = (policy.version or 0) + 1
        policy.updated_at = utcnow_naive()
        policy.updated_by = operator
        self.db.commit()
        self.db.refresh(policy)
        invalidate_cache()
        return policy

    def delete(self, policy: MonitoringPolicy) -> None:
        if policy.scope == "default":
            raise ValueError("The default policy cannot be deleted")
        self.db.delete(policy)
        self.db.commit()
        invalidate_cache()

    def devices_for(self, policy: MonitoringPolicy) -> List[int]:
        snap = _snapshot(policy)
        return [
            d.id for d in self.db.query(Device).filter(Device.is_archived.is_(False)).all() if _matches(snap, d)
        ]


def agent_policy_payload(policy: EffectivePolicy) -> dict:
    """What the agent needs: collection settings and the monitors it evaluates
    itself (server-side monitors stay on the platform)."""
    return {
        "version": policy.version,
        "sample_seconds": policy.sample_seconds,
        "upload_seconds": policy.upload_seconds,
        "buffer_mb": policy.buffer_mb,
        "keep_days": policy.keep_days,
        "monitors": [m.model_dump() for m in policy.monitors if m.enabled and m.metric not in SERVER_METRICS],
    }
