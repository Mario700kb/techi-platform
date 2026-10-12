"""The client IP of each request is stamped on audit entries."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.request_context import ClientIPMiddleware, current_client_ip
from app.services import audit_service


def _app():
    app = FastAPI()
    app.add_middleware(ClientIPMiddleware)

    @app.get("/sync")
    def sync_endpoint():  # runs in the threadpool, like most endpoints here
        return {"ip": current_client_ip()}

    @app.get("/async")
    async def async_endpoint():
        return {"ip": current_client_ip()}

    return app


def test_the_request_ip_is_visible_in_sync_and_async_endpoints():
    client = TestClient(_app(), client=("203.0.113.7", 50000))
    assert client.get("/sync").json() == {"ip": "203.0.113.7"}
    assert client.get("/async").json() == {"ip": "203.0.113.7"}


def test_outside_a_request_there_is_no_ip():
    assert current_client_ip() is None


def test_audit_entries_get_the_ip_without_overwriting_one_given(monkeypatch):
    written = []

    class FakeRepo:
        def __init__(self, db):
            pass

        def create(self, **kwargs):
            written.append(kwargs["details"])

    monkeypatch.setattr(audit_service, "AuditLogRepository", FakeRepo)
    monkeypatch.setattr(audit_service, "current_client_ip", lambda: "198.51.100.4")

    audit_service.system_audit_log(None, action="x", details={"kind": "domain"})
    audit_service.system_audit_log(None, action="x")
    audit_service.system_audit_log(None, action="x", details={"ip": "10.0.0.1"})

    assert written == [{"kind": "domain", "ip": "198.51.100.4"}, {"ip": "198.51.100.4"}, {"ip": "10.0.0.1"}]
