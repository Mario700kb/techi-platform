"""Embedded SSH Connect — the backend acting as the SSH client
("connector relay" mode, recorded as an architecture recommendation in
IMPLEMENTATION-ROADMAP.md before this feature was built).

Reuses the Web Terminal stack (Platform Expansion Phase 5) completely
unchanged: the operator still connects to the existing `/ws/terminal/{id}`
route, the same `TerminalRelay` pairs the two legs and pumps bytes, the same
`TerminalWatchdog` sweeps idle/expired sessions, the same audit call sites
close the session. The only new piece is what attaches as the "agent" leg of
that pair: instead of the device's own agent dialing out over a websocket
(Linux PTY), this module dials an SSH connection to the device itself using a
credential resolved from the Credential Vault, and wraps it in an adapter that
duck-types the small subset of the WebSocket interface `TerminalRelay.pump()`
uses (`receive`/`send_bytes`/`send_text`/`close`) — so the relay and watchdog
require zero changes.
"""

import asyncio
import logging
from typing import Optional

import asyncssh

from app.db.session import SessionLocal
from app.models.terminal_session import TerminalSessionStatus
from app.services.audit_service import AuditAction, system_audit_log
from app.services.terminal_relay import terminal_relay
from app.services.terminal_service import TerminalService
from app.services.vault_service import VaultService

logger = logging.getLogger(__name__)

SSH_CONNECT_TIMEOUT_SECONDS = 10


class SSHConnectError(Exception):
    """Raised when the SSH leg cannot be established. `reason` is one of the
    error categories the mission requires surfacing distinctly to the
    operator: credential_missing, host_unreachable, authentication_failed,
    timeout, host_key_mismatch, connection_refused, network_error."""

    def __init__(self, reason: str, message: str):
        self.reason = reason
        super().__init__(message)


class SSHConnectAdapter:
    """Duck-types the WebSocket methods TerminalRelay.pump()/close() call, so
    an asyncssh PTY process can be attached as a relay leg exactly like the
    Linux agent's websocket leg. Nothing here touches the DB or audit — same
    separation of concerns as TerminalRelay itself."""

    def __init__(self, conn: "asyncssh.SSHClientConnection", process: "asyncssh.SSHClientProcess"):
        self._conn = conn
        self._process = process

    async def receive(self) -> dict:
        try:
            chunk = await self._process.stdout.read(4096)
        except asyncssh.Error:
            return {"type": "websocket.disconnect"}
        if not chunk:
            return {"type": "websocket.disconnect"}
        return {"type": "websocket.receive", "text": chunk}

    async def send_bytes(self, data: bytes) -> None:
        self._process.stdin.write(data.decode("utf-8", errors="ignore"))

    async def send_text(self, data: str) -> None:
        self._process.stdin.write(data)

    async def close(self) -> None:
        try:
            self._process.terminate()
        except Exception:
            pass
        try:
            self._conn.close()
        except Exception:
            pass


def _map_connect_error(exc: Exception) -> SSHConnectError:
    if isinstance(exc, asyncssh.PermissionDenied):
        return SSHConnectError("authentication_failed", str(exc) or "Authentication failed")
    if isinstance(exc, asyncssh.HostKeyNotVerifiable):
        return SSHConnectError("host_key_mismatch", str(exc) or "Host key could not be verified")
    if isinstance(exc, asyncio.TimeoutError):
        return SSHConnectError("timeout", "Connection timed out")
    if isinstance(exc, ConnectionRefusedError):
        return SSHConnectError("connection_refused", str(exc) or "Connection refused")
    if isinstance(exc, (TimeoutError, OSError)):
        return SSHConnectError("host_unreachable", str(exc) or "Host unreachable")
    if isinstance(exc, asyncssh.Error):
        return SSHConnectError("network_error", str(exc) or "SSH network error")
    return SSHConnectError("network_error", str(exc) or "Unknown SSH error")


