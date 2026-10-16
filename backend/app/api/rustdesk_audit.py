from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.core.agent_auth import _SlidingWindowRateLimiter
from app.db.session import get_db
from app.schemas.rustdesk_audit import RustDeskAlarmReport, RustDeskConnReport
from app.services.rustdesk_audit_service import RustDeskAuditService

# RustDesk derives these paths from its API server (get_audit_server:
# "<api-server>/api/audit/<type>"), so they live at the root, not under /api/v1.
router = APIRouter()

# The endpoints take no credential, so each source address gets a ceiling.
# A connection is three reports (new, password accepted, close); 300 a minute
# leaves room for an office of devices behind one address. Alarms are rarer.
conn_limiter = _SlidingWindowRateLimiter(limit=300, window_seconds=60)
alarm_limiter = _SlidingWindowRateLimiter(limit=30, window_seconds=60)


def _source_ip(request: Request, limiter: _SlidingWindowRateLimiter):
    source_ip = request.client.host if request.client else None
    if not limiter.is_allowed(source_ip or "unknown"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many reports")
    return source_ip


@router.post("/api/audit/conn", status_code=status.HTTP_204_NO_CONTENT)
def rustdesk_connection_report(report: RustDeskConnReport, request: Request, db: Session = Depends(get_db)):
    RustDeskAuditService(db).record_connection(report, _source_ip(request, conn_limiter))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/api/audit/alarm", status_code=status.HTTP_204_NO_CONTENT)
def rustdesk_alarm_report(report: RustDeskAlarmReport, request: Request, db: Session = Depends(get_db)):
    RustDeskAuditService(db).record_alarm(report, _source_ip(request, alarm_limiter))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
