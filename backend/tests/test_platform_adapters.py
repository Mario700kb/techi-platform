"""Phase 1 — Platform Adapters tests.

Locks: (1) the Windows adapter is bit-identical to the legacy classification
(golden corpus with hardcoded expectations, matching the pre-extraction
behavior), (2) dispatch fallbacks never let a rogue platform value change how
the Windows fleet is treated, (3) capability persistence is flag-gated and
off the fast path.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from app.core.config import settings
from app.models.device import DeviceType
from app.schemas.agent import AgentHeartbeatPayload
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.platform_adapters import get_adapter
from app.services.platform_adapters.linux import LinuxAdapter
from app.services.platform_adapters.windows import WindowsAdapter

# (payload kwargs, expected DeviceType) — expectations mirror production
# behavior BEFORE the adapter extraction; do not edit without an amendment.
GOLDEN_WINDOWS_CORPUS = [
    (dict(os_name="windows", domain="corp.local", windows_product_type=3), DeviceType.SERVER),
    (dict(os_name="windows", domain="corp.local", windows_product_type=2), DeviceType.SERVER),
    (dict(os_name="windows", domain="corp.local", windows_product_type=1), DeviceType.CLIENT),
    (dict(os_caption="Microsoft Windows Server 2022 Standard", domain="ad.example"), DeviceType.SERVER),
    (dict(os_caption="Microsoft Windows 11 Pro", domain="ad.example"), DeviceType.CLIENT),
    (dict(os_caption="Microsoft Windows 10 Pro", domain="ad.example"), DeviceType.CLIENT),
    (dict(os_name="windows", domain="WORKGROUP", windows_product_type=1), DeviceType.UNASSIGNED),
    (dict(os_name="windows", domain=None, windows_product_type=3), DeviceType.UNASSIGNED),
    (dict(os_name="windows", domain="corp.local"), DeviceType.UNASSIGNED),
    # product_type wins over caption text
    (dict(os_caption="Microsoft Windows 11 Pro", domain="x.local", windows_product_type=3), DeviceType.SERVER),
]


class TestWindowsAdapterGolden:
    def test_adapter_matches_golden_expectations(self):
        adapter = WindowsAdapter()
        for kwargs, expected in GOLDEN_WINDOWS_CORPUS:
            payload = AgentHeartbeatPayload(**kwargs)
            assert adapter.classify_device_type(payload) == expected, kwargs

    def test_adapter_equals_legacy_service_path(self):
        """Flag-ON dispatch and flag-OFF legacy path must be identical."""
        adapter = WindowsAdapter()
        for kwargs, _ in GOLDEN_WINDOWS_CORPUS:
            payload = AgentHeartbeatPayload(**kwargs)
            legacy = DeviceHeartbeatService.classify_device_type(
                payload.os_name,
                payload.domain,
                os_version=payload.os_version,
                os_caption=payload.os_caption,
                os_build=payload.os_build,
                windows_product_type=payload.windows_product_type,
            )
            assert adapter.classify_device_type(payload) == legacy, kwargs


class TestLinuxAdapter:
    def test_server_distro(self):
        payload = AgentHeartbeatPayload(os_name="Ubuntu", os_caption="Ubuntu 22.04.4 LTS Server")
        assert LinuxAdapter().classify_device_type(payload) == DeviceType.SERVER

    def test_desktop_distro(self):
        payload = AgentHeartbeatPayload(os_caption="Ubuntu Desktop 24.04")
        assert LinuxAdapter().classify_device_type(payload) == DeviceType.CLIENT

    def test_no_signal_is_unassigned(self):
        assert LinuxAdapter().classify_device_type(AgentHeartbeatPayload()) == DeviceType.UNASSIGNED
        assert (
            LinuxAdapter().classify_device_type(AgentHeartbeatPayload(os_name="Debian"))
            == DeviceType.UNASSIGNED
        )


class TestAdapterDispatch:
    def test_null_and_windows_resolve_to_windows_adapter(self):
        assert get_adapter(None).platform_id == "windows"
        assert get_adapter("").platform_id == "windows"
        assert get_adapter("Windows").platform_id == "windows"

    def test_linux_resolves_to_linux_adapter(self):
        assert get_adapter("linux").platform_id == "linux"

    def test_unknown_and_adapterless_platforms_fall_back_to_windows(self):
        assert get_adapter("templeos").platform_id == "windows"  # unknown value
        assert get_adapter("mikrotik").platform_id == "windows"  # known, no adapter yet

    def test_capability_filtering_per_platform(self):
        reported = {"docker": "26.1", "powershell": "5.1", "bash": ""}
        assert "docker" not in WindowsAdapter().normalize_capabilities(reported)
        assert WindowsAdapter().normalize_capabilities(reported)["powershell"] == "5.1"
        linux_caps = LinuxAdapter().normalize_capabilities(reported)
        assert linux_caps["docker"] == "26.1"
        assert "powershell" not in linux_caps


class TestCapabilitiesSideEffect:
    def _service(self):
        service = DeviceHeartbeatService.__new__(DeviceHeartbeatService)
        service.db = MagicMock()
        return service

    def _device(self, platform=None, capabilities=None):
        return SimpleNamespace(platform=platform, capabilities=capabilities)

    def test_noop_when_flag_off_even_if_agent_sends_capabilities(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", False)
        service = self._service()
        device = self._device(platform="linux")
        payload = AgentHeartbeatPayload(capabilities=["bash", "docker"])
        service._process_capabilities(payload, device)
        assert device.capabilities is None
        service.db.commit.assert_not_called()

    def test_noop_when_no_capabilities_sent(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
        service = self._service()
        device = self._device(platform="linux")
        service._process_capabilities(AgentHeartbeatPayload(), device)
        service.db.commit.assert_not_called()

    def test_persists_normalized_capabilities_when_enabled(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
        service = self._service()
        device = self._device(platform="linux")
        payload = AgentHeartbeatPayload(capabilities={"docker": "26.1", "nonsense": "1"})
        service._process_capabilities(payload, device)
        assert device.capabilities == {"docker": "26.1"}
        service.db.commit.assert_called_once()

    def test_no_write_when_capabilities_unchanged(self, monkeypatch):
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
        service = self._service()
        device = self._device(platform="linux", capabilities={"docker": "26.1"})
        payload = AgentHeartbeatPayload(capabilities={"docker": "26.1"})
        service._process_capabilities(payload, device)
        service.db.commit.assert_not_called()
