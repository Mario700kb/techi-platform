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
from typing import Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.agent_auth import _SlidingWindowRateLimiter
from app.core.time import utcnow
from app.db.session import SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.services.agent_revocation import is_agent_revoked
from app.websocket.agent_channel import agent_command_channel
from app.websocket.live_hub import device_live_hub, parse_agent_message

logger = logging.getLogger(__name__)

router = APIRouter()

# How a channel that died is noticed. A dead TCP connection (power cut, cable
# pulled, Wi-Fi gone) sends no FIN, so the read below would wait forever.
# Two layers find it:
#
# 1. WebSocket protocol pings from uvicorn: every 20 s, and a socket that does
#    not answer within 20 s is closed (Dockerfile: --ws-ping-interval 20
#    --ws-ping-timeout 20, the uvicorn defaults made explicit). The agent's
#    gorilla/websocket read loop answers pings by itself, through the proxy,
#    so a dead peer is found within 40 s of its last answer. This is what
#    catches a power cut or a lost network.
# 2. This idle timeout on the agent's own {"type":"ping"} every 60 s (or any
#    live frame): a backstop for an agent whose socket still answers protocol
#    pings but that has stopped working. 90 s is one ping interval plus 30 s
#    for a late ping (the write deadline is 10 s); a false close costs only a
#    reconnect, which the grace below absorbs.
IDLE_TIMEOUT_SECONDS = 90

# How long a dropped channel may stay down before the device counts as
# offline (connection_lost). Agents from 2.1.27 come back 5-65 s after a
# connection that was up for 2 minutes drops (a random spread, so the fleet
# does not return at once), plus the dial; 90 s covers that with room.
PRESENCE_GRACE_SECONDS = 90
# Older agents (the Linux 2.1.23 build) never reset their reconnect backoff,
# which grows to 2 min +-20%: up to 144 s, measured 145 s on device 812.
LEGACY_PRESENCE_GRACE_SECONDS = 150
# A drop while the agent updates itself is its service restarting around the
# package install, which can take minutes; the action itself expires at 600 s.
SELF_UPDATE_GRACE_SECONDS = 300
# The first agent version whose reconnect starts from the bottom after a
# healthy connection (command_channel.go reconnectAfterHealthy).
FAST_RECONNECT_AGENT_VERSION = (2, 1, 27)


def _version_tuple(version) -> tuple:
    parts = []
    for piece in str(version or "").strip().split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def presence_grace_seconds(agent_version) -> int:
    """The grace for a drop of this agent's channel: short for agents that
    reconnect within 65 s, the old 150 s for those that may take 144 s."""
    if _version_tuple(agent_version) >= FAST_RECONNECT_AGENT_VERSION:
        return PRESENCE_GRACE_SECONDS
    return max(PRESENCE_GRACE_SECONDS, LEGACY_PRESENCE_GRACE_SECONDS)


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


def _publish_presence(device_id: int, reason: str) -> None:
    """Tell the pages the channel's state changed (live, or reconnecting):
    the device's status itself has not changed, so nothing else would."""
    from app.services.device_status_service import DeviceStatusService

    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is not None and not device.is_archived:
            DeviceStatusService(db).publish_presence(device, reason)
    except Exception:
        logger.exception("[agent-channel] device #%d: presence event not published", device_id)
    finally:
        db.close()


def _mark_lost(device_id: int, disconnected_at, grace_seconds: int = PRESENCE_GRACE_SECONDS) -> None:
    from app.services.device_status_service import DeviceStatusService

    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is None:
            return
        service = DeviceStatusService(db)
        if service.mark_offline_connection_lost(device, disconnected_at):
            logger.info("[agent-channel] device #%d offline: channel lost for %ds", device_id, grace_seconds)
        elif not device.is_archived:
            # Still online (a heartbeat came after the drop) or already
            # offline for another reason: only the reconnecting state ends.
            service.publish_presence(device, "agent_channel_grace_ended")
    except Exception:
        logger.exception("[agent-channel] device #%d: could not record it offline", device_id)
    finally:
        db.close()


def _note_self_update_channel(device_id: int, connected: bool) -> bool:
    """A self_update in progress: the channel dropping is the agent service
    restarting, its return is the new agent starting up. True when one is."""
    from app.services.remote_action_service import RemoteActionService

    db = SessionLocal()
    try:
        return RemoteActionService(db).note_command_channel(device_id, connected)
    except Exception:
        logger.exception("[agent-channel] device #%d: self-update stage not recorded", device_id)
        return False
    finally:
        db.close()


