from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import agent as agent_endpoint


def test_agent_enroll_returns_public_https_and_wss_urls(monkeypatch):
    captured = {}

    class FakeEnrollmentService:
        def __init__(self, db):
            pass

        def enroll(self, payload, *, heartbeat_url: str, websocket_url: str):
            captured["heartbeat_url"] = heartbeat_url
            captured["websocket_url"] = websocket_url
            return {
                "agent_id": "agent-1",
                "device_id": 1,
                "heartbeat_url": heartbeat_url,
                "websocket_url": websocket_url,
                "enrollment_status": "enrolled",
                "assigned_client_id": None,
                "assigned_group_id": None,
            }

    def fake_db():
        yield object()

    monkeypatch.setattr(agent_endpoint, "AgentEnrollmentService", FakeEnrollmentService)
    app = FastAPI()
    app.dependency_overrides[agent_endpoint.get_db] = fake_db
    app.include_router(agent_endpoint.router, prefix="/api/v1/agent")

    response = TestClient(app).post(
        "/api/v1/agent/enroll",
        json={"hostname": "pc-1", "enrollment_token": "token-123"},
    )

    assert response.status_code == 200
    assert captured["heartbeat_url"] == "https://api-rdp.techi.com.al/api/v1/agent/heartbeat"
    assert captured["websocket_url"] == "wss://api-rdp.techi.com.al/ws/devices?tenant_id=default"
    assert response.json()["heartbeat_url"] == captured["heartbeat_url"]
    assert response.json()["websocket_url"] == captured["websocket_url"]
