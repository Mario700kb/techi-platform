from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.alert import AlertState, DeviceAlert
from app.models.operator import Operator, OperatorRole
from app.repositories.alert_repository import AlertRepository
from app.schemas.alert import (
    AlertAnalysisOut,
    AlertAnalyzeBody,
    AlertAssignBody,
    AlertBulkBody,
    AlertBulkResult,
    AlertCountResponse,
    AlertDetailOut,
    AlertGroupAnalyzeBody,
    AlertGroupOut,
    AlertMuteBody,
    AlertMuteOut,
    AlertNoteBody,
    AlertOut,
    AlertPage,
    AlertRateBody,
    AlertResolveBody,
    AlertSnoozeBody,
    FindingsPage,
    QualityReport,
)
from app.repositories.alert_repository import QUEUE_VIEWS, AlertQueueRepository
from app.services.alert_ai_service import AIError, AlertAIService
from app.services.alert_center_service import AlertActionError, AlertCenterService, alert_out
from app.services.device_service import DeviceService
from app.services.operator_scope_service import OperatorScopeService
from app.services.token_usage_alert_service import build_token_usage_alerts

router = APIRouter()


def _alert_out(alert: DeviceAlert, hostname: Optional[str], display_name: Optional[str], client_name: Optional[str]) -> AlertOut:
    out = AlertOut.model_validate(alert)
    out.device_name = (display_name or "").strip() or hostname
    out.client_name = client_name
    return out


@router.get("/", response_model=List[AlertOut])
def list_alerts(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    state: Optional[str] = Query(default=None, description="open | resolved | all"),
    severity: Optional[str] = Query(default=None, pattern="^(info|warning|critical)$"),
    kind: Optional[str] = None,
    search: Optional[str] = Query(default=None, max_length=100),
    client_id: Optional[int] = None,
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
):
    if client_id is not None:
        scope = OperatorScopeService(db).scope_for_client(scope, client_id)
        if scope is None:
            raise HTTPException(status_code=404, detail="Client not found")
    repo = AlertRepository(db)
    rows = repo.list_with_device(
        scope=scope,
        state=state if state in (AlertState.OPEN.value, AlertState.RESOLVED.value) else None,
        severity=severity,
        kind=kind,
        search=search,
        limit=limit,
        offset=offset,
    )
    alerts = [_alert_out(*row) for row in rows]
    # Token usage alerts are synthetic (computed on read, negative ids) and
    # always "open" — they resolve themselves once max_uses is raised. They
    # describe enrollment tokens, not devices, so only an unscoped operator
    # sees them.
    if (
        offset == 0
        and scope is None
        and not search
        and state != AlertState.RESOLVED.value
        and kind in (None, "token_usage_warning", "token_usage_critical")
    ):
        token_alerts = [
            alert for alert in build_token_usage_alerts(db)
            if (severity is None or alert["severity"] == severity) and (kind is None or alert["kind"] == kind)
        ]
        return token_alerts + alerts
    return alerts


@router.get("/count", response_model=AlertCountResponse)
def alert_count(
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    search: Optional[str] = Query(default=None, max_length=100),
    client_id: Optional[int] = None,
):
    if client_id is not None:
        scope = OperatorScopeService(db).scope_for_client(scope, client_id)
        if scope is None:
            raise HTTPException(status_code=404, detail="Client not found")
    counts = AlertRepository(db).open_counts(scope, search)
    views = AlertQueueRepository(db).view_counts(scope, operator_id=operator.id, search=search)
    by_severity, by_kind = counts["by_severity"], counts["by_kind"]
    total = counts["total"]
    if scope is None and not search:
        for alert in build_token_usage_alerts(db):
            by_severity[alert["severity"]] = by_severity.get(alert["severity"], 0) + 1
            by_kind[alert["kind"]] = by_kind.get(alert["kind"], 0) + 1
            total += 1
    return AlertCountResponse(
        total_open=total,
        by_severity=by_severity,
        by_kind=by_kind,
        devices_affected=counts["devices_affected"],
        oldest_open_at=counts["oldest_open_at"],
        views=views["views"],
        by_priority=views["by_priority"],
    )


