"""Deleting a device must succeed even when it has terminal sessions, a connect
preference or a vault credential. On 2026-10-16 deleting device 729 returned
500 three times because a terminal_sessions row still referenced it.
"""
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.time import utcnow_naive
from app.db.base import Base
from app.models.connect_preference import OperatorConnectPreference
from app.models.device import Device
from app.models.operator import Operator
from app.models.terminal_session import TerminalSession
from app.models.vault_credential import VaultCredential
from app.repositories.device_repository import DeviceRepository


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def _fk_on(conn, _rec):  # FK enforcement, like PostgreSQL
        conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()


def test_delete_a_device_with_terminal_session_vault_and_preference(db):
    op = Operator(id=1, username="op", email="op@x.test", hashed_password="x", role="admin", is_active=True, is_superuser=False)
    device = Device(agent_id="a", hostname="rustdesk-srv", platform="windows", cpu=None, ram=None, storage=None)
    db.add_all([op, device])
    db.commit()
    db.refresh(device)

    db.add(TerminalSession(id="sess-1", device_id=device.id, operator_id=1, status="closed",
                           operator_ticket_hash="h1", agent_ticket_hash="h2",
                           created_at=utcnow_naive(), expires_at=utcnow_naive()))
    db.add(OperatorConnectPreference(operator_id=1, platform="windows", device_id=device.id, method_id="rustdesk"))
    cred = VaultCredential(
        name="srv admin", credential_type="password", scope_type="device", device_id=device.id,
        ciphertext="x", dek_wrapped="y", created_by="admin",
    )
    db.add(cred)
    db.commit()
    cred_id = cred.id

    deleted = DeviceRepository(db).hard_delete(device.id)

    assert deleted is not None
    assert db.query(Device).filter_by(id=device.id).first() is None
    assert db.query(TerminalSession).count() == 0
    # The vault credential outlives the device, detached.
    kept = db.query(VaultCredential).filter_by(id=cred_id).first()
    assert kept is not None and kept.device_id is None
    assert db.query(OperatorConnectPreference).filter_by(device_id=device.id).count() == 0
