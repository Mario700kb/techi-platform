from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.models.device_heartbeat import DeviceHeartbeat
import logging

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
    cutoff = datetime.utcnow() - timedelta(days=days)
    deleted = db.query(DeviceHeartbeat).filter(DeviceHeartbeat.created_at < cutoff).delete()
    db.commit()
    _vacuum_analyze(db, "device_heartbeats")
    logger.info(f"Cleanup: deleted {deleted} heartbeat records older than {days} days")
    return deleted


def cleanup_old_telemetry(db: Session, days: int = 7) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM device_telemetry WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_telemetry")
    logger.info(f"Cleanup: deleted {deleted} telemetry records older than {days} days")
    return deleted


def cleanup_old_activity_events(db: Session, days: int = 7) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
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
    """Open alerts are never touched; only resolved ones past the window."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM device_alerts WHERE state = 'resolved' AND updated_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "device_alerts")
    logger.info(f"Cleanup: deleted {deleted} resolved alerts older than {days} days")
    return deleted


def cleanup_old_remote_actions(db: Session, days: int = 90) -> int:
    """Only terminal actions; queued/sent/running are never touched."""
    cutoff = datetime.utcnow() - timedelta(days=days)
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
    cutoff = datetime.utcnow() - timedelta(days=days)
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


def cleanup_old_status_history(db: Session, days: int = 60) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
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
    cutoff = datetime.utcnow() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM audit_logs WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "audit_logs")
    logger.info(f"Cleanup: deleted {deleted} audit log records older than {days} days")
    return deleted


def cleanup_old_enrollment_audit(db: Session, days: int = 180) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM enrollment_audit WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "enrollment_audit")
    logger.info(f"Cleanup: deleted {deleted} enrollment audit records older than {days} days")
    return deleted


def cleanup_old_remote_support_connect_tokens(db: Session, days: int = 7) -> int:
    """Launch capabilities are useful only for audit correlation after expiry."""
    cutoff = datetime.utcnow() - timedelta(days=days)
    result = db.execute(
        text("DELETE FROM remote_support_connect_tokens WHERE created_at < :cutoff"),
        {"cutoff": cutoff},
    )
    db.commit()
    deleted = result.rowcount
    _vacuum_analyze(db, "remote_support_connect_tokens")
    logger.info(f"Cleanup: deleted {deleted} Remote Support connect tokens older than {days} days")
    return deleted
