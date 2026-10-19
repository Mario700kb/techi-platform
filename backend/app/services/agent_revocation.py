"""Agents the platform no longer accepts (see app.models.revoked_agent).

An archived or trashed device's agent is revoked: its heartbeats get 410 and
its command channel is refused, so the device does not come back as a new
row while the agent is still installed. Agents up to 2.1.33 do not know the
answer and keep retrying on their normal interval; each attempt costs one
indexed lookup, and the time of the last one is kept for the console.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.time import utcnow_naive
from app.models.device import Device
from app.models.revoked_agent import RevokedAgent

logger = logging.getLogger(__name__)

# How often an attempt by a revoked agent is written down: often enough to
# say "still trying", rarely enough that a retrying agent costs no writes.
ATTEMPT_NOTE_INTERVAL = timedelta(minutes=10)


class AgentRevokedError(ValueError):
    """The heartbeat comes from a revoked agent."""


def revoke_device_agent(db: Session, device: Device, *, by: Optional[str], reason: Optional[str]) -> bool:
    """Revoke the device's agent. Does not commit. False when the device has
    no agent (nothing to refuse)."""
    agent_id = (device.agent_id or "").strip()
    if not agent_id:
        return False
    row = db.query(RevokedAgent).filter(RevokedAgent.agent_id == agent_id).first()
    if row is None:
        row = RevokedAgent(agent_id=agent_id, attempt_count=0)
        db.add(row)
    row.device_id = device.id
    row.hostname = device.hostname
    row.client_id = device.client_id
    row.reason = (reason or "")[:500] or None
    row.revoked_at = utcnow_naive()
    row.revoked_by = by
    from app.services.device_heartbeat_service import _evict_agent_cache

    _evict_agent_cache(agent_id)
    return True


def unrevoke_device_agent(db: Session, device: Device) -> int:
    """Accept the device's agent again. Does not commit."""
    query = db.query(RevokedAgent).filter(RevokedAgent.device_id == device.id)
    if device.agent_id:
        query = db.query(RevokedAgent).filter(
            (RevokedAgent.device_id == device.id) | (RevokedAgent.agent_id == device.agent_id)
        )
    return query.delete(synchronize_session=False)


def is_agent_revoked(db: Session, agent_id: Optional[str]) -> bool:
    agent_id = (agent_id or "").strip()
    if not agent_id:
        return False
    return db.query(RevokedAgent.id).filter(RevokedAgent.agent_id == agent_id).first() is not None


def refuse_if_revoked(db: Session, agent_id: Optional[str], ip: Optional[str] = None) -> None:
    """Raise AgentRevokedError for a revoked agent, noting the attempt at
    most every ATTEMPT_NOTE_INTERVAL."""
    agent_id = (agent_id or "").strip()
    if not agent_id:
        return
    row = db.query(RevokedAgent).filter(RevokedAgent.agent_id == agent_id).first()
    if row is None:
        return
    now = utcnow_naive()
    if row.last_attempt_at is None or now - row.last_attempt_at >= ATTEMPT_NOTE_INTERVAL:
        row.last_attempt_at = now
        row.last_attempt_ip = (ip or "")[:64] or None
        row.attempt_count = (row.attempt_count or 0) + 1
        try:
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("revoked agent: could not note attempt for device %s", row.device_id)
    raise AgentRevokedError("This agent was revoked: its device is archived or deleted in TECHI.")


def close_agent_channel(device_id: int) -> None:
    """Drop the device's open command channel, if any (best effort; sync
    callers run in a worker thread, so the close goes to the main loop)."""
    import asyncio

    from app.websocket.agent_channel import agent_command_channel, get_main_loop

    if not agent_command_channel.is_connected(device_id):
        return
    loop = get_main_loop()
    if loop is None:
        return
    try:
        asyncio.run_coroutine_threadsafe(agent_command_channel.close_device(device_id), loop)
    except Exception:
        logger.exception("revoked agent: could not close channel of device %s", device_id)
