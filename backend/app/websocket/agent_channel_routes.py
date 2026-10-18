"""WebSocket route for the agent command channel.

`/ws/agent/commands?device_id=<id>&agent_id=<secret>`

The agent dials this outbound and holds it open. The server pushes queued
actions on it instead of waiting for the next heartbeat. See
app/websocket/agent_channel.py for why, and for the guarantees this does and
does not provide.

Authentication is the same knowledge barrier used by the heartbeat response
gate: the caller must present the device's own `agent_id`. That is a bearer
secret a local administrator can read, not proof of identity — it is the bridge
to the RSA challenge/response in AgentAuthMigrationService, not a replacement
(RISK-SEC-002). Nothing on this channel is more sensitive than what the same
agent already receives in its heartbeat response.
"""

import asyncio
import logging
import secrets
from typing import Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.agent_auth import _SlidingWindowRateLimiter
from app.core.time import utcnow
from app.db.session import SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.websocket.agent_channel import agent_command_channel
from app.websocket.live_hub import device_live_hub, parse_agent_message

logger = logging.getLogger(__name__)

router = APIRouter()

# The agent sends a ping on this cadence; anything longer than a comfortable
# multiple of it means the socket is dead in a way TCP has not noticed yet.
IDLE_TIMEOUT_SECONDS = 180

# How long a dropped channel may stay down before the device counts as
# offline. Agents from 2.1.27 return within 5-65 s after a backend restart or
# their own service restart; the Linux 2.1.23 agent backs off up to ~144 s.
PRESENCE_GRACE_SECONDS = 150

# Pending offline checks, kept so they are not garbage-collected mid-sleep and
# can be cancelled at shutdown.
_offline_checks: Set[asyncio.Task] = set()


def _mark_connected(device_id: int) -> None:
    from app.services.device_status_service import DeviceStatusService

    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is not None and not device.is_archived:
            DeviceStatusService(db).mark_online_from_channel(device)
    except Exception:
        logger.exception("[agent-channel] device #%d: could not record it online", device_id)
    finally:
        db.close()


def _mark_lost(device_id: int, disconnected_at) -> None:
    from app.services.device_status_service import DeviceStatusService

    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is not None and DeviceStatusService(db).mark_offline_connection_lost(device, disconnected_at):
            logger.info("[agent-channel] device #%d offline: channel lost for %ds", device_id, PRESENCE_GRACE_SECONDS)
    except Exception:
        logger.exception("[agent-channel] device #%d: could not record it offline", device_id)
    finally:
        db.close()


def _note_self_update_channel(device_id: int, connected: bool) -> None:
    """A self_update in progress: the channel dropping is the agent service
    restarting, its return is the new agent starting up."""
    from app.services.remote_action_service import RemoteActionService

    db = SessionLocal()
    try:
        RemoteActionService(db).note_command_channel(device_id, connected)
    except Exception:
        logger.exception("[agent-channel] device #%d: self-update stage not recorded", device_id)
    finally:
        db.close()


async def _offline_after_grace(device_id: int, disconnected_at) -> None:
    await asyncio.sleep(PRESENCE_GRACE_SECONDS)
    if agent_command_channel.presence_paused or agent_command_channel.is_connected(device_id):
        return
    await asyncio.to_thread(_mark_lost, device_id, disconnected_at)


# A device reports a monitor only when it changes state; this ceiling stops a
# flapping or misbehaving agent from flooding the alert engine.
_monitor_limiter = _SlidingWindowRateLimiter(limit=60, window_seconds=60)


def _apply_monitor_event(device_id: int, raw) -> None:
    from pydantic import ValidationError

    from app.schemas.telemetry_pipeline import MonitorEvent
    from app.services.monitor_alert_service import MonitorAlertService
    from app.services.monitoring_policy_service import effective_policy

    try:
        event = MonitorEvent.model_validate(raw)
    except ValidationError:
        logger.info("[agent-channel] device #%d sent a malformed monitor event; dropped", device_id)
        return
    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is not None and not device.is_archived:
            MonitorAlertService(db).apply(device, event, effective_policy(db, device))
    except Exception:
        logger.exception("[agent-channel] device #%d: monitor event failed", device_id)
    finally:
        db.close()


def cancel_presence_checks() -> None:
    """Shutdown: every channel drops with the process, which says nothing
    about the devices."""
    agent_command_channel.presence_paused = True
    for task in list(_offline_checks):
        task.cancel()


def _agent_id_matches(provided: str, stored: str) -> bool:
    provided = (provided or "").strip()
    stored = (stored or "").strip()
    if not provided or not stored:
        return False
    return secrets.compare_digest(provided, stored)


@router.websocket("/ws/agent/commands")
async def agent_command_ws(websocket: WebSocket, device_id: int = 0, agent_id: str = ""):
    if not device_id or not agent_id:
        await websocket.close(code=4001)
        return

    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is None or not _agent_id_matches(agent_id, getattr(device, "agent_id", None)):
            logger.info("[agent-channel] rejected device_id=%s (unknown device or agent_id mismatch)", device_id)
            await websocket.close(code=4001)
            return
    finally:
        db.close()

    await websocket.accept()
    await agent_command_channel.register(device_id, websocket)
    # The open channel is the agent saying it is up: online now, not at its
    # next heartbeat.
    await asyncio.to_thread(_mark_connected, device_id)
    await asyncio.to_thread(_note_self_update_channel, device_id, True)
    if device_live_hub.has_viewers(device_id):
        # Someone has the device open: an agent that just (re)connected picks
        # the live view up at once instead of at the page's next renewal.
        await device_live_hub.request_live(device_id)
    try:
        while True:
            # The agent sends pings, and live frames while someone watches the
            # device. Nothing else is acted on: an agent cannot use this
            # channel to ask the server for anything it could not already
            # request over HTTP. The read also times out a socket gone quiet.
            text = await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
            message = parse_agent_message(text)
            if message is not None and message.get("type") == "live":
                await device_live_hub.publish(device_id, message.get("data"))
            elif message is not None and message.get("type") == "monitor":
                if _monitor_limiter.is_allowed(f"device:{device_id}"):
                    await asyncio.to_thread(_apply_monitor_event, device_id, message.get("event"))
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        logger.info("[agent-channel] device #%d idle past %ds; closing", device_id, IDLE_TIMEOUT_SECONDS)
    except Exception:
        logger.exception("[agent-channel] device #%d channel error", device_id)
    finally:
        was_current = await agent_command_channel.unregister(device_id, websocket)
        if was_current and not agent_command_channel.presence_paused:
            task = asyncio.create_task(_offline_after_grace(device_id, utcnow()))
            _offline_checks.add(task)
            task.add_done_callback(_offline_checks.discard)
            await asyncio.to_thread(_note_self_update_channel, device_id, False)
        try:
            await websocket.close()
        except Exception:
            pass
