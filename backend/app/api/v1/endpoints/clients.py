import re
from datetime import timedelta
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role, require_team_permission
from app.core.time import utcnow
from app.core.scope import AllowedScope
from app.db.session import get_db
from app.models.client_document import ClientDocument
from app.models.client_location import ClientLocation, ClientLocationRule
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.operator import Operator, OperatorRole
from app.repositories.alert_repository import AlertRepository
from app.repositories.audit_log_repository import AuditLogRepository
from app.repositories.device_repository import DeviceRepository
from app.schemas.alert import AlertCountResponse
from app.schemas.client_document import (
    ClientDocumentCreate,
    ClientDocumentOut,
    ClientDocumentSummary,
    ClientDocumentUpdate,
)
from app.schemas.client_location import (
    DeviceLocationAssign,
    LocationApplyResult,
    LocationCreate,
    LocationList,
    LocationOut,
    LocationSuggestion,
    LocationUpdate,
)
from app.schemas.client import (
    Client,
    ClientActivityDevice,
    ClientActivityOperator,
    ClientActivityPage,
    ClientActivitySummary,
    ClientCreate,
    ClientProfile,
    ClientProfileGroup,
    ClientUpdate,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.client_service import ClientService
from app.services.device_overview_service import DeviceOverviewService
from app.services.location_service import LocationService
from app.services.operator_scope_service import OperatorScopeService
from app.services.permission_service import MANAGE_CLIENTS

router = APIRouter()

_require_manage_clients = require_team_permission(MANAGE_CLIENTS)


@router.get("", response_model=List[Client])
def list_clients(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    all_clients = ClientService(db).list_clients()
    if scope is None:
        return all_clients
    visible_ids = OperatorScopeService(db).get_visible_client_ids(scope)
    return [c for c in all_clients if c.id in visible_ids]


@router.post("", response_model=Client)
def create_client(
    payload: ClientCreate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        return ClientService(db).create_client(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{client_id}", response_model=Client)
def get_client(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    client = ClientService(db).get_client(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    if scope is not None:
        visible_ids = OperatorScopeService(db).get_visible_client_ids(scope)
        if client.id not in visible_ids:
            raise HTTPException(status_code=404, detail="Client not found")
    return client


def _client_in_scope(db: Session, scope: Optional[AllowedScope], client_id: int):
    client = ClientService(db).get_client(client_id)
    narrowed = OperatorScopeService(db).scope_for_client(scope, client_id) if client else None
    if narrowed is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return client, narrowed


@router.get("/{client_id}/profile", response_model=ClientProfile)
def get_client_profile(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Header and Overview of the client profile: devices by status and
    category, open alerts, health, updates and groups, within the operator's
    view of the client."""
    client, narrowed = _client_in_scope(db, scope, client_id)
    overview = DeviceOverviewService(db).get_overview(narrowed)
    alerts = AlertRepository(db).open_counts(narrowed)
    devices = DeviceRepository(db)._apply_scope_filter(
        db.query(Device).filter(Device.client_id == client_id, Device.is_archived.is_(False)), narrowed
    )
    group_rows = (
        devices.join(DeviceGroup, DeviceGroup.id == Device.group_id)
        .with_entities(DeviceGroup.id, DeviceGroup.name, func.count(Device.id))
        .group_by(DeviceGroup.id, DeviceGroup.name)
        .order_by(DeviceGroup.name)
        .all()
    )
    last_seen = devices.with_entities(func.max(Device.last_seen)).scalar()
    return ClientProfile(
        client=client,
        stats=overview.stats,
        by_category=overview.tree_counts.by_category,
        alerts=AlertCountResponse(
            total_open=alerts["total"],
            by_severity=alerts["by_severity"],
            by_kind=alerts["by_kind"],
            devices_affected=alerts["devices_affected"],
            oldest_open_at=alerts["oldest_open_at"],
        ),
        average_health=overview.average_health,
        health_critical=overview.critical,
        health_warning=overview.warnings,
        needs_updates=overview.needs_updates,
        agents_outdated=overview.agents_outdated,
        groups=[ClientProfileGroup(id=g_id, name=name, devices=count) for g_id, name, count in group_rows],
        last_seen=last_seen,
    )


# What each Activity filter on the client profile shows.
ACTIVITY_KINDS = {
    "remote": ["remote_connect", "remote_session_started", "remote_session_ended", "remote_support_alarm"],
    "terminal": [
        "terminal_session_opened",
        "terminal_session_closed",
        "terminal_session_denied",
        "terminal_session_expired",
        "ssh_session_started",
        "ssh_session_ended",
        "ssh_connection_failed",
        "ssh_authentication_failed",
    ],
    "actions": [
        "action_queued",
        "action_cancelled",
        "maintenance_entered",
        "maintenance_cleared",
        "note_created",
        "note_updated",
        "note_deleted",
    ],
    "credentials": ["vault_credential_revealed", "vault_credential_assigned", "ssh_credential_resolved"],
}
SESSION_DURATION_ACTIONS = ["terminal_session_closed", "ssh_session_ended", "remote_session_ended"]


def _activity_device_ids(db: Session, scope, client_id: int) -> Optional[List[int]]:
    """None when the operator sees the whole client, else the devices they see in it."""
    _, narrowed = _client_in_scope(db, scope, client_id)
    if client_id in narrowed.client_ids:
        return None
    return [
        row[0]
        for row in DeviceRepository(db)
        ._apply_scope_filter(db.query(Device.id).filter(Device.client_id == client_id), narrowed)
        .all()
    ]


def _device_names(db: Session, ids) -> dict:
    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    rows = db.query(Device.id, Device.display_name, Device.hostname).filter(Device.id.in_(ids)).all()
    return {device_id: display or hostname for device_id, display, hostname in rows}


@router.get("/{client_id}/activity/summary", response_model=ClientActivitySummary)
def get_client_activity_summary(
    client_id: int,
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Remote connections, operators, most-reached devices and session time
    for the client over the last `days`, within the operator's view."""
    device_ids = _activity_device_ids(db, scope, client_id)
    since = utcnow() - timedelta(days=days)
    summary = AuditLogRepository(db).client_summary(
        client_id,
        device_ids,
        since,
        remote_action=AuditAction.REMOTE_CONNECT,
        duration_actions=SESSION_DURATION_ACTIONS,
    )
    names = _device_names(db, (d["device_id"] for d in summary["devices"]))
    return ClientActivitySummary(
        days=days,
        since=since,
        **{k: v for k, v in summary.items() if k not in ("operators", "devices")},
        operators=[ClientActivityOperator(**o) for o in summary["operators"]],
        devices=[
            ClientActivityDevice(name=names.get(d["device_id"], f"Device #{d['device_id']}"), **d)
            for d in summary["devices"]
        ],
    )


@router.get("/{client_id}/activity", response_model=ClientActivityPage)
def get_client_activity(
    client_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    kind: Literal["all", "remote", "terminal", "actions", "credentials"] = Query(default="all"),
    operator: Optional[str] = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Audit entries about the client or its devices (connections, actions,
    terminal sessions, credential use…), newest first; `kind` and `operator`
    narrow the list."""
    device_ids = _activity_device_ids(db, scope, client_id)
    total, items = AuditLogRepository(db).for_client(
        client_id,
        device_ids,
        limit,
        offset,
        actions=ACTIVITY_KINDS.get(kind),
        operator_username=operator or None,
    )
    names = _device_names(db, (item.device_id for item in items))
    return ClientActivityPage(total=total, items=items, device_names=names)


def _excerpt(body: str) -> str:
    text = re.sub(r"^\s*(?:[-*+]|\d+\.)\s+", "", body, flags=re.MULTILINE)
    text = re.sub(r"[#>*_`|~\[\]()]+|-{3,}", " ", text)
    return " ".join(text.split())[:160]


def _document_summary(doc: ClientDocument) -> ClientDocumentSummary:
    return ClientDocumentSummary.model_validate(doc).model_copy(update={"excerpt": _excerpt(doc.body)})


def _document(db: Session, client_id: int, document_id: int) -> ClientDocument:
    doc = (
        db.query(ClientDocument)
        .filter(ClientDocument.id == document_id, ClientDocument.client_id == client_id)
        .first()
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.get("/{client_id}/documents", response_model=List[ClientDocumentSummary])
def list_client_documents(
    client_id: int,
    q: Optional[str] = Query(default=None, max_length=100),
    category: Optional[str] = Query(default=None, max_length=40),
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """The client's documentation pages, pinned first, then most recently edited."""
    _client_in_scope(db, scope, client_id)
    query = db.query(ClientDocument).filter(ClientDocument.client_id == client_id)
    if category:
        query = query.filter(ClientDocument.category == category)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.filter(or_(ClientDocument.title.ilike(like), ClientDocument.body.ilike(like)))
    docs = query.order_by(ClientDocument.pinned.desc(), ClientDocument.updated_at.desc()).all()
    return [_document_summary(doc) for doc in docs]


@router.get("/{client_id}/documents/{document_id}", response_model=ClientDocumentOut)
def get_client_document(
    client_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _client_in_scope(db, scope, client_id)
    doc = _document(db, client_id, document_id)
    return ClientDocumentOut.model_validate(doc).model_copy(update={"excerpt": _excerpt(doc.body)})


@router.post("/{client_id}/documents", response_model=ClientDocumentOut, status_code=201)
def create_client_document(
    client_id: int,
    payload: ClientDocumentCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _client_in_scope(db, scope, client_id)
    now = utcnow()
    doc = ClientDocument(
        client_id=client_id,
        title=payload.title.strip(),
        category=payload.category,
        body=payload.body,
        pinned=payload.pinned,
        created_by=operator.username,
        updated_by=operator.username,
        created_at=now,
        updated_at=now,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    audit_log(db, operator=operator, action=AuditAction.CLIENT_DOCUMENT_CREATED, entity_type="client_document",
              entity_id=doc.id, details={"client_id": client_id, "title": doc.title})
    return ClientDocumentOut.model_validate(doc).model_copy(update={"excerpt": _excerpt(doc.body)})


@router.put("/{client_id}/documents/{document_id}", response_model=ClientDocumentOut)
def update_client_document(
    client_id: int,
    document_id: int,
    payload: ClientDocumentUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _client_in_scope(db, scope, client_id)
    doc = _document(db, client_id, document_id)
    changes = payload.model_dump(exclude_unset=True)
    if "title" in changes:
        changes["title"] = changes["title"].strip()
    for field, value in changes.items():
        setattr(doc, field, value)
    doc.updated_by = operator.username
    doc.updated_at = utcnow()
    db.commit()
    db.refresh(doc)
    audit_log(db, operator=operator, action=AuditAction.CLIENT_DOCUMENT_UPDATED, entity_type="client_document",
              entity_id=doc.id, details={"client_id": client_id, "title": doc.title, "fields": sorted(changes)})
    return ClientDocumentOut.model_validate(doc).model_copy(update={"excerpt": _excerpt(doc.body)})


@router.delete("/{client_id}/documents/{document_id}", status_code=204)
def delete_client_document(
    client_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _client_in_scope(db, scope, client_id)
    doc = _document(db, client_id, document_id)
    title = doc.title
    db.delete(doc)
    db.commit()
    audit_log(db, operator=operator, action=AuditAction.CLIENT_DOCUMENT_DELETED, entity_type="client_document",
              entity_id=document_id, details={"client_id": client_id, "title": title})
    return Response(status_code=204)


# ─── Locations ──────────────────────────────────────────────────────────────


def _location(db: Session, client_id: int, location_id: int) -> ClientLocation:
    location = db.query(ClientLocation).filter(
        ClientLocation.id == location_id, ClientLocation.client_id == client_id
    ).first()
    if location is None:
        raise HTTPException(status_code=404, detail="Location not found")
    return location


def _location_out(db: Session, client_id: int, location_id: int, scope) -> LocationOut:
    listing = LocationService(db).listing(client_id, scope)
    return next(item for item in listing.locations if item.id == location_id)


def _check_unique_name(db: Session, client_id: int, name: str, exclude_id: Optional[int] = None) -> None:
    query = db.query(ClientLocation.id).filter(
        ClientLocation.client_id == client_id, func.lower(ClientLocation.name) == name.lower()
    )
    if exclude_id is not None:
        query = query.filter(ClientLocation.id != exclude_id)
    if query.first():
        raise HTTPException(status_code=409, detail="This client already has a location with that name")


@router.get("/{client_id}/locations", response_model=LocationList)
def list_client_locations(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """The client's sites with the devices at each, and the devices at none."""
    _, narrowed = _client_in_scope(db, scope, client_id)
    return LocationService(db).listing(client_id, narrowed)


@router.get("/{client_id}/locations/suggestions", response_model=List[LocationSuggestion])
def suggest_client_locations(
    client_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Public IPs that several of the client's unlocated devices share."""
    _, narrowed = _client_in_scope(db, scope, client_id)
    return LocationService(db).suggestions(client_id, narrowed)


@router.post("/{client_id}/locations", response_model=LocationOut, status_code=201)
def create_client_location(
    client_id: int,
    payload: LocationCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_manage_clients),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _, narrowed = _client_in_scope(db, scope, client_id)
    _check_unique_name(db, client_id, payload.name)
    now = utcnow()
    location = ClientLocation(
        client_id=client_id,
        **payload.model_dump(exclude={"rules"}),
        created_by=operator.username,
        updated_by=operator.username,
        created_at=now,
        updated_at=now,
    )
    location.rules = [ClientLocationRule(**rule.model_dump()) for rule in payload.rules]
    db.add(location)
    db.commit()
    placed = LocationService(db).apply_rules(client_id)
    audit_log(db, operator=operator, action=AuditAction.CLIENT_LOCATION_CREATED, entity_type="client_location",
              entity_id=location.id, details={"client_id": client_id, "name": location.name,
                                              "city": location.city, "country": location.country,
                                              "rules": len(payload.rules), "devices_placed": placed.assigned})
    return _location_out(db, client_id, location.id, narrowed)


@router.put("/{client_id}/locations/{location_id}", response_model=LocationOut)
def update_client_location(
    client_id: int,
    location_id: int,
    payload: LocationUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_manage_clients),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _, narrowed = _client_in_scope(db, scope, client_id)
    location = _location(db, client_id, location_id)
    changes = payload.model_dump(exclude_unset=True, exclude={"rules"})
    if changes.get("name"):
        _check_unique_name(db, client_id, changes["name"], exclude_id=location_id)
    for field, value in changes.items():
        setattr(location, field, value)
    if payload.rules is not None:
        location.rules = [ClientLocationRule(**rule.model_dump()) for rule in payload.rules]
    location.updated_by = operator.username
    location.updated_at = utcnow()
    db.commit()
    placed = LocationService(db).apply_rules(client_id)
    fields = sorted(changes) + (["rules"] if payload.rules is not None else [])
    audit_log(db, operator=operator, action=AuditAction.CLIENT_LOCATION_UPDATED, entity_type="client_location",
              entity_id=location_id, details={"client_id": client_id, "name": location.name, "fields": fields,
                                              "devices_placed": placed.assigned, "devices_cleared": placed.cleared})
    return _location_out(db, client_id, location_id, narrowed)


@router.delete("/{client_id}/locations/{location_id}", status_code=204)
def delete_client_location(
    client_id: int,
    location_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_manage_clients),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """The location's devices go back to the rules of the remaining locations."""
    _client_in_scope(db, scope, client_id)
    location = _location(db, client_id, location_id)
    name = location.name
    db.query(Device).filter(Device.location_id == location_id).update(
        {Device.location_id: None, Device.location_source: None}, synchronize_session=False
    )
    db.delete(location)
    db.commit()
    placed = LocationService(db).apply_rules(client_id)
    audit_log(db, operator=operator, action=AuditAction.CLIENT_LOCATION_DELETED, entity_type="client_location",
              entity_id=location_id, details={"client_id": client_id, "name": name,
                                              "devices_placed_elsewhere": placed.assigned})
    return Response(status_code=204)


@router.post("/{client_id}/locations/apply", response_model=LocationApplyResult)
def apply_client_location_rules(
    client_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_manage_clients),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Place every device no operator placed by hand, with the current rules."""
    _client_in_scope(db, scope, client_id)
    result = LocationService(db).apply_rules(client_id)
    audit_log(db, operator=operator, action=AuditAction.CLIENT_LOCATIONS_APPLIED, entity_type="client",
              entity_id=client_id, details={"client_id": client_id, "trigger": "manual",
                                            "assigned": result.assigned, "cleared": result.cleared})
    return result


@router.post("/{client_id}/locations/assign", response_model=LocationApplyResult)
def assign_device_location(
    client_id: int,
    payload: DeviceLocationAssign,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    _: None = Depends(_require_manage_clients),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Put devices at a location by hand (pinned), or give them back to the rules."""
    _, narrowed = _client_in_scope(db, scope, client_id)
    if payload.mode == "manual" and payload.location_id is not None:
        _location(db, client_id, payload.location_id)
    devices = LocationService(db).assign(client_id, narrowed, payload.device_ids, payload.location_id, payload.mode)
    for device in devices:
        audit_log(db, operator=operator, action=AuditAction.DEVICE_LOCATION_SET, entity_type="device",
                  entity_id=device.id, details={"client_id": client_id, "device_id": device.id,
                                                "location_id": device.location_id, "mode": payload.mode})
    return LocationApplyResult(assigned=len(devices), cleared=0)


@router.put("/{client_id}", response_model=Client)
def update_client(
    client_id: int,
    payload: ClientUpdate,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    try:
        client = ClientService(db).update_client(client_id, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client


@router.delete("/{client_id}", response_model=Client)
def delete_client(
    client_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(_require_manage_clients),
):
    client = ClientService(db).delete_client(client_id)
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")
    return client
