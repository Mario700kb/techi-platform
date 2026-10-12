"""A heartbeat must not re-read the device's client and group.

Each commit in the heartbeat path expires the device; with lazy loading,
every later client_name/group_name read re-selected both — 6 of 17 queries
per heartbeat, ~135M scans of `clients` and `device_groups` in production.
Device.client and Device.group load joined with the device now.
"""
import re
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints.agent import router as agent_router
from app.db.base import Base
from app.db.session import get_db
from app.models.client import Client
from app.models.device import Device
from app.models.device_group import DeviceGroup

BODY = {
    "agent_id": "agent_budget", "device_id": 42, "hostname": "WS-01", "domain": "CORP",
    "rustdesk_id": "123456789", "os_name": "Windows", "platform": "windows",
    "cpu_percent": 12.0, "ram_percent": 40.0, "disk_percent": 50.0,
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
    db.add(Client(id=1, name="Northwind", slug="northwind", is_active=True))
    db.add(DeviceGroup(id=1, client_id=1, name="Front desk"))
    db.add(Device(id=42, agent_id="agent_budget", rustdesk_id="123456789", hostname="WS-01", device_type="client",
                  status="online", client_id=1, group_id=1, rustdesk_install_status="installed",
                  rustdesk_status="running", rustdesk_sync_state="synced", rustdesk_manual_override=False,
                  rustdesk_conflict_detected=False, domain="CORP"))
    db.commit()
    db.close()

    def get():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    api = FastAPI()
    api.dependency_overrides[get_db] = get
    api.include_router(agent_router, prefix="/api/v1/agent")
    yield TestClient(api), engine
    vault_cipher.reset_master_key_cache_for_tests()


def test_heartbeat_does_not_reselect_client_or_group(setup):
    client, engine = setup
    with patch("app.api.v1.endpoints.agent._heartbeat_side_effects"):
        client.post("/api/v1/agent/heartbeat", json=BODY)  # first-seen paths
        statements = []
        event.listen(engine, "before_cursor_execute", lambda c, cur, st, *a: statements.append(st))
        response = client.post("/api/v1/agent/heartbeat", json=BODY)

    assert response.status_code == 200
    standalone = [s for s in statements if re.match(r"\s*SELECT .* FROM (clients|device_groups)\b", s, re.S)]
    assert standalone == []
    # Budget for the whole request; was 17 before the joined load.
    assert len(statements) <= 12, statements
