from datetime import timedelta
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.models.device_heartbeat import DeviceHeartbeat
import logging
from app.core.config import settings
from app.core.time import utcnow_naive

logger = logging.getLogger(__name__)


def _vacuum_analyze(db: Session, table_name: str) -> None:
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        db.execute(text(f"ANALYZE {table_name}"))
        db.commit()
        return

    with bind.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text(f"VACUUM ANALYZE {table_name}"))


def cleanup_old_heartbeats(db: Session, days: int = 7) -> int:
    cutoff = utcnow_naive() - timedelta(days=days)
    deleted = db.query(DeviceHeartbeat).filter(DeviceHeartbeat.created_at < cutoff).delete()
    db.commit()
    _vacuum_analyze(db, "device_heartbeats")
    logger.info(f"Cleanup: deleted {deleted} heartbeat records older than {days} days")
    return deleted


def cleanup_old_telemetry(db: Session, days: int = 7, pipeline_days: int = 1) -> int:
    """Heartbeat telemetry (the legacy table). Agents that send pipeline
    telemetry keep one day here plus their newest row, which the device list,
    health score and reports read; the others keep `days` for their charts."""
    now = utcnow_naive()
    result = db.execute(
        text(
            "DELETE FROM device_telemetry WHERE created_at < :cutoff "
            "OR (created_at < :pipeline_cutoff "
            "    AND device_id IN (SELECT device_id FROM device_telemetry_state WHERE policy_version IS NOT NULL) "
            "    AND id NOT IN (SELECT max(id) FROM device_telemetry GROUP BY device_id))"
        ),
        {"cutoff": now - timedelta(days=days), "pipeline_cutoff": now - timedelta(days=pipeline_days)},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_telemetry")
    logger.info(f"Cleanup: deleted {deleted} telemetry records older than {days} days")
    return deleted


def cleanup_old_activity_events(db: Session, days: int = 7) -> int:
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM device_activity_events WHERE occurred_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_activity_events")
    logger.info(f"Cleanup: deleted {deleted} activity event records older than {days} days")
    return deleted


def cleanup_resolved_alerts(db: Session, days: int = 90) -> int:
    """Open alerts are never touched; only resolved ones past the window.

    The newest offline alert of a device that is still offline stays: the
    offline sweep reads it to know an alert was already raised for this
    outage, and without it would open (and notify) a new one."""
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text(
            "DELETE FROM device_alerts WHERE state = 'resolved' AND updated_at < :cutoff "
            "AND id NOT IN ("
            "  SELECT max(a.id) FROM device_alerts a JOIN devices d ON d.id = a.device_id "
            "  WHERE a.kind = 'device_offline' AND d.status = 'OFFLINE' GROUP BY a.device_id)"
        ),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_alerts")
    logger.info(f"Cleanup: deleted {deleted} resolved alerts older than {days} days")
    return deleted


def cleanup_old_remote_actions(db: Session, days: int = 90) -> int:
    """Only terminal actions; queued/sent/running are never touched."""
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text(
            "DELETE FROM remote_actions "
            "WHERE status IN ('completed', 'failed', 'expired', 'cancelled') "
            "AND created_at < :cutoff"
        ),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "remote_actions")
    logger.info(f"Cleanup: deleted {deleted} terminal remote actions older than {days} days")
    return deleted


def cleanup_old_command_batches(db: Session, days: int = 90) -> int:
    """Batches past the window whose actions are all gone (see cleanup_old_remote_actions)."""
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text(
            "DELETE FROM agent_command_batches "
            "WHERE created_at < :cutoff "
            "AND NOT EXISTS (SELECT 1 FROM remote_actions WHERE remote_actions.batch_id = agent_command_batches.id)"
        ),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "agent_command_batches")
    logger.info(f"Cleanup: deleted {deleted} empty command batches older than {days} days")
    return deleted


def cleanup_old_status_history(db: Session, days: int = 90) -> int:
    """90 days: the availability report offers 7, 30 and 90 days."""
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM device_status_history WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_status_history")
    logger.info(f"Cleanup: deleted {deleted} status history records older than {days} days")
    return deleted


def cleanup_old_audit_logs(db: Session, days: int = 180) -> int:
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM audit_logs WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "audit_logs")
    logger.info(f"Cleanup: deleted {deleted} audit log records older than {days} days")
    return deleted


def cleanup_old_remote_support_connections(db: Session, days: int = 180) -> int:
    """Same window as the audit log, which keeps the sessions built from them."""
    cutoff = utcnow_naive() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM remote_support_connections WHERE opened_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    logger.info(f"Cleanup: deleted {deleted} Remote Support connection records older than {days} days")
    return deleted


