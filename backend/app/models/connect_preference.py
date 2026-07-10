from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint

from app.core.time import utcnow
from app.db.base import Base


class OperatorConnectPreference(Base):
    """Per-operator default Connect method (Section G). Two rows shapes share
    one table, distinguished by whether `device_id` is set:
      - device_id IS NULL  -> per operator+platform default ("always use
        Winbox for MikroTik").
      - device_id IS NOT NULL -> per operator+device override (highest
        precedence — a specific device's default beats the platform default).

    Resolution hierarchy (ConnectPreferenceService.get_preferred_method):
      1. operator + device override
      2. operator + platform default
      3. Connect Framework registry priority (first method, already priority-
         sorted by methods_for())
      4. first Ready method (registry priority's pick wasn't actually usable)

    Deliberately NOT global-for-every-operator (mission requirement) — always
    scoped to operator_id.
    """

    __tablename__ = "operator_connect_preferences"
    __table_args__ = (
        UniqueConstraint("operator_id", "platform", "device_id", name="uq_connect_pref_operator_platform_device"),
    )

    id = Column(Integer, primary_key=True, index=True)
    operator_id = Column(Integer, ForeignKey("operators.id"), nullable=False, index=True)
    platform = Column(String(32), nullable=False, index=True)
    device_id = Column(Integer, ForeignKey("devices.id"), nullable=True, index=True)
    method_id = Column(String(32), nullable=False)
    created_at = Column(DateTime, default=utcnow, nullable=False)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
