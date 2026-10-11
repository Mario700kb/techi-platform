"""The dashboard WebSocket takes its session token from a subprotocol, not the URL.

The token used to travel as /ws/devices?token=<jwt>; uvicorn and
nginx-proxy-manager wrote every connection URL to their access logs, so the
logs held replayable operator sessions. A subprotocol header is not logged.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.websockets import WebSocketDisconnect

import app.models  # noqa: F401
from app.core.security import create_access_token
from app.db.base import Base
from app.models.operator import Operator
from app.websocket import routes as ws_routes


@pytest.fixture()
def client(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    db.add(Operator(id=1, username="owner", email="o@example.com", hashed_password="x", role="owner", is_active=True))
    db.commit()
    db.close()
    monkeypatch.setattr(ws_routes, "SessionLocal", factory)
    app = FastAPI()
    app.include_router(ws_routes.router)
    return TestClient(app)


def test_token_in_the_subprotocol_opens_the_socket(client):
    token = create_access_token("1")
    with client.websocket_connect("/ws/devices?tenant_id=default", subprotocols=["techi.v1", f"techi.auth.{token}"]) as ws:
        assert ws.accepted_subprotocol == "techi.v1"
        assert ws.receive_json()["type"] == "connection_ready"


def test_no_token_closes_with_the_application_code(client):
    with client.websocket_connect("/ws/devices", subprotocols=["techi.v1"]) as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4001


def test_a_token_in_the_url_is_no_longer_accepted(client):
    token = create_access_token("1")
    with client.websocket_connect(f"/ws/devices?token={token}", subprotocols=["techi.v1"]) as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4001


def test_an_invalid_token_is_rejected(client):
    with client.websocket_connect("/ws/devices", subprotocols=["techi.v1", "techi.auth.not-a-jwt"]) as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4001
