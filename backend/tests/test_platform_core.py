"""Phase 0 — Platform Core Foundation tests.

Covers the three Phase 0 deliverables (flags, Platform Registry, Capability
Registry) and the flag-off bit-identity contract at the config level.
"""

from app.core.config import settings
from app.platform_core import (
    DEFAULT_PLATFORM_ID,
    FEATURE_DEPENDENCIES,
    KNOWN_CAPABILITIES,
    PLATFORM_REGISTRY,
    feature_enabled,
    is_known_capability,
    is_known_platform,
    normalize_capabilities,
    resolve_platform,
)

ALL_FLAGS = tuple(FEATURE_DEPENDENCIES.keys())


class TestFeatureFlags:
    def test_all_flags_exist_on_settings_and_default_off(self):
        for flag in ALL_FLAGS:
            assert hasattr(settings, flag), f"{flag} missing from Settings"
            assert getattr(settings, flag) is False, f"{flag} must default OFF"

    def test_feature_enabled_is_false_by_default(self):
        for flag in ALL_FLAGS:
            assert feature_enabled(flag) is False

    def test_unknown_flag_fails_closed(self):
        assert feature_enabled("FEATURE_DOES_NOT_EXIST") is False

    def test_dependencies_gate_enablement(self, monkeypatch):
        # FEATURE_LINUX alone is not effective without FEATURE_PLATFORM_CORE.
        monkeypatch.setattr(settings, "FEATURE_LINUX", True)
        assert feature_enabled("FEATURE_LINUX") is False
        monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
        assert feature_enabled("FEATURE_LINUX") is True
        # Terminal needs core + linux + vault.
        monkeypatch.setattr(settings, "FEATURE_TERMINAL", True)
        assert feature_enabled("FEATURE_TERMINAL") is False
        monkeypatch.setattr(settings, "FEATURE_VAULT", True)
        assert feature_enabled("FEATURE_TERMINAL") is True

    def test_dependency_flags_are_all_known(self):
        for deps in FEATURE_DEPENDENCIES.values():
            for dep in deps:
                assert dep in FEATURE_DEPENDENCIES


class TestPlatformRegistry:
    def test_windows_is_default_and_ungated_lts(self):
        windows = PLATFORM_REGISTRY[DEFAULT_PLATFORM_ID]
        assert windows.mode == "native_agent"
        assert windows.feature_flag == ""  # reference implementation, never gated
        assert windows.certification_stage == "lts"

    def test_expected_platforms_registered(self):
        assert set(PLATFORM_REGISTRY) == {
            "windows",
            "linux",
            "mikrotik",
            "synology",
            "qnap",
            "vmware",
            "hyperv",
            "proxmox",
        }

    def test_every_non_windows_platform_is_flag_gated(self):
        for descriptor in PLATFORM_REGISTRY.values():
            if descriptor.id == DEFAULT_PLATFORM_ID:
                continue
            assert descriptor.feature_flag in FEATURE_DEPENDENCIES

    def test_absence_resolves_to_windows(self):
        # Audit §8: existing rows are never backfilled; NULL/empty ⇒ windows.
        assert resolve_platform(None).id == "windows"
        assert resolve_platform("").id == "windows"
        assert resolve_platform("   ").id == "windows"

    def test_known_values_resolve_case_insensitively(self):
        assert resolve_platform("Linux").id == "linux"
        assert resolve_platform("  MIKROTIK ").id == "mikrotik"
        assert is_known_platform("Windows")

    def test_unknown_value_fails_closed(self):
        # An unknown platform must not silently become Windows.
        assert resolve_platform("templeos") is None
        assert not is_known_platform("templeos")

    def test_allowed_capabilities_subset_of_vocabulary(self):
        for descriptor in PLATFORM_REGISTRY.values():
            assert descriptor.allowed_capabilities <= KNOWN_CAPABILITIES


class TestCapabilityRegistry:
    def test_vocabulary_membership(self):
        assert is_known_capability("docker")
        assert is_known_capability("  Bash ")
        assert not is_known_capability("bitcoin_miner")
        assert not is_known_capability(None)

    def test_normalize_from_list(self):
        assert normalize_capabilities(["docker", "BASH", "unknown_cap"]) == {
            "docker": "",
            "bash": "",
        }

    def test_normalize_from_mapping_keeps_versions(self):
        reported = {"docker": "26.1", "systemd": 252, "nonsense": "1"}
        assert normalize_capabilities(reported) == {"docker": "26.1", "systemd": "252"}

    def test_normalize_garbage_payloads(self):
        assert normalize_capabilities(None) == {}
        assert normalize_capabilities("docker") == {}
        assert normalize_capabilities(42) == {}
        assert normalize_capabilities([42, None, {"a": 1}]) == {}


class TestPhase0Darkness:
    def test_nothing_in_app_imports_platform_core(self):
        """Phase 0 contract: platform_core is dark — no existing module wires it."""
        import pathlib

        app_dir = pathlib.Path(__file__).resolve().parents[1] / "app"
        offenders = []
        for path in app_dir.rglob("*.py"):
            if "platform_core" in path.parts:
                continue
            if "platform_core" in path.read_text(encoding="utf-8"):
                offenders.append(str(path))
        assert offenders == [], f"platform_core imported outside itself: {offenders}"
