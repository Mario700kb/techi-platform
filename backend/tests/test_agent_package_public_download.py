from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import agent_packages


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(agent_packages.router, prefix="/api/v1/agent-packages")
    return TestClient(app)


def test_public_active_windows_package_download_returns_active_msi(monkeypatch, tmp_path):
    package_file = tmp_path / "techi-agent.msi"
    package_file.write_bytes(b"active-agent-msi")
    package = SimpleNamespace(
        id="pkg-active",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.msi",
        version="1.2.3",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            assert file_type == "msi"
            return package

        def package_path(self, selected_package):
            assert selected_package is package
            return package_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/windows-amd64/download")

    assert response.status_code == 200
    assert response.content == b"active-agent-msi"
    assert response.headers["content-type"] == "application/octet-stream"
    assert "techi-agent.msi" in response.headers["content-disposition"]


def test_public_platform_download_ignores_active_agent_binary(monkeypatch, tmp_path):
    msi_file = tmp_path / "techi-agent.msi"
    msi_file.write_bytes(b"active-msi")
    msi_package = SimpleNamespace(
        id="pkg-msi",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="techi-agent.msi",
        version="2.1.1",
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
            if file_type == "msi":
                return msi_package
            if file_type == "agent_binary":
                return binary_package
            raise AssertionError(f"unexpected file_type={file_type}")

        def package_path(self, selected_package):
            assert selected_package is msi_package
            return msi_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/windows-amd64/download")

    assert response.status_code == 200
    assert response.content == b"active-msi"
    assert "techi-agent.msi" in response.headers["content-disposition"]


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
            assert file_type == "msi"
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

    # freebsd-amd64 is not in PUBLIC_DOWNLOAD_PLATFORMS (linux-* now IS supported).
    response = _client().get("/api/v1/agent-packages/platform/freebsd-amd64/download")

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported public download platform"


def test_public_linux_amd64_download_returns_active_agent_binary(monkeypatch, tmp_path):
    binary_file = tmp_path / "techi-agent-linux-amd64.bin"
    binary_file.write_bytes(b"\x7fELF-linux-agent")
    package = SimpleNamespace(
        id="pkg-linux",
        platform=SimpleNamespace(value="linux-amd64"),
        filename="techi-agent-linux-amd64.bin",
        version="2.1.5",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "linux-amd64"
            # Linux resolves via agent_binary, NOT msi.
            assert file_type == "agent_binary"
            return package

        def package_path(self, selected_package):
            assert selected_package is package
            return binary_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/linux-amd64/download")

    assert response.status_code == 200
    assert response.content == b"\x7fELF-linux-agent"
    assert response.headers["content-type"] == "application/octet-stream"
    assert "techi-agent-linux-amd64.bin" in response.headers["content-disposition"]


def test_public_linux_download_falls_back_to_any_active(monkeypatch, tmp_path):
    binary_file = tmp_path / "techi-agent-linux-amd64.bin"
    binary_file.write_bytes(b"raw-binary")
    package = SimpleNamespace(
        id="pkg-linux",
        platform=SimpleNamespace(value="linux-amd64"),
        filename="techi-agent-linux-amd64.bin",
        version="2.1.5",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            # No agent_binary typed package → fall back to any active for platform.
            if file_type == "agent_binary":
                return None
            assert file_type is None
            return package

        def package_path(self, selected_package):
            return binary_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/linux-amd64/download")

    assert response.status_code == 200
    assert response.content == b"raw-binary"


def test_public_linux_download_404_when_missing(monkeypatch):
    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            return None

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/platform/linux-amd64/download")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active package for platform"


def test_public_linux_arm_platforms_are_supported(monkeypatch):
    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            return None  # 404, but NOT 400 — proves the platform is allowed

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)
    client = _client()
    for platform in ("linux-arm64", "linux-armhf"):
        response = client.get(f"/api/v1/agent-packages/platform/{platform}/download")
        assert response.status_code == 404, platform  # reached the service, not rejected


def test_public_agent_update_msi_download_returns_active_bridge(monkeypatch, tmp_path):
    bridge_file = tmp_path / "TECHI-Agent-Update-2.1.2.msi"
    bridge_file.write_bytes(b"bridge-msi")
    bridge_package = SimpleNamespace(
        id="pkg-bridge",
        platform=SimpleNamespace(value="windows-amd64"),
        filename="TECHI-Agent-Update-2.1.2.msi",
        version="2.1.2",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            assert file_type == "agent_update_msi"
            return bridge_package

        def package_path(self, selected_package):
            assert selected_package is bridge_package
            return bridge_file

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/agent-update-msi/download")

    assert response.status_code == 200
    assert response.content == b"bridge-msi"
    assert "TECHI-Agent-Update-2.1.2.msi" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"


def test_public_agent_update_msi_download_404_when_missing(monkeypatch):
    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert file_type == "agent_update_msi"
            return None

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)

    response = _client().get("/api/v1/agent-packages/agent-update-msi/download")

    assert response.status_code == 404
    assert response.json()["detail"] == "No active agent update MSI package for windows-amd64"


def test_public_windows_remote_support_msi_download_remains_unchanged(monkeypatch, tmp_path):
    msi = tmp_path / "TECHI-Remote-Support-1.4.7.msi"
    msi.write_bytes(b"windows-rs-msi")
    package = SimpleNamespace(
        id="pkg-windows-rs",
        platform=SimpleNamespace(value="windows-amd64"),
        filename=msi.name,
        version="1.4.7",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "windows-amd64"
            assert file_type == "remote_support_msi"
            return package

        def package_path(self, selected_package):
            assert selected_package is package
            return msi

    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)
    response = _client().get("/api/v1/agent-packages/remote-support-msi/download")

    assert response.status_code == 200
    assert response.content == b"windows-rs-msi"
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("query", "artifact", "file_type", "filename", "content_type"),
    [
        ("", "pkg", "remote_support_pkg", "TECHI-Remote-Support-1.4.8-darwin-arm64.pkg", "application/vnd.apple.installer+xml"),
        ("?artifact=dmg", "dmg", "remote_support_dmg", "TECHI-Remote-Support-1.4.8-darwin-arm64.dmg", "application/x-apple-diskimage"),
    ],
)
def test_public_macos_remote_support_download(
    monkeypatch, tmp_path, query, artifact, file_type, filename, content_type
):
    package_path = tmp_path / filename
    package_path.write_bytes(f"macos-{artifact}".encode())
    package = SimpleNamespace(
        id="pkg-macos-rs",
        platform=SimpleNamespace(value="darwin-arm64"),
        filename=package_path.name,
        version="1.4.8",
    )

    class FakeAgentPackageService:
        def latest_active(self, platform: str, *, file_type=None):
            assert platform == "darwin-arm64"
            assert file_type == file_type_expected
            return package

        def package_path(self, selected_package):
            assert selected_package is package
            return package_path

    file_type_expected = file_type
    monkeypatch.setattr(agent_packages, "AgentPackageService", FakeAgentPackageService)
    response = _client().get(f"/api/v1/agent-packages/remote-support/darwin-arm64/download{query}")

    assert response.status_code == 200
    assert response.content == f"macos-{artifact}".encode()
    assert response.headers["content-type"] == content_type
    assert response.headers["cache-control"] == "no-store"


def test_public_macos_remote_support_download_rejects_other_platform(monkeypatch):
    class UnexpectedAgentPackageService:
        def __init__(self):
            raise AssertionError("service must not be called")

    monkeypatch.setattr(agent_packages, "AgentPackageService", UnexpectedAgentPackageService)
    response = _client().get("/api/v1/agent-packages/remote-support/windows-amd64/download")

    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported Remote Support platform"
