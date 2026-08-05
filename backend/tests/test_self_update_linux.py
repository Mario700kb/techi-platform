"""self_update must install the right binary for the device's platform.

Linux was handed the Windows payload — the active windows-amd64 agent_binary
and the /agent-binary/download URL — so a Linux agent was told to install an
.exe. Its handler ignored the parameters anyway and passed Available:false, so
the action sat in `running` forever waiting for a version change that could
never happen (device 812, 2026-08-05).

The operator's requirement is fleet-scale: "we may have 200 Linux machines and
cannot go to each one by hand". These tests pin that Linux resolves its own
architecture's package, and that Windows behaviour is untouched.
"""

import pytest

from app.services.agent_command_service import AgentCommandService


class _Pkg:
    def __init__(self, version, sha256):
        self.version = version
        self.sha256 = sha256


class _Device:
    def __init__(self, id, platform, architecture=None, agent_version="2.1.20",
                 hostname=None, agent_sha256="win-sha"):
        self.id = id
        self.platform = platform
        self.architecture = architecture
        self.agent_version = agent_version
        self.agent_sha256 = agent_sha256
        self.hostname = hostname or f"host{id}"


@pytest.fixture
def packages(monkeypatch):
    """Active packages keyed by (platform, file_type)."""
    table = {
        ("windows-amd64", "agent_binary"): _Pkg("2.1.20", "win-sha"),
        ("linux-amd64", "agent_binary"): _Pkg("2.1.23", "amd64-sha"),
        ("linux-arm64", "agent_binary"): _Pkg("2.1.6", "arm64-sha"),
    }

    from app.services import agent_command_service as acs

    class _Service:
        def latest_active(self, platform, *, file_type=None):
            return table.get((platform, file_type or "agent_binary"))

        def agent_binary_download_url(self):
            return "/api/v1/agent-packages/agent-binary/download"

        def agent_update_msi_download_url(self):
            return "/api/v1/agent-packages/agent-update-msi/download"

    monkeypatch.setattr(acs, "AgentPackageService", _Service)
    monkeypatch.setattr(acs.settings, "PUBLIC_BACKEND_URL", "https://api.example")
    monkeypatch.setattr(acs.settings, "API_PREFIX", "/api/v1")
    return table


def _payloads(devices):
    return AgentCommandService._build_self_update_payloads(devices)[1]


class TestLinux:
    def test_amd64_gets_its_own_package_not_the_windows_one(self, packages):
        device = _Device(812, "linux", "x86_64")
        payload = _payloads([device])[812]
        assert payload["version"] == "2.1.23"
        assert payload["sha256"] == "amd64-sha"
        assert payload["download_url"].endswith("/agent-packages/platform/linux-amd64/download")
        assert "agent-binary/download" not in payload["download_url"], (
            "that endpoint serves the Windows .exe"
        )

    def test_arm64_is_not_given_the_amd64_build(self, packages):
        payload = _payloads([_Device(900, "linux", "aarch64")])[900]
        assert payload["version"] == "2.1.6"
        assert payload["download_url"].endswith("/platform/linux-arm64/download")

    def test_unknown_architecture_is_refused_not_guessed(self, packages):
        with pytest.raises(ValueError, match="architecture"):
            _payloads([_Device(901, "linux", "riscv64")])

    def test_missing_package_names_the_platform_and_the_device(self, packages):
        packages.pop(("linux-arm64", "agent_binary"))
        with pytest.raises(ValueError, match="linux-arm64"):
            _payloads([_Device(902, "linux", "aarch64", hostname="pi")])


class TestWindowsUnchanged:
    def test_windows_still_uses_the_agent_binary_endpoint(self, packages):
        payload = _payloads([_Device(575, "windows", agent_version="2.1.20")])[575]
        assert payload["download_url"].endswith("/agent-packages/agent-binary/download")
        assert payload["version"] == "2.1.20"
        assert payload["sha256"] == "win-sha"

    def test_a_mixed_batch_gives_each_device_its_own_binary(self, packages):
        out = _payloads([_Device(575, "windows"), _Device(812, "linux", "x86_64")])
        assert out[575]["sha256"] == "win-sha"
        assert out[812]["sha256"] == "amd64-sha"
        assert out[575]["download_url"] != out[812]["download_url"]


class TestUnsupportedPlatforms:
    def test_mikrotik_is_refused_with_its_hostname(self, packages):
        with pytest.raises(ValueError, match="not supported"):
            _payloads([_Device(700, "mikrotik", hostname="rb-gw")])
