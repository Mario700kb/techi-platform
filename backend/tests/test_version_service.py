"""Version Service — reused, not reimplemented, per platform."""
from app.services import version_service as vs


class TestCompareVersions:
    def test_equal_strings_are_current(self):
        assert vs.compare_versions("1.0.0", "1.0.0") == "current"

    def test_older_numeric_is_outdated(self):
        assert vs.compare_versions("1.0.0", "1.0.1") == "outdated"
        assert vs.compare_versions("2.1.5", "2.1.6") == "outdated"

    def test_newer_numeric_is_ahead(self):
        assert vs.compare_versions("2.1.7", "2.1.6") == "ahead"

    def test_missing_either_side_is_unknown(self):
        assert vs.compare_versions(None, "1.0.0") == "unknown"
        assert vs.compare_versions("1.0.0", None) == "unknown"
        assert vs.compare_versions("", "") == "unknown"

    def test_unparseable_nonequal_strings_are_outdated(self):
        # Same fallback the prior string-equality check used: not equal -> mismatch.
        assert vs.compare_versions("dev-build", "1.0.0") == "outdated"

    def test_trailing_zero_segments_are_current(self):
        # Missing trailing segments are zero: 1.4.6 == 1.4.6.0 (RS regression).
        assert vs.compare_versions("1.4.6", "1.4.6.0") == "current"
        assert vs.compare_versions("2.1.19", "2.1.19.0") == "current"
        assert vs.compare_versions("1.4", "1.4.0.0") == "current"

    def test_cross_width_older_and_newer(self):
        assert vs.compare_versions("1.4.5", "1.4.6.0") == "outdated"
        assert vs.compare_versions("2.0", "1.9.9") == "ahead"
        assert vs.compare_versions("2.1.20", "2.1.19.9") == "ahead"


class TestGetActiveVersion:
    def test_mikrotik_reads_from_platform_registry(self):
        assert vs.get_active_version("mikrotik") == "1.0.0"

    def test_windows_delegates_to_agent_package_service(self, monkeypatch):
        from types import SimpleNamespace
        import app.services.agent_package_service as pkg_mod

        monkeypatch.setattr(
            pkg_mod.AgentPackageService, "latest_active",
            lambda self, *a, **kw: SimpleNamespace(version="2.1.6"),
        )
        assert vs.get_active_version("windows") == "2.1.6"
        assert vs.get_active_version(None) == "2.1.6"

    def test_platform_with_no_declared_version_returns_none(self):
        # Linux declares no latest_connector_version and isn't "windows".
        assert vs.get_active_version("linux") is None


class TestAgentPlatformResolution:
    """Which AgentPackage a device is measured against.

    Linux was declared an agent platform from the start but never resolved:
    get_active_version only ever looked up windows-amd64, so a Linux device
    always got None and rendered "unknown" — device 729 stayed un-badged on
    2.1.21 while 2.1.21 was the latest build (2026-08-05).
    """

    def test_linux_maps_uname_architectures_to_package_platforms(self):
        from app.services import version_service as vs

        assert vs._package_platform("linux", "x86_64") == "linux-amd64"
        assert vs._package_platform("linux", "amd64") == "linux-amd64"
        assert vs._package_platform("linux", "aarch64") == "linux-arm64"
        assert vs._package_platform("linux", "arm64") == "linux-arm64"
        assert vs._package_platform("linux", "armv7l") == "linux-armhf"

    def test_linux_architecture_matching_is_case_and_space_tolerant(self):
        from app.services import version_service as vs

        assert vs._package_platform("linux", " X86_64 ") == "linux-amd64"

    def test_unknown_or_missing_linux_architecture_resolves_to_nothing(self):
        """Better an "unknown" badge than measuring a device against a build
        it does not run."""
        from app.services import version_service as vs

        assert vs._package_platform("linux", None) is None
        assert vs._package_platform("linux", "") is None
        assert vs._package_platform("linux", "riscv64") is None

    def test_windows_still_resolves_to_windows_amd64(self):
        from app.services import version_service as vs

        assert vs._package_platform("windows", None) == "windows-amd64"
        assert vs._package_platform(None, None) == "windows-amd64"

    def test_connector_platforms_do_not_use_packages(self):
        from app.services import version_service as vs

        assert vs._package_platform("mikrotik", None) is None

    def test_an_arm64_device_is_not_marked_outdated_by_the_amd64_build(self):
        """The two Linux builds move independently; comparing across them
        would report a false rollout gap."""
        from app.services import version_service as vs

        assert vs._package_platform("linux", "aarch64") != vs._package_platform("linux", "x86_64")