async def _offline_after_grace(device_id: int, disconnected_at, grace_seconds: Optional[int] = None) -> None:
    grace = PRESENCE_GRACE_SECONDS if grace_seconds is None else grace_seconds
    try:
        await asyncio.sleep(grace)
    except asyncio.CancelledError:
        agent_command_channel.clear_lost(device_id, disconnected_at)
        raise
    if agent_command_channel.presence_paused or agent_command_channel.is_connected(device_id):
        agent_command_channel.clear_lost(device_id, disconnected_at)
        return
    if agent_command_channel.lost_since(device_id) not in (None, disconnected_at):
        # The channel came back and dropped again since: that later drop's
        # own check decides, with its own full grace period.
        return
    # Cleared first, so the offline (or still online) event the check
    # publishes no longer says "reconnecting".
    agent_command_channel.clear_lost(device_id, disconnected_at)
    await asyncio.to_thread(_mark_lost, device_id, disconnected_at, grace)


async def _after_drop(device_id: int, disconnected_at, agent_version) -> None:
    """Record a self-update's restart stage, then wait the grace that fits
    the drop: longer while the agent is updating itself."""
    updating = await asyncio.to_thread(_note_self_update_channel, device_id, False)
    grace = presence_grace_seconds(agent_version)
    if updating:
        grace = max(grace, SELF_UPDATE_GRACE_SECONDS)
    await _offline_after_grace(device_id, disconnected_at, grace)


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


def _authorize_channel(device_id: int, agent_id: str) -> tuple[Optional[int], Optional[str]]:
    """(close code, agent version): no close code when the agent may connect."""
    db = SessionLocal()
    try:
        device = DeviceRepository(db).get(device_id)
        if device is None or not _agent_id_matches(agent_id, getattr(device, "agent_id", None)):
            logger.info("[agent-channel] rejected device_id=%s (unknown device or agent_id mismatch)", device_id)
            return 4001, None
        if device.is_archived and is_agent_revoked(db, agent_id):
            logger.info("[agent-channel] rejected device_id=%s (agent revoked)", device_id)
            return 4003, None
        return None, getattr(device, "agent_version", None)
    finally:
        db.close()


def _on_connected(device_id: int) -> None:
    # The open channel is the agent saying it is up: online now, not at its
    # next heartbeat.
    _mark_connected(device_id)
    _note_self_update_channel(device_id, True)


# Handshakes run their database lookup in a worker thread (it ran on the event
# loop, so a reconnecting fleet blocked every other request), a few at a time.
# Past HANDSHAKE_MAX_WAITING the agent is told to come back later (1013): it
# retries after its own randomized backoff.
HANDSHAKE_CONCURRENCY = 8
HANDSHAKE_MAX_WAITING = 32
_handshake_slots = asyncio.Semaphore(HANDSHAKE_CONCURRENCY)
_handshakes_waiting = 0


@router.websocket("/ws/agent/commands")
async def agent_command_ws(websocket: WebSocket, device_id: int = 0, agent_id: str = ""):
    global _handshakes_waiting
    if not device_id or not agent_id:
        await websocket.close(code=4001)
        return

    if _handshakes_waiting >= HANDSHAKE_MAX_WAITING:
        await websocket.close(code=1013)
        return
    _handshakes_waiting += 1
    try:
        async with _handshake_slots:
            close_code, agent_version = await asyncio.to_thread(_authorize_channel, device_id, agent_id)
    finally:
        _handshakes_waiting -= 1
    if close_code is not None:
        await websocket.close(code=close_code)
        return

    await websocket.accept()
    await agent_command_channel.register(device_id, websocket)
    await asyncio.to_thread(_on_connected, device_id)
    if device_live_hub.has_viewers(device_id):
        # Someone has the device open: an agent that just (re)connected picks
        # the live view up at once instead of at the page's next renewal.
        await device_live_hub.request_live(device_id)
    shutting_down = False
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
    except WebSocketDisconnect as exc:
        # 1012: uvicorn closing every channel because the backend is stopping;
        # none of those drops means a device went offline.
        shutting_down = exc.code == 1012
    except asyncio.TimeoutError:
        logger.info("[agent-channel] device #%d idle past %ds; closing", device_id, IDLE_TIMEOUT_SECONDS)
    except Exception:
        logger.exception("[agent-channel] device #%d channel error", device_id)
    finally:
        was_current = await agent_command_channel.unregister(device_id, websocket)
        if was_current and not agent_command_channel.presence_paused and not shutting_down:
            disconnected_at = utcnow()
            agent_command_channel.note_lost(device_id, disconnected_at)
            task = asyncio.create_task(_after_drop(device_id, disconnected_at, agent_version))
            _offline_checks.add(task)
            task.add_done_callback(_offline_checks.discard)
            # At once, before the grace decides: the page stops saying "live"
            # and says it is waiting for the connection to come back.
            await asyncio.to_thread(_publish_presence, device_id, "agent_channel_dropped")
        try:
            await websocket.close()
        except Exception:
            pass
