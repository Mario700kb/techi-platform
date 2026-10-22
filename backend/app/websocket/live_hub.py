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
        # (device, invalid fields) already logged: a bad value repeats every frame.
        self._logged_bad: set = set()

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
        snapshot = self._validate(device_id, data)
        if snapshot is None:
            return 0
        self._last_frame_at[device_id] = now
        payload = {"type": "live", "device_id": device_id, "data": snapshot.model_dump(exclude_none=True)}
        results = await asyncio.gather(*(viewer.send(payload) for viewer in viewers))
        return sum(1 for ok in results if ok)


    def _validate(self, device_id: int, data: Any) -> Optional[LiveSnapshot]:
        """The frame as a snapshot. One bad value (a disk or process the agent
        could not measure, sent as a huge negative number) no longer costs the
        whole frame: that item or field is left out and the rest is shown.
        A frame with nothing usable left is dropped."""
        try:
            return LiveSnapshot.model_validate(data)
        except ValidationError as exc:
            salvaged = _salvage(data, exc)
            fields = sorted({_field_name(e.get("loc") or ()) for e in exc.errors()})
        snapshot = None
        if salvaged is not None:
            try:
                snapshot = LiveSnapshot.model_validate(salvaged)
            except ValidationError:
                snapshot = None
        if snapshot is not None and not _has_content(snapshot):
            snapshot = None
        # Which fields, never their values; once per device and field set.
        key = (device_id, tuple(fields))
        if key not in self._logged_bad:
            self._logged_bad.add(key)
            logger.info(
                "[live] device #%d sent invalid %s; %s",
                device_id, ", ".join(fields) or "frame", "left out" if snapshot is not None else "frame dropped",
            )
        return snapshot


def _field_name(loc) -> str:
    if not loc:
        return "frame"
    if len(loc) >= 3 and isinstance(loc[1], int):
        return f"{loc[0]}[].{loc[2]}"
    return str(loc[0])


def _salvage(data: Any, exc: ValidationError) -> Optional[Dict[str, Any]]:
    """The frame without what failed: list items by index, other fields whole."""
    if not isinstance(data, dict):
        return None
    out = dict(data)
    drop_items: Dict[str, set] = {}
    for error in exc.errors():
        loc = error.get("loc") or ()
        if not loc:
            return None
        field = loc[0]
        if len(loc) >= 2 and isinstance(loc[1], int) and isinstance(out.get(field), list):
            drop_items.setdefault(field, set()).add(loc[1])
        else:
            out.pop(field, None)
    for field, indexes in drop_items.items():
        if isinstance(out.get(field), list):
            out[field] = [item for i, item in enumerate(out[field]) if i not in indexes]
    return out


def _has_content(snapshot: LiveSnapshot) -> bool:
    dumped = snapshot.model_dump(exclude_none=True)
    dumped.pop("at", None)
    return any(value not in ([], "") for value in dumped.values())


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
