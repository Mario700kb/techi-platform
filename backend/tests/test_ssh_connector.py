"""Embedded SSH Connect — app.services.ssh_connector.

Locks: every SSHConnectError reason category maps correctly from asyncssh
exceptions, the adapter duck-types cleanly onto TerminalRelay, and
dial_and_run's DB/audit side effects on both the failure and success/end
paths (mirrors test_terminal_watchdog.py's monkeypatched-SessionLocal style).
"""

import asyncio
import json

import asyncssh
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.terminal_session import TerminalSessionStatus
from app.services import ssh_connector as ssh_connector_module
from app.services.ssh_connector import SSHConnectAdapter, SSHConnectError, _map_connect_error, dial_and_run
from app.services.terminal_relay import TerminalRelay
from app.services.terminal_service import TerminalService


def _sqlite_session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)


# ── error mapping ───────────────────────────────────────────────────────── #

@pytest.mark.parametrize(
    "exc, expected_reason",
    [
        (asyncssh.PermissionDenied("denied"), "authentication_failed"),
        (asyncio.TimeoutError(), "timeout"),
        (ConnectionRefusedError("refused"), "connection_refused"),
        (OSError("no route to host"), "host_unreachable"),
        (asyncssh.Error(1, "generic ssh error"), "network_error"),
        (ValueError("totally unexpected"), "network_error"),
    ],
)
def test_map_connect_error_reasons(exc, expected_reason):
    mapped = _map_connect_error(exc)
    assert isinstance(mapped, SSHConnectError)
    assert mapped.reason == expected_reason


def test_map_connect_error_host_key_mismatch():
    exc = asyncssh.HostKeyNotVerifiable("mismatch")
    assert _map_connect_error(exc).reason == "host_key_mismatch"


# ── SSHConnectAdapter duck-typing ───────────────────────────────────────── #

class _FakeStdin:
    def __init__(self):
        self.written = []

    def write(self, data):
        self.written.append(data)


class _FakeStdout:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def read(self, _n):
        if self._chunks:
            return self._chunks.pop(0)
        return ""


class _FakeProcess:
    def __init__(self, chunks=()):
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(chunks)
        self.terminated = False

    def terminate(self):
        self.terminated = True


class _FakeConn:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


def test_adapter_receive_yields_text_then_disconnect():
    async def _body():
        process = _FakeProcess(chunks=["hello"])
        adapter = SSHConnectAdapter(_FakeConn(), process)
        first = await adapter.receive()
        assert first == {"type": "websocket.receive", "text": "hello"}
        second = await adapter.receive()
        assert second == {"type": "websocket.disconnect"}

    asyncio.run(_body())


def test_adapter_send_bytes_and_text_write_to_stdin():
    async def _body():
        process = _FakeProcess()
        adapter = SSHConnectAdapter(_FakeConn(), process)
        await adapter.send_bytes(b"ls\n")
        await adapter.send_text("pwd\n")
        assert process.stdin.written == ["ls\n", "pwd\n"]

    asyncio.run(_body())


def test_adapter_close_terminates_process_and_closes_connection():
    async def _body():
        process = _FakeProcess()
        conn = _FakeConn()
        adapter = SSHConnectAdapter(conn, process)
        await adapter.close()
        assert process.terminated is True
        assert conn.closed is True

    asyncio.run(_body())


def test_adapter_attaches_to_relay_like_a_websocket():
    # Proves the whole point of the adapter: TerminalRelay.attach_agent /
    # pump work on it with zero changes, exactly like a real WebSocket.
    async def _body():
        relay = TerminalRelay()
        process = _FakeProcess(chunks=["output"])
        adapter = SSHConnectAdapter(_FakeConn(), process)
        await relay.attach_agent("s1", adapter)
        assert relay.is_active("s1") is False  # only one side attached so far

        class _FakeOperatorWS:
            def __init__(self):
                self.sent_text = []

            async def send_text(self, data):
                self.sent_text.append(data)

        operator_ws = _FakeOperatorWS()
        await relay.attach_operator("s1", operator_ws)
        assert relay.is_active("s1") is True

        await relay.pump("s1", adapter, is_operator=False)
        assert operator_ws.sent_text == ["output"]

    asyncio.run(_body())


# ── dial_and_run: failure path ───────────────────────────────────────────── #

