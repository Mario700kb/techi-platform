import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, get_operator_scope, require_min_role, require_team_permission
from app.core.scope import AllowedScope
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.models.report import ReportRunStatus
from app.platform_core.flags import feature_enabled
from app.repositories.client_repository import ClientRepository
from app.repositories.report_repository import ReportRunRepository, ReportScheduleRepository
from app.schemas.report import (
    ReportGenerateRequest,
    ReportRunList,
    ReportRunOut,
    ReportScheduleCreate,
    ReportScheduleOut,
    ReportScheduleUpdate,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.permission_service import VIEW_DEVICES
from app.services.report_service import ReportService

logger = logging.getLogger(__name__)
router = APIRouter()

_require_view = require_team_permission(VIEW_DEVICES)
_require_admin = require_min_role(OperatorRole.ADMIN.value)


def _require_reporting_enabled() -> None:
    if not feature_enabled("FEATURE_REPORTING"):
        raise HTTPException(status_code=404, detail="Not Found")


def _ensure_client_scope(client_id: int, scope: Optional[AllowedScope]) -> None:
    # A client-facing report includes the client's complete fleet. Group/device-
    # only access must not be elevated into a full-client export.
    if scope is not None and client_id not in scope.client_ids:
        raise HTTPException(status_code=404, detail="Client not found")


def _schedule_out(schedule, client_name: str) -> ReportScheduleOut:
    return ReportScheduleOut(
        id=schedule.id, name=schedule.name, client_id=schedule.client_id, client_name=client_name,
        report_format=schedule.report_format, cadence=schedule.cadence, period_days=schedule.period_days,
        hour_utc=schedule.hour_utc, day_of_week=schedule.day_of_week, day_of_month=schedule.day_of_month,
        enabled=schedule.enabled, next_run_at=schedule.next_run_at, last_run_at=schedule.last_run_at,
        created_by=schedule.created_by, created_at=schedule.created_at, updated_at=schedule.updated_at,
    )


@router.get("/clients", dependencies=[Depends(_require_reporting_enabled), Depends(_require_view)])
def report_clients(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    clients = ClientRepository(db).list()
    if scope is not None:
        clients = [client for client in clients if client.id in scope.client_ids]
    return [{"id": client.id, "name": client.name} for client in clients]


@router.post("/generate", response_model=ReportRunOut, dependencies=[Depends(_require_reporting_enabled), Depends(_require_view)])
def generate_report(
    payload: ReportGenerateRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    _ensure_client_scope(payload.client_id, scope)
    service = ReportService(db)
    try:
        run = service.generate(
            client_id=payload.client_id,
            report_format=payload.report_format.value,
            period_days=payload.period_days,
            generated_by=operator.username,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception:
        audit_log(
            db, operator=operator, action=AuditAction.REPORT_GENERATION_FAILED,
            entity_type="client", entity_id=payload.client_id,
            details={"format": payload.report_format.value},
        )
        raise HTTPException(status_code=500, detail="Report generation failed")
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_GENERATED,
        entity_type="report_run", entity_id=run.id,
        details={"client_id": run.client_id, "format": run.report_format, "period_days": payload.period_days},
    )
    return run


@router.get("/runs", response_model=ReportRunList, dependencies=[Depends(_require_reporting_enabled), Depends(_require_view)])
def list_runs(
    db: Session = Depends(get_db),
    _: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
    client_id: Optional[int] = Query(default=None, gt=0),
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    if status is not None and status not in {item.value for item in ReportRunStatus}:
        raise HTTPException(status_code=422, detail="Invalid report status")
    if client_id is not None:
        _ensure_client_scope(client_id, scope)
    items, total = ReportRunRepository(db).list_history(
        scope=scope, client_id=client_id, status=status, limit=limit, offset=offset,
    )
    return ReportRunList(items=items, total=total)


@router.get("/runs/{run_id}/download", dependencies=[Depends(_require_reporting_enabled), Depends(_require_view)])
def download_report(
    run_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(get_current_operator),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    run = ReportRunRepository(db).get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Report not found")
    _ensure_client_scope(run.client_id, scope)
    try:
        path = ReportService.resolve_download_path(run)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_DOWNLOADED,
        entity_type="report_run", entity_id=run.id,
        details={"client_id": run.client_id, "format": run.report_format},
    )
    media_type = "application/pdf" if run.report_format == "pdf" else "text/csv; charset=utf-8"
    return FileResponse(path, media_type=media_type, filename=run.filename)


@router.delete("/runs/{run_id}", status_code=204, dependencies=[Depends(_require_reporting_enabled)])
def delete_run(
    run_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
    scope: Optional[AllowedScope] = Depends(get_operator_scope),
):
    repo = ReportRunRepository(db)
    run = repo.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Report not found")
    _ensure_client_scope(run.client_id, scope)
    details = {"client_id": run.client_id, "format": run.report_format, "schedule_id": run.schedule_id}
    ReportService(db).delete_run(run)
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_RUN_DELETED,
        entity_type="report_run", entity_id=run_id, details=details,
    )
    return Response(status_code=204)


@router.get("/schedules", response_model=list[ReportScheduleOut], dependencies=[Depends(_require_reporting_enabled)])
def list_schedules(db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    return [_schedule_out(schedule, client_name) for schedule, client_name in ReportScheduleRepository(db).list()]


@router.post("/schedules", response_model=ReportScheduleOut, dependencies=[Depends(_require_reporting_enabled)])
def create_schedule(
    payload: ReportScheduleCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    client = ClientRepository(db).get(payload.client_id)
    if client is None or not client.is_active:
        raise HTTPException(status_code=404, detail="Client not found")
    schedule = ReportService(db).create_schedule(
        **payload.model_dump(mode="json"), created_by=operator.username,
    )
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_SCHEDULE_CREATED,
        entity_type="report_schedule", entity_id=schedule.id,
        details={"client_id": schedule.client_id, "cadence": schedule.cadence, "format": schedule.report_format},
    )
    return _schedule_out(schedule, client.name)


@router.patch("/schedules/{schedule_id}", response_model=ReportScheduleOut, dependencies=[Depends(_require_reporting_enabled)])
def update_schedule(
    schedule_id: int,
    payload: ReportScheduleUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    schedule = ReportScheduleRepository(db).get(schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    try:
        schedule = ReportService(db).update_schedule(schedule, **payload.model_dump(exclude_unset=True, mode="json"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    client = ClientRepository(db).get(schedule.client_id)
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_SCHEDULE_UPDATED,
        entity_type="report_schedule", entity_id=schedule.id,
        details={"changes": sorted(payload.model_fields_set)},
    )
    return _schedule_out(schedule, client.name if client else f"Client {schedule.client_id}")


@router.delete("/schedules/{schedule_id}", status_code=204, dependencies=[Depends(_require_reporting_enabled)])
def delete_schedule(
    schedule_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    repo = ReportScheduleRepository(db)
    schedule = repo.get(schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="Schedule not found")
    details = {"client_id": schedule.client_id, "name": schedule.name}
    repo.delete(schedule)
    audit_log(
        db, operator=operator, action=AuditAction.REPORT_SCHEDULE_DELETED,
        entity_type="report_schedule", entity_id=schedule_id, details=details,
    )
    return Response(status_code=204)
