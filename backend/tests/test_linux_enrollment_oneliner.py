"""Phase 3b — Linux enrollment one-liner (flag-gated)."""

from app.core.config import settings
from app.schemas.enrollment_bootstrap import EnrollmentBootstrapPlatform
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService


def _posix(token="TKN-XYZ"):
    svc = EnrollmentBootstrapService(db=None)
    return svc._posix_bootstrap(
        EnrollmentBootstrapPlatform.LINUX,
        "https://api-rdp.techi.com.al",
        token,
        config_template="{}",
    )


def test_flag_off_keeps_legacy_script(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", False)
    monkeypatch.setattr(settings, "FEATURE_LINUX", False)
    command, script = _posix()
    # Legacy path: not the install one-liner.
    assert "/api/v1/install/linux" not in command
    assert "bash ./techi-bootstrap.sh" == command


def test_flag_on_uses_install_oneliner(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    monkeypatch.setattr(settings, "FEATURE_LINUX", True)
    command, script = _posix(token="TKN-ABC")
    assert command.startswith("curl -fsSL")
    assert "/api/v1/install/linux?token=TKN-ABC" in command
    assert "sudo bash" in command
    assert command in script
