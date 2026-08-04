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

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db.session import SessionLocal
from app.repositories.device_repository import DeviceRepository
from app.websocket.agent_channel import agent_command_channel

logger = logging.getLogger(__name__)

router = APIRouter()

# The agent sends a ping on this cadence; anything longer than a comfortable
# multiple of it means the socket is dead in a way TCP has not noticed yet.
IDLE_TIMEOUT_SECONDS = 180


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
    try:
        while True:
            # The agent is not expected to say anything meaningful; this read
            # exists to notice the disconnect and to time out a socket that has
            # gone quiet. Payloads are ignored on purpose — this channel is
            # push-only, so an agent cannot use it to ask the server for
            # anything it could not already request over HTTP.
            await asyncio.wait_for(websocket.receive_text(), timeout=IDLE_TIMEOUT_SECONDS)
    except WebSocketDisconnect:
        pass
    except asyncio.TimeoutError:
        logger.info("[agent-channel] device #%d idle past %ds; closing", device_id, IDLE_TIMEOUT_SECONDS)
    except Exception:
        logger.exception("[agent-channel] device #%d channel error", device_id)
    finally:
        await agent_command_channel.unregister(device_id, websocket)
        try:
            await websocket.close()
        except Exception:
            pass
