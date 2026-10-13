"""A heartbeat must not hold two pool connections, nor wait for one on the event loop.

2026-10-13 15:24 outage: the v1 heartbeat kept its request session open until
its background side effects had opened their own, so after a restart every
queued heartbeat held one connection and waited for a second until the pool
ran dry; the legacy route ran the same database work on the event loop, so
those waits froze every other request too.
"""
import asyncio
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.legacy_compat import router as legacy_router
from app.api.v1.endpoints.agent import router as agent_router
from app.db.base import Base
from app.db.session import get_db
from app.models.device import Device

BODY = {
    "agent_id": "agent_release", "device_id": 42, "hostname": "WS-01", "domain": "CORP",
    "rustdesk_id": "123456789", "os_name": "Windows", "platform": "windows",
    "rustdesk_install_status": "installed", "rustdesk_status": "running",
}


@pytest.fixture()
def setup(tmp_path, monkeypatch):
    from app.core import vault_cipher
    from app.core.config import settings

    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "k"))
    vault_cipher.reset_master_key_cache_for_tests()
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add(Device(id=42, agent_id="agent_release", rustdesk_id="123456789", hostname="WS-01", device_type="client",
                  status="online", rustdesk_install_status="installed", rustdesk_status="running",
                  rustdesk_sync_state="synced", rustdesk_manual_override=False, rustdesk_conflict_detected=False,
                  domain="CORP"))
    db.commit()
    db.close()
    sessions = []

    def get():
        session = factory()
        sessions.append(session)
        try:
            yield session
        finally:
            session.close()

    api = FastAPI()
    api.dependency_overrides[get_db] = get
    api.include_router(legacy_router)
    api.include_router(agent_router, prefix="/api/v1/agent")
    yield TestClient(api), sessions
    vault_cipher.reset_master_key_cache_for_tests()


def test_side_effects_start_after_the_request_session_is_released(setup):
    client, sessions = setup
    seen = []

    def side_effects(*_args):
        seen.append(sessions[-1].in_transaction())

    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects", side_effects):
        response = client.post("/api/v1/agent/heartbeat", json=BODY)

    assert response.status_code == 200
    assert seen == [False]


def test_legacy_heartbeat_does_its_database_work_off_the_event_loop(setup):
    client, _sessions = setup
    from app.api import legacy_compat

    real = legacy_compat.agent_heartbeat
    on_loop = []

    def spy(*args):
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        return real(*args)

    with (
        patch("app.api.legacy_compat.agent_heartbeat", spy),
        patch("app.api.v1.endpoints.agent._heartbeat_side_effects"),
    ):
        response = client.post("/api/heartbeat", json=BODY)

    assert response.status_code == 200
    assert on_loop == [False]
