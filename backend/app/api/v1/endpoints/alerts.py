from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role
from app.core.scope import AllowedScope, device_in_scope
from app.db.session import get_db
from app.models.alert import AlertState, DeviceAlert
from app.models.operator import Operator, OperatorRole
from app.repositories.alert_repository import AlertRepository
from app.schemas.alert import AlertCountResponse, AlertOut
from app.services.alert_engine import _alert_payload
from app.services.device_service import DeviceService
from app.services.token_usage_alert_service import build_token_usage_alerts
from app.websocket.events import RealtimeEventType, build_event
from app.websocket.publisher import realtime_publisher

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
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
):
    repo = AlertRepository(db)
    rows = repo.list_with_device(
        scope=scope,
        state=AlertState.OPEN.value if state == "open" else None,
        severity=severity,
        kind=kind,
        limit=limit,
        offset=offset,
    )
    alerts = [_alert_out(*row) for row in rows]
    # Token usage alerts are synthetic (computed on read, negative ids) and
    # always "open" — they resolve themselves once max_uses is raised. They
    # describe enrollment tokens, not devices, so only an unscoped operator
    # sees them.
    if offset == 0 and scope is None and kind in (None, "token_usage_warning", "token_usage_critical"):
        token_alerts = [
            alert for alert in build_token_usage_alerts(db)
            if (severity is None or alert["severity"] == severity) and (kind is None or alert["kind"] == kind)
        ]
        return token_alerts + alerts
    return alerts


@router.get("/count", response_model=AlertCountResponse)
def alert_count(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    total, by_severity, by_kind = AlertRepository(db).open_counts(scope)
    if scope is None:
        for alert in build_token_usage_alerts(db):
            by_severity[alert["severity"]] = by_severity.get(alert["severity"], 0) + 1
            by_kind[alert["kind"]] = by_kind.get(alert["kind"], 0) + 1
            total += 1
    return AlertCountResponse(total_open=total, by_severity=by_severity, by_kind=by_kind)


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


@router.put("/{alert_id}/resolve", response_model=AlertOut)
def resolve_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    _: Operator = Depends(require_min_role(OperatorRole.OPERATOR.value)),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    repo = AlertRepository(db)
    # Out of scope reads as not found, so ids cannot be probed across clients.
    alert: Optional[DeviceAlert] = repo.get_in_scope(alert_id, scope)
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    if alert.state == AlertState.RESOLVED:
        raise HTTPException(status_code=409, detail="Alert already resolved")
    resolved = repo.resolve(alert_id, cooldown_seconds=0)
    if not resolved:
        raise HTTPException(status_code=500, detail="Failed to resolve alert")
    realtime_publisher.publish_threadsafe(
        build_event(RealtimeEventType.ALERT_RESOLVED, data=_alert_payload(resolved), reason="manual_resolve"),
        dedupe_key=f"alert_resolved:{resolved.id}",
    )
    return resolved
