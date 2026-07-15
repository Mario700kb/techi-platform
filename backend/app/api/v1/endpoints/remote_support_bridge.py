from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.agent_auth import remote_connect_redeem_limiter, remote_connect_report_limiter
from app.db.session import get_db
from app.services.audit_service import AuditAction, system_audit_log
from app.services.remote_support_connect_service import ConnectTokenError, RemoteSupportConnectService


router = APIRouter()


class RedeemRequest(BaseModel):
    token: str = Field(min_length=32, max_length=128)


class RedeemResponse(BaseModel):
    remote_id: str
    password: str
    receipt: str


class LaunchResultRequest(BaseModel):
    receipt: str = Field(min_length=32, max_length=128)
    outcome: Literal["launched", "failed"]
    failure_code: Optional[str] = Field(default=None, max_length=64)


def _source_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/connect-tokens/redeem", response_model=RedeemResponse)
def redeem_connect_token(
    body: RedeemRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if not remote_connect_redeem_limiter.is_allowed(f"redeem:{_source_key(request)}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many redemption attempts")
    try:
        redeemed = RemoteSupportConnectService(db).redeem(body.token)
    except ConnectTokenError as exc:
        system_audit_log(
            db,
            action=AuditAction.REMOTE_CONNECT_FAILED,
            entity_type="remote_support_connect",
            details={"stage": "redeem", "reason": exc.reason},
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.reason) from exc

    system_audit_log(
        db,
        action=AuditAction.REMOTE_CONNECT_TOKEN_REDEEMED,
        entity_type="device",
        entity_id=redeemed.row.device_id,
        details={
            "operator_id": redeemed.row.operator_id,
            "client_id": redeemed.row.client_id,
            "purpose": redeemed.row.purpose,
        },
    )
    return RedeemResponse(
        remote_id=redeemed.remote_id,
        password=redeemed.password,
        receipt=redeemed.receipt,
    )


@router.post("/connect-tokens/result", status_code=204)
def report_connect_result(
    body: LaunchResultRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    response.headers["Cache-Control"] = "no-store"
    if not remote_connect_report_limiter.is_allowed(f"result:{_source_key(request)}"):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many result reports")
    try:
        row = RemoteSupportConnectService(db).report(
            receipt=body.receipt,
            outcome=body.outcome,
            failure_code=body.failure_code,
        )
    except ConnectTokenError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.reason) from exc

    system_audit_log(
        db,
        action=(
            AuditAction.REMOTE_CONNECT_LAUNCHED
            if body.outcome == "launched"
            else AuditAction.REMOTE_CONNECT_FAILED
        ),
        entity_type="device",
        entity_id=row.device_id,
        details={
            "operator_id": row.operator_id,
            "client_id": row.client_id,
            "stage": "native_handoff",
            "outcome": body.outcome,
            "failure_code": row.failure_code,
        },
    )
