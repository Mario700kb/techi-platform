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
