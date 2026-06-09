from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from app.models.device_heartbeat import DeviceHeartbeat
import logging

logger = logging.getLogger(__name__)


def cleanup_old_heartbeats(db: Session, days: int = 7) -> int:
    cutoff = datetime.utcnow() - timedelta(days=days)
    deleted = db.query(DeviceHeartbeat).filter(DeviceHeartbeat.created_at < cutoff).delete()
    db.commit()
    logger.info(f"Cleanup: deleted {deleted} heartbeat records older than {days} days")
    return deleted
