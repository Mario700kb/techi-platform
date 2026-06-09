from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import text
from app.models.device_heartbeat import DeviceHeartbeat
import logging

logger = logging.getLogger(__name__)


def cleanup_old_heartbeats(db: Session, days: int = 7) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
    deleted = db.query(DeviceHeartbeat).filter(DeviceHeartbeat.created_at < cutoff).delete()
    db.commit()
    db.execute(text("VACUUM ANALYZE device_heartbeats"))
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
    db.execute(text("VACUUM ANALYZE device_telemetry"))
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
    db.execute(text("VACUUM ANALYZE device_activity_events"))
    logger.info(f"Cleanup: deleted {deleted} activity event records older than {days} days")
    return deleted
