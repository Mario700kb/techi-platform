from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import TYPE_CHECKING, List, Optional
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_, case, false, func, not_, or_

from app.models.alert import DeviceAlert
from app.models.device import Device, DeviceFreshnessState, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.models.device_heartbeat import DeviceHeartbeat
from app.models.device_status_history import DeviceStatusHistory
from app.models.device_telemetry import DeviceTelemetry
from app.schemas.device import DeviceCreate, DeviceUpdate

if TYPE_CHECKING:
    from app.core.scope import AllowedScope


class DeviceRepository:
    def __init__(self, db: Session):
        self.db = db

    def get(self, device_id: int) -> Optional[Device]:
        return self.db.query(Device).filter(Device.id == device_id).first()

    def get_by_rustdesk_id(self, rustdesk_id: Optional[str]) -> Optional[Device]:
        if not rustdesk_id:
            return None
        return self.db.query(Device).filter(Device.rustdesk_id == rustdesk_id).first()

    def get_by_agent_id(self, agent_id: Optional[str]) -> Optional[Device]:
        if not agent_id:
            return None
        return self.db.query(Device).filter(Device.agent_id == agent_id).first()

    def find_reenrollment_match(
        self,
        *,
        agent_id: Optional[str],
        rustdesk_id: Optional[str],
        hostname: Optional[str],
        local_ip: Optional[str],
        public_ip: Optional[str],
    ) -> Optional[Device]:
        match = self.get_by_agent_id(agent_id)
        if match:
            return match
        match = self.get_by_rustdesk_id(rustdesk_id)
        if match:
            return match
        normalized_hostname = (hostname or "").strip()
        if normalized_hostname and local_ip:
            match = (
                self.db.query(Device)
                .filter(Device.hostname == normalized_hostname, Device.local_ip == local_ip)
                .order_by(Device.id.desc())
                .first()
            )
            if match:
                return match
        if normalized_hostname and public_ip:
            return (
                self.db.query(Device)
                .filter(Device.hostname == normalized_hostname, Device.public_ip == public_ip)
                .order_by(Device.id.desc())
                .first()
            )
        return None

    def get_conflicting_rustdesk_id(self, rustdesk_id: Optional[str], *, exclude_device_id: Optional[int] = None) -> Optional[Device]:
        if not rustdesk_id:
            return None
        query = self.db.query(Device).filter(Device.rustdesk_id == rustdesk_id)
        if exclude_device_id is not None:
            query = query.filter(Device.id != exclude_device_id)
        return query.first()

    def get_online_stale(self, cutoff: datetime, limit: int = 500) -> List[Device]:
        return (
            self.db.query(Device)
            .filter(Device.status == DeviceStatus.ONLINE)
            .filter(or_(Device.last_seen.is_(None), Device.last_seen < cutoff))
            .order_by(
                case((Device.last_seen.is_(None), 0), else_=1),
                Device.last_seen.asc(),
                Device.id.asc(),
            )
            .limit(limit)
            .all()
        )

    def get_multi(
        self,
        skip: int = 0,
        limit: int = 100,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        freshness_state: Optional[DeviceFreshnessState] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        assignment_source: Optional[str] = None,
        lifecycle_state: Optional[str] = "active",
        search: Optional[str] = None,
        duplicate_candidates: Optional[bool] = None,
        maintenance_state: Optional[str] = None,
        smart_folder: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
    ) -> List[Device]:
        query = self.db.query(Device).options(joinedload(Device.client), joinedload(Device.group))

        if status:
            query = query.filter(Device.status == status)
        if device_type:
            query = query.filter(Device.device_type == device_type)
        query = self._apply_freshness_filter(query, freshness_state)
        if client_id == -1:
            query = query.filter(Device.client_id.is_(None))
        elif client_id:
            query = query.filter(Device.client_id == client_id)
        if group_id:
            query = query.filter(Device.group_id == group_id)
        query = self._apply_assignment_filter(query, assignment_source)
        query = self._apply_smart_folder_filter(query, smart_folder)
        query = self._apply_lifecycle_filter(query, lifecycle_state)
        if duplicate_candidates is True:
            query = query.filter(Device.duplicate_candidate.is_(True))
        query = self._apply_maintenance_filter(query, maintenance_state)
        if search:
            search_filter = or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.rustdesk_id.ilike(f"%{search}%"),
                Device.current_user.ilike(f"%{search}%"),
                Device.public_ip.ilike(f"%{search}%"),
                Device.local_ip.ilike(f"%{search}%"),
            )
            query = query.filter(search_filter)
        query = self._apply_scope_filter(query, scope)

        return query.order_by(Device.registered_at.desc(), Device.id.desc()).offset(skip).limit(limit).all()

    def _apply_maintenance_filter(self, query, maintenance_state: Optional[str]):
        if not maintenance_state:
            return query
        state = maintenance_state.strip().lower()
        if state == "maintenance":
            return query.filter(Device.is_in_maintenance.is_(True))
        if state == "normal":
            return query.filter(or_(Device.is_in_maintenance.is_(False), Device.is_in_maintenance.is_(None)))
        return query

    def _apply_lifecycle_filter(self, query, lifecycle_state: Optional[str]):
        state = (lifecycle_state or "active").strip().lower()
        if state == "all":
            return query
        if state == "archived":
            return query.filter(Device.is_archived.is_(True))
        return query.filter(or_(Device.is_archived.is_(False), Device.is_archived.is_(None)))

    def _apply_assignment_filter(self, query, assignment_source: Optional[str]):
        if not assignment_source:
            return query
        source = assignment_source.strip().lower()
        if source == "auto":
            return query.filter(Device.assignment_source.in_(["auto_os", "system_auto", "trusted_domain"]))
        if source == "system_auto":
            return query.filter(Device.assignment_source == "system_auto")
        if source == "manual":
            return query.filter(or_(Device.assignment_source.in_(["manual", "legacy_manual"]), and_(Device.assignment_source.is_(None), or_(Device.client_id.is_not(None), Device.group_id.is_not(None)))))
        if source in {"token", "enrollment"}:
            return query.filter(Device.assignment_source == "enrollment_token")
        if source == "unassigned":
            return query.filter(
                or_(
                    Device.assignment_source.in_(["unassigned", "system_auto_unassigned"]),
                    Device.assignment_source.is_(None),
                    and_(Device.client_id.is_(None), Device.group_id.is_(None)),
                )
            )
        return query.filter(Device.assignment_source == source)

    def _apply_smart_folder_filter(self, query, smart_folder: Optional[str]):
        if not smart_folder:
            return query
        key = smart_folder.strip().lower()
        server_group = Device.group.has(or_(DeviceGroup.name.ilike("servers"), DeviceGroup.name.ilike("server")))
        client_pc_group = Device.group.has(
            or_(
                DeviceGroup.name.ilike("client pc"),
                DeviceGroup.name.ilike("client pcs"),
                DeviceGroup.name.ilike("workstation"),
                DeviceGroup.name.ilike("workstations"),
            )
        )
        ungrouped = Device.group_id.is_(None)
        if key == "windows_server":
            return query.filter(
                or_(
                    server_group,
                    and_(
                        ungrouped,
                        or_(
                            Device.windows_product_type.in_([2, 3]),
                            Device.os_name.ilike("%windows server%"),
                            Device.os_version.ilike("%windows server%"),
                            Device.os_caption.ilike("%windows server%"),
                        ),
                    ),
                )
            )
        if key == "windows_workstation":
            return query.filter(
                or_(
                    client_pc_group,
                    and_(
                        ungrouped,
                        or_(Device.os_name.ilike("%windows%"), Device.platform.ilike("%windows%")),
                        or_(Device.os_name.is_(None), not_(Device.os_name.ilike("%windows server%"))),
                        or_(Device.os_version.is_(None), not_(Device.os_version.ilike("%windows server%"))),
                        or_(Device.os_caption.is_(None), not_(Device.os_caption.ilike("%windows server%"))),
                        or_(Device.windows_product_type.is_(None), Device.windows_product_type == 1),
                    ),
                )
            )
        if key == "laptop":
            return query.filter(or_(Device.hostname.ilike("%laptop%"), Device.group.has(name="laptop")))
        if key == "domain":
            return query.filter(and_(Device.domain.is_not(None), Device.domain != "", not_(Device.domain.ilike("%workgroup%"))))
        if key == "workgroup":
            return query.filter(or_(Device.domain.is_(None), Device.domain == "", Device.domain.ilike("%workgroup%")))
        if key == "unassigned":
            return query.filter(and_(Device.client_id.is_(None), Device.group_id.is_(None)))
        if key == "offline":
            return self._apply_freshness_filter(query, DeviceFreshnessState.OFFLINE)
        if key == "rustdesk_missing":
            return query.filter(Device.rustdesk_install_status.in_(["missing", "not_installed", "not installed", "absent", "unknown"]))
        return query

    def _apply_freshness_filter(self, query, freshness_state: Optional[DeviceFreshnessState]):
        if not freshness_state:
            return query
        now = utcnow()
        online_cutoff = now - timedelta(minutes=6)
        stale_cutoff = now - timedelta(minutes=25)
        if freshness_state == DeviceFreshnessState.ONLINE:
            return query.filter(Device.last_seen >= online_cutoff)
        if freshness_state == DeviceFreshnessState.STALE:
            return query.filter(and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff))
        if freshness_state == DeviceFreshnessState.OFFLINE:
            return query.filter(or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff))
        return query

    def create(self, obj_in: DeviceCreate) -> Device:
        db_obj = Device(**obj_in.model_dump())
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def update(self, db_obj: Device, obj_in: DeviceUpdate) -> Device:
        update_data = obj_in.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(db_obj, field, value)
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def archive(self, db_obj: Device, archived_by: Optional[str] = None) -> Device:
        db_obj.is_archived = True
        db_obj.archived_at = utcnow()
        db_obj.archived_by = archived_by
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def restore(self, db_obj: Device) -> Device:
        db_obj.is_archived = False
        db_obj.archived_at = None
        db_obj.archived_by = None
        self.db.add(db_obj)
        self.db.commit()
        self.db.refresh(db_obj)
        return db_obj

    def remove(self, device_id: int) -> Optional[Device]:
        obj = self.db.query(Device).get(device_id)
        if obj:
            self.db.delete(obj)
            self.db.commit()
        return obj

    def hard_delete(self, device_id: int) -> Optional[Device]:
        obj = self.get(device_id)
        if not obj:
            return None
        self.db.query(DeviceAlert).filter(DeviceAlert.device_id == device_id).delete(synchronize_session=False)
        self.db.query(DeviceTelemetry).filter(DeviceTelemetry.device_id == device_id).delete(synchronize_session=False)
        self.db.query(DeviceStatusHistory).filter(DeviceStatusHistory.device_id == device_id).delete(synchronize_session=False)
        self.db.query(DeviceHeartbeat).filter(DeviceHeartbeat.device_id == device_id).delete(synchronize_session=False)
        self.db.delete(obj)
        self.db.commit()
        return obj

    def clear_group(self, group_id: int) -> int:
        count = self.db.query(Device).filter(Device.group_id == group_id).count()
        self.db.query(Device).filter(Device.group_id == group_id).update({Device.group_id: None}, synchronize_session=False)
        self.db.commit()
        return count

    def count_by_group(self, group_id: int) -> int:
        return self.db.query(Device).filter(Device.group_id == group_id).count()

    def move_group_devices(self, source_group_id: int, target_group_id: int) -> int:
        count = self.count_by_group(source_group_id)
        self.db.query(Device).filter(Device.group_id == source_group_id).update(
            {Device.group_id: target_group_id},
            synchronize_session=False,
        )
        self.db.commit()
        return count

    def clear_client(self, client_id: int) -> int:
        count = self.db.query(Device).filter(Device.client_id == client_id).count()
        self.db.query(Device).filter(Device.client_id == client_id).update(
            {Device.client_id: None, Device.group_id: None},
            synchronize_session=False,
        )
        self.db.commit()
        return count

    def count(
        self,
        status: Optional[DeviceStatus] = None,
        device_type: Optional[DeviceType] = None,
        freshness_state: Optional[DeviceFreshnessState] = None,
        client_id: Optional[int] = None,
        group_id: Optional[int] = None,
        assignment_source: Optional[str] = None,
        lifecycle_state: Optional[str] = "active",
        search: Optional[str] = None,
        duplicate_candidates: Optional[bool] = None,
        maintenance_state: Optional[str] = None,
        smart_folder: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
    ) -> int:
        query = self.db.query(Device)

        if status:
            query = query.filter(Device.status == status)
        if device_type:
            query = query.filter(Device.device_type == device_type)
        query = self._apply_freshness_filter(query, freshness_state)
        if client_id == -1:
            query = query.filter(Device.client_id.is_(None))
        elif client_id:
            query = query.filter(Device.client_id == client_id)
        if group_id:
            query = query.filter(Device.group_id == group_id)
        query = self._apply_assignment_filter(query, assignment_source)
        query = self._apply_smart_folder_filter(query, smart_folder)
        query = self._apply_lifecycle_filter(query, lifecycle_state)
        if duplicate_candidates is True:
            query = query.filter(Device.duplicate_candidate.is_(True))
        query = self._apply_maintenance_filter(query, maintenance_state)
        if search:
            search_filter = or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.rustdesk_id.ilike(f"%{search}%"),
                Device.current_user.ilike(f"%{search}%"),
                Device.public_ip.ilike(f"%{search}%"),
                Device.local_ip.ilike(f"%{search}%"),
            )
            query = query.filter(search_filter)
        query = self._apply_scope_filter(query, scope)

        return query.count()

    def count_stats(self, scope: Optional["AllowedScope"] = None) -> dict:
        """Return total/online/stale/offline in one query instead of four."""
        now = utcnow()
        online_cutoff = now - timedelta(minutes=6)
        stale_cutoff = now - timedelta(minutes=25)
        q = self.db.query(
            func.count(Device.id).label("total"),
            func.count(case((Device.last_seen >= online_cutoff, 1))).label("online"),
            func.count(case((
                and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff), 1
            ))).label("stale"),
            func.count(case((
                or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff), 1
            ))).label("offline"),
        )
        q = self._apply_lifecycle_filter(q, "active")
        q = self._apply_scope_filter(q, scope)
        row = q.one()
        return {"total": row.total, "online": row.online, "stale": row.stale, "offline": row.offline}

    def _apply_scope_filter(self, query, scope: Optional["AllowedScope"]):
        """Restrict query to devices visible under *scope*.

        None = no restriction.  Empty scope = no devices.
        """
        if scope is None:
            return query
        filters = []
        if scope.client_ids:
            filters.append(Device.client_id.in_(list(scope.client_ids)))
        if scope.group_ids:
            filters.append(Device.group_id.in_(list(scope.group_ids)))
        if scope.device_ids:
            filters.append(Device.id.in_(list(scope.device_ids)))
        if not filters:
            return query.filter(false())   # no scope entries = nothing visible
        return query.filter(or_(*filters))
