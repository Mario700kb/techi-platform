"""Platform → Automation: scheduled agent updates in waves (administrators)."""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import require_roles
from app.core.time import utcnow_naive
from app.db.session import get_db
from app.models.automation import AutomationRun, AutomationTask
from app.models.operator import Operator, OperatorRole
from app.schemas.automation import AutomationPreview, AutomationRunOut, AutomationTaskBody, AutomationTaskOut
from app.services import automation_service as automation
from app.services.agent_package_service import AgentPackageService
from app.services.audit_service import AuditAction, audit_log

router = APIRouter()
_require_admin = require_roles(OperatorRole.ADMIN.value)


def _out(db: Session, task: AutomationTask) -> AutomationTaskOut:
    last = (
        db.query(AutomationRun).filter(AutomationRun.task_id == task.id)
        .order_by(AutomationRun.id.desc()).first()
    )
    out = AutomationTaskOut.model_validate(task)
    out.last_run = AutomationRunOut.model_validate(last) if last else None
    return out


def _get(db: Session, task_id: int) -> AutomationTask:
    task = db.get(AutomationTask, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


def _apply(task: AutomationTask, body: AutomationTaskBody) -> None:
    for field, value in body.model_dump().items():
        setattr(task, field, value)
    task.next_run_at = automation.next_run_after(task, utcnow_naive()) if task.enabled else None


@router.get("/automation/tasks", response_model=List[AutomationTaskOut])
def list_tasks(db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    return [_out(db, t) for t in db.query(AutomationTask).order_by(AutomationTask.id).all()]


@router.post("/automation/tasks", response_model=AutomationTaskOut, status_code=201)
def create_task(body: AutomationTaskBody, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    task = AutomationTask(kind="agent_update", created_by=operator.username)
    _apply(task, body)
    db.add(task)
    db.commit()
    db.refresh(task)
    audit_log(db, operator=operator, action=AuditAction.AUTOMATION_TASK_CREATED, entity_type="automation_task",
              entity_id=task.id, details={"name": task.name, "schedule": task.schedule, "scope": task.scope})
    return _out(db, task)


@router.put("/automation/tasks/{task_id}", response_model=AutomationTaskOut)
def update_task(task_id: int, body: AutomationTaskBody, db: Session = Depends(get_db),
                operator: Operator = Depends(_require_admin)):
    task = _get(db, task_id)
    _apply(task, body)
    db.commit()
    db.refresh(task)
    audit_log(db, operator=operator, action=AuditAction.AUTOMATION_TASK_UPDATED, entity_type="automation_task",
              entity_id=task.id, details={"name": task.name, "enabled": task.enabled})
    return _out(db, task)


@router.delete("/automation/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    task = _get(db, task_id)
    if automation.active_run(db, task.id) is not None:
        raise HTTPException(status_code=409, detail="Stop the run in progress before deleting the task")
    name = task.name
    db.delete(task)
    db.commit()
    audit_log(db, operator=operator, action=AuditAction.AUTOMATION_TASK_DELETED, entity_type="automation_task",
              entity_id=task_id, details={"name": name})


@router.get("/automation/tasks/{task_id}/preview", response_model=AutomationPreview)
def preview_task(task_id: int, db: Session = Depends(get_db), _: Operator = Depends(_require_admin)):
    task = _get(db, task_id)
    keep, other = automation.eligible_devices(db, task)
    first = automation._wave_target(task, 0)
    package = AgentPackageService().latest_active("windows-amd64", file_type="agent_binary")
    return AutomationPreview(needs_update=len(keep), up_to_date_or_busy=other,
                             first_wave=len(keep) if first <= 0 else min(first, len(keep)),
                             version=package.version if package else None)


@router.post("/automation/tasks/{task_id}/run", response_model=AutomationRunOut, status_code=201)
def run_now(task_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    task = _get(db, task_id)
    try:
        run = automation.start_run(db, task, trigger="manual", started_by=operator.username)
    except automation.AutomationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    automation.advance_run(db, run, utcnow_naive())  # the first wave goes out now
    db.commit()
    db.refresh(run)
    audit_log(db, operator=operator, action=AuditAction.AUTOMATION_RUN_STARTED, entity_type="automation_task",
              entity_id=task.id, details={"name": task.name, "run_id": run.id})
    return AutomationRunOut.model_validate(run)


@router.get("/automation/tasks/{task_id}/runs", response_model=List[AutomationRunOut])
def list_runs(task_id: int, limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db),
              _: Operator = Depends(_require_admin)):
    _get(db, task_id)
    rows = (db.query(AutomationRun).filter(AutomationRun.task_id == task_id)
            .order_by(AutomationRun.id.desc()).limit(limit).all())
    return [AutomationRunOut.model_validate(r) for r in rows]


@router.post("/automation/runs/{run_id}/cancel", response_model=AutomationRunOut)
def cancel_run(run_id: int, db: Session = Depends(get_db), operator: Operator = Depends(_require_admin)):
    run = db.get(AutomationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found")
    try:
        automation.cancel_run(db, run)
    except automation.AutomationError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    audit_log(db, operator=operator, action=AuditAction.AUTOMATION_RUN_CANCELLED, entity_type="automation_task",
              entity_id=run.task_id, details={"run_id": run.id})
    return AutomationRunOut.model_validate(run)
