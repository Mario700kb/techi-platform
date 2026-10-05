"""Recent deployments = the fleet command batches operators actually ran.

A "deployment" in TECHI is a bulk command pushed to many devices at once
(agent self-update, remote password rollout, PowerShell, ...). Each batch and
its per-device remote actions are already persisted, so this reads them back
instead of inventing rows.
"""
from typing import List

from sqlalchemy.orm import Session

from app.schemas.agent_command import BatchSummary
from app.schemas.deployment import DeploymentStatus, RecentDeployment
from app.services.agent_command_service import AgentCommandService


def deployment_status(summary: BatchSummary) -> DeploymentStatus:
    """success: every device completed · warning: some did not ·
    failed: none completed · running: devices still pending."""
    if not summary.finished:
        return "running"
    unsuccessful = summary.failed + summary.timeout
    if unsuccessful == 0:
        return "success"
    if summary.completed == 0:
        return "failed"
    return "warning"


def recent_deployments(db: Session, limit: int = 5) -> List[RecentDeployment]:
    summaries = AgentCommandService(db).get_history(limit=limit)
    return [
        RecentDeployment(
            id=summary.batch_id,
            command_type=summary.command_type,
            target=summary.target,
            total=summary.total,
            completed=summary.completed,
            failed=summary.failed,
            timeout=summary.timeout,
            status=deployment_status(summary),
            timestamp=summary.created_at,
            created_by_name=summary.created_by_name,
        )
        for summary in summaries
    ]
