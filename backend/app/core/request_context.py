"""The client IP of the request being handled, for audit entries.

Uvicorn resolves the real client from X-Forwarded-For when the proxy's
address is in FORWARDED_ALLOW_IPS (docker-compose.yml); this records it per
request so audit_log() can stamp it without every caller passing a Request.
A pure ASGI middleware, so the value is visible in sync endpoints too (their
threadpool copies the context).
"""
from contextvars import ContextVar
from typing import Optional

_client_ip: ContextVar[Optional[str]] = ContextVar("client_ip", default=None)


def current_client_ip() -> Optional[str]:
    return _client_ip.get()


class ClientIPMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        client = scope.get("client")
        token = _client_ip.set(client[0] if client else None)
        try:
            await self.app(scope, receive, send)
        finally:
            _client_ip.reset(token)
