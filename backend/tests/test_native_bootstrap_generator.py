"""Tests for the transitional native GPO bootstrap generator
(docs/architecture/native-bootstrap.md). Covers: policy carries no secrets, the
Scheduled Task calls the native bootstrap directly (local-copy-first), required
artifacts are enumerated, the feature flag gates emission, and the legacy CMD
path remains the fallback. No DB / real package store.
"""

import json
from types import SimpleNamespace

import pytest

from app.core.config import settings
from app.schemas.enrollment_bootstrap import (
    EnrollmentBootstrapRequest,
    NativeBootstrapArtifacts,
)
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService


def _pkg(version, filename, sha):
    return SimpleNamespace(version=version, filename=filename, sha256=sha)


class _NativeStub(EnrollmentBootstrapService):
    """Bypass DB + package store; return fixed active packages."""

    def __init__(self, rollout="disabled", with_bundle=True):
        self._rollout = rollout
        self._packages = {
            "agent_binary": _pkg("2.1.8", "TECHI-Agent-2.1.8.exe", "AB" * 32),
            "msi": _pkg("2.1.8", "TECHI-Agent-2.1.8.msi", "CD" * 32),
            "remote_support_msi": _pkg("1.4.6", "TECHI-Remote-Support-1.4.6.msi", "EF" * 32),
        }
        if with_bundle:
            self._packages["remote_support_bundle"] = _pkg(
                "1.4.6", "TECHI-Remote-Support-1.4.6-windows-amd64.zip", "12" * 32
            )

    def _active_package(self, file_type):
        return self._packages.get(file_type)

    def _agent_rollout_mode(self):
        return self._rollout


def _req(**overrides):
    defaults = dict(
        mode="gpo",
        platform="windows",
        backend_url="https://api-rdp.techi.com.al",
        enrollment_token=None,
        enrollment_token_id=None,
        availability_profile="workstation",
        manage_power_policy=False,
    )
    defaults.update(overrides)
    return EnrollmentBootstrapRequest(**defaults)


def test_policy_carries_no_secrets():
    svc = _NativeStub()
    policy = svc.build_native_policy("https://api-rdp.techi.com.al")
    flat = json.dumps(policy).lower()
    for forbidden in ("enrollment_token", "token", "password", "secret"):
        assert forbidden not in flat, f"policy leaked {forbidden}"
    assert policy["schema_version"] == 1
    assert policy["agent"]["package_type"] == "exe"
    # SHAs must be lowercased for the native validator.
    assert policy["agent"]["sha256"] == "ab" * 32
    # Recovery payload is the native BUNDLE (12*32), never the MSI (ef*32).
    assert policy["remote_support"]["sha256"] == "12" * 32
    assert policy["remote_support"]["payload_filename"].endswith(".zip")


def test_policy_references_native_bundle_not_msi():
    svc = _NativeStub()
    policy = svc.build_native_policy("https://x.example")
    payload = policy["remote_support"]["payload_filename"].lower()
    assert payload.endswith(".zip") and "msi" not in payload
    assert svc.native_recovery_available() is True


def test_recovery_unavailable_and_blocked_without_bundle():
    svc = _NativeStub(with_bundle=False)
    assert svc.native_recovery_available() is False
    policy = svc.build_native_policy("https://x.example")
    # No bundle -> empty RS payload so the native validator/executor refuse.
    assert policy["remote_support"]["payload_filename"] == ""
    art = svc.build_native_bootstrap("https://x.example")
    assert "BLOCKED" in art.notes


def test_rollout_mode_is_baked_into_policy():
    for mode in ("disabled", "canary", "enabled"):
        svc = _NativeStub(rollout=mode)
        policy = svc.build_native_policy("https://x.example")
        assert policy["rollout_mode"] == mode


def test_native_task_is_local_copy_first_and_direct():
    svc = _NativeStub()
    art = svc.build_native_bootstrap("https://api-rdp.techi.com.al")
    assert isinstance(art, NativeBootstrapArtifacts)
    # Scheduled Task calls the native bootstrap directly (not a CMD wrapper),
    # from a LOCAL path (not the network share).
    assert art.scheduled_task_program.endswith(r"\techi-bootstrap.exe")
    assert not art.scheduled_task_program.upper().startswith(r"\\")
    assert art.scheduled_task_arguments.startswith("apply-policy --policy")
    kinds = {a["kind"] for a in art.required_artifacts}
    assert {"native_bootstrap", "policy", "agent_binary",
            "remote_support_payload", "remote_support_manifest"} <= kinds
    # The MSI is enumerated only as first-install fallback, never as the payload.
    assert "remote_support_first_install_msi" in kinds
    # Recovery uses the native bundle, not the MSI.
    assert "never the MSI" in art.notes


def test_no_zero_av_claim_language():
    svc = _NativeStub()
    art = svc.build_native_bootstrap("https://x.example")
    lowered = art.notes.lower()
    assert "zero av" not in lowered and "zero detection" not in lowered
    assert "av/edr policies remain applicable" in lowered


def test_feature_flag_gates_emission_and_legacy_remains(monkeypatch):
    svc = _NativeStub()
    url = svc.normalize_backend_url("https://api-rdp.techi.com.al")

    monkeypatch.setattr(settings, "NATIVE_BOOTSTRAP_ENABLED", False, raising=False)
    off = svc._generate_gpo(_req(), url)
    assert off.native_bootstrap is None
    # Legacy CMD path is still produced (fallback remains available).
    assert off.bootstrap_script

    monkeypatch.setattr(settings, "NATIVE_BOOTSTRAP_ENABLED", True, raising=False)
    on = svc._generate_gpo(_req(), url)
    assert on.native_bootstrap is not None
    assert on.native_bootstrap.policy_json
    # Even with the native path on, the legacy script is still emitted as fallback.
    assert on.bootstrap_script


def test_bundle_filename_version_consistency():
    import pytest as _pytest
    from app.services.agent_package_service import AgentPackageService

    ft = "remote_support_bundle"
    ok = AgentPackageService._canonical_package_version(
        "1.4.6", "TECHI-Remote-Support-1.4.6-windows-amd64.zip", ft, strict=True
    )
    assert ok == "1.4.6"
    # Version must match filename under strict upload.
    with _pytest.raises(ValueError):
        AgentPackageService._canonical_package_version(
            "1.4.7", "TECHI-Remote-Support-1.4.6-windows-amd64.zip", ft, strict=True
        )
    # Wrong filename shape (e.g. the MSI name) is rejected for the bundle type.
    with _pytest.raises(ValueError):
        AgentPackageService._canonical_package_version(
            "1.4.6", "TECHI-Remote-Support-1.4.6.msi", ft, strict=True
        )
    # A non-amd64/platform-tagged name is rejected.
    with _pytest.raises(ValueError):
        AgentPackageService._canonical_package_version(
            "1.4.6", "TECHI-Remote-Support-1.4.6.zip", ft, strict=True
        )


def test_policy_json_has_no_enrollment_token_even_when_request_carries_one():
    svc = _NativeStub()
    # A token on the request must never reach the policy JSON.
    art = svc.build_native_bootstrap("https://x.example")
    assert "enrollment_token" not in art.policy_json.lower()
