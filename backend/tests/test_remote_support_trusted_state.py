from app.models.device import Device, DeviceStatus
from app.services.remote_support_state_service import (
    classify_authenticated_remote_support,
)


def test_authenticated_state_matrix_distinguishes_unknown_missing_and_damaged():
    cases = [
        ("unknown", "unknown", "unknown"),
        ("not_installed", "not_installed", "missing"),
        ("damaged", "stale_service", "damaged"),
        ("installed", "running", "installed_running"),
        ("installed", "stopped", "installed_stopped"),
    ]
    for install, runtime, expected in cases:
        state = classify_authenticated_remote_support(
            install_status=install,
            runtime_status=runtime,
        )
        assert state.state == expected


def test_legacy_without_trusted_evidence_is_status_unavailable():
    device = Device(
        hostname="legacy",
        status=DeviceStatus.ONLINE,
        heartbeat_auth_state="legacy_restricted",
        remote_support_trusted_state="unknown",
        remote_support_state_trusted_at=None,
    )
    assert device.remote_support_state == "legacy_status_unavailable"
