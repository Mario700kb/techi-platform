"""MikroTik platform integration — deployment + registration ONLY.
Registry-driven script generation, architecture validation, flag-gated installer
endpoint, and generic (platform-neutral) enrollment placement under Network.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import install as install_endpoint
from app.core.config import settings
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.platform_core import classification as clf
from app.platform_core.registry import (
    PLATFORM_REGISTRY, render_deployment_script, validate_architecture,
)
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService


# --- Platform Registry metadata -------------------------------------------- #
def test_mikrotik_registry_declares_deployment_metadata():
    d = PLATFORM_REGISTRY["mikrotik"]
    assert d.deployment_method == "routeros_script"
    assert d.deployment_template  # non-empty
    assert d.supported_architectures == ("chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile")
    assert d.supported_routeros_versions == ("6", "7")
    assert d.connect_methods[:3] == ("winbox", "webfig", "ssh")


# --- Script generation (never hardcoded; from the registry template) -------- #
def test_render_deployment_script_injects_everything():
    script = render_deployment_script(
        "mikrotik", token="TKN-XYZ", api_endpoint="https://api-rdp.techi.com.al/", version="1.0.0",
    )
    assert 'token "TKN-XYZ"' in script
    assert 'api "https://api-rdp.techi.com.al"' in script  # trailing slash stripped
    assert 'platform "mikrotik"' in script
    assert 'connver "1.0.0"' in script
    assert "/api/v1/agent/enroll" in script
    assert "architecture-name" in script  # arch self-detected on the router
    assert "{{" not in script  # every placeholder filled


def test_render_deployment_script_unknown_platform_raises():
    with pytest.raises(ValueError):
        render_deployment_script("windows", token="t", api_endpoint="x", version="1")


# --- Architecture validation ------------------------------------------------ #
def test_validate_architecture_accepts_supported():
    for arch in ("chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile", "ARM64"):
        assert validate_architecture("mikrotik", arch) == arch.strip().lower()


def test_validate_architecture_rejects_unknown_and_absent():
    with pytest.raises(ValueError):
        validate_architecture("mikrotik", "sparc")
    with pytest.raises(ValueError):
        validate_architecture("mikrotik", None)


def test_agent_platforms_are_not_arch_validated():
    # Windows/Linux declare no architectures → never rejected.
    assert validate_architecture("windows", None) == ""
    assert validate_architecture("linux", "anything") == "anything"


# --- Installer endpoint (flag-gated) --------------------------------------- #
def _client(monkeypatch, flag_on: bool) -> TestClient:
    # FEATURE_MIKROTIK depends on FEATURE_PLATFORM_CORE + FEATURE_VAULT.
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", flag_on)
    monkeypatch.setattr(settings, "FEATURE_VAULT", flag_on)
    monkeypatch.setattr(settings, "FEATURE_MIKROTIK", flag_on)
    app = FastAPI()
    app.include_router(install_endpoint.router, prefix="/api/v1/install")
    return TestClient(app)


def test_installer_404_when_flag_off(monkeypatch):
    assert _client(monkeypatch, False).get("/api/v1/install/mikrotik", params={"token": "T"}).status_code == 404


def test_installer_serves_script_when_on(monkeypatch):
    r = _client(monkeypatch, True).get("/api/v1/install/mikrotik", params={"token": "TKN-7"})
    assert r.status_code == 200
    assert 'token "TKN-7"' in r.text and "/api/v1/agent/enroll" in r.text


# --- Enrollment places MikroTik under Network (not Servers/Client PC) ------- #
def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def test_mikrotik_token_enrollment_stays_ungrouped_and_network():
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()
    dev = Device(hostname="rb-1", platform="mikrotik", device_type=DeviceType.UNASSIGNED,
                 status=DeviceStatus.OFFLINE, assignment_source="unassigned")
    s.add(dev)
    s.commit()

    out = DeviceAssignmentService(s).apply_enrollment_assignment(
        dev, client_id=client.id, group_id=None,
        signal=AssignmentSignal(platform="mikrotik"),
    )
    assert out.client_id == client.id
    # Non-agent platform → NOT forced into a Servers/Client PC group.
    assert out.group_id is None
    # The engine categorizes it as Network by platform.
    assert clf.classify_category(out) == clf.CATEGORY_NETWORK
