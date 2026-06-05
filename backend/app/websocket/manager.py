import asyncio
import logging
from dataclasses import dataclass, field
from collections import defaultdict
from typing import Any, Dict, Optional, TYPE_CHECKING
from uuid import uuid4

from fastapi import WebSocket

from app.core.time import utcnow
from app.websocket.events import RealtimeEventType, build_event

if TYPE_CHECKING:
    from app.core.scope import AllowedScope

logger = logging.getLogger(__name__)


@dataclass
class RealtimeConnection:
    websocket: WebSocket
    tenant_id: str
    channel: str
    # None = unrestricted (admin/owner bypass). AllowedScope = operator/readonly restriction.
    operator_scope: Optional["AllowedScope"] = None
    connection_id: str = field(default_factory=lambda: str(uuid4()))
    connected_at: str = field(default_factory=lambda: utcnow().isoformat())
    last_seen_at: str = field(default_factory=lambda: utcnow().isoformat())

    def touch(self) -> None:
        self.last_seen_at = utcnow().isoformat()


class RealtimeConnectionManager:
    def __init__(self) -> None:
        self._connections: Dict[str, Dict[str, RealtimeConnection]] = defaultdict(dict)
        self._lock = asyncio.Lock()
        self._send_timeout_seconds = 5.0

    async def connect(
        self,
        websocket: WebSocket,
        *,
        tenant_id: str = "default",
        channel: str = "devices",
        operator_scope: Optional["AllowedScope"] = None,
    ) -> str:
        await websocket.accept()
        connection = RealtimeConnection(
            websocket=websocket,
            tenant_id=tenant_id,
            channel=channel,
            operator_scope=operator_scope,
        )
        async with self._lock:
            self._connections[tenant_id][connection.connection_id] = connection

        await websocket.send_json(
            build_event(
                RealtimeEventType.CONNECTION_READY,
                tenant_id=tenant_id,
                data={
                    "message": "connected",
                    "connection_id": connection.connection_id,
                    "channel": channel,
                },
            )
        )
        logger.info(
            "Websocket connected tenant=%s channel=%s connection_id=%s total=%s scoped=%s",
            tenant_id,
            channel,
            connection.connection_id,
            await self.connection_count(tenant_id=tenant_id),
            operator_scope is not None,
        )
        return connection.connection_id

    async def disconnect(self, connection_id: str, *, tenant_id: str = "default") -> None:
        async with self._lock:
            removed = self._connections[tenant_id].pop(connection_id, None)
            if not self._connections[tenant_id]:
                self._connections.pop(tenant_id, None)
        if removed:
            logger.info("Websocket disconnected tenant=%s connection_id=%s", tenant_id, connection_id)

    async def touch(self, connection_id: str, *, tenant_id: str = "default") -> None:
        async with self._lock:
            connection = self._connections.get(tenant_id, {}).get(connection_id)
            if connection:
                connection.touch()

    async def broadcast(self, event: Dict[str, Any]) -> None:
        tenant_id = event.get("tenant_id") or "default"
        async with self._lock:
            connections = list(self._connections.get(tenant_id, {}).values())

        if not connections:
            return

        results = await asyncio.gather(
            *(self._send_scoped(connection, event) for connection in connections),
            return_exceptions=True,
        )
        stale_connection_ids = [
            connection.connection_id
            for connection, result in zip(connections, results)
            if result is False or isinstance(result, Exception)
        ]

        if stale_connection_ids:
            async with self._lock:
                for connection_id in stale_connection_ids:
                    self._connections[tenant_id].pop(connection_id, None)
                if not self._connections.get(tenant_id):
                    self._connections.pop(tenant_id, None)
            logger.info("Removed %s stale websocket connections", len(stale_connection_ids))

    async def connection_count(self, *, tenant_id: Optional[str] = None) -> int:
        async with self._lock:
            if tenant_id:
                return len(self._connections.get(tenant_id, {}))
            return sum(len(connections) for connections in self._connections.values())

    @staticmethod
    def _event_in_scope(event: Dict[str, Any], scope: Optional["AllowedScope"]) -> bool:
        """Return True if *event* should be delivered to a connection with *scope*.

        scope=None means unrestricted (admin/owner) — always deliver.
        Events without device-identifying data are delivered to all connections.
        Device events are filtered by client_id / group_id / device_id.
        """
        if scope is None:
            return True

        data = event.get("data") or {}
        client_id = data.get("client_id")
        group_id  = data.get("group_id")
        device_id = data.get("id")

        # Non-device events (deployment_event, connection_ready, server_ping, etc.)
        # have no device-identifying fields → broadcast to all authenticated users.
        if client_id is None and group_id is None and device_id is None:
            return True

        from app.core.scope import device_in_scope
        return device_in_scope(client_id, group_id, device_id, scope)

    async def _send_scoped(self, connection: RealtimeConnection, event: Dict[str, Any]) -> bool:
        """Send *event* to *connection* only if the event is within the connection's scope."""
        if not self._event_in_scope(event, connection.operator_scope):
            return True  # Suppressed — not a send failure
        return await self._send(connection, event)

    async def _send(self, connection: RealtimeConnection, event: Dict[str, Any]) -> bool:
        try:
            await asyncio.wait_for(
                connection.websocket.send_json(event),
                timeout=self._send_timeout_seconds,
            )
            connection.touch()
            return True
        except Exception:
            logger.debug(
                "Websocket send failed tenant=%s connection_id=%s",
                connection.tenant_id,
                connection.connection_id,
                exc_info=True,
            )
            return False


realtime_manager = RealtimeConnectionManager()