async def open_ssh_leg(
    session_id: str,
    *,
    host: str,
    port: int,
    username: str,
    password: Optional[str] = None,
    private_key: Optional[str] = None,
    passphrase: Optional[str] = None,
) -> SSHConnectAdapter:
    """Dials the SSH connection and attaches it as the agent leg of the
    session's TerminalRelay pair. Raises SSHConnectError on failure — the
    caller (dial_and_run) marks the session FAILED and writes the matching
    audit entry.

    Host key verification is intentionally not enforced in this release
    (`known_hosts=None`) — there is no shared, per-device trusted host-key
    store yet (documented Known Limitation, same class as the MikroTik NAT
    caveat already recorded in IMPLEMENTATION-ROADMAP.md). The error mapping
    for a mismatch is implemented so enabling verification later needs no
    further change here.
    """
    if not password and not private_key:
        raise SSHConnectError("credential_missing", "Credential has no usable secret")

    connect_kwargs: dict = dict(
        host=host,
        port=port,
        username=username,
        known_hosts=None,
        connect_timeout=SSH_CONNECT_TIMEOUT_SECONDS,
    )
    if private_key:
        try:
            client_key = asyncssh.import_private_key(private_key, passphrase=passphrase)
        except asyncssh.KeyImportError as exc:
            raise SSHConnectError("authentication_failed", f"Invalid private key: {exc}") from exc
        connect_kwargs["client_keys"] = [client_key]
    else:
        connect_kwargs["password"] = password

    try:
        conn = await asyncssh.connect(**connect_kwargs)
    except Exception as exc:  # noqa: BLE001 - mapped into a typed SSHConnectError below
        raise _map_connect_error(exc) from exc

    try:
        process = await conn.create_process(term_type="xterm", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        conn.close()
        raise _map_connect_error(exc) from exc

    adapter = SSHConnectAdapter(conn, process)
    await terminal_relay.attach_agent(session_id, adapter)
    return adapter


async def dial_and_run(
    session_id: str,
    device_id: int,
    operator_username: Optional[str],
    *,
    host: str,
    port: int,
    username: str,
    password: Optional[str],
    private_key: Optional[str],
    passphrase: Optional[str],
    vault_credential_id: Optional[int] = None,
) -> None:
    """Top-level coroutine scheduled on the app's event loop for a new SSH
    session: dial, run the reverse-direction pump (device -> operator) for
    the lifetime of the connection, then clean up. Mirrors the shape of
    app.workers.terminal_watchdog, which already does DB+audit work from a
    background asyncio task."""
    try:
        adapter = await open_ssh_leg(
            session_id,
            host=host,
            port=port,
            username=username,
            password=password,
            private_key=private_key,
            passphrase=passphrase,
        )
    except SSHConnectError as exc:
        logger.info(
            "ssh connect failed: session_id=%s device_id=%s reason=%s", session_id, device_id, exc.reason,
        )
        db = SessionLocal()
        try:
            svc = TerminalService(db)
            session = svc.get(session_id)
            if session is not None and session.status not in (
                TerminalSessionStatus.CLOSED.value,
                TerminalSessionStatus.EXPIRED.value,
            ):
                session.status = TerminalSessionStatus.FAILED.value
                session.disconnect_reason = exc.reason
                db.commit()
            action = (
                AuditAction.SSH_AUTHENTICATION_FAILED
                if exc.reason == "authentication_failed"
                else AuditAction.SSH_CONNECTION_FAILED
            )
            system_audit_log(
                db,
                action=action,
                entity_type="terminal_session",
                entity_id=None,
                details={
                    "session_id": session_id,
                    "device_id": device_id,
                    "operator_username": operator_username,
                    "reason": exc.reason,
                    "message": str(exc),
                },
            )
        finally:
            db.close()
        await terminal_relay.close(session_id)
        return

    # Connected: record real Vault usage (Vault UI's "Used By: Embedded SSH" +
    # "Last Used") before the potentially long-lived pump below.
    if vault_credential_id is not None:
        db = SessionLocal()
        try:
            vault = VaultService(db)
            credential = vault.get(vault_credential_id)
            if credential is not None:
                vault.record_credential_use(credential, operator_username, device_id)
        finally:
            db.close()

    # Blocks for the lifetime of the SSH connection, forwarding device output
    # to the operator's websocket via the unmodified TerminalRelay.
    await terminal_relay.pump(session_id, adapter, is_operator=False)

    # The SSH leg ended (device closed the connection, network drop, etc.) —
    # clean up exactly like the watchdog does for an idle/max-duration
    # force-close: mark the DB session, write the audit entry, close the
    # relay pair (which force-closes the operator's websocket too, so a
    # dangling browser tab isn't left waiting forever).
    db = SessionLocal()
    try:
        svc = TerminalService(db)
        session = svc.get(session_id)
        if session is not None and session.status not in (
            TerminalSessionStatus.CLOSED.value,
            TerminalSessionStatus.EXPIRED.value,
            TerminalSessionStatus.FAILED.value,
        ):
            svc.close(session, "agent_gone")
            system_audit_log(
                db,
                action=AuditAction.SSH_SESSION_ENDED,
                entity_type="terminal_session",
                entity_id=None,
                details={
                    "session_id": session_id,
                    "device_id": device_id,
                    "operator_username": operator_username,
                    "reason": "agent_gone",
                    "duration_seconds": session.duration_seconds,
                },
            )
    finally:
        db.close()
    await terminal_relay.close(session_id)


class SSHConnectorRunner:
    """Captures the app's running event loop at startup (same pattern as
    RealtimeEventPublisher) so the synchronous session-creation endpoint
    (regular SQLAlchemy request handler, not `async def`) can schedule the
    SSH dial coroutine onto it via `run_coroutine_threadsafe`."""

    def __init__(self) -> None:
        self._loop: "asyncio.AbstractEventLoop | None" = None

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()

    def stop(self) -> None:
        self._loop = None

    def schedule_threadsafe(self, coro) -> None:
        if self._loop is None or self._loop.is_closed():
            logger.warning("SSH connector runner loop not available; dropping scheduled dial")
            coro.close()  # avoid a "coroutine was never awaited" warning/leak
            return
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        future.add_done_callback(self._log_error)

    @staticmethod
    def _log_error(future: "asyncio.Future") -> None:
        try:
            future.result()
        except Exception:
            logger.exception("Scheduled SSH connect task failed")


ssh_connector_runner = SSHConnectorRunner()
