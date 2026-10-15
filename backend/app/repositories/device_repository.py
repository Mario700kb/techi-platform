from datetime import datetime, timedelta
from app.core.time import utcnow
from typing import TYPE_CHECKING, List, Mapping, Optional, Sequence
from sqlalchemy.orm import Session, aliased, defer, joinedload
from sqlalchemy import and_, case, false, func, not_, or_, select

from app.db.sql import id_in
from app.models.alert import DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceFreshnessState, DeviceStatus, DeviceType, freshness_for
from app.models.device_group import DeviceGroup
from app.models.device_heartbeat import DeviceHeartbeat
from app.models.device_inventory import DeviceInventory
from app.models.device_status_history import DeviceStatusHistory
from app.models.device_telemetry import DeviceTelemetry
from app.platform_core import classification as clf
from app.schemas.device import DeviceCreate, DeviceDirectoryEntry, DeviceTreeCounts, DeviceUpdate

if TYPE_CHECKING:
    from app.core.scope import AllowedScope

ONLINE_WINDOW = timedelta(minutes=6)
STALE_WINDOW = timedelta(minutes=25)

# Quick filters of the Devices page. Each one is a single SQL condition used
# both to filter the list and to count it, so a chip's number always equals
# the rows it opens. The health-derived ones read the cached health index.
QUICK_FILTERS = (
    "online", "stale", "offline", "servers", "workstations", "maintenance",
    "critical", "warnings", "healthy", "needs_updates", "reboot_required",
    "needs_attention", "low_health", "rustdesk_issues", "needs_agent_update",
)
HEALTH_INDEX_FILTERS = frozenset({
    "critical", "warnings", "healthy", "needs_updates", "reboot_required",
    "needs_attention", "low_health", "needs_agent_update",
})
SORT_KEYS = ("hostname", "client_name", "last_seen", "health")
LOW_HEALTH_SCORE = 60


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
        active_agent_version: Optional[str] = None,
        active_agent_sha256: Optional[str] = None,
        platform: Optional[str] = None,
        category: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
        quick_filter: Optional[str] = None,
        health_index: Optional[Mapping] = None,
        device_ids: Optional[Sequence[int]] = None,
        agent_version: Optional[str] = None,
        hide_offline_days: Optional[int] = None,
        location_ids: Optional[Sequence[int]] = None,
        sort: Optional[str] = None,
        order: Optional[str] = None,
    ) -> List[Device]:
        query = self._filtered_query(
            self.db.query(Device),
            status=status, device_type=device_type, freshness_state=freshness_state,
            client_id=client_id, group_id=group_id, assignment_source=assignment_source,
            lifecycle_state=lifecycle_state, search=search, duplicate_candidates=duplicate_candidates,
            maintenance_state=maintenance_state, smart_folder=smart_folder,
            active_agent_version=active_agent_version, active_agent_sha256=active_agent_sha256,
            platform=platform, category=category, scope=scope, quick_filter=quick_filter,
            health_index=health_index, device_ids=device_ids, agent_version=agent_version,
            hide_offline_days=hide_offline_days, location_ids=location_ids,
        )
        descending = (order or "asc").strip().lower() == "desc"
        sort_key = (sort or "").strip().lower()

        if sort_key == "health" and health_index is not None:
            # The score is computed in Python, so rank the matching ids here
            # and page over that ranking; ties fall back to the id.
            ids = [row[0] for row in query.with_entities(Device.id).all()]
            ids.sort(key=lambda device_id: (_score(health_index, device_id), device_id), reverse=descending)
            page = ids[skip: skip + limit]
            if not page:
                return []
            rows = (
                self.db.query(Device)
                .options(joinedload(Device.client), joinedload(Device.group))
                .filter(Device.id.in_(page))
                .all()
            )
            position = {device_id: i for i, device_id in enumerate(page)}
            return sorted(rows, key=lambda device: position[device.id])

        if sort_key == "hostname":
            name = func.lower(func.coalesce(func.nullif(func.trim(Device.display_name), ""), Device.hostname, ""))
            ordering = [name.desc() if descending else name.asc(), Device.id.asc()]
        elif sort_key == "client_name":
            query = query.outerjoin(Client, Device.client_id == Client.id)
            client_name = func.lower(func.coalesce(Client.name, ""))
            ordering = [client_name.desc() if descending else client_name.asc(), Device.id.asc()]
        elif sort_key == "last_seen":
            ordering = [
                Device.last_seen.desc().nullslast() if descending else Device.last_seen.asc().nullsfirst(),
                Device.id.asc(),
            ]
        else:
            ordering = [Device.registered_at.desc(), Device.id.desc()]

        return (
            query.options(joinedload(Device.client), joinedload(Device.group))
            .order_by(*ordering)
            .offset(skip)
            .limit(limit)
            .all()
        )

    def _filtered_query(
        self,
        query,
        *,
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
        active_agent_version: Optional[str] = None,
        active_agent_sha256: Optional[str] = None,
        platform: Optional[str] = None,
        category: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
        quick_filter: Optional[str] = None,
        health_index: Optional[Mapping] = None,
        device_ids: Optional[Sequence[int]] = None,
        agent_version: Optional[str] = None,
        hide_offline_days: Optional[int] = None,
        location_ids: Optional[Sequence[int]] = None,
        group_join: bool = False,
    ):
        if group_join or self._needs_group_join(category, smart_folder) or quick_filter in ("servers", "workstations"):
            query = self._ensure_group_join(query)

        if status:
            query = query.filter(Device.status == status)
        if device_type:
            query = query.filter(Device.device_type == device_type)
        query = self._apply_platform_filter(query, platform)
        query = self._apply_category_filter(query, category)
        query = self._apply_freshness_filter(query, freshness_state)
        if client_id == -1:
            query = query.filter(Device.client_id.is_(None))
        elif client_id:
            query = query.filter(Device.client_id == client_id)
        if group_id:
            query = query.filter(Device.group_id == group_id)
        query = self._apply_assignment_filter(query, assignment_source)
        query = self._apply_smart_folder_filter(query, smart_folder)
        query = self._apply_agent_update_filter(query, active_agent_version, active_agent_sha256)
        query = self._apply_lifecycle_filter(query, lifecycle_state)
        if duplicate_candidates is True:
            query = query.filter(Device.duplicate_candidate.is_(True))
        query = self._apply_maintenance_filter(query, maintenance_state)
        if search:
            search_filter = or_(
                Device.hostname.ilike(f"%{search}%"),
                Device.display_name.ilike(f"%{search}%"),
                Device.rustdesk_id.ilike(f"%{search}%"),
                Device.current_user.ilike(f"%{search}%"),
                Device.public_ip.ilike(f"%{search}%"),
                Device.local_ip.ilike(f"%{search}%"),
            )
            query = query.filter(search_filter)
        if device_ids is not None:
            query = query.filter(Device.id.in_(list(device_ids)) if device_ids else false())
        if agent_version:
            if agent_version.strip().lower() == "unknown":
                query = query.filter(or_(Device.agent_version.is_(None), Device.agent_version == ""))
            else:
                query = query.filter(Device.agent_version == agent_version)
        if hide_offline_days:
            query = query.filter(Device.last_seen >= utcnow() - timedelta(days=hide_offline_days))
        if location_ids is not None:
            # An Explorer location (one id) or city (several); -1 is "no location".
            wanted = [i for i in location_ids if i > 0]
            clauses = [Device.location_id.in_(wanted)] if wanted else []
            if -1 in location_ids:
                clauses.append(Device.location_id.is_(None))
            query = query.filter(or_(*clauses) if clauses else false())
        if quick_filter:
            query = query.filter(self.quick_filter_clause(quick_filter, health_index or {}))
        return self._apply_scope_filter(query, scope)

    def quick_filter_clause(self, key: str, health_index: Mapping):
        now = utcnow()
        online_cutoff = now - ONLINE_WINDOW
        stale_cutoff = now - STALE_WINDOW
        is_online = Device.last_seen >= online_cutoff

        dialect = self.db.get_bind().dialect.name

        def ids_where(predicate):
            ids = [device_id for device_id, entry in health_index.items() if predicate(entry)]
            return id_in(Device.id, ids, dialect) if ids else false()

        if key == "online":
            return is_online
        if key == "stale":
            return and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff)
        if key == "offline":
            return or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff)
        if key == "servers":
            return clf.category_case() == clf.CATEGORY_SERVERS
        if key == "workstations":
            return clf.category_case() == clf.CATEGORY_CLIENTPC
        if key == "maintenance":
            return Device.is_in_maintenance.is_(True)
        if key == "critical":
            return ids_where(lambda e: e.state == "critical")
        if key == "warnings":
            return ids_where(lambda e: e.state == "warning")
        if key == "healthy":
            return ids_where(lambda e: e.state == "healthy")
        if key == "needs_updates":
            # Pending updates or a pending reboot: the dashboard's "Needs
            # updates" tile counts the same set, so the tile opens its rows.
            return ids_where(lambda e: e.has_pending_patches)
        if key == "reboot_required":
            return ids_where(lambda e: e.patch_state == "reboot_required")
        if key == "low_health":
            return ids_where(lambda e: e.score < LOW_HEALTH_SCORE)
        if key == "needs_attention":
            return or_(
                Device.last_seen.is_(None),
                Device.last_seen < online_cutoff,
                ids_where(lambda e: e.critical_alerts > 0 or e.score < LOW_HEALTH_SCORE),
            )
        if key == "rustdesk_issues":
            return and_(
                or_(Device.rustdesk_install_status.is_(None), Device.rustdesk_install_status != "not_installed"),
                func.coalesce(Device.rustdesk_status, "") != "running",
            )
        if key == "needs_agent_update":
            return ids_where(lambda e: e.agent_outdated)
        raise ValueError(f"Unknown quick filter: {key}")

    def count_quick_filters(self, health_index: Mapping, **filters) -> dict:
        """Count every quick filter over the same base filters in one query."""
        query = self._filtered_query(self.db.query(Device), group_join=True, health_index=health_index, **filters)
        columns = [func.count(Device.id)] + [
            func.count(case((self.quick_filter_clause(key, health_index), 1))) for key in QUICK_FILTERS
        ]
        row = query.with_entities(*columns).one()
        return {"all": row[0], **dict(zip(QUICK_FILTERS, row[1:]))}

    def agent_version_counts(self, **filters) -> dict:
        query = self._filtered_query(self.db.query(Device), **filters)
        rows = (
            query.with_entities(Device.agent_version, func.count(Device.id))
            .group_by(Device.agent_version)
            .all()
        )
        counts: dict = {}
        for version, count in rows:
            key = version or "unknown"
            counts[key] = counts.get(key, 0) + count
        return counts

    def _apply_agent_update_filter(
        self,
        query,
        active_agent_version: Optional[str],
        active_agent_sha256: Optional[str] = None,
    ):
        if not active_agent_version:
            return query
        filters = [Device.agent_version.is_(None), Device.agent_version != active_agent_version]
        if active_agent_sha256:
            filters.extend([Device.agent_sha256.is_(None), Device.agent_sha256 != active_agent_sha256.lower()])
        return query.filter(or_(*filters))

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

    def _apply_platform_filter(self, query, platform: Optional[str]):
        """Additive platform filter via the Unified Classification Engine — the
        single platform definition. "windows" matches NULL/unknown platforms too
        (absence ⇒ windows, audit §8)."""
        if not platform:
            return query
        return query.filter(clf.platform_case() == platform.strip().lower())

    def _apply_category_filter(self, query, category: Optional[str]):
        """Additive tree-category filter via the Unified Classification Engine —
        the SAME expression the tree counts use, so a node's filtered result
        always equals its count badge (client AND category AND platform).
        Requires the caller to have outer-joined DeviceGroup (see
        `_ensure_group_join`)."""
        if not category:
            return query
        return query.filter(clf.category_case() == category.strip().lower())

    @staticmethod
    def _needs_group_join(category: Optional[str], smart_folder: Optional[str]) -> bool:
        """The category engine + the server/client smart folders read the group
        name, so the query must outer-join DeviceGroup for them."""
        if category:
            return True
        return (smart_folder or "").strip().lower() in ("windows_server", "windows_workstation")

    @staticmethod
    def _ensure_group_join(query):
        return query.outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)

    def _apply_smart_folder_filter(self, query, smart_folder: Optional[str]):
        if not smart_folder:
            return query
        key = smart_folder.strip().lower()
        # The Servers / Client PC smart folders are the SAME category as the tree:
        # route them through the Unified Classification Engine (keys kept for
        # back-compat with saved views / API callers). Requires the DeviceGroup
        # outer-join (added by the caller via _ensure_group_join).
        if key == "windows_server":
            return query.filter(clf.category_case() == clf.CATEGORY_SERVERS)
        if key == "windows_workstation":
            return query.filter(clf.category_case() == clf.CATEGORY_CLIENTPC)
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
            {Device.client_id: None, Device.group_id: None, Device.location_id: None, Device.location_source: None},
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
        active_agent_version: Optional[str] = None,
        active_agent_sha256: Optional[str] = None,
        platform: Optional[str] = None,
        category: Optional[str] = None,
        scope: Optional["AllowedScope"] = None,
        quick_filter: Optional[str] = None,
        health_index: Optional[Mapping] = None,
        device_ids: Optional[Sequence[int]] = None,
        agent_version: Optional[str] = None,
        hide_offline_days: Optional[int] = None,
        location_ids: Optional[Sequence[int]] = None,
    ) -> int:
        return self._filtered_query(
            self.db.query(Device),
            status=status, device_type=device_type, freshness_state=freshness_state,
            client_id=client_id, group_id=group_id, assignment_source=assignment_source,
            lifecycle_state=lifecycle_state, search=search, duplicate_candidates=duplicate_candidates,
            maintenance_state=maintenance_state, smart_folder=smart_folder,
            active_agent_version=active_agent_version, active_agent_sha256=active_agent_sha256,
            platform=platform, category=category, scope=scope, quick_filter=quick_filter,
            health_index=health_index, device_ids=device_ids, agent_version=agent_version,
            hide_offline_days=hide_offline_days, location_ids=location_ids,
        ).count()

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

    def count_by_client(self, scope: Optional["AllowedScope"] = None) -> DeviceTreeCounts:
        """Fast GROUP BY aggregation for the Device Tree sidebar. No telemetry/health loaded."""
        q = self.db.query(
            Device.client_id,
            func.count(Device.id).label("cnt"),
        )
        q = self._apply_lifecycle_filter(q, "active")
        q = self._apply_scope_filter(q, scope)
        rows = q.group_by(Device.client_id).all()

        total = 0
        unassigned = 0
        by_client: dict[int, int] = {}
        for client_id, cnt in rows:
            total += cnt
            if client_id is None:
                unassigned += cnt
            else:
                by_client[client_id] = cnt

        return DeviceTreeCounts(total=total, unassigned=unassigned, by_client=by_client)

    def directory(self, scope: Optional["AllowedScope"] = None) -> List[DeviceDirectoryEntry]:
        """Every active device with only what a picker needs: no telemetry,
        inventory or assignment resolution, so the fleet comes back in one
        small response instead of megabytes of full device rows."""
        q = self.db.query(Device.id, Device.hostname, Device.rustdesk_id, Device.client_id, Device.group_id, Device.last_seen)
        q = self._apply_lifecycle_filter(q, "active")
        q = self._apply_scope_filter(q, scope)
        return [
            DeviceDirectoryEntry(id=row.id, hostname=row.hostname, rustdesk_id=row.rustdesk_id, client_id=row.client_id, group_id=row.group_id, freshness_state=freshness_for(row.last_seen))
            for row in q.order_by(Device.hostname, Device.id).all()
        ]

    def count_by_client_category_platform(
        self, scope: Optional["AllowedScope"] = None
    ) -> dict[int, dict[str, dict[str, int]]]:
        """Additive tree aggregation: {client_id: {category: {platform: total}}}.
        A separate lightweight GROUP BY — it does NOT touch get_fleet_counts
        (the sacred Windows path)."""
        category = clf.category_case()
        platform_class = clf.platform_case()
        q = self.db.query(
            Device.client_id,
            category,
            platform_class,
            func.count(Device.id).label("total"),
        ).outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
        q = self._apply_lifecycle_filter(q, "active")
        q = self._apply_scope_filter(q, scope)
        rows = q.group_by(Device.client_id, category, platform_class).all()

        result: dict[int, dict[str, dict[str, int]]] = {}
        for client_id, cat, plat, total in rows:
            if client_id is None:
                continue
            result.setdefault(client_id, {}).setdefault(cat, {})[plat] = total
        return result

    def location_stats(self, client_id: int, known_location_ids, scope: Optional["AllowedScope"] = None):
        """One client's devices per location (None: at no location of its own):
        rows of (location_id, total, online, stale, offline, servers, clientpc,
        placed by hand)."""
        now = utcnow()
        online_cutoff = now - ONLINE_WINDOW
        stale_cutoff = now - STALE_WINDOW
        category = clf.category_case()
        location = case((Device.location_id.in_(list(known_location_ids)), Device.location_id), else_=None)
        q = (
            self.db.query(
                location,
                func.count(Device.id),
                func.count(case((Device.last_seen >= online_cutoff, 1))),
                func.count(case((and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff), 1))),
                func.count(case((or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff), 1))),
                func.count(case((category == clf.CATEGORY_SERVERS, 1))),
                func.count(case((category == clf.CATEGORY_CLIENTPC, 1))),
                func.count(case((Device.location_source == "manual", 1))),
            )
            .outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
            .filter(Device.client_id == client_id, Device.is_archived.is_(False))
        )
        q = self._apply_scope_filter(q, scope)
        return q.group_by(location).all()

    def count_by_client_location(self, scope: Optional["AllowedScope"] = None):
        """Explorer counts for client sites: rows of (client_id, location_id or
        None, category, platform, total, online, stale, offline). A location of
        another client (the device moved) counts as no location."""
        from app.models.client_location import ClientLocation

        now = utcnow()
        online_cutoff = now - ONLINE_WINDOW
        stale_cutoff = now - STALE_WINDOW
        category = clf.category_case()
        platform_class = clf.platform_case()
        location = case((ClientLocation.client_id == Device.client_id, Device.location_id), else_=None)
        q = (
            self.db.query(
                Device.client_id,
                location,
                category,
                platform_class,
                func.count(Device.id),
                func.count(case((Device.last_seen >= online_cutoff, 1))),
                func.count(case((and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff), 1))),
                func.count(case((or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff), 1))),
            )
            .outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
            .outerjoin(ClientLocation, ClientLocation.id == Device.location_id)
            .filter(Device.client_id.isnot(None))
        )
        q = self._apply_lifecycle_filter(q, "active")
        q = self._apply_scope_filter(q, scope)
        return q.group_by(Device.client_id, location, category, platform_class).all()

    def get_fleet_counts(self, scope: Optional["AllowedScope"] = None):
        """Active-device totals per client and category, by freshness."""
        now = utcnow()
        online_cutoff = now - ONLINE_WINDOW
        stale_cutoff = now - STALE_WINDOW
        category = clf.category_case()

        counts_query = self.db.query(
            Device.client_id,
            category,
            func.count(Device.id).label("total"),
            func.count(case((Device.last_seen >= online_cutoff, 1))).label("online"),
            func.count(case((
                and_(Device.last_seen >= stale_cutoff, Device.last_seen < online_cutoff), 1
            ))).label("stale"),
            func.count(case((
                or_(Device.last_seen.is_(None), Device.last_seen < stale_cutoff), 1
            ))).label("offline"),
        ).outerjoin(DeviceGroup, Device.group_id == DeviceGroup.id)
        counts_query = self._apply_lifecycle_filter(counts_query, "active")
        counts_query = self._apply_scope_filter(counts_query, scope)
        return counts_query.group_by(Device.client_id, category).all()

    def get_health_inputs(self, scope: Optional["AllowedScope"] = None):
        """Every device in scope, archived included, with its latest telemetry,
        inventory and open alert counts — one row per (device, alert severity).
        The large inventory snapshots are never loaded: scoring reads only the
        patch status and the collection time."""
        # Newest telemetry row per device by one index probe on
        # (device_id, created_at DESC). A max(id) GROUP BY over the whole
        # table read ~1.1M rows on every call: 1.8 s measured in production,
        # 136 ms this way.
        newer = aliased(DeviceTelemetry)
        latest_telemetry_id = (
            select(newer.id)
            .where(newer.device_id == Device.id)
            .order_by(newer.created_at.desc())
            .limit(1)
            .correlate(Device)
            .scalar_subquery()
        )
        alert_counts = (
            self.db.query(
                DeviceAlert.device_id.label("device_id"),
                DeviceAlert.severity.label("severity"),
                func.count(DeviceAlert.id).label("count"),
            )
            .filter(DeviceAlert.state == "open")
            .group_by(DeviceAlert.device_id, DeviceAlert.severity)
            .subquery()
        )
        health_query = (
            self.db.query(
                Device,
                DeviceTelemetry,
                DeviceInventory,
                alert_counts.c.severity,
                alert_counts.c.count,
            )
            # Explicit: the ON clause no longer names Device directly, so the
            # join's left side cannot be inferred from it.
            .select_from(Device)
            .outerjoin(DeviceTelemetry, DeviceTelemetry.id == latest_telemetry_id)
            .outerjoin(DeviceInventory, DeviceInventory.device_id == Device.id)
            .outerjoin(alert_counts, alert_counts.c.device_id == Device.id)
            .options(
                defer(DeviceInventory.processes_json),
                defer(DeviceInventory.services_json),
                defer(DeviceInventory.software_json),
            )
        )
        return self._apply_scope_filter(health_query, scope).all()

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


def _score(health_index: Mapping, device_id: int) -> int:
    entry = health_index.get(device_id)
    return entry.score if entry is not None else 100
