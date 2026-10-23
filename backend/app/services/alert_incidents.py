"""One problem on several devices of a client is one incident.

When the same alert (kind and fingerprint) opens on three or more devices of
one client within 15 minutes, the first of them leads: the others follow it.
Followers leave the work queue, take the lead's owner, stop their own
escalation and close with it when a person resolves it. Offline devices are
left to the site outage (alert_center_service.site_outages), which already
groups them by site.

Runs only when an alert opens: one indexed query over the last 15 minutes of
openings, nothing on any other heartbeat.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow_naive
from app.models.alert import AlertKind, AlertState, DeviceAlert
from app.models.device import Device

INCIDENT_MIN_DEVICES = 3
INCIDENT_WINDOW = timedelta(minutes=15)
NOT_GROUPED = (AlertKind.DEVICE_OFFLINE.value, AlertKind.ARCHIVED_CHECKIN.value)


def _follow(db: Session, alert: DeviceAlert, lead: DeviceAlert) -> None:
    from app.repositories.alert_repository import AlertRepository

    alert.parent_id = lead.id
    alert.next_check_at = None
    if lead.assigned_to_id is not None:
        alert.assigned_to_id = lead.assigned_to_id
        alert.acknowledged_at = alert.acknowledged_at or lead.acknowledged_at
    AlertRepository(db).add_activity(alert.id, "incident_joined", None, f"Part of incident #{lead.id}")


def attach(db: Session, alert: DeviceAlert, device: Optional[Device]) -> Optional[DeviceAlert]:
    """Join the alert to its incident, or start one; returns the lead."""
    kind = getattr(alert.kind, "value", alert.kind)
    client_id = getattr(device, "client_id", None)
    if kind in NOT_GROUPED or client_id is None or alert.parent_id is not None:
        return None
    since = (alert.sla_started_at or utcnow_naive()) - INCIDENT_WINDOW
    peers = (
        db.query(DeviceAlert)
        .join(Device, Device.id == DeviceAlert.device_id)
        .filter(
            DeviceAlert.state == AlertState.OPEN.value,
            DeviceAlert.kind == kind,
            DeviceAlert.fingerprint == (alert.fingerprint or ""),
            DeviceAlert.sla_started_at >= since,
            DeviceAlert.device_id != alert.device_id,
            DeviceAlert.id != alert.id,
            Device.client_id == client_id,
        )
        .order_by(DeviceAlert.sla_started_at, DeviceAlert.id)
        .limit(100)
        .all()
    )
    if not peers:
        return None
    from app.repositories.alert_repository import AlertRepository

    lead_id = next((p.parent_id for p in peers if p.parent_id is not None), None)
    if lead_id is not None:
        lead = db.get(DeviceAlert, lead_id)
        if lead is None or getattr(lead.state, "value", lead.state) != AlertState.OPEN.value:
            return None
        _follow(db, alert, lead)
        db.commit()
        return lead
    if len({p.device_id for p in peers}) + 1 < INCIDENT_MIN_DEVICES:
        return None
    lead, others = peers[0], peers[1:]
    for follower in [*others, alert]:
        _follow(db, follower, lead)
    client = device.client if device is not None else None
    AlertRepository(db).add_activity(
        lead.id, "incident", None,
        f"{len(others) + 2} devices{' of ' + client.name if client is not None else ''} within "
        f"{int(INCIDENT_WINDOW.total_seconds() // 60)} minutes: one incident",
    )
    db.commit()
    return lead


def follower_counts(db: Session, lead_ids) -> dict:
    """Open followers of each lead, for a page of the queue."""
    from sqlalchemy import func

    ids = [i for i in lead_ids if i and i > 0]
    if not ids:
        return {}
    return dict(
        db.query(DeviceAlert.parent_id, func.count(DeviceAlert.id))
        .filter(DeviceAlert.parent_id.in_(ids), DeviceAlert.state == AlertState.OPEN.value)
        .group_by(DeviceAlert.parent_id)
        .all()
    )
