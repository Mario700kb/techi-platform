"""Fleet risk for the dashboard: security posture, disk and restart health,
crashes, and the agent versions in use.

Read from what the agents already report (device_inventory.security_json and
health_json, the latest telemetry row) — no new collection. One pass over the
active devices in scope, served from a five-minute stale-while-revalidate
cache: the dashboard polls, the data changes on inventory uploads (hourly or
slower), and the host has one vCPU.
"""
from collections import Counter
from datetime import timedelta
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.scope import AllowedScope
from app.core.swr_cache import SWRCache, scope_cache_key
from app.core.time import utcnow
from app.db.sql import id_in
from app.models.client import Client
from app.models.device import Device
from app.models.device_inventory import DeviceInventory
from app.repositories.device_repository import DeviceRepository
from app.repositories.device_telemetry_repository import DeviceTelemetryRepository
from app.services.client_reports.common import json_dict
from app.services.client_reports.security import evaluate
from app.services.device_health import alerting_events, disks_with_problems, health_from_json, reboot_pending_days

_cache: SWRCache[dict] = SWRCache("fleet-risk", ttl=300.0, max_age=3600.0)

DISK_FULL_PCT = 90.0
REBOOT_PENDING_DAYS = 7
EVENT_WINDOW = timedelta(days=7)
# Devices listed under each check; the count is always the full number.
SAMPLE = 8

# (key, label, group, severity) in the order the dashboard shows them.
CHECKS = [
    ("no_antivirus", "No antivirus enabled", "security", "critical"),
    ("realtime_off", "Real-time protection off", "security", "critical"),
    ("firewall_off", "Firewall off", "security", "warning"),
    ("bitlocker_off", "BitLocker off on the system drive", "security", "warning"),
    ("signatures_old", "Antivirus signatures over 7 days old", "security", "warning"),
    ("disk_failing", "Disk reporting health problems", "health", "critical"),
    ("disk_full", f"Disk over {int(DISK_FULL_PCT)}% full", "health", "warning"),
    ("reboot_pending", f"Restart pending over {REBOOT_PENDING_DAYS} days", "health", "warning"),
    ("crashes", "Crashes or hardware errors this week", "health", "warning"),
]
# Security checks from client_reports.security.evaluate → dashboard keys.
_SECURITY_KEYS = {
    "antivirus": "no_antivirus",
    "realtime": "realtime_off",
    "firewall": "firewall_off",
    "bitlocker": "bitlocker_off",
    "signatures": "signatures_old",
}


def invalidate_risk_cache() -> None:
    _cache.clear()


def _family(platform: Optional[str]) -> Optional[str]:
    value = (platform or "").lower()
    if "mikrotik" in value or "routeros" in value:
        return None  # a connector, not an agent
    return "linux" if "linux" in value else "windows"


class FleetRiskService:
    def __init__(self, db: Session):
        self.db = db
        self._dialect = db.get_bind().dialect.name

    def get_risk(self, scope: Optional[AllowedScope] = None) -> dict:
        return _cache.get(scope_cache_key(scope, "risk"), self.db,
                          lambda session: FleetRiskService(session)._compute(scope))

    def _compute(self, scope: Optional[AllowedScope]) -> dict:
        now = utcnow()
        repo = DeviceRepository(self.db)
        query = self.db.query(
            Device.id, Device.hostname, Device.display_name, Device.client_id, Device.agent_version, Device.platform,
        )
        query = repo._apply_scope_filter(repo._apply_lifecycle_filter(query, "active"), scope)
        devices = query.all()
        ids = [d.id for d in devices]
        clients = dict(self.db.query(Client.id, Client.name).all())

        def entry(device, detail: str) -> dict:
            return {
                "id": device.id,
                "name": device.display_name or device.hostname or f"Device #{device.id}",
                "client_name": clients.get(device.client_id),
                "detail": detail,
            }

        hits: Dict[str, List[tuple]] = {key: [] for key, *_ in CHECKS}
        scores: List[int] = []
        protected = 0
        reported_security = 0
        reported_health = 0

        inventory = {}
        if ids:
            inventory = {
                row.device_id: row
                for row in self.db.query(
                    DeviceInventory.device_id, DeviceInventory.security_json, DeviceInventory.health_json,
                ).filter(id_in(DeviceInventory.device_id, ids, self._dialect))
            }
        disk_pct = {}
        if ids:
            disk_pct = {
                t.device_id: t.disk_percent
                for t in DeviceTelemetryRepository(self.db).get_latest_for_device_ids(ids)
                if t.disk_percent is not None
            }

        for device in devices:
            row = inventory.get(device.id)
            security = json_dict(row.security_json) if row is not None else {}
            if security:
                reported_security += 1
                score, issues, values = evaluate(security)
                scores.append(score)
                protected += 1 if values.get("protected") else 0
                for severity, check, text in issues:
                    key = _SECURITY_KEYS.get(check)
                    if key:
                        # Sort weight: critical issues first, then by name.
                        hits[key].append((-severity, entry(device, text)))

            health = health_from_json(row.health_json) if row is not None else None
            if health is not None:
                reported_health += 1
                failing = disks_with_problems(health)
                if failing:
                    names = ", ".join(d.name for d in failing[:2]) + (" …" if len(failing) > 2 else "")
                    hits["disk_failing"].append((-len(failing), entry(device, names)))
                waited = reboot_pending_days(health, now)
                if waited is not None and waited >= REBOOT_PENDING_DAYS:
                    hits["reboot_pending"].append((-waited, entry(device, f"{int(waited)} days")))
                events = alerting_events(health, now, window=EVENT_WINDOW)
                if events:
                    hits["crashes"].append(
                        (-len(events), entry(device, f"{len(events)} event{'s' if len(events) != 1 else ''}"))
                    )

            pct = disk_pct.get(device.id)
            if pct is not None and pct >= DISK_FULL_PCT:
                hits["disk_full"].append((-pct, entry(device, f"{pct:.0f}% used")))

        checks = []
        for key, label, group, severity in CHECKS:
            found = sorted(hits[key], key=lambda item: (item[0], item[1]["name"].lower()))
            checks.append({
                "key": key,
                "label": label,
                "group": group,
                "severity": severity,
                "count": len(found),
                "devices": [item[1] for item in found[:SAMPLE]],
            })

        versions = Counter(
            (family, device.agent_version)
            for device in devices
            if device.agent_version and (family := _family(device.platform)) is not None
        )
        return {
            "devices": len(devices),
            "security": {
                "reported": reported_security,
                "average_score": round(sum(scores) / len(scores), 1) if scores else None,
                "protected": protected,
            },
            "health_reported": reported_health,
            "checks": checks,
            "agent_versions": [
                {"family": family, "version": version, "count": count}
                for (family, version), count in sorted(versions.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
            "generated_at": now,
        }
