"""Per-operator default Connect method (Section G).

Not global for every operator — every read/write is scoped to the acting
operator_id. See app.models.connect_preference.OperatorConnectPreference for
the resolution hierarchy this implements.
"""

from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.connect_preference import OperatorConnectPreference


class ConnectPreferenceService:
    def __init__(self, db: Session):
        self.db = db

    def _get(self, operator_id: int, platform: str, device_id: Optional[int]) -> Optional[OperatorConnectPreference]:
        return (
            self.db.query(OperatorConnectPreference)
            .filter(
                OperatorConnectPreference.operator_id == operator_id,
                OperatorConnectPreference.platform == platform,
                OperatorConnectPreference.device_id == device_id,
            )
            .first()
        )

    def get_preferred_method_id(
        self, operator_id: int, platform: str, device_id: Optional[int]
    ) -> Optional[str]:
        """Tiers 1-2 of the hierarchy only (device override, then platform
        default) — tiers 3-4 (registry priority / first Ready) are resolved
        by the caller, which already has the priority-ordered method list
        with readiness computed (this service has no Connect Framework
        knowledge)."""
        if device_id is not None:
            device_pref = self._get(operator_id, platform, device_id)
            if device_pref is not None:
                return device_pref.method_id
        platform_pref = self._get(operator_id, platform, None)
        return platform_pref.method_id if platform_pref is not None else None

    def set_preference(
        self, operator_id: int, platform: str, method_id: str, device_id: Optional[int] = None
    ) -> OperatorConnectPreference:
        existing = self._get(operator_id, platform, device_id)
        if existing is not None:
            existing.method_id = method_id
            self.db.commit()
            self.db.refresh(existing)
            return existing
        pref = OperatorConnectPreference(
            operator_id=operator_id, platform=platform, device_id=device_id, method_id=method_id,
        )
        self.db.add(pref)
        self.db.commit()
        self.db.refresh(pref)
        return pref

    def reset_preference(self, operator_id: int, platform: str, device_id: Optional[int] = None) -> bool:
        existing = self._get(operator_id, platform, device_id)
        if existing is None:
            return False
        self.db.delete(existing)
        self.db.commit()
        return True

    def list_preferences(self, operator_id: int) -> List[OperatorConnectPreference]:
        return (
            self.db.query(OperatorConnectPreference)
            .filter(OperatorConnectPreference.operator_id == operator_id)
            .order_by(OperatorConnectPreference.platform, OperatorConnectPreference.device_id)
            .all()
        )
