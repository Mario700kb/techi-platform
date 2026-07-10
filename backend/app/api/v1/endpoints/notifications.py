"""Notification Engine API (flag-gated by FEATURE_NOTIFICATIONS).

With the flag off every route returns 404 — same darkness contract as Vault
and Terminal. Role gates mirror Vault: list/read → operator+,
create/update/delete/test → admin+. Every mutation is audited.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import get_current_operator, require_min_role
from app.db.session import get_db
from app.models.operator import Operator, OperatorRole
from app.platform_core.flags import feature_enabled
from app.schemas.notification import (
    NotificationChannelCreate,
    NotificationChannelOut,
    NotificationChannelUpdate,
    NotificationDeliveryList,
    NotificationDeliveryOut,
    NotificationRuleCreate,
    NotificationRuleOut,
    NotificationRuleUpdate,
    NotificationTestRequest,
    NotificationTestResult,
)
from app.repositories.notification_repository import (
    NotificationChannelRepository,
    NotificationDeliveryRepository,
    NotificationRuleRepository,
)
from app.services.audit_service import AuditAction, audit_log
from app.services.notification_service import NotificationService

logger = logging.getLogger(__name__)

router = APIRouter()

_require_operator = require_min_role(OperatorRole.OPERATOR.value)
_require_admin = require_min_role(OperatorRole.ADMIN.value)


def _require_notifications_enabled() -> None:
    if not feature_enabled("FEATURE_NOTIFICATIONS"):
        raise HTTPException(status_code=404, detail="Not Found")


def _channel_out(channel) -> NotificationChannelOut:
    config = NotificationService._decode_config(channel)
    return NotificationChannelOut(
        id=channel.id,
        name=channel.name,
        channel_type=channel.channel_type,
        enabled=channel.enabled,
        config=config,
        has_secret=bool(channel.secret_ciphertext),
        created_by=channel.created_by,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
    )


def _get_channel_or_404(db: Session, channel_id: int):
    channel = NotificationChannelRepository(db).get(channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    return channel


def _get_rule_or_404(db: Session, rule_id: int):
    rule = NotificationRuleRepository(db).get(rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    return rule


# ---- Channels -------------------------------------------------------------

@router.get("/channels", response_model=List[NotificationChannelOut], dependencies=[Depends(_require_notifications_enabled)])
def list_channels(db: Session = Depends(get_db), _: Operator = Depends(_require_operator)):
    return [_channel_out(c) for c in NotificationChannelRepository(db).list()]


@router.post("/channels", response_model=NotificationChannelOut, dependencies=[Depends(_require_notifications_enabled)])
def create_channel(
    payload: NotificationChannelCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    ciphertext, dek_wrapped = (None, None)
    if payload.secret:
        ciphertext, dek_wrapped = NotificationService.encrypt_secret_for_storage(payload.secret)
    channel = NotificationChannelRepository(db).create(
        name=payload.name,
        channel_type=payload.channel_type.value,
        enabled=payload.enabled,
        config_json=NotificationService.encode_config(payload.config),
        secret_ciphertext=ciphertext,
        secret_dek_wrapped=dek_wrapped,
        created_by=operator.username,
    )
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_CHANNEL_CREATED,
        entity_type="notification_channel", entity_id=channel.id,
        details={"name": channel.name, "channel_type": channel.channel_type},
    )
    return _channel_out(channel)


@router.patch("/channels/{channel_id}", response_model=NotificationChannelOut, dependencies=[Depends(_require_notifications_enabled)])
def update_channel(
    channel_id: int,
    payload: NotificationChannelUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    channel = _get_channel_or_404(db, channel_id)
    updates = {}
    if payload.name is not None:
        updates["name"] = payload.name
    if payload.enabled is not None:
        updates["enabled"] = payload.enabled
    if payload.config is not None:
        updates["config_json"] = NotificationService.encode_config(payload.config)
    if payload.secret is not None:
        ciphertext, dek_wrapped = NotificationService.encrypt_secret_for_storage(payload.secret)
        updates["secret_ciphertext"] = ciphertext
        updates["secret_dek_wrapped"] = dek_wrapped
    channel = NotificationChannelRepository(db).update(channel, **updates)
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_CHANNEL_UPDATED,
        entity_type="notification_channel", entity_id=channel.id, details={"name": channel.name},
    )
    return _channel_out(channel)


@router.delete("/channels/{channel_id}", status_code=204, dependencies=[Depends(_require_notifications_enabled)])
def delete_channel(
    channel_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    channel = _get_channel_or_404(db, channel_id)
    name = channel.name
    NotificationChannelRepository(db).delete(channel)
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_CHANNEL_DELETED,
        entity_type="notification_channel", entity_id=channel_id, details={"name": name},
    )


@router.post("/channels/{channel_id}/test", response_model=NotificationTestResult, dependencies=[Depends(_require_notifications_enabled)])
def test_channel(
    channel_id: int,
    payload: NotificationTestRequest,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    channel = _get_channel_or_404(db, channel_id)
    ok, error = NotificationService(db).send_test(channel, payload.message)
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_CHANNEL_TESTED,
        entity_type="notification_channel", entity_id=channel.id,
        details={"name": channel.name, "success": ok},
    )
    return NotificationTestResult(success=ok, error=error)


# ---- Rules ------------------------------------------------------------

@router.get("/rules", response_model=List[NotificationRuleOut], dependencies=[Depends(_require_notifications_enabled)])
def list_rules(db: Session = Depends(get_db), _: Operator = Depends(_require_operator)):
    return NotificationRuleRepository(db).list()


@router.post("/rules", response_model=NotificationRuleOut, dependencies=[Depends(_require_notifications_enabled)])
def create_rule(
    payload: NotificationRuleCreate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    _get_channel_or_404(db, payload.channel_id)
    rule = NotificationRuleRepository(db).create(
        event_type=payload.event_type,
        scope_type=payload.scope_type.value,
        client_id=payload.client_id,
        channel_id=payload.channel_id,
        enabled=payload.enabled,
        min_severity=payload.min_severity,
        cooldown_seconds=payload.cooldown_seconds,
        rate_limit_per_hour=payload.rate_limit_per_hour,
        created_by=operator.username,
    )
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_RULE_CREATED,
        entity_type="notification_rule", entity_id=rule.id,
        details={"event_type": rule.event_type, "channel_id": rule.channel_id},
    )
    return rule


@router.patch("/rules/{rule_id}", response_model=NotificationRuleOut, dependencies=[Depends(_require_notifications_enabled)])
def update_rule(
    rule_id: int,
    payload: NotificationRuleUpdate,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    rule = _get_rule_or_404(db, rule_id)
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items()}
    rule = NotificationRuleRepository(db).update(rule, **updates)
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_RULE_UPDATED,
        entity_type="notification_rule", entity_id=rule.id, details={"event_type": rule.event_type},
    )
    return rule


@router.delete("/rules/{rule_id}", status_code=204, dependencies=[Depends(_require_notifications_enabled)])
def delete_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    operator: Operator = Depends(_require_admin),
):
    rule = _get_rule_or_404(db, rule_id)
    event_type = rule.event_type
    NotificationRuleRepository(db).delete(rule)
    audit_log(
        db, operator=operator, action=AuditAction.NOTIFICATION_RULE_DELETED,
        entity_type="notification_rule", entity_id=rule_id, details={"event_type": event_type},
    )


# ---- Delivery history ---------------------------------------------------

@router.get("/deliveries", response_model=NotificationDeliveryList, dependencies=[Depends(_require_notifications_enabled)])
def list_deliveries(
    channel_id: Optional[int] = Query(default=None),
    event_type: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _: Operator = Depends(_require_operator),
):
    items, total = NotificationDeliveryRepository(db).list_history(
        channel_id=channel_id, event_type=event_type, status=status, limit=limit, offset=offset,
    )
    return NotificationDeliveryList(items=[NotificationDeliveryOut.model_validate(d) for d in items], total=total)
