"""Live device view: who is watching which device, and the frames between them.

An operator opening a device page connects to /ws/devices/{id}/live. While at
least one page is open the server keeps asking the device's agent, over its
command channel, to stream a small snapshot every few seconds; the agent stops
on its own when the requests stop (the request carries a TTL), so a page closed
without a goodbye or a backend restart never leaves an agent streaming.

Frames go from the agent straight to the open pages. Nothing is written to the
database, and a device nobody is watching costs nothing beyond its idle
command channel.
"""
import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

from fastapi import WebSocket
from pydantic import ValidationError

from app.schemas.device_live import LiveSnapshot
from app.websocket.agent_channel import agent_command_channel

logger = logging.getLogger(__name__)

LIVE_INTERVAL_SECONDS = 3
# The agent streams this long after the last request. The page renews well
# inside it, so one lost renewal does not interrupt the view.
LIVE_TTL_SECONDS = 45
LIVE_RENEW_SECONDS = 15
# A snapshot is about 2 KB; anything far larger is not one.
LIVE_FRAME_MAX_BYTES = 16 * 1024
# Frames closer together than this are dropped, whatever the agent sends.
LIVE_MIN_FRAME_GAP_SECONDS = 1.0
_VIEWER_SEND_TIMEOUT_SECONDS = 2.0


class _Viewer:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.lock = asyncio.Lock()

    async def send(self, payload: Dict[str, Any]) -> bool:
        try:
            async with self.lock:
                await asyncio.wait_for(self.websocket.send_json(payload), timeout=_VIEWER_SEND_TIMEOUT_SECONDS)
            return True
        except Exception:
            return False


class DeviceLiveHub:
    def __init__(self) -> None:
        self._viewers: Dict[int, Dict[int, _Viewer]] = {}
        self._last_frame_at: Dict[int, float] = {}
        self._lock = asyncio.Lock()

    async def add_viewer(self, device_id: int, websocket: WebSocket) -> _Viewer:
        viewer = _Viewer(websocket)
        async with self._lock:
            self._viewers.setdefault(device_id, {})[id(websocket)] = viewer
        return viewer

    async def remove_viewer(self, device_id: int, websocket: WebSocket) -> bool:
        """Returns True when that was the device's last viewer."""
        async with self._lock:
            viewers = self._viewers.get(device_id)
            if not viewers:
                return False
            viewers.pop(id(websocket), None)
            if viewers:
                return False
            self._viewers.pop(device_id, None)
            self._last_frame_at.pop(device_id, None)
            return True

    def has_viewers(self, device_id: int) -> bool:
        return bool(self._viewers.get(device_id))

    def viewer_count(self, device_id: int) -> int:
        return len(self._viewers.get(device_id) or {})

    async def request_live(self, device_id: int) -> bool:
        """Ask the agent to stream (or keep streaming). False when the agent
        has no open command channel, so the page can say why nothing moves."""
        return await agent_command_channel.push(
            device_id,
            {"type": "live_start", "interval_seconds": LIVE_INTERVAL_SECONDS, "ttl_seconds": LIVE_TTL_SECONDS},
        )

    async def stop_live(self, device_id: int) -> None:
        await agent_command_channel.push(device_id, {"type": "live_stop"})

    async def publish(self, device_id: int, data: Any) -> int:
        """Forward one agent frame to the device's open pages. Returns how
        many received it; a frame nobody watches, an oversized or malformed
        one, or one too soon after the last is dropped."""
        viewers = list((self._viewers.get(device_id) or {}).values())
        if not viewers:
            return 0
        now = time.monotonic()
        last = self._last_frame_at.get(device_id)
        if last is not None and now - last < LIVE_MIN_FRAME_GAP_SECONDS:
            return 0
        try:
            snapshot = LiveSnapshot.model_validate(data)
        except ValidationError:
            logger.info("[live] device #%d sent a malformed frame; dropped", device_id)
            return 0
        self._last_frame_at[device_id] = now
        payload = {"type": "live", "device_id": device_id, "data": snapshot.model_dump(exclude_none=True)}
        results = await asyncio.gather(*(viewer.send(payload) for viewer in viewers))
        return sum(1 for ok in results if ok)


def parse_agent_message(text: str) -> Optional[Dict[str, Any]]:
    """An agent message on the command channel, or None for anything that is
    not a small JSON object (pings included)."""
    if not text or len(text) > LIVE_FRAME_MAX_BYTES:
        return None
    try:
        message = json.loads(text)
    except ValueError:
        return None
    return message if isinstance(message, dict) else None


device_live_hub = DeviceLiveHub()
