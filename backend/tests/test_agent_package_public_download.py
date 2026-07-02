from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import agent_packages


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(agent_packages.router, prefix="/api/v1/agent-packages")
    return TestClient(app)


def test_public_active_windows_package_download_returns_200(monkeypatch, tmp_path):
    package_file = tmp_path / "techi-agent.exe"
    package_file.write_bytes(b"active-agent-binary")
    package = SimpleNamespace(
        id="pkg-active",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.exe",
        version="1.2.3",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            return package

        def package_path(self, selected_package):
            assert selected_package is package
            return package_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/windows-amd64/download")

    assert response.status_code == 200
    assert response.content == b"active-agent-binary"
    assert response.headers["content-type"] == "application/octet-stream"
    assert "techi-agent.exe" in response.headers["content-disposition"]


def test_public_download_without_authentication_works(monkeypatch, tmp_path):
    package_file = tmp_path / "techi-agent-arm64.exe"
    package_file.write_bytes(b"arm64-agent-binary")
    package = SimpleNamespace(
        id="pkg-arm64",
        platform=SimpleNamespace(value="windows-arm64"),
        filename="techi-agent-arm64.exe",
        version="1.2.3",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            return package

        def package_path(self, selected_package):
            return package_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/windows-arm64/download")

    assert response.status_code == 200
    assert response.content == b"arm64-agent-binary"


def test_public_active_windows_version_returns_plain_text(monkeypatch):
    package = SimpleNamespace(
        id="pkg-active",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.msi",
        version="2.0.0",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            if file_type == "agent_binary":
                return None
            return package

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/active-version")

    assert response.status_code == 200
    assert response.text == "2.0.0"
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["cache-control"] == "no-store"


def test_public_active_windows_version_prefers_agent_binary(monkeypatch):
    msi_package = SimpleNamespace(
        id="pkg-msi",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.msi",
        version="2.1.0",
    )
    binary_package = SimpleNamespace(
        id="pkg-binary",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.exe",
        version="2.1.1",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            return binary_package if file_type == "agent_binary" else msi_package

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/active-version")

    assert response.status_code == 200
    assert response.text == "2.1.1"


def test_public_active_windows_version_returns_404_when_missing(monkeypatch):
    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            return None

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/active-version")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active package for platform"


def test_public_inactive_package_returns_404(monkeypatch):
    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            return None

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/windows-amd64/download")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active package for platform"


def test_public_unsupported_platform_rejected(monkeypatch):
    class UnexpectedAgentPackageService:
        def __init__(self):
            raise AssertionError("service must not be called for unsupported platforms")

    monkeypatch.setattr(agent_packages, "AgentPackageService", UnexpectedAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/linux-amd64/download")

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported public download platform"