def test_dial_and_run_marks_session_failed_and_audits_on_credential_missing(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(ssh_connector_module, "SessionLocal", session_factory)

    db = session_factory()
    svc = TerminalService(db)
    session, _ = svc.create_ssh_session(
        device_id=7, operator_id=1, operator_username="mario",
        ssh_username="root", vault_credential_id=None, credential_source="temporary",
    )
    session_id = session.id
    db.close()

    asyncio.run(dial_and_run(
        session_id, 7, "mario",
        host="10.0.0.5", port=22, username="root",
        password=None, private_key=None, passphrase=None,
    ))

    db2 = session_factory()
    reloaded = TerminalService(db2).get(session_id)
    assert reloaded.status == TerminalSessionStatus.FAILED.value
    assert reloaded.disconnect_reason == "credential_missing"

    audit_rows = db2.query(AuditLog).filter(AuditLog.action == "ssh_connection_failed").all()
    assert len(audit_rows) == 1
    details = json.loads(audit_rows[0].details_json)
    assert details["session_id"] == session_id
    assert details["reason"] == "credential_missing"


def test_dial_and_run_uses_authentication_failed_audit_action(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(ssh_connector_module, "SessionLocal", session_factory)

    async def _fake_connect(**kwargs):
        raise asyncssh.PermissionDenied("bad password")

    monkeypatch.setattr(ssh_connector_module.asyncssh, "connect", _fake_connect)

    db = session_factory()
    svc = TerminalService(db)
    session, _ = svc.create_ssh_session(
        device_id=7, operator_id=1, operator_username="mario",
        ssh_username="root", vault_credential_id=None, credential_source="temporary",
    )
    session_id = session.id
    db.close()

    asyncio.run(dial_and_run(
        session_id, 7, "mario",
        host="10.0.0.5", port=22, username="root",
        password="wrong", private_key=None, passphrase=None,
    ))

    db2 = session_factory()
    reloaded = TerminalService(db2).get(session_id)
    assert reloaded.status == TerminalSessionStatus.FAILED.value
    assert reloaded.disconnect_reason == "authentication_failed"
    audit_rows = db2.query(AuditLog).filter(AuditLog.action == "ssh_authentication_failed").all()
    assert len(audit_rows) == 1


def test_dial_and_run_does_not_clobber_already_closed_session(monkeypatch):
    session_factory = _sqlite_session_factory()
    monkeypatch.setattr(ssh_connector_module, "SessionLocal", session_factory)

    db = session_factory()
    svc = TerminalService(db)
    session, _ = svc.create_ssh_session(
        device_id=7, operator_id=1, operator_username="mario",
        ssh_username="root", vault_credential_id=None, credential_source="temporary",
    )
    session_id = session.id
    svc.close(session, "operator_closed")
    db.close()

    asyncio.run(dial_and_run(
        session_id, 7, "mario",
        host="10.0.0.5", port=22, username="root",
        password=None, private_key=None, passphrase=None,
    ))

    db2 = session_factory()
    reloaded = TerminalService(db2).get(session_id)
    # Must stay CLOSED/operator_closed — a later dial failure must never
    # override an already-terminal session.
    assert reloaded.status == TerminalSessionStatus.CLOSED.value
    assert reloaded.disconnect_reason == "operator_closed"


# ── dial_and_run: success path ───────────────────────────────────────────── #

def test_dial_and_run_records_credential_use_on_success(monkeypatch):
    import app.core.vault_cipher as vault_cipher
    from app.core.config import settings
    from app.models.vault_credential import VaultCredential
    from app.schemas.vault import VaultCredentialCreate
    from app.services.vault_service import VaultService

    def _factory():
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(bind=engine)
        return sessionmaker(bind=engine)

    session_factory = _factory()
    monkeypatch.setattr(ssh_connector_module, "SessionLocal", session_factory)

    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", None, raising=False)
    import tempfile
    key_path = tempfile.mktemp()
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", key_path)
    vault_cipher.reset_master_key_cache_for_tests()

    db = session_factory()
    vault = VaultService(db)
    credential = vault.create(
        VaultCredentialCreate(name="cred", credential_type="ssh_password", username="root", secret="hunter2", scope_type="device", device_id=7),
        created_by="tester",
    )
    svc = TerminalService(db)
    session, _ = svc.create_ssh_session(
        device_id=7, operator_id=1, operator_username="mario",
        ssh_username="root", vault_credential_id=credential.id, credential_source="device",
    )
    session_id = session.id
    credential_id = credential.id
    db.close()

    class _Process:
        def __init__(self):
            self.stdin = _FakeStdin()
            self.stdout = _FakeStdout([])

    class _Conn:
        def close(self):
            pass

        async def create_process(self, **kwargs):
            return _Process()

    async def _fake_connect(**kwargs):
        return _Conn()

    monkeypatch.setattr(ssh_connector_module.asyncssh, "connect", _fake_connect)

    asyncio.run(dial_and_run(
        session_id, 7, "mario",
        host="10.0.0.5", port=22, username="root",
        password="hunter2", private_key=None, passphrase=None,
        vault_credential_id=credential_id,
    ))

    db2 = session_factory()
    reloaded_cred = db2.query(VaultCredential).filter(VaultCredential.id == credential_id).one()
    assert reloaded_cred.last_used_at is not None

    reloaded_session = TerminalService(db2).get(session_id)
    # The reverse pump ended immediately (empty stdout) — session ended
    # ("agent_gone") and got its own SSH-specific audit action.
    assert reloaded_session.status == TerminalSessionStatus.CLOSED.value
    assert reloaded_session.disconnect_reason == "agent_gone"
    audit_rows = db2.query(AuditLog).filter(AuditLog.action == "ssh_session_ended").all()
    assert len(audit_rows) == 1

    vault_cipher.reset_master_key_cache_for_tests()