def purge_trashed_devices(db: Session) -> int:
    """Devices deleted more than TRASH_RETENTION_DAYS ago go for good, with
    their history and console recordings. Their agents stay revoked."""
    from app.models.device import Device
    from app.services.device_service import TRASH_RETENTION_DAYS, DeviceService

    cutoff = utcnow_naive() - timedelta(days=TRASH_RETENTION_DAYS)
    ids = [row[0] for row in db.query(Device.id).filter(Device.deleted_at.is_not(None), Device.deleted_at < cutoff)]
    service = DeviceService(db)
    purged = 0
    for device_id in ids:
        if service.delete_device(device_id):
            purged += 1
    logger.info(f"Cleanup: purged {purged} devices from the trash (deleted over {TRASH_RETENTION_DAYS} days ago)")
    return purged


def cleanup_old_enrollment_audit(db: Session, days: int = 180, failed_days: int = 30) -> int:
    """Successful enrollments stay: token diagnostics compare them with the
    token's use count. Failures go after `failed_days`, the rest after `days`."""
    now = utcnow_naive()
    result = db.execute(
        text(
            "DELETE FROM enrollment_audit WHERE result <> 'success' AND ("
            "  (result = 'failed' AND created_at < :failed_cutoff) OR created_at < :cutoff)"
        ),
        {"cutoff": now - timedelta(days=days), "failed_cutoff": now - timedelta(days=failed_days)},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "enrollment_audit")
    logger.info(f"Cleanup: deleted {deleted} enrollment audit records older than {days} days")
    return deleted


def find_stale_alerts(db: Session) -> list:
    """Open alerts that nothing will ever close: (alert, reason) pairs.

    - any alert of an archived device (except the "archived device checked
      in" warning, which exists precisely for archived devices);
    - readings-based alerts (CPU, memory, disk, reconnects…) of a device that
      is offline, whose reading is no longer current;
    - repeated-reconnect alerts past their window, which used to have no
      closing path at all.
    """
    from app.models.alert import AlertKind, AlertState, DeviceAlert
    from app.models.device import Device, DeviceStatus
    from app.services.alert_rules import RECONNECT_WINDOW_SECONDS, STALE_WHEN_OFFLINE

    reconnect_cutoff = utcnow_naive() - timedelta(seconds=RECONNECT_WINDOW_SECONDS)
    # A full disk outlives a night off, not a device that has gone away.
    long_gone = utcnow_naive() - timedelta(days=max(1, settings.OFFLINE_ALERT_ABSENT_DAYS))
    rows = (
        db.query(DeviceAlert, Device)
        .join(Device, Device.id == DeviceAlert.device_id)
        .filter(DeviceAlert.state == AlertState.OPEN.value)
        .all()
    )
    stale = []
    for alert, device in rows:
        if device.is_archived and alert.kind != AlertKind.ARCHIVED_CHECKIN:
            stale.append((alert, "device_archived"))
        elif device.status == DeviceStatus.OFFLINE and (
            alert.kind in STALE_WHEN_OFFLINE
            or (alert.kind == AlertKind.LOW_DISK and (device.last_seen is None or device.last_seen < long_gone))
        ):
            stale.append((alert, "device_offline"))
        elif alert.kind == AlertKind.REPEATED_RECONNECTS and alert.created_at < reconnect_cutoff:
            stale.append((alert, "reconnects_settled"))
    return stale


def resolve_stale_alerts(db: Session) -> int:
    from app.services.alert_engine import AlertEngine

    engine = AlertEngine(db)
    resolved = 0
    for alert, reason in find_stale_alerts(db):
        if engine.resolve_alert(alert, reason=reason) is not None:
            resolved += 1
    logger.info(f"Cleanup: resolved {resolved} stale open alerts")
    return resolved


def rotate_remote_support_passwords(db: Session) -> int:
    """Nightly: replace per-device Remote Support passwords older than
    REMOTE_SUPPORT_PASSWORD_ROTATION_DAYS. Returns 0 (nothing is deleted);
    the count goes to its own audit entry."""
    from app.services.audit_service import AuditAction, system_audit_log
    from app.services.remote_support_password_service import RemoteSupportPasswordService

    rotated = RemoteSupportPasswordService(db).rotate_due()
    if rotated:
        system_audit_log(
            db,
            action=AuditAction.REMOTE_SUPPORT_PASSWORDS_ROTATED,
            details={"rotated": rotated, "trigger": "schedule"},
        )
        logger.info("Rotated %d Remote Support passwords", rotated)
    return 0