class TestFleetOverviewAgentVersions:
    """The Device List badge reads active_agent_versions.

    Before this existed, a Linux row fell through to the connector lookup —
    which Linux never populates — resolved to None, and rendered grey however
    current the agent was. Windows must keep using active_agent_version.
    """

    def test_linux_architectures_are_published_for_the_badge(self):
        from app.services import version_service as vs

        architectures = vs.linux_architectures()
        assert "x86_64" in architectures
        assert "aarch64" in architectures

    def test_published_architectures_all_resolve_to_a_package_platform(self):
        """A key the frontend can be handed but never resolve is a silent
        grey badge, which is the bug this replaced."""
        from app.services import version_service as vs

        for architecture in vs.linux_architectures():
            assert vs._package_platform("linux", architecture) is not None

    def test_overview_keys_are_platform_colon_architecture(self, monkeypatch):
        from app.services import device_overview_service as dos
        from app.services import version_service as vs

        monkeypatch.setattr(
            vs, "get_active_version",
            lambda platform, architecture=None: "2.1.21" if architecture == "x86_64" else None,
        )
        versions = dos._active_agent_versions()
        assert versions == {"linux:x86_64": "2.1.21"}, (
            "only architectures with an active package should be published"
        )

    def test_windows_is_absent_from_agent_versions(self, monkeypatch):
        """Windows badges must stay on active_agent_version, untouched."""
        from app.services import device_overview_service as dos
        from app.services import version_service as vs

        monkeypatch.setattr(vs, "get_active_version", lambda platform, architecture=None: "9.9.9")
        versions = dos._active_agent_versions()
        assert all(key.startswith("linux:") for key in versions)


class TestOutdatedAgentCounting:
    """Who counts toward AGENT UPDATE / Needs Agent Update.

    Every device used to be measured against the Windows package version, so
    MikroTik connectors on 1.0.0 and Linux agents on 2.1.21 were both counted
    as needing an update against Windows' 2.1.20 — the operator reported the
    tile and the filter inflated by the whole non-Windows fleet (2026-08-05).
    """

    class _Device:
        def __init__(self, platform, version, architecture=None, sha256=None):
            self.platform = platform
            self.agent_version = version
            self.architecture = architecture
            self.agent_sha256 = sha256

    AGENT_VERSIONS = {"linux:x86_64": "2.1.21"}
    CONNECTOR_VERSIONS = {"mikrotik": "1.0.0"}

    def _outdated(self, device):
        from app.services import device_overview_service as dos

        return dos._is_device_agent_outdated(
            device, "2.1.20", None, self.AGENT_VERSIONS, self.CONNECTOR_VERSIONS
        )

    def test_a_current_mikrotik_is_not_counted(self):
        assert self._outdated(self._Device("mikrotik", "1.0.0")) is False

    def test_a_current_linux_agent_is_not_counted(self):
        assert self._outdated(self._Device("linux", "2.1.21", "x86_64")) is False

    def test_a_genuinely_old_linux_agent_is_counted(self):
        assert self._outdated(self._Device("linux", "2.1.5", "x86_64")) is True

    def test_a_genuinely_old_mikrotik_connector_is_counted(self):
        assert self._outdated(self._Device("mikrotik", "0.9.0")) is True

    def test_a_platform_with_no_known_latest_is_never_counted(self):
        """An unmeasurable device is not a stale one."""
        assert self._outdated(self._Device("linux", "2.1.21", "riscv64")) is False
        assert self._outdated(self._Device("synology", "1.0.0")) is False

    def test_windows_keeps_the_original_two_state_check(self):
        assert self._outdated(self._Device("windows", "2.1.20")) is False
        assert self._outdated(self._Device("windows", "2.1.19")) is True

    def test_a_linux_agent_ahead_of_the_package_is_not_counted(self):
        """Ahead is not behind — it must not appear in an update queue."""
        assert self._outdated(self._Device("linux", "2.2.0", "x86_64")) is False
