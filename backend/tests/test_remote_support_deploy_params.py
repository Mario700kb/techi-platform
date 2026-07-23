"""The legacy Remote Support deploy endpoint must resolve every version-bearing
parameter from the ACTIVE MSI package metadata, never from a hardcoded literal.

Root cause covered: the endpoint hardcoded msi_version="1.4.6" while the managed
MSI registers DisplayVersion "1.4.6.29665273". The agent's install guard
(`installedVersion != msiVersion`) could therefore never match, so every deploy
reinstalled an already-current MSI.
"""
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.api.v1.endpoints.remote_support import build_remote_support_deploy_parameters
from app.core.config import settings
from app.platform_core.action_resolver import ComponentActionError
from app.services.component_package_service import ComponentPackageService

ENDPOINT_SOURCE = Path(__file__).resolve().parents[1] / "app/api/v1/endpoints/remote_support.py"

MANAGED_PRODUCT_CODE = "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}"
MSI_PRODUCT_VERSION = "1.4.6.29665273"


def _package(**overrides):
    base = dict(
        version=MSI_PRODUCT_VERSION,
        filename="TECHI-Remote-Support.msi",
        sha256="a" * 64,
        is_active=True,
        platform=SimpleNamespace(value="windows-amd64"),
        file_type=SimpleNamespace(value="remote_support_msi"),
        product_name="TECHI Remote Support",
        product_version=MSI_PRODUCT_VERSION,
        product_code=MANAGED_PRODUCT_CODE,
        upgrade_code="{60D9FA89-6F6C-5C7C-A74E-027363D83921}",
        file_size=42_000_000,
        metadata_status="ok",
        metadata_error=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class _FakePackages:
    def __init__(self, packages):
        self._packages = packages

    def latest_active(self, platform, *, file_type=None):
        for p in self._packages:
            if (
                p.is_active
                and p.platform.value == platform
                and (file_type is None or p.file_type.value == file_type)
            ):
                return p
        return None

    def list_packages(self, *, include_inactive=False):
        if include_inactive:
            return list(self._packages)
        return [p for p in self._packages if p.is_active]

    def remote_support_msi_download_url(self):
        return "/api/v1/agent-packages/remote-support-msi/download"


def _service(packages):
    svc = ComponentPackageService(db=None)
    svc._packages = _FakePackages(packages)
    return svc


@pytest.fixture
def deploy_settings(monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_BACKEND_URL", "https://api-rdp.techi.com.al", raising=False)
    monkeypatch.setattr(settings, "RUSTDESK_SERVER_HOST", "139.162.158.208", raising=False)
    monkeypatch.setattr(settings, "RUSTDESK_PUBLIC_KEY", "test-public-key", raising=False)


def _device(platform="windows"):
    return SimpleNamespace(id=1, platform=platform)


def test_deploy_parameters_come_from_active_package_metadata(deploy_settings):
    params = build_remote_support_deploy_parameters(
        db=None,
        device=_device(),
        force_reinstall=False,
        packages=_service([_package()]),
    )

    # The MSI ProductVersion — the same namespace the agent reads back out of the
    # uninstall registry — so the install guard can actually match.
    assert params["msi_version"] == MSI_PRODUCT_VERSION
    assert params["product_guid"] == MANAGED_PRODUCT_CODE
    assert params["sha256"] == "a" * 64
    assert params["msi_url"].endswith("/agent-packages/remote-support-msi/download")
    assert params["rendezvous_server"] == "139.162.158.208"
    assert params["key"] == "test-public-key"
    assert params["force_reinstall"] is False


def test_deploy_parameters_never_emit_the_hardcoded_semantic_version(deploy_settings):
    params = build_remote_support_deploy_parameters(
        db=None,
        device=_device(),
        force_reinstall=True,
        packages=_service([_package()]),
    )

    assert params["msi_version"] != "1.4.6"
    assert "rdp.techi.com.al/downloads" not in params["msi_url"]
    assert params["force_reinstall"] is True


def test_deploy_refuses_when_no_active_remote_support_package(deploy_settings):
    with pytest.raises(ComponentActionError):
        build_remote_support_deploy_parameters(
            db=None,
            device=_device(),
            force_reinstall=False,
            packages=_service([]),
        )


def test_deploy_refuses_when_package_metadata_incomplete(deploy_settings):
    with pytest.raises(ComponentActionError):
        build_remote_support_deploy_parameters(
            db=None,
            device=_device(),
            force_reinstall=False,
            packages=_service([_package(product_code=None)]),
        )


def test_endpoint_source_has_no_hardcoded_deploy_literals():
    source = ENDPOINT_SOURCE.read_text(encoding="utf-8")

    assert '"msi_version": "1.4.6"' not in source
    assert "TECHI-Remote-Support-1.4.6.msi" not in source
    assert '"product_guid": "{74CEDF4A' not in source
