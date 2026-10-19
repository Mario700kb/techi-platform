"""Which device an agent speaks for.

An agent's identity is its agent_id, the secret it got at enrollment. The
device_id it sends is the one it enrolled with, and agents up to 2.1.33 never
change it (they do not read the id a heartbeat returns). The server, though,
can give the same machine a new device row: a device deleted for good and let
back in comes back under a new id, and so did devices re-created after the
old immediate delete. On 2026-10-19 six agents' command channels, Mario-Lenovo
among them, were refused for exactly that: unknown device_id. Their
heartbeats, resolved by agent_id, kept them online, so nothing showed except
a device that never went live.

Every agent endpoint resolves the way the heartbeat does: the device named by
device_id when it carries this agent_id, otherwise the device that carries
it. Knowing the agent_id is what authenticates, in both cases.
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device
from app.repositories.device_repository import DeviceRepository

logger = logging.getLogger(__name__)

_STALE_LOG_EVERY_S = 3600.0
_stale_logged: dict[int, float] = {}


def agent_id_matches(provided: Optional[str], stored: Optional[str]) -> bool:
    """Both non-empty and equal, compared in constant time."""
    provided = (provided or "").strip()
    stored = (stored or "").strip()
    return bool(provided) and bool(stored) and secrets.compare_digest(provided, stored)


def resolve_agent_device(db: Session, device_id: Optional[int], agent_id: Optional[str]) -> Optional[Device]:
    agent_id = (agent_id or "").strip()
    if not agent_id:
        return None
    repo = DeviceRepository(db)
    if device_id:
        device = repo.get(device_id)
        if device is not None and agent_id_matches(agent_id, device.agent_id):
            return device
    device = repo.get_by_agent_id(agent_id)
    if device is not None and device_id and device.id != device_id:
        _note_stale(device_id, device.id)
    return device


def _note_stale(sent_id: int, device_id: int) -> None:
    now = time.monotonic()
    if now - _stale_logged.get(device_id, 0.0) < _STALE_LOG_EVERY_S:
        return
    _stale_logged[device_id] = now
    logger.info("agent of device #%d still sends device_id %d; accepted by its agent_id", device_id, sent_id)