@router.get("/device/{device_id}", response_model=List[AlertOut])
def device_alerts(
    device_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    state: Optional[str] = Query(default=None),
    limit: int = Query(default=20, le=100),
):
    if scope is not None:
        device = DeviceService(db).get_device(device_id)
        if not device or not device_in_scope(device.client_id, device.group_id, device.id, scope):
            raise HTTPException(status_code=404, detail="Device not found")
    repo = AlertRepository(db)
    parsed_state = state if state in ("open", "resolved") else None
    return repo.get_by_device(device_id=device_id, state=parsed_state, limit=limit)


# ── the work queue ─────────────────────────────────────────────────────────

def _scope_for(db: Session, scope, client_id: Optional[int]):
    if client_id is None:
        return scope
    scoped = OperatorScopeService(db).scope_for_client(scope, client_id)
    if scoped is None:
        raise HTTPException(status_code=404, detail="Client not found")
    return scoped


def _raise(exc: Exception):
    if isinstance(exc, (AlertActionError, AIError)):
        raise HTTPException(status_code=exc.status, detail=exc.detail)
    raise exc


@router.get("/queue", response_model=AlertPage)
def alert_queue(
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    view: str = Query(default="needs_action", pattern="^(needs_action|mine|open|snoozed|resolved)$"),
    severity: Optional[str] = Query(default=None, pattern="^(info|warning|critical)$"),
    priority: Optional[int] = Query(default=None, ge=1, le=4),
    kind: Optional[str] = Query(default=None, max_length=64),
    issue: Optional[str] = Query(default=None, max_length=200),
    client_id: Optional[int] = None,
    device_id: Optional[int] = None,
    search: Optional[str] = Query(default=None, max_length=100),
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    """The Alerts page: most urgent first. "needs_action" is P1–P2 nobody else
    owns; a site that went offline as a whole leads it, above its devices."""
    assert view in QUEUE_VIEWS
    repo = AlertQueueRepository(db)
    rows, total = repo.queue(
        scope, view=view, operator_id=operator.id, limit=limit, offset=offset, severity=severity, priority=priority,
        kind=kind, issue=issue, client_id=client_id, device_id=device_id, search=search,
    )
    items = [alert_out(*row) for row in rows]
    if offset == 0 and view in ("needs_action", "open") and not (kind or issue or device_id or search or severity) \
            and priority in (None, 1):
        outages = [o for o in AlertCenterService(db).site_outages(scope) if client_id is None or o.client_id == client_id]
        items = outages + items
        total += len(outages)
    return AlertPage(items=items, total=total)


@router.get("/groups", response_model=List[AlertGroupOut])
def alert_groups(
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    by: str = Query(default="issue", pattern="^(issue|client|device)$"),
    view: str = Query(default="open", pattern="^(needs_action|mine|open|snoozed|resolved)$"),
    search: Optional[str] = Query(default=None, max_length=100),
    client_id: Optional[int] = None,
):
    from app.services.alert_presenter import KIND_TITLES, describe_alert
    from app.services.alert_rules import EVENT_GROUPS

    groups = AlertQueueRepository(db).groups(scope, by=by, view=view, operator_id=operator.id, search=search,
                                             client_id=client_id)
    for group in groups:
        if by == "issue":
            fingerprint = group["fingerprint"]
            if fingerprint.startswith("evt:") and fingerprint[4:] in EVENT_GROUPS:
                group["title"] = EVENT_GROUPS[fingerprint[4:]].title
            elif fingerprint.startswith("regress:"):
                group["title"] = describe_alert(group["kind"], fingerprint, "", None, "warning").title
            else:
                group["title"] = KIND_TITLES.get(group["kind"], group["kind"])
            group["label"] = group["title"]
        else:
            group["title"] = group["label"]
    return groups


@router.get("/findings", response_model=FindingsPage)
def alert_findings(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    type: Optional[str] = Query(default=None, pattern="^(security|reboot|disk_forecast)$"),
    client_id: Optional[int] = None,
):
    """States to fix on a plan, not incidents: security posture, restarts
    pending on PCs, disks forecast to fill."""
    return AlertCenterService(db).findings(_scope_for(db, scope, client_id), kind=type, client_id=client_id)


@router.get("/quality", response_model=QualityReport)
def alert_quality(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    days: int = Query(default=7, ge=1, le=90),
):
    return AlertCenterService(db).quality(scope, days=days)


@router.get("/mutes", response_model=List[AlertMuteOut])
def list_mutes(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return AlertCenterService(db).list_mutes(scope)


@router.post("/mutes", response_model=AlertMuteOut)
def create_mute(
    body: AlertMuteBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    from app.services.audit_service import audit_log

    try:
        row = AlertCenterService(db).create_mute(scope, operator, body)
    except AlertActionError as exc:
        _raise(exc)
    audit_log(db, operator=operator, action="alert_mute_created", entity_type="alert_mute", entity_id=row.get("id"),
              details={"device_id": body.device_id, "client_id": body.client_id, "kind": body.kind,
                       "fingerprint": body.fingerprint, "days": body.days, "reason": body.reason, "closed": row.get("closed")})
    return row


@router.delete("/mutes/{mute_id}", status_code=204)
def remove_mute(
    mute_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    from app.services.audit_service import audit_log

    try:
        AlertCenterService(db).remove_mute(mute_id, scope, operator)
    except AlertActionError as exc:
        _raise(exc)
    audit_log(db, operator=operator, action="alert_mute_removed", entity_type="alert_mute", entity_id=mute_id)


@router.post("/bulk", response_model=AlertBulkResult)
def bulk_alerts(
    body: AlertBulkBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    ids = [i for i in body.ids if i > 0]
    done, failed = AlertCenterService(db).bulk(ids, scope, operator, body)
    return AlertBulkResult(done=done, failed=failed)


@router.post("/analysis/group", response_model=AlertAnalysisOut)
def analyze_group(
    body: AlertGroupAnalyzeBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    rows, _ = AlertQueueRepository(db).queue(scope, view="open", operator_id=operator.id, limit=15, issue=body.issue)
    try:
        return AlertAIService(db).analyze_group(body.issue, [row[0] for row in rows], operator,
                                                language=body.language, force=body.force)
    except AIError as exc:
        _raise(exc)


@router.post("/analysis/{analysis_id}/rating", response_model=AlertAnalysisOut)
def rate_analysis(
    analysis_id: int,
    body: AlertRateBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
):
    try:
        return AlertAIService(db).rate(analysis_id, body.rating, operator)
    except AIError as exc:
        _raise(exc)


@router.get("/{alert_id}", response_model=AlertDetailOut)
def alert_detail(
    alert_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    try:
        return AlertCenterService(db).detail(alert_id, scope)
    except AlertActionError as exc:
        _raise(exc)


def _action(fn):
    try:
        return fn()
    except AlertActionError as exc:
        _raise(exc)


@router.put("/{alert_id}/resolve", response_model=AlertOut)
def resolve_alert(
    alert_id: int,
    body: Optional[AlertResolveBody] = None,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    """Out of scope reads as not found, so ids cannot be probed across clients."""
    body = body or AlertResolveBody()
    alert = _action(lambda: AlertCenterService(db).resolve(alert_id, scope, operator, resolution=body.resolution, note=body.note))
    return alert_out(alert)


@router.post("/{alert_id}/take", response_model=AlertOut)
def take_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return alert_out(_action(lambda: AlertCenterService(db).take(alert_id, scope, operator)))


@router.post("/{alert_id}/assign", response_model=AlertOut)
def assign_alert(
    alert_id: int,
    body: AlertAssignBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return alert_out(_action(lambda: AlertCenterService(db).assign(alert_id, scope, operator, body.operator_id)))


@router.post("/{alert_id}/snooze", response_model=AlertOut)
def snooze_alert(
    alert_id: int,
    body: AlertSnoozeBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return alert_out(_action(lambda: AlertCenterService(db).snooze(
        alert_id, scope, operator, minutes=body.minutes, until=body.until, until_worse=body.until_worse)))


@router.post("/{alert_id}/unsnooze", response_model=AlertOut)
def unsnooze_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    return alert_out(_action(lambda: AlertCenterService(db).unsnooze(alert_id, scope, operator)))


@router.post("/{alert_id}/notes", status_code=204)
def add_alert_note(
    alert_id: int,
    body: AlertNoteBody,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _action(lambda: AlertCenterService(db).note(alert_id, scope, operator, body.text))


@router.post("/{alert_id}/analysis", response_model=AlertAnalysisOut)
def analyze_alert(
    alert_id: int,
    body: Optional[AlertAnalyzeBody] = None,
    db: Session = Depends(get_db),
    operator: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    body = body or AlertAnalyzeBody()
    alert = AlertRepository(db).get_in_scope(alert_id, scope)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    try:
        return AlertAIService(db).analyze_alert(alert, operator, language=body.language, force=body.force)
    except AIError as exc:
        _raise(exc)
