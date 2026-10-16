from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas.rustdesk_audit import RustDeskAlarmReport, RustDeskConnReport
from app.services.rustdesk_audit_service import RustDeskAuditService

# RustDesk derives these paths from its API server (get_audit_server:
# "<api-server>/api/audit/<type>"), so they live at the root, not under /api/v1.
router = APIRouter()


@router.post("/api/audit/conn", status_code=status.HTTP_204_NO_CONTENT)
def rustdesk_connection_report(report: RustDeskConnReport, request: Request, db: Session = Depends(get_db)):
    RustDeskAuditService(db).record_connection(report, request.client.host if request.client else None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/api/audit/alarm", status_code=status.HTTP_204_NO_CONTENT)
def rustdesk_alarm_report(report: RustDeskAlarmReport, request: Request, db: Session = Depends(get_db)):
    RustDeskAuditService(db).record_alarm(report, request.client.host if request.client else None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
