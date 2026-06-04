import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models.operator import Operator
from app.repositories.audit_log_repository import AuditLogRepository

logger = logging.getLogger(__name__)


class AuditAction:
    LOGIN = "login"
    OPERATOR_CREATED = "operator_created"
    OPERATOR_UPDATED = "operator_updated"
    OPERATOR_DELETED = "operator_deleted"
    OPERATOR_PASSWORD_RESET = "operator_password_reset"
    DEVICE_ARCHIVED = "device_archived"
    DEVICE_RESTORED = "device_restored"
    DEVICE_DELETED = "device_deleted"
    ENROLLMENT_TOKEN_REGENERATED = "enrollment_token_regenerated"
    ENROLLMENT_TOKEN_VIEWED = "enrollment_token_viewed"
    ENROLLMENT_TOKEN_UPDATED = "enrollment_token_updated"
    ENROLLMENT_TOKEN_DEPLOYMENT_VIEWED = "enrollment_token_deployment_viewed"
    ENROLLMENT_TOKEN_BOOTSTRAP_DOWNLOADED = "enrollment_token_bootstrap_downloaded"
    ENROLLMENT_TOKEN_REVOKED = "enrollment_token_revoked"
    ENROLLMENT_TOKEN_DELETED = "enrollment_token_deleted"
    BOOTSTRAP_SCRIPT_SERVED = "bootstrap_script_served"
    AGENT_PACKAGE_ACTIVATED = "agent_package_activated"
    AGENT_PACKAGE_DEACTIVATED = "agent_package_deactivated"
    AGENT_PACKAGE_DELETED = "agent_package_deleted"
    MAINTENANCE_ENTERED = "maintenance_entered"
    MAINTENANCE_CLEARED = "maintenance_cleared"
    NOTE_CREATED = "note_created"
    NOTE_UPDATED = "note_updated"
    NOTE_DELETED = "note_deleted"
    ACTION_QUEUED = "action_queued"
    ACTION_CANCELLED = "action_cancelled"
    ACTION_RETRIED = "action_retried"
    SCOPE_ENTRY_ADDED = "scope_entry_added"
    SCOPE_ENTRY_REMOVED = "scope_entry_removed"
    SCOPE_REPLACED = "scope_replaced"
    REMOTE_CONNECT = "remote_connect"
    TEAM_CREATED = "team_created"
    TEAM_UPDATED = "team_updated"
    TEAM_DELETED = "team_deleted"
    TEAM_MEMBER_ADDED = "team_member_added"
    TEAM_MEMBER_REMOVED = "team_member_removed"
    TEAM_ACCESS_UPDATED = "team_access_updated"
    UPDATE_OPERATOR = "operator_updated"


def audit_log(
    db: Session,
    *,
    operator: Operator,
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    details: Optional[dict] = None,
) -> None:
    """Write an audit entry. Never raises — failures are logged and swallowed."""
    try:
        AuditLogRepository(db).create(
            operator_id=operator.id,
            operator_username=operator.username,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
    except Exception:
        logger.exception("audit_log write failed action=%s operator=%s", action, operator.username)


def system_audit_log(
    db: Session,
    *,
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    details: Optional[dict] = None,
) -> None:
    """Write an audit entry for unauthenticated/system flows."""
    try:
        AuditLogRepository(db).create(
            operator_id=None,
            operator_username="system",
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
    except Exception:
        logger.exception("system_audit_log write failed action=%s", action)
