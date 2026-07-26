"""Component Package Integration (Operational M11): Installed / Desired /
Available versions, Outdated detection, and version-changing payload enrichment.
Reuses the STABLE Desired-State resolver + Package Registry (no new storage).
"""
from types import SimpleNamespace

import pytest

from app.platform_core.components import ComponentHealth, LifecycleOperation
from app.services.component_package_service import ComponentPackageService
from app.services.component_state_service import ComponentDeviceState


def _pkg(version, file_type="agent_binary", platform="windows-amd64", sha256=None, active=True, **metadata):
    return SimpleNamespace(
        version=version,
        filename=metadata.get("filename", "pkg.msi"),
        sha256=sha256,
        is_active=active,
        platform=SimpleNamespace(value=platform),
        file_type=SimpleNamespace(value=file_type),
        product_name=metadata.get("product_name"),
        product_version=metadata.get("product_version"),
        product_code=metadata.get("product_code"),
        upgrade_code=metadata.get("upgrade_code"),
        file_size=metadata.get("file_size"),
        metadata_status=metadata.get("metadata_status"),
        metadata_error=metadata.get("metadata_error"),
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

    def remote_support_msi_download_url(self):
        return "/api/v1/agent-packages/remote-support-msi/download"


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
def test_remote_support_trailing_zero_is_not_outdated():
    """End-to-end through the real Desired-State resolver: RS installed 1.4.6
    against desired 1.4.6.0 must report outdated=False (production regression)."""
    packages = [_pkg("1.4.6.0", file_type="remote_support_msi", active=True)]
    svc = ComponentPackageService(db=None)
    svc._packages = _FakePackages(packages)
    svc._states._packages = _FakePackages(packages)  # real resolver, faked pkg source
    device = SimpleNamespace(platform="windows", agent_version=None, rustdesk_version="1.4.6")

    status = svc.status_for(device, "remote_support")

    assert status.installed_version == "1.4.6"
    assert status.desired_version == "1.4.6.0"
    assert status.outdated is False


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
def test_agent_self_update_enrichment_reuses_command_center_builder(monkeypatch):
    """The Drawer's agent self_update must produce the SAME complete payload as
    Command Center — built by the ONE shared builder — so it includes
    download_url (the field whose absence broke the Drawer)."""
    captured = {}

    def fake_builder(devices):
        captured["devices"] = devices
        payload = {
            "download_url": "https://api.example.test/api/v1/agent-packages/agent-binary/download",
            "version": "2.1.18",
            "sha256": "abc123",
        }
        return payload, {devices[0].id: dict(payload)}

    monkeypatch.setattr(
        "app.services.agent_command_service.AgentCommandService._build_self_update_payloads",
        staticmethod(fake_builder),
    )
    svc = _svc([_pkg("2.1.18", file_type="agent_binary", sha256="abc123", active=True)])
    device = SimpleNamespace(id=42, platform="windows", agent_version="2.1.8")

    enrich = svc.enrichment_for("agent", device, LifecycleOperation.UPDATE)

    assert enrich["download_url"].endswith("/agent-binary/download")
    assert enrich["version"] == "2.1.18"
    assert enrich["sha256"] == "abc123"
    # It genuinely delegated to the shared builder for THIS device.
    assert captured["devices"][0].id == 42


def test_agent_self_update_enrichment_inert_when_builder_cannot_build(monkeypatch):
    """No active binary (or legacy bridge missing) -> shared builder raises;
    enrichment stays inert ({}) rather than introducing a new failure path."""

    def boom(devices):
        raise ValueError("No active agent binary package")

    monkeypatch.setattr(
        "app.services.agent_command_service.AgentCommandService._build_self_update_payloads",
        staticmethod(boom),
    )
    svc = _svc([])
    device = SimpleNamespace(id=7, platform="windows", agent_version="2.1.18")
    assert svc.enrichment_for("agent", device, LifecycleOperation.UPDATE) == {}


def test_enrichment_empty_for_non_version_changing_op():
    svc = _svc([_pkg("2.1.14", active=True)])
    assert svc.enrichment_for("agent", "windows", LifecycleOperation.RESTART) == {}


def test_remote_support_enrichment_injects_msi_metadata(monkeypatch):
    monkeypatch.setattr(
        "app.services.component_package_service.settings.PUBLIC_BACKEND_URL",
        "https://api.example.test",
    )
    svc = _svc([
        _pkg(
            "1.4.9",
            file_type="remote_support_msi",
            sha256="cafebabe",
            active=True,
            product_name="TECHI Remote Support",
            product_version="1.4.9.0",
            product_code="{PRODUCT-CODE}",
            upgrade_code="{UPGRADE-CODE}",
        ),
    ])

    enrich = svc.enrichment_for("remote_support", "windows", LifecycleOperation.REPAIR)

    assert enrich["version"] == "1.4.9.0"
    assert enrich["msi_version"] == "1.4.9.0"
    assert enrich["remote_support_msi_version"] == "1.4.9.0"
    assert enrich["remote_support_msi_filename"] == "pkg.msi"
    assert enrich["remote_support_msi_sha256"] == "cafebabe"
    assert enrich["msi_url"] == "https://api.example.test/api/v1/agent-packages/remote-support-msi/download"
    assert enrich["sha256"] == "cafebabe"
    assert enrich["target_sha256"] == "cafebabe"
    assert enrich["product_name"] == "TECHI Remote Support"
    assert enrich["product_guid"] == "{PRODUCT-CODE}"
    assert enrich["product_code"] == "{PRODUCT-CODE}"
    assert enrich["upgrade_code"] == "{UPGRADE-CODE}"


@pytest.mark.parametrize(
    "operation",
    [
        LifecycleOperation.INSTALL,
        LifecycleOperation.UPDATE,
        LifecycleOperation.REPAIR,
        LifecycleOperation.REINSTALL,
    ],
)
def test_remote_support_package_operations_require_active_msi_package(operation):
    from app.platform_core.action_resolver import ComponentActionError

    svc = _svc([])

    try:
        svc.enrichment_for("remote_support", "windows", operation)
        assert False, "expected no active package error"
    except ComponentActionError as exc:
        assert exc.message == "no active Remote Support MSI package"


@pytest.mark.parametrize(
    "operation",
    [
        LifecycleOperation.INSTALL,
        LifecycleOperation.UPDATE,
        LifecycleOperation.REPAIR,
        LifecycleOperation.REINSTALL,
    ],
)
def test_remote_support_package_operations_require_complete_msi_metadata(monkeypatch, operation):
    from app.platform_core.action_resolver import ComponentActionError

    monkeypatch.setattr(
        "app.services.component_package_service.settings.PUBLIC_BACKEND_URL",
        "https://api.example.test",
    )
    svc = _svc([
        _pkg(
            "1.4.9",
            file_type="remote_support_msi",
            sha256=None,
            active=True,
            product_name="TECHI Remote Support",
            product_version="1.4.9.0",
            product_code="{PRODUCT-CODE}",
            upgrade_code="{UPGRADE-CODE}",
        )
    ])

    try:
        svc.enrichment_for("remote_support", "windows", operation)
        assert False, "expected incomplete metadata error"
    except ComponentActionError as exc:
        assert exc.message == "active Remote Support MSI metadata is incomplete"


def test_remote_support_discover_sync_restart_do_not_resolve_msi():
    svc = _svc([])

    assert svc.enrichment_for("remote_support", "windows", LifecycleOperation.RESTART) == {}
    assert svc.enrichment_for("remote_support", "windows", LifecycleOperation.SYNC) == {}
    assert svc.enrichment_for("remote_support", "windows", LifecycleOperation.DISCOVER) == {}
