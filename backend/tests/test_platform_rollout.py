"""Generic feature rollout scoping (app.platform_core.rollout).

Reusable mechanism, tested independently of Terminal: none/device/group/
client/fleet, fail-closed defaults, malformed-value tolerance.
"""

from types import SimpleNamespace

from app.core.config import settings
from app.platform_core import rollout as rollout_module
from app.platform_core.rollout import RolloutScope, get_scope, is_device_in_rollout, is_rollout_allowed


class _FakeDevice:
    def __init__(self, id, group_id=None, client_id=None):
        self.id = id
        self.group_id = group_id
        self.client_id = client_id


def _set(monkeypatch, prefix, scope="", devices="", groups="", clients=""):
    monkeypatch.setattr(settings, f"{prefix}_SCOPE", scope, raising=False)
    monkeypatch.setattr(settings, f"{prefix}_ALLOWED_DEVICE_IDS", devices, raising=False)
    monkeypatch.setattr(settings, f"{prefix}_ALLOWED_GROUPS", groups, raising=False)
    monkeypatch.setattr(settings, f"{prefix}_ALLOWED_CLIENTS", clients, raising=False)


def test_default_scope_missing_setting_fails_closed(monkeypatch):
    # No FEATURE_X_SCOPE configured at all for an unrelated prefix.
    assert get_scope("FEATURE_NONEXISTENT") == RolloutScope.NONE
    assert is_rollout_allowed("FEATURE_NONEXISTENT", device_id=1) is False


def test_scope_none_denies_everyone(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="none", devices="1,2,3")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1) is False


def test_scope_fleet_allows_everyone(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="fleet")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=999) is True
    assert is_rollout_allowed("FEATURE_TERMINAL") is True


def test_scope_device_allowlist(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="device", devices=" 7, 42 ,not-a-number,")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=7) is True
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=42) is True
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=8) is False
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=None) is False


def test_scope_group_allowlist(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="group", groups="5,9")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, group_id=5) is True
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, group_id=6) is False
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, group_id=None) is False
    # A device_id on the allowlist for a DIFFERENT scope must not leak through.
    _set(monkeypatch, "FEATURE_TERMINAL", scope="group", devices="1", groups="")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, group_id=5) is False


def test_scope_client_allowlist(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="client", clients="100")
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, client_id=100) is True
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, client_id=101) is False
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1, client_id=None) is False


def test_unknown_scope_value_fails_closed(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="everyone-lol", devices="1")
    assert get_scope("FEATURE_TERMINAL") == RolloutScope.NONE
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1) is False


def test_is_device_in_rollout_reads_device_attributes(monkeypatch):
    _set(monkeypatch, "FEATURE_TERMINAL", scope="device", devices="7")
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=7)) is True
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=8)) is False

    _set(monkeypatch, "FEATURE_TERMINAL", scope="group", groups="5")
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=1, group_id=5)) is True
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=1, group_id=6)) is False

    _set(monkeypatch, "FEATURE_TERMINAL", scope="client", clients="100")
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=1, client_id=100)) is True
    assert is_device_in_rollout("FEATURE_TERMINAL", _FakeDevice(id=1, client_id=101)) is False


def test_scope_reusable_for_a_different_feature_prefix(monkeypatch):
    # `is_rollout_allowed` takes the feature prefix as a parameter — it is not
    # hardcoded to Terminal. Proven with a hypothetical future consumer
    # (FEATURE_SSH_RELAY) that has no dedicated Settings fields at all yet,
    # via a stand-in settings object swapped into the module.
    fake_settings = SimpleNamespace(
        FEATURE_TERMINAL_SCOPE="none",
        FEATURE_SSH_RELAY_SCOPE="fleet",
    )
    monkeypatch.setattr(rollout_module, "settings", fake_settings)
    assert is_rollout_allowed("FEATURE_SSH_RELAY", device_id=1) is True
    # Unrelated prefix's scope is untouched by Terminal's.
    assert is_rollout_allowed("FEATURE_TERMINAL", device_id=1) is False
