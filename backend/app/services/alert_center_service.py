"""The Alerts work queue: who owns an alert, snooze, resolve with a reason,
notes, mute rules, the alert panel (description, evidence, history, runbook),
the Findings view, the alert-quality report, site outages and the reminder
for an unowned P1.

Everything runs in the backend and Postgres the platform already has.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow, utcnow_naive
from app.models.alert import AlertKind, AlertMute, AlertResolution, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.operator import Operator
from app.repositories.alert_repository import AlertQueueRepository, issue_key
from app.schemas.alert import AlertOut
from app.services.alert_engine import _alert_payload, device_is_server
from app.services.alert_presenter import KIND_TITLES, describe_alert
from app.services.alert_rules import ESCALATE_AFTER_SECONDS, EVENT_GROUPS, priority_for
from app.services.alert_runbooks import runbook_for
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher

logger = logging.getLogger(__name__)

# Manual "false positive" or "expected" keeps the alert closed for a day; a
# mute rule keeps it closed for longer.
QUIET_AFTER_DISMISS_SECONDS = 24 * 3600
# A site is out when this many of its devices went offline within this long.
SITE_OUTAGE_MIN_DEVICES = 3
SITE_OUTAGE_WINDOW = timedelta(minutes=15)


class AlertActionError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _value(x):
    return getattr(x, "value", x)


def alert_out(alert: DeviceAlert, hostname=None, display_name=None, client_name=None, client_id=None, category=None) -> AlertOut:
    out = AlertOut.model_validate(alert)
    out.device_name = (display_name or "").strip() or hostname
    out.client_name = client_name
    out.client_id = client_id
    out.assigned_to_name = (
        (alert.assigned_to.display_name or alert.assigned_to.username) if alert.assigned_to is not None else None
    )
    text = describe_alert(alert.kind, alert.fingerprint, alert.message, alert.detail, alert.severity)
    out.title, out.summary, out.value = text.title, text.summary, text.value
    if category is not None:
        from app.services.alert_rules import is_server_category

        out.device_role = "server" if is_server_category(category) else "pc"
    return out


class AlertCenterService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = AlertQueueRepository(db)

    # ── actions ─────────────────────────────────────────────────────────────

    def _get(self, alert_id: int, scope) -> DeviceAlert:
        alert = self.repo.get_in_scope(alert_id, scope)
        if alert is None:
            raise AlertActionError(404, "Alert not found")
        return alert

    def _publish(self, alert: DeviceAlert, reason: str) -> None:
        event = RealtimeEventType.ALERT_RESOLVED if _value(alert.state) == "resolved" else RealtimeEventType.ALERT_CREATED
        realtime_publisher.publish_threadsafe(
            build_event(event, data=_alert_payload(alert), reason=reason),
            dedupe_key=f"alert_{reason}:{alert.id}:{alert.updated_at.isoformat()}",
        )

    def take(self, alert_id: int, scope, operator: Operator) -> DeviceAlert:
        return self.assign(alert_id, scope, operator, operator.id)

    def assign(self, alert_id: int, scope, operator: Operator, operator_id: Optional[int]) -> DeviceAlert:
        alert = self._get(alert_id, scope)
        if _value(alert.state) != "open":
            raise AlertActionError(409, "Alert already resolved")
        target = None
        if operator_id is not None:
            target = self.db.get(Operator, operator_id)
            if target is None or not target.is_active:
                raise AlertActionError(404, "Operator not found")
        now = utcnow_naive()
        alert.assigned_to_id = target.id if target else None
        if target is not None and alert.acknowledged_at is None:
            alert.acknowledged_at = now
        if target is None:
            alert.acknowledged_at = None
        alert.updated_at = now
        if target is None:
            self.repo.add_activity(alert.id, "unassigned", operator.username, None)
        elif target.id == operator.id:
            self.repo.add_activity(alert.id, "taken", operator.username, None)
        else:
            self.repo.add_activity(alert.id, "assigned", operator.username, target.display_name or target.username)
        self.db.commit()
        self.db.refresh(alert)
        self._publish(alert, "assigned")
        return alert

    def snooze(self, alert_id: int, scope, operator: Operator, *, minutes: Optional[int], until: Optional[datetime],
               until_worse: bool) -> DeviceAlert:
        alert = self._get(alert_id, scope)
        if _value(alert.state) != "open":
            raise AlertActionError(409, "Alert already resolved")
        now = utcnow_naive()
        if until_worse:
            ends = now + timedelta(days=30)
        elif until is not None:
            ends = ensure_utc(until).replace(tzinfo=None)
        elif minutes:
            ends = now + timedelta(minutes=minutes)
        else:
            raise AlertActionError(422, "Say how long to snooze")
        if ends <= now:
            raise AlertActionError(422, "The snooze must end in the future")
        alert.snoozed_until = ends
        alert.snooze_until_worse = bool(until_worse)
        alert.updated_at = now
        what = "until it gets worse" if until_worse else f"until {ends:%d %b %H:%M} UTC"
        self.repo.add_activity(alert.id, "snoozed", operator.username, what)
        self.db.commit()
        self.db.refresh(alert)
        self._publish(alert, "snoozed")
        return alert

    def unsnooze(self, alert_id: int, scope, operator: Operator) -> DeviceAlert:
        alert = self._get(alert_id, scope)
        alert.snoozed_until = None
        alert.snooze_until_worse = False
        alert.updated_at = utcnow_naive()
        self.repo.add_activity(alert.id, "unsnoozed", operator.username, None)
        self.db.commit()
        self.db.refresh(alert)
        self._publish(alert, "unsnoozed")
        return alert

    def resolve(self, alert_id: int, scope, operator: Operator, *, resolution: str = "fixed", note: Optional[str] = None) -> DeviceAlert:
        alert = self._get(alert_id, scope)
        if _value(alert.state) == "resolved":
            raise AlertActionError(409, "Alert already resolved")
        quiet = QUIET_AFTER_DISMISS_SECONDS if resolution in (AlertResolution.FALSE_POSITIVE.value, AlertResolution.EXPECTED.value) else 0
        resolved = self.repo.resolve(alert.id, cooldown_seconds=quiet, resolution=resolution,
                                     resolved_by=operator.username, note=note)
        if resolved is None:
            raise AlertActionError(500, "Failed to resolve alert")
        self._publish(resolved, "manual_resolve")
        return resolved

    def note(self, alert_id: int, scope, operator: Operator, text: str) -> None:
        alert = self._get(alert_id, scope)
        self.repo.add_activity(alert.id, "note", operator.username, text.strip())
        alert.updated_at = utcnow_naive()
        self.db.commit()

    def bulk(self, ids: List[int], scope, operator: Operator, body) -> Tuple[List[int], List[int]]:
        done: List[int] = []
        failed: List[int] = []
        for alert_id in ids:
            try:
                if body.action == "take":
                    self.take(alert_id, scope, operator)
                elif body.action == "assign":
                    self.assign(alert_id, scope, operator, body.operator_id)
                elif body.action == "snooze":
                    self.snooze(alert_id, scope, operator, minutes=body.minutes, until=None, until_worse=body.until_worse)
                elif body.action == "unsnooze":
                    self.unsnooze(alert_id, scope, operator)
                elif body.action == "resolve":
                    self.resolve(alert_id, scope, operator, resolution=body.resolution, note=body.note)
                done.append(alert_id)
            except AlertActionError:
                self.db.rollback()
                failed.append(alert_id)
        return done, failed

    # ── mute rules ──────────────────────────────────────────────────────────

    def list_mutes(self, scope) -> List[Dict[str, Any]]:
        mutes = self.repo.active_mutes()
        out = []
        for mute in sorted(mutes, key=lambda m: m.created_at, reverse=True):
            device = self.db.get(Device, mute.device_id) if mute.device_id else None
            if scope is not None and mute.device_id is not None:
                from app.core.scope import device_in_scope

                if device is None or not device_in_scope(device.client_id, device.group_id, device.id, scope):
                    continue
            client = self.db.get(Client, mute.client_id) if mute.client_id else None
            out.append({
                "id": mute.id, "device_id": mute.device_id,
                "device_name": ((device.display_name or "").strip() or device.hostname) if device else None,
                "client_id": mute.client_id, "client_name": client.name if client else None,
                "kind": mute.kind, "fingerprint": mute.fingerprint, "until": mute.until, "reason": mute.reason,
                "created_by": mute.created_by, "created_at": mute.created_at,
            })
        return out

    def create_mute(self, scope, operator: Operator, body) -> Dict[str, Any]:
        if body.device_id is None and body.client_id is None and not body.kind:
            raise AlertActionError(422, "A mute needs a device, a client or an alert type")
        if body.kind and body.kind not in {k.value for k in AlertKind}:
            raise AlertActionError(422, "Unknown alert type")
        if scope is not None:
            from app.core.scope import device_in_scope

            if body.device_id is None:
                raise AlertActionError(403, "Only an operator who sees every device can mute a client or a type")
            device = self.db.get(Device, body.device_id)
            if device is None or not device_in_scope(device.client_id, device.group_id, device.id, scope):
                raise AlertActionError(404, "Device not found")
        now = utcnow_naive()
        mute = AlertMute(
            device_id=body.device_id, client_id=body.client_id, kind=body.kind, fingerprint=body.fingerprint or None,
            until=now + timedelta(days=body.days) if body.days else None, reason=body.reason.strip(),
            created_by=operator.username, created_at=now,
        )
        self.db.add(mute)
        self.db.commit()
        closed = 0
        if body.resolve_open:
            query = self.db.query(DeviceAlert).join(Device, Device.id == DeviceAlert.device_id).filter(
                DeviceAlert.state == AlertState.OPEN.value
            )
            if body.device_id is not None:
                query = query.filter(DeviceAlert.device_id == body.device_id)
            if body.client_id is not None:
                query = query.filter(Device.client_id == body.client_id)
            if body.kind:
                query = query.filter(DeviceAlert.kind == body.kind)
            if body.fingerprint:
                query = query.filter(DeviceAlert.fingerprint == body.fingerprint)
            for alert in query.limit(2000).all():
                resolved = self.repo.resolve(alert.id, cooldown_seconds=0, resolution=AlertResolution.MUTED.value,
                                             resolved_by=operator.username, note=f"mute #{mute.id}: {mute.reason}")
                if resolved is not None:
                    closed += 1
                    self._publish(resolved, "muted")
        row = next((m for m in self.list_mutes(None) if m["id"] == mute.id), {})
        row["closed"] = closed
        return row

    def remove_mute(self, mute_id: int, scope, operator: Operator) -> None:
        mute = self.db.get(AlertMute, mute_id)
        if mute is None or mute.removed_at is not None:
            raise AlertActionError(404, "Mute not found")
        if scope is not None and mute.device_id is None:
            raise AlertActionError(403, "Only an operator who sees every device can remove this mute")
        mute.removed_at = utcnow_naive()
        mute.removed_by = operator.username
        self.db.commit()

    # ── the alert panel ─────────────────────────────────────────────────────

    def facts(self, device: Optional[Device]) -> Dict[str, Any]:
        if device is None:
            return {}
        now = utcnow_naive()
        last_boot = device.last_boot_at
        uptime_h = round((now - last_boot).total_seconds() / 3600, 1) if last_boot and last_boot < now else None
        return {
            "role": "server" if device_is_server(device) else "pc",
            "os": device.os_caption or device.os_name,
            "os_build": device.os_build,
            "agent_version": getattr(device, "agent_version", None),
            "status": _value(device.status),
            "last_seen": device.last_seen,
            "last_boot": last_boot,
            "uptime_hours": uptime_h,
            "offline_reason": device.offline_reason,
            "client": device.client.name if getattr(device, "client", None) is not None else None,
            "location": device.location_name if hasattr(device, "location_name") else None,
            "cpu": device.cpu,
            "ram": device.ram,
            "in_maintenance": bool(getattr(device, "is_in_maintenance", False)),
        }

    def evidence(self, alert: DeviceAlert, device: Optional[Device]) -> Dict[str, Any]:
        from app.services.device_health import is_actionable
        from app.services.device_inventory_service import DeviceInventoryService

        kind = _value(alert.kind)
        fingerprint = alert.fingerprint or ""
        out: Dict[str, Any] = {}
        inventory = DeviceInventoryService(self.db)
        if kind in ("critical_events", "disk_health", "reboot_pending", "service_stopped"):
            health = inventory.get_health(alert.device_id)
            if health is not None:
                from app.services.alert_rules import EVENT_GROUP_OF

                group = fingerprint[4:] if fingerprint.startswith("evt:") else None
                events = []
                for e in health.events:
                    in_group = EVENT_GROUP_OF.get((e.source.lower(), e.event_id))
                    if kind == "critical_events" and group and in_group != group:
                        continue
                    if kind == "service_stopped" and e.category != "service":
                        continue
                    events.append({"at": e.at, "source": e.source, "event_id": e.event_id, "title": e.title,
                                   "message": e.message, "counts": is_actionable(e)})
                out["events"] = events[:25]
                others = {EVENT_GROUP_OF.get((e.source.lower(), e.event_id)) for e in health.events if is_actionable(e)}
                out["also_seen_7d"] = sorted(EVENT_GROUPS[g].title for g in others if g and g != group)
                if kind == "disk_health":
                    out["disks"] = [d.model_dump() for d in health.disks]
                if kind == "reboot_pending":
                    out["reboot_reasons"] = health.reboot_reasons
                    out["reboot_pending_since"] = health.reboot_pending_since
        if kind == "security_posture":
            posture = inventory.get_security_posture(alert.device_id)
            if posture is not None:
                from app.services.security_posture import posture_findings, posture_score

                out["posture_score"] = posture_score(posture)
                out["findings"] = [text for _, text in posture_findings(posture)]
        if kind in ("high_cpu", "high_ram", "disk_busy", "packet_loss", "network_latency"):
            from app.models.telemetry_pipeline import TelemetryRollup5m

            since = (alert.last_seen_at or alert.created_at) - timedelta(hours=2)
            rows = (
                self.db.query(TelemetryRollup5m)
                .filter(TelemetryRollup5m.device_id == alert.device_id, TelemetryRollup5m.bucket >= since)
                .order_by(TelemetryRollup5m.bucket)
                .limit(48)
                .all()
            )
            out["series"] = [
                {"at": r.bucket, "cpu_avg": r.cpu_avg, "cpu_max": r.cpu_max, "mem_avg": r.mem_avg, "mem_max": r.mem_max,
                 "disk_busy_max": r.disk_busy_max, "gw_ms_avg": r.gw_ms_avg, "gw_loss_max": r.gw_loss_max}
                for r in rows
            ]
            busiest = max((r for r in rows if r.top), key=lambda r: r.cpu_max or 0, default=None)
            out["top_processes"] = busiest.top if busiest else None
        if kind in ("low_disk", "disk_forecast"):
            from app.models.telemetry_pipeline import TelemetrySample

            latest = (
                self.db.query(TelemetrySample.disks)
                .filter(TelemetrySample.device_id == alert.device_id, TelemetrySample.disks.isnot(None))
                .order_by(TelemetrySample.ts.desc())
                .first()
            )
            out["disks"] = latest[0] if latest else None
        if kind == "device_offline" and device is not None and device.location_id:
            peers = (
                self.db.query(func.count(Device.id))
                .filter(Device.location_id == device.location_id, Device.status == DeviceStatus.OFFLINE,
                        Device.is_archived.is_(False), Device.deleted_at.is_(None))
                .scalar()
            )
            total = (
                self.db.query(func.count(Device.id))
                .filter(Device.location_id == device.location_id, Device.is_archived.is_(False), Device.deleted_at.is_(None))
                .scalar()
            )
            out["site"] = {"offline": peers, "devices": total}
        return out

    def describe(self, alert: DeviceAlert, facts: Dict[str, Any], evidence: Dict[str, Any]) -> str:
        """A paragraph in plain words: what happened, how often, on what."""
        text = describe_alert(alert.kind, alert.fingerprint, alert.message, alert.detail, alert.severity)
        role = "server" if facts.get("role") == "server" else "workstation"
        parts = [f"{text.title} on this {role}."]
        if text.summary:
            parts.append(text.summary.rstrip(".") + ".")
        if (alert.occurrences or 1) > 1:
            parts.append(f"It has come back {alert.occurrences} times; each return reopened this same alert.")
        events = evidence.get("events") or []
        if events:
            counted = [e for e in events if e.get("counts")]
            parts.append(f"{len(counted)} matching event{'s' if len(counted) != 1 else ''} in the device's last report.")
        if evidence.get("also_seen_7d"):
            parts.append(f"Also on this device in the last 7 days: {', '.join(evidence['also_seen_7d'])}.")
        elif _value(alert.kind) == "critical_events":
            parts.append("No other crash, hardware or disk error in the last 7 days.")
        if facts.get("offline_reason") and _value(alert.kind) in ("device_offline", "critical_events"):
            parts.append(f"Last offline reason the agent gave: {facts['offline_reason']}.")
        if evidence.get("top_processes"):
            top = evidence["top_processes"][:3]
            parts.append("Busiest processes: " + ", ".join(
                f"{p.get('n')} {p.get('c'):.0f}%" if p.get("c") is not None else str(p.get("n")) for p in top
            ) + ".")
        if evidence.get("site"):
            site = evidence["site"]
            parts.append(f"At this device's site {site['offline']} of {site['devices']} devices are offline.")
        return " ".join(parts)

    def detail(self, alert_id: int, scope) -> Dict[str, Any]:
        from app.services.alert_ai_service import AlertAIService

        alert = self._get(alert_id, scope)
        device = self.db.get(Device, alert.device_id)
        client = device.client if device is not None else None
        out = alert_out(alert, device.hostname if device else None, device.display_name if device else None,
                        client.name if client else None, device.client_id if device else None)
        facts = self.facts(device)
        out.device_role = facts.get("role")
        evidence = self.evidence(alert, device)
        runbook = runbook_for(alert.kind, alert.fingerprint)
        ai = AlertAIService(self.db)
        return {
            "alert": out,
            "description": self.describe(alert, facts, evidence),
            "facts": facts,
            "evidence": evidence,
            "history": self.repo.history(alert),
            "activity": self.repo.activity(alert.id),
            "runbook": runbook.as_dict() if runbook else None,
            "analysis": ai.latest_for_alert(alert),
            "ai_enabled": ai.enabled,
        }

    # ── site outages ────────────────────────────────────────────────────────

    def site_outages(self, scope) -> List[AlertOut]:
        """Several devices of one site offline at once is one problem: the
        site (power, internet). Computed on read, shown above their alerts."""
        from app.models.client_location import ClientLocation

        rows = (
            self.repo._in_scope(self.db.query(DeviceAlert, Device.location_id, Device.client_id), scope)
            .filter(DeviceAlert.state == AlertState.OPEN.value, DeviceAlert.kind == AlertKind.DEVICE_OFFLINE.value,
                    Device.location_id.isnot(None))
            .all()
        )
        by_site: Dict[int, list] = {}
        for alert, location_id, client_id in rows:
            by_site.setdefault(location_id, []).append((alert, client_id))
        out: List[AlertOut] = []
        for location_id, items in by_site.items():
            if len(items) < SITE_OUTAGE_MIN_DEVICES:
                continue
            items.sort(key=lambda x: x[0].last_seen_at or x[0].created_at)
            # The largest cluster of alerts opened close together.
            best: list = []
            for i in range(len(items)):
                start = items[i][0].last_seen_at or items[i][0].created_at
                cluster = [x for x in items[i:] if (x[0].last_seen_at or x[0].created_at) - start <= SITE_OUTAGE_WINDOW]
                if len(cluster) > len(best):
                    best = cluster
            if len(best) < SITE_OUTAGE_MIN_DEVICES:
                continue
            location = self.db.get(ClientLocation, location_id)
            client = self.db.get(Client, best[0][1]) if best[0][1] else None
            first = best[0][0]
            name = location.name if location else f"Site #{location_id}"
            out.append(AlertOut(
                id=-(100000 + location_id), device_id=None, kind="site_outage", severity="critical", state="open",
                message=f"{len(best)} devices at {name} went offline within {int(SITE_OUTAGE_WINDOW.total_seconds() // 60)} minutes",
                detail=f"{location.city}, {location.country}" if location else None,
                created_at=first.last_seen_at or first.created_at, updated_at=utcnow_naive(),
                device_name=name, client_name=client.name if client else None, client_id=client.id if client else None,
                priority=1, title=f"Site offline · {name}",
                summary=f"{len(best)} devices offline together: power or internet at the site",
                value=f"{len(best)}", member_ids=[x[0].id for x in best], device_role="site",
                last_seen_at=max(x[0].last_seen_at or x[0].created_at for x in best),
            ))
        return sorted(out, key=lambda a: a.created_at, reverse=True)

    # ── reminders ───────────────────────────────────────────────────────────

    def escalate_unowned(self, now: Optional[datetime] = None) -> int:
        """A P1 nobody took within 30 minutes of working hours is sent again."""
        from app.services.notification_events import NotificationEvent
        from app.services.notification_service import NotificationService
        from app.services.offline_alerts import WorkHours

        now = ensure_utc(now or utcnow())
        window = WorkHours.from_settings().window(now)
        if window is None or not (window[0] <= now <= window[1]):
            return 0
        naive = now.replace(tzinfo=None)
        cutoff = naive - timedelta(seconds=ESCALATE_AFTER_SECONDS)
        due = (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.state == AlertState.OPEN.value,
                DeviceAlert.priority == 1,
                DeviceAlert.assigned_to_id.is_(None),
                DeviceAlert.escalated_at.is_(None),
                func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at) <= cutoff,
                func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at) >= window[0].replace(tzinfo=None) - timedelta(hours=16),
            )
            .filter((DeviceAlert.snoozed_until.is_(None)) | (DeviceAlert.snoozed_until <= naive))
            .limit(50)
            .all()
        )
        for alert in due:
            device = self.db.get(Device, alert.device_id)
            NotificationService(self.db).dispatch(
                event_type=NotificationEvent.CRITICAL_ALERT,
                title=f"Still nobody on it: {alert.message}"[:255],
                message=f"P1 open for over {ESCALATE_AFTER_SECONDS // 60} minutes without an owner. {alert.detail or ''}".strip(),
                severity=_value(alert.severity),
                device_id=alert.device_id,
                client_id=getattr(device, "client_id", None),
                payload={"kind": _value(alert.kind), "priority": 1, "alert_id": alert.id, "reminder": True},
            )
            alert.escalated_at = naive
            self.repo.add_activity(alert.id, "escalated", None, "Reminder sent: no owner after 30 minutes")
        if due:
            self.db.commit()
        return len(due)

    # ── findings ────────────────────────────────────────────────────────────

    def findings(self, scope, *, kind: Optional[str] = None, client_id: Optional[int] = None) -> Dict[str, Any]:
        """States worth fixing on a plan, not incidents: weak security,
        restarts waiting on PCs, PCs that keep losing power, disks forecast
        to fill."""
        from app.models.device_inventory import DeviceInventory
        from app.repositories.device_repository import DeviceRepository
        from app.services.alert_rules import EVENT_GROUPS
        from app.services.device_health import firing_event_groups, health_from_json, reboot_pending_days
        from app.services.metrics_query_service import disk_trends
        from app.services.security_posture import posture_findings, posture_from_json, posture_score

        query = self.db.query(Device, DeviceInventory.security_json, DeviceInventory.health_json, Client.name).join(
            DeviceInventory, DeviceInventory.device_id == Device.id
        ).outerjoin(Client, Client.id == Device.client_id)
        query = DeviceRepository(self.db)._apply_scope_filter(query, scope)
        query = query.filter(Device.is_archived.is_(False), Device.deleted_at.is_(None))
        if client_id is not None:
            query = query.filter(Device.client_id == client_id)
        now = utcnow()
        items: List[Dict[str, Any]] = []
        for device, security_json, health_json, client_name in query.limit(5000).all():
            name = (device.display_name or "").strip() or device.hostname or f"Device #{device.id}"
            server = device_is_server(device)
            role = "server" if server else "pc"
            if kind in (None, "security") and security_json:
                posture = posture_from_json(security_json)
                if posture is not None:
                    found = posture_findings(posture)
                    if found:
                        score = posture_score(posture)
                        codes = {c for c, _ in found}
                        level = "high" if ("no_antivirus" in codes or (server and score < 70)) else ("medium" if score < 70 else "low")
                        items.append({
                            "device_id": device.id, "device_name": name, "client_name": client_name, "device_role": role,
                            "type": "security", "severity": level, "title": f"Security score {score}",
                            "detail": "; ".join(t for _, t in found), "since": posture.collected_at,
                        })
            health = health_from_json(health_json) if kind in (None, "reboot", "power") and health_json else None
            if kind in (None, "power") and health is not None and not server:
                for group in firing_event_groups(health, now, is_server=False):
                    if EVENT_GROUPS[group.key].pc_alert:
                        continue
                    items.append({
                        "device_id": device.id, "device_name": name, "client_name": client_name, "device_role": role,
                        "type": "power", "severity": "medium" if group.count >= 4 else "low",
                        "title": f"{group.title} {group.count}× in {group.window_h // 24} days",
                        "detail": "Power cut or the power button held: check the UPS and power strip, ask the user",
                        "since": group.events[0].at,
                    })
            if kind in (None, "reboot") and health is not None:
                days = reboot_pending_days(health, now)
                if days is not None and days >= 3:
                    items.append({
                        "device_id": device.id, "device_name": name, "client_name": client_name, "device_role": role,
                        "type": "reboot", "severity": "medium" if days > 14 or server else "low",
                        "title": f"Restart pending {days:.0f} days",
                        "detail": ", ".join(health.reboot_reasons) or None, "since": health.reboot_pending_since,
                    })
        if kind in (None, "disk_forecast"):
            from app.models.telemetry_pipeline import DeviceTelemetryState

            states = DeviceRepository(self.db)._apply_scope_filter(
                self.db.query(Device, Client.name).join(DeviceTelemetryState, DeviceTelemetryState.device_id == Device.id)
                .outerjoin(Client, Client.id == Device.client_id), scope
            ).filter(Device.is_archived.is_(False), Device.deleted_at.is_(None))
            if client_id is not None:
                states = states.filter(Device.client_id == client_id)
            for device, client_name in states.limit(2000).all():
                for disk in disk_trends(self.db, device.id):
                    if disk.days_to_full is not None and disk.days_to_full < 60:
                        items.append({
                            "device_id": device.id,
                            "device_name": (device.display_name or "").strip() or device.hostname or f"Device #{device.id}",
                            "client_name": client_name, "device_role": "server" if device_is_server(device) else "pc",
                            "type": "disk_forecast", "severity": "medium" if disk.days_to_full < 30 else "low",
                            "title": f"Disk {disk.mount} full in ~{disk.days_to_full:.0f} days", "detail": None, "since": None,
                        })
        rank = {"high": 0, "medium": 1, "low": 2}
        items.sort(key=lambda i: (rank[i["severity"]], 0 if i["device_role"] == "server" else 1, i["device_name"].lower()))
        counts: Dict[str, int] = {}
        for item in items:
            counts[item["type"]] = counts.get(item["type"], 0) + 1
        return {"items": items, "counts": counts}

    # ── alert quality ───────────────────────────────────────────────────────

    def quality(self, scope, days: int = 7) -> Dict[str, Any]:
        """Which rules make noise: per issue, how many opened, came back,
        closed by themselves within 15 minutes or were dismissed as wrong, and
        how long they took to be taken and fixed."""
        from app.models.alert import AlertActivity

        since = utcnow_naive() - timedelta(days=days)
        alerts = (
            self.repo._in_scope(self.db.query(DeviceAlert), scope)
            .filter(func.coalesce(DeviceAlert.last_seen_at, DeviceAlert.created_at) >= since)
            .limit(50000)
            .all()
        )
        ids = [a.id for a in alerts]
        reopened: Dict[int, int] = {}
        if ids:
            for alert_id, count in (
                self.db.query(AlertActivity.alert_id, func.count(AlertActivity.id))
                .filter(AlertActivity.action == "reopened", AlertActivity.at >= since, AlertActivity.alert_id.in_(ids))
                .group_by(AlertActivity.alert_id)
                .all()
            ):
                reopened[alert_id] = count
        rows: Dict[str, Dict[str, Any]] = {}
        for alert in alerts:
            key = issue_key(alert.kind, alert.fingerprint)
            row = rows.setdefault(key, {"issue": key, "opened": 0, "reopened": 0, "devices": set(), "flapping": 0,
                                        "false_positive": 0, "expected": 0, "still_open": 0, "tta": [], "ttr": []})
            row["opened"] += 1
            row["reopened"] += reopened.get(alert.id, 0)
            row["devices"].add(alert.device_id)
            if _value(alert.state) == "open":
                row["still_open"] += 1
            started = alert.last_seen_at or alert.created_at
            if alert.resolved_at is not None:
                minutes = (alert.resolved_at - started).total_seconds() / 60
                if alert.resolution in (None, "auto") and 0 <= minutes < 15:
                    row["flapping"] += 1
                if alert.resolution not in (None, "auto"):
                    row["ttr"].append(max(0.0, (alert.resolved_at - alert.created_at).total_seconds() / 60))
            if alert.resolution == "false_positive":
                row["false_positive"] += 1
            if alert.resolution == "expected":
                row["expected"] += 1
            if alert.acknowledged_at is not None:
                row["tta"].append(max(0.0, (alert.acknowledged_at - alert.created_at).total_seconds() / 60))
        out = []
        for key, row in rows.items():
            kind, _, fingerprint = key.partition("|")
            text = describe_alert(kind, fingerprint, "", None, "warning")
            total = row["opened"] + row["reopened"]
            # A reopening is the problem closing by itself and coming back.
            noise = row["flapping"] + row["reopened"] + row["false_positive"] + row["expected"]
            out.append({
                "issue": key,
                "title": EVENT_GROUPS[fingerprint[4:]].title if fingerprint.startswith("evt:") else text.title,
                "opened": row["opened"], "reopened": row["reopened"], "devices": len(row["devices"]),
                "flapping": row["flapping"], "false_positive": row["false_positive"], "expected": row["expected"],
                "still_open": row["still_open"],
                "mtta_minutes": round(sum(row["tta"]) / len(row["tta"]), 1) if row["tta"] else None,
                "mttr_minutes": round(sum(row["ttr"]) / len(row["ttr"]), 1) if row["ttr"] else None,
                "noise_pct": round(100.0 * noise / total, 1) if total else 0.0,
            })
        out.sort(key=lambda r: (-(r["opened"] + r["reopened"]), r["issue"]))
        all_open = sum(r["opened"] + r["reopened"] for r in out)
        all_noise = sum(r["flapping"] + r["reopened"] + r["false_positive"] + r["expected"] for r in out)
        return {
            "days": days, "since": since, "rows": out,
            "totals": {"opened": all_open, "noise_pct": round(100.0 * all_noise / all_open, 1) if all_open else 0.0,
                       "issues": len(out)},
        }


def kind_title(kind: str) -> str:
    return KIND_TITLES.get(kind, kind)


__all__ = ["AlertCenterService", "AlertActionError", "alert_out", "kind_title", "priority_for"]
