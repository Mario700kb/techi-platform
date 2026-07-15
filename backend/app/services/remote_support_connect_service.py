"""One-use capability tokens for native Remote Support launches."""

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import quote

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.device import Device
from app.models.operator import Operator
from app.models.remote_support_connect_token import RemoteSupportConnectToken
from app.services.remote_support_password_service import RemoteSupportPasswordService
from app.services.rustdesk_service import RustDeskIdentityService


CONNECT_TOKEN_TTL_SECONDS = 45
CONNECT_TOKEN_PURPOSE = "remote_support_connect"
_SAFE_FAILURE_CODE = re.compile(r"^[a-z0-9_]{1,64}$")


class ConnectTokenError(Exception):
    def __init__(self, reason: str, *, status_code: int = 409):
        super().__init__(reason)
        self.reason = reason
        self.status_code = status_code


@dataclass(frozen=True)
class LaunchCapability:
    device_id: int
    token: str
    expires_at: datetime

    @property
    def connect_url(self) -> str:
        return f"techiremotesupport://connect?token={quote(self.token, safe='')}"


@dataclass
class RedeemedLaunch:
    row: RemoteSupportConnectToken
    remote_id: str
    password: str
    receipt: str


def _now() -> datetime:
    # Existing production DateTime columns are timestamp-without-time-zone.
    return datetime.utcnow()


def _capability_hash(value: str) -> str:
    return hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


class RemoteSupportConnectService:
    def __init__(self, db: Session):
        self.db = db

    def create(self, *, operator: Operator, device: Device) -> LaunchCapability:
        valid, remote_id, error = RustDeskIdentityService.validate_rustdesk_id(device.rustdesk_id)
        if not valid:
            raise ConnectTokenError(error or "Remote Support ID is unavailable", status_code=422)
        if getattr(device, "rustdesk_conflict_detected", False):
            raise ConnectTokenError("Remote Support ID conflict must be resolved")
        if not device.client_id:
            raise ConnectTokenError("Device must be assigned to a client before secure Connect")

        if device.remote_support_apply_status != "applied":
            raise ConnectTokenError("No confirmed applied Remote Support credential is available")
        password = RemoteSupportPasswordService(self.db).get_confirmed_active_plaintext(device)
        if not password:
            raise ConnectTokenError("No confirmed applied Remote Support credential is available")
        password = ""

        token = secrets.token_urlsafe(32)
        expires_at = _now() + timedelta(seconds=CONNECT_TOKEN_TTL_SECONDS)
        row = RemoteSupportConnectToken(
            token_hash=_capability_hash(token),
            purpose=CONNECT_TOKEN_PURPOSE,
            operator_id=operator.id,
            operator_username=operator.username,
            client_id=device.client_id,
            device_id=device.id,
            remote_id=remote_id,
            created_at=_now(),
            expires_at=expires_at,
        )
        self.db.add(row)
        self.db.commit()
        return LaunchCapability(device_id=device.id, token=token, expires_at=expires_at)

    def redeem(self, token: str) -> RedeemedLaunch:
        if not token or len(token) > 128:
            raise ConnectTokenError("invalid_or_expired_token", status_code=410)

        now = _now()
        token_hash = _capability_hash(token)
        receipt = secrets.token_urlsafe(32)
        receipt_hash = _capability_hash(receipt)
        updated = (
            self.db.query(RemoteSupportConnectToken)
            .filter(
                RemoteSupportConnectToken.token_hash == token_hash,
                RemoteSupportConnectToken.purpose == CONNECT_TOKEN_PURPOSE,
                RemoteSupportConnectToken.consumed_at.is_(None),
                RemoteSupportConnectToken.expires_at > now,
            )
            .update(
                {
                    RemoteSupportConnectToken.consumed_at: now,
                    RemoteSupportConnectToken.receipt_hash: receipt_hash,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            self.db.rollback()
            raise ConnectTokenError("invalid_or_expired_token", status_code=410)
        self.db.commit()

        row = self.db.query(RemoteSupportConnectToken).filter_by(token_hash=token_hash).one()
        device = self.db.query(Device).filter(Device.id == row.device_id).one_or_none()
        operator = self.db.query(Operator).filter(Operator.id == row.operator_id).one_or_none()
        valid_remote_id, current_remote_id, _ = RustDeskIdentityService.validate_rustdesk_id(
            device.rustdesk_id if device is not None else None
        )
        if (
            device is None
            or operator is None
            or not operator.is_active
            or operator.username != row.operator_username
            or device.client_id != row.client_id
            or not valid_remote_id
            or current_remote_id != row.remote_id
            or row.purpose != CONNECT_TOKEN_PURPOSE
        ):
            raise ConnectTokenError("launch_binding_changed", status_code=409)

        if device.remote_support_apply_status != "applied":
            raise ConnectTokenError("confirmed_credential_unavailable", status_code=409)
        password = RemoteSupportPasswordService(self.db).get_confirmed_active_plaintext(device)
        if not password:
            raise ConnectTokenError("confirmed_credential_unavailable", status_code=409)
        return RedeemedLaunch(row=row, remote_id=row.remote_id, password=password, receipt=receipt)

    def report(self, *, receipt: str, outcome: str, failure_code: Optional[str]) -> RemoteSupportConnectToken:
        if outcome not in {"launched", "failed"}:
            raise ConnectTokenError("invalid_launch_result", status_code=400)
        if failure_code and not _SAFE_FAILURE_CODE.fullmatch(failure_code):
            raise ConnectTokenError("invalid_failure_code", status_code=400)
        if not receipt or len(receipt) > 128:
            raise ConnectTokenError("invalid_receipt", status_code=410)

        now = _now()
        receipt_hash = _capability_hash(receipt)
        updated = (
            self.db.query(RemoteSupportConnectToken)
            .filter(
                RemoteSupportConnectToken.receipt_hash == receipt_hash,
                RemoteSupportConnectToken.consumed_at.is_not(None),
                RemoteSupportConnectToken.reported_at.is_(None),
            )
            .update(
                {
                    RemoteSupportConnectToken.reported_at: now,
                    RemoteSupportConnectToken.launch_result: outcome,
                    RemoteSupportConnectToken.failure_code: failure_code if outcome == "failed" else None,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            self.db.rollback()
            raise ConnectTokenError("invalid_receipt", status_code=410)
        self.db.commit()
        return self.db.query(RemoteSupportConnectToken).filter_by(receipt_hash=receipt_hash).one()
