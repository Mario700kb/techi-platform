"""Component Package Integration (Operational M11): Installed / Desired /
Available versions, Outdated detection, and version-changing payload enrichment.
Reuses the STABLE Desired-State resolver + Package Registry (no new storage).
"""
from types import SimpleNamespace

from app.platform_core.components import ComponentHealth, LifecycleOperation
from app.services.component_package_service import ComponentPackageService
from app.services.component_state_service import ComponentDeviceState


def _pkg(version, file_type="agent_binary", platform="windows-amd64", sha256=None, active=True):
    return SimpleNamespace(
        version=version,
        sha256=sha256,
        is_active=active,
        platform=SimpleNamespace(value=platform),
        file_type=SimpleNamespace(value=file_type),
    )


class _FakePackages:
    def __init__(self, packages):
        self._packages = packages

    def latest_active(self, platform, *, file_type=None):
        actives = [
            p for p in self._packages
            if p.is_active and p.platform.value == platform
            and (file_type is None or p.file_type.value == file_type)
        ]
        return actives[0] if actives else None

    def list_packages(self, *, include_inactive=False):
        if include_inactive:
            return list(self._packages)
        return [p for p in self._packages if p.is_active]


def _svc(packages):
    svc = ComponentPackageService(db=None)
    svc._packages = _FakePackages(packages)
    return svc


def _device(platform="windows"):
    return SimpleNamespace(platform=platform, agent_version=None, rustdesk_version=None)


# --------------------------------------------------------------------------- #
# Available version                                                           #
# --------------------------------------------------------------------------- #
def test_available_is_highest_version_active_or_inactive():
    svc = _svc([
        _pkg("2.1.14", active=True),
        _pkg("2.1.20", active=False),   # uploaded, not activated
        _pkg("2.1.5", active=False),
    ])
    assert svc.available_version("agent", "windows") == "2.1.20"


def test_available_none_when_no_packages():
    assert _svc([]).available_version("agent", "windows") is None


# --------------------------------------------------------------------------- #
# Status (reuses Desired-State resolver)                                       #
# --------------------------------------------------------------------------- #
def test_status_combines_state_and_available(monkeypatch):
    svc = _svc([_pkg("2.1.14", active=True), _pkg("2.1.20", active=False)])
    monkeypatch.setattr(
        svc._states, "resolve_for_device",
        lambda device: [ComponentDeviceState(
            component_id="agent", display_name="TECHI Agent", icon_key="agent",
            installed_version="2.1.5", desired_version="2.1.14",
            health=ComponentHealth.OUTDATED, status="Outdated",
        )],
    )
    status = svc.status_for(_device(), "agent")
    assert status.installed_version == "2.1.5"
    assert status.desired_version == "2.1.14"
    assert status.available_version == "2.1.20"
    assert status.outdated is True


# --------------------------------------------------------------------------- #
# Payload enrichment (version-changing ops only)                              #
# --------------------------------------------------------------------------- #
def test_enrichment_injects_version_and_sha_for_update():
    svc = _svc([_pkg("2.1.14", sha256="deadbeef", active=True)])
    enrich = svc.enrichment_for("agent", "windows", LifecycleOperation.UPDATE)
    assert enrich == {"version": "2.1.14", "target_sha256": "deadbeef"}


def test_enrichment_empty_for_non_version_changing_op():
    svc = _svc([_pkg("2.1.14", active=True)])
    assert svc.enrichment_for("agent", "windows", LifecycleOperation.RESTART) == {}


def test_enrichment_empty_when_no_active_package():
    svc = _svc([_pkg("2.1.14", active=False)])
    assert svc.enrichment_for("agent", "windows", LifecycleOperation.UPDATE) == {}
