"""FEATURE_SSH — Embedded SSH is off by default (RISK-SSH-001).

Embedded SSH dials the device from the backend (`host = local_ip or
public_ip`), which no NAT'd endpoint can satisfy: every attempt on device 729
ended `ssh connect failed: reason=timeout`, and the public_ip fallback would
mean exposing port 22 on customer servers. Rather than delete a feature that
works for directly routable hosts, it is flag-gated OFF and shown in the
Connect menu as unavailable with the real reason.

These tests pin the two properties that matter: the flag fails closed, and
turning it off does not disturb the Embedded Terminal, which is the path
operators actually use.
"""

from app.core.config import settings
from app.platform_core.flags import FEATURE_DEPENDENCIES, feature_enabled


def _enable(monkeypatch, **flags):
    for name, value in flags.items():
        monkeypatch.setattr(settings, name, value)


ALL_ON = dict(
    FEATURE_PLATFORM_CORE=True,
    FEATURE_LINUX=True,
    FEATURE_VAULT=True,
    FEATURE_TERMINAL=True,
    FEATURE_SSH=True,
)


class TestFlagWiring:
    def test_ssh_is_off_by_default(self):
        assert settings.model_fields["FEATURE_SSH"].default is False

    def test_ssh_is_a_known_flag(self):
        """Unknown names fail closed, which would hide a wiring mistake as a
        permanently-off feature."""
        assert "FEATURE_SSH" in FEATURE_DEPENDENCIES

    def test_ssh_requires_the_stack_it_runs_on(self, monkeypatch):
        _enable(monkeypatch, **ALL_ON)
        assert feature_enabled("FEATURE_SSH") is True

        for dependency in ("FEATURE_TERMINAL", "FEATURE_VAULT", "FEATURE_LINUX", "FEATURE_PLATFORM_CORE"):
            _enable(monkeypatch, **ALL_ON)
            _enable(monkeypatch, **{dependency: False})
            assert feature_enabled("FEATURE_SSH") is False, (
                f"SSH must not be available with {dependency} off"
            )

    def test_terminal_does_not_depend_on_ssh(self, monkeypatch):
        """Turning SSH off must leave the Embedded Terminal fully working."""
        _enable(monkeypatch, **ALL_ON)
        _enable(monkeypatch, FEATURE_SSH=False)
        assert feature_enabled("FEATURE_TERMINAL") is True


class TestConnectMenuStatus:
    def _status(self, monkeypatch, ssh_on: bool):
        from app.api.v1.endpoints import connect as connect_endpoint
        from app.platform_core.connect import CONNECT_METHODS

        _enable(monkeypatch, **ALL_ON)
        _enable(monkeypatch, FEATURE_SSH=ssh_on)
        monkeypatch.setattr(connect_endpoint, "is_device_in_rollout", lambda *a, **k: True)

        ssh_method = next(m for m in CONNECT_METHODS["linux"] if m.id == "ssh")
        device = type("D", (), {"id": 729, "platform": "linux", "capabilities": None})()
        return connect_endpoint._method_status(None, device, ssh_method)

    def test_ssh_is_unavailable_with_an_honest_reason_when_off(self, monkeypatch):
        status, reason, _ = self._status(monkeypatch, ssh_on=False)
        assert status == "unavailable"
        assert "direct route" in reason, (
            "the reason must name the actual limitation, not a generic error"
        )

    def test_ssh_is_not_hidden_when_off(self, monkeypatch):
        """The Connect menu shows methods it cannot run, with a reason — the
        registry must still list SSH for Linux."""
        from app.platform_core.connect import CONNECT_METHODS

        assert any(m.id == "ssh" for m in CONNECT_METHODS["linux"])

    def test_web_terminal_is_unaffected_by_the_ssh_flag(self, monkeypatch):
        from app.api.v1.endpoints import connect as connect_endpoint
        from app.platform_core.connect import CONNECT_METHODS

        _enable(monkeypatch, **ALL_ON)
        _enable(monkeypatch, FEATURE_SSH=False)
        monkeypatch.setattr(connect_endpoint, "is_device_in_rollout", lambda *a, **k: True)

        terminal = next(m for m in CONNECT_METHODS["linux"] if m.id == "web_terminal")
        device = type("D", (), {"id": 729, "platform": "linux", "capabilities": None})()
        status, _, _ = connect_endpoint._method_status(None, device, terminal)
        assert status == "ready"
