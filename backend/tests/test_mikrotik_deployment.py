"""MikroTik platform integration — connector enrollment + heartbeat.
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
from app.models.device_activity_event import DeviceActivityEvent
from app.models.device_inventory import DeviceInventory
from app.models.device_telemetry import DeviceTelemetry
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.platform_core.actions import actions_for
from app.platform_core import classification as clf
from app.platform_core.capabilities import capability_tabs, normalize_capabilities
from app.platform_core.connect import methods_for
from app.platform_core.registry import (
    PLATFORM_REGISTRY, render_deployment_script, validate_architecture,
)
from app.schemas.agent import AgentEnrollmentRequest, AgentHeartbeatPayload
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.device_assignment_service import AssignmentSignal, DeviceAssignmentService
from app.services.device_heartbeat_service import DeviceHeartbeatService
from app.services.enrollment_token_service import EnrollmentTokenService


# --- Platform Registry metadata -------------------------------------------- #
def test_mikrotik_registry_declares_deployment_metadata():
    d = PLATFORM_REGISTRY["mikrotik"]
    assert d.deployment_method == "routeros_script"
    assert d.deployment_template  # non-empty
    assert set(d.deployment_templates_by_version) == {"6", "7"}
    assert d.supported_architectures == ("chr", "x86", "arm", "arm64", "mipsbe", "mmips", "ppc", "tile")
    assert d.supported_routeros_versions == ("6", "7")
    assert d.connect_methods == ("winbox", "webfig", "ssh")
    # Connector philosophy: MikroTik reports ONLY `connect` — no agent-style
    # capability surface; advanced work happens through Winbox/WebFig/SSH.
    assert d.allowed_capabilities == frozenset({"connect"})


# --- Script generation (never hardcoded; from the registry template) -------- #
def test_render_deployment_script_injects_everything():
    script = render_deployment_script(
        "mikrotik", token="TKN-XYZ", api_endpoint="https://api-rdp.techi.com.al/", version="1.0.0",
    )
    assert '\\"enrollment_token\\":\\"TKN-XYZ\\"' in script
    assert 'url="https://api-rdp.techi.com.al/api/v1/agent/enroll"' in script  # trailing slash stripped
    assert 'url="https://api-rdp.techi.com.al/api/v1/agent/heartbeat"' in script
    assert '\\"platform\\":\\"mikrotik\\"' in script
    assert '\\"agent_version\\":\\"1.0.0\\"' in script
    assert '\\"agent_id\\":\\"mikrotik-" . $serial' in script  # stable identity
    assert "TECHI-Heartbeat" in script
    assert "TECHI-Inventory" in script
    assert '/system scheduler add name="TECHI-Heartbeat" interval=250s on-event="TECHI-Heartbeat"' in script
    assert '/system scheduler add name="TECHI-Inventory" interval=1800s on-event="TECHI-Inventory"' in script
    assert "architecture-name" in script  # arch self-detected on the router
    assert "{{" not in script  # every placeholder filled


def test_render_deployment_script_uses_configured_intervals():
    script = render_deployment_script(
        "mikrotik",
        token="TKN-XYZ",
        api_endpoint="https://api-rdp.techi.com.al/",
        version="1.0.0",
        heartbeat_interval_seconds=123,
        inventory_interval_seconds=1801,
    )
    assert "interval=123s" in script
    assert "interval=1801s" in script


def test_connector_script_stays_small_and_flat():
    """The connector is NOT an agent: the RouterOS script must stay tiny —
    no loops, no enumeration, no RouterOS globals (reboot-safe), flat JSON.
    Ceiling raised 2026-07-10 (60->70 lines, 5000->6000 chars) to add: (a) an
    on-error guard around the enroll fetch so a failed enrollment halts the
    script instead of silently falling through to auto-create an unassigned
    device, and (b) cpu_percent/ram_percent/disk_percent — single-property
    RouterOS queries (no loops) feeding the SAME generic telemetry fields
    Windows/Linux already use for Overview resource cards. Still zero loops,
    zero globals, zero enumeration."""
    script = render_deployment_script(
        "mikrotik", token="T", api_endpoint="https://api-rdp.techi.com.al", version="1.0.0",
    )
    lines = [l for l in script.strip().splitlines()]
    assert len(lines) <= 70, f"RouterOS script grew to {len(lines)} lines"
    assert len(script) <= 6000, f"RouterOS script grew to {len(script)} chars"
    assert ":foreach" not in script          # no enumeration loops
    assert ":global" not in script           # self-contained; survives reboot
    # No agent-style enumeration in the payloads.
    for forbidden in ("/system package find", "/interface find", "/ip dns get",
                      '\\"services\\":', "http-header-field-value"):
        assert forbidden not in script, forbidden
    # Capabilities are connector-minimal.
    assert '\\"capabilities\\":[\\"connect\\"]' in script
    # Enrollment failure halts the script (no unassigned auto-create).
    assert ':error "TECHI enrollment failed"' in script
    # Resource utilization reuses the existing generic telemetry fields.
    assert '\\"cpu_percent\\":' in script
    assert '\\"ram_percent\\":' in script
    assert '\\"disk_percent\\":' in script


def test_routeros6_script_uses_routeros6_fetch_syntax():
    script = render_deployment_script(
        "mikrotik", token="TKN-6", api_endpoint="https://api-rdp.techi.com.al/", version="1.0.0",
        routeros_version="6",
    )
    assert "# TECHI Platform - MikroTik connector (RouterOS 6.x)" in script
    assert 'http-header-field="Content-Type:application/json"' in script
    assert "http-header-field-value" not in script
    assert "keep-result=no" in script
    assert "output=none" not in script
    assert "\\\n" not in script
    assert "{\n:local serial" in script
    assert '\\"enrollment_token\\":\\"TKN-6\\"' in script
    assert "TECHI-Heartbeat" in script and "TECHI-Inventory" in script
    assert '/tool fetch mode=https url="https://api-rdp.techi.com.al/api/v1/agent/enroll"' in script
    assert '/tool fetch mode=https url="https://api-rdp.techi.com.al/api/v1/agent/heartbeat"' in script
    assert script.rstrip().endswith("}")


def test_routeros7_script_uses_routeros7_fetch_syntax():
    script = render_deployment_script(
        "mikrotik", token="TKN-7", api_endpoint="https://api-rdp.techi.com.al/", version="1.0.0",
        routeros_version="7",
    )
    assert "# TECHI Platform - MikroTik connector (RouterOS 7.x)" in script
    assert 'http-header-field="Content-Type:application/json"' in script
    assert "http-header-field-value" not in script
    assert "output=none" in script
    assert "keep-result=no" not in script
    assert "\\\n" not in script
    assert "{\n:local serial" in script
    assert "TECHI-Heartbeat" in script and "TECHI-Inventory" in script
    assert '/tool fetch mode=https url="https://api-rdp.techi.com.al/api/v1/agent/enroll"' in script
    assert '/tool fetch mode=https url="https://api-rdp.techi.com.al/api/v1/agent/heartbeat"' in script
    assert script.rstrip().endswith("}")


def test_render_deployment_script_rejects_unknown_routeros_version():
    with pytest.raises(ValueError):
        render_deployment_script(
            "mikrotik", token="TKN", api_endpoint="https://api-rdp.techi.com.al/", version="1.0.0",
            routeros_version="5",
        )


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
    r = _client(monkeypatch, True).get("/api/v1/install/mikrotik", params={"token": "TKN-7", "routeros_version": "7"})
    assert r.status_code == 200
    assert "TKN-7" in r.text and "/api/v1/agent/enroll" in r.text
    assert "RouterOS 7.x" in r.text


def test_installer_serves_routeros6_script_when_requested(monkeypatch):
    r = _client(monkeypatch, True).get("/api/v1/install/mikrotik", params={"token": "TKN-6", "routeros_version": "6"})
    assert r.status_code == 200
    assert "RouterOS 6.x" in r.text
    assert "keep-result=no" in r.text


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


def test_mikrotik_capabilities_drive_generic_drawer_surface():
    # Even a misbehaving connector reporting agent-style capabilities is
    # clamped by the registry to the connector-minimal `connect`.
    caps = normalize_capabilities(["connect", "remote_support", "terminal", "interfaces"])
    allowed = PLATFORM_REGISTRY["mikrotik"].allowed_capabilities
    reported = {name: version for name, version in caps.items() if name in allowed}

    assert reported == {"connect": ""}
    # No capability tabs: the Drawer is Overview / Management / Notes / Timeline.
    assert capability_tabs(reported) == []
    assert [m.id for m in methods_for("mikrotik", reported)] == ["winbox", "webfig", "ssh"]
    assert [a.id for a in actions_for("mikrotik", reported)] == [
        "refresh_inventory", "restart_connector", "reenroll",
    ]


def test_mikrotik_heartbeat_populates_connector_state(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    s = _session()
    dev = Device(
        agent_id="mikrotik-SERIAL1",
        hostname="rb-1",
        platform="mikrotik",
        device_type=DeviceType.UNASSIGNED,
        status=DeviceStatus.OFFLINE,
        assignment_source="enrollment_token",
    )
    s.add(dev)
    s.commit()

    payload = AgentHeartbeatPayload(
        agent_id="mikrotik-SERIAL1",
        platform="mikrotik",
        hostname="rb-1",
        os_name="RouterOS",
        os_version="7.15.3",
        os_caption="Board=RB5009; Model=RB5009UG; Serial=SERIAL1; Firmware=7.15.3; Uptime=1d2h; Bridges=1; Wireless=no; DefaultRoute=yes",
        architecture="arm64",
        local_ip="192.168.88.1",
        public_ip="203.0.113.10",
        agent_version="1.0.0",
        cpu="arm64",
        ram="1073741824",
        storage="free=123; total=456",
        capabilities=["connect", "remote_support"],
        software=[
            {"name": "RouterOS", "version": "7.15.3"},
            {"name": "RouterBOOT", "version": "7.15.3"},
        ],
    )

    device, heartbeat = DeviceHeartbeatService(s).process_heartbeat(payload)
    assert heartbeat.device_id == device.id
    assert device.status == DeviceStatus.ONLINE
    assert device.last_seen is not None
    assert device.platform == "mikrotik"
    assert device.device_type == DeviceType.UNASSIGNED
    assert device.architecture == "arm64"
    assert device.public_ip == "203.0.113.10"
    assert device.capabilities
    assert "remote_support" not in device.capabilities
    assert "connect" in device.capabilities
    assert clf.classify_category(device) == clf.CATEGORY_NETWORK

    inventory = s.query(DeviceInventory).filter(DeviceInventory.device_id == device.id).one()
    assert "RouterOS" in (inventory.software_json or "")
    event_types = {e.event_type for e in s.query(DeviceActivityEvent).filter(DeviceActivityEvent.device_id == device.id)}
    assert {"heartbeat_received", "inventory_updated"} <= event_types


def test_mikrotik_repeated_heartbeats_resolve_by_stable_agent_id(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    s = _session()
    payload = AgentHeartbeatPayload(
        agent_id="mikrotik-STABLE1",
        platform="mikrotik",
        hostname="rb-original",
        os_name="RouterOS",
        os_version="7.15.3",
        architecture="arm64",
        capabilities=["connect"],
    )
    first, _ = DeviceHeartbeatService(s).process_heartbeat(payload)
    second_payload = payload.model_copy(update={"hostname": "rb-renamed", "mac_address": "AA:BB:CC:00:00:02"})
    second, _ = DeviceHeartbeatService(s).process_heartbeat(second_payload)

    assert second.id == first.id
    assert s.query(Device).count() == 1
    assert second.hostname == "rb-renamed"
    # Timeline is transition-gated: an online device's steady heartbeats add
    # NO further heartbeat_received events (no timeline spam, no extra writes).
    hb_events = (
        s.query(DeviceActivityEvent)
        .filter(DeviceActivityEvent.device_id == first.id,
                DeviceActivityEvent.event_type == "heartbeat_received")
        .count()
    )
    assert hb_events == 1


def test_mikrotik_heartbeat_rejects_missing_stable_agent_id(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    s = _session()
    with pytest.raises(ValueError):
        DeviceHeartbeatService(s).process_heartbeat(AgentHeartbeatPayload(
            platform="mikrotik",
            hostname="rb-no-id",
            os_name="RouterOS",
            os_version="7.15.3",
            architecture="arm64",
        ))
    # A bare "mikrotik-" (empty serial) would collapse every such router into
    # one shared device — rejected too.
    with pytest.raises(ValueError):
        DeviceHeartbeatService(s).process_heartbeat(AgentHeartbeatPayload(
            agent_id="mikrotik-",
            platform="mikrotik",
            hostname="rb-empty-serial",
            os_name="RouterOS",
            os_version="7.15.3",
            architecture="arm64",
        ))


def test_mikrotik_real_enroll_then_heartbeat_keeps_token_assignment(monkeypatch):
    """Reproduces the exact RouterOS connector sequence: a real /agent/enroll
    call (generic AgentEnrollmentService, same code path as every platform)
    immediately followed by /agent/heartbeat with no token. This is the
    generic enrollment pipeline the connector is required to reuse — no
    MikroTik-specific assignment logic anywhere in this path."""
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    s = _session()
    client = Client(name="Acme", slug="acme", is_active=True)
    s.add(client)
    s.commit()

    raw_token = "mikrotik-real-token-1234567890"
    token = EnrollmentToken(
        name="mikrotik-real",
        token_hash=EnrollmentTokenService.hash_token(raw_token),
        token_prefix=raw_token[:8],
        client_id=client.id,
        group_id=None,
        status=EnrollmentTokenStatus.ACTIVE,
        max_uses=10,
        use_count=0,
    )
    s.add(token)
    s.commit()

    enroll_response = AgentEnrollmentService(s).enroll(
        AgentEnrollmentRequest(
            agent_id="mikrotik-REALSERIAL1",
            enrollment_token=raw_token,
            platform="mikrotik",
            hostname="rb-real",
            architecture="arm64",
            os_name="RouterOS",
            os_version="7.15.3",
            agent_version="1.0.0",
        ),
        heartbeat_url="x", websocket_url="y",
    )
    assert enroll_response.assigned_client_id == client.id

    device = s.query(Device).filter(Device.agent_id == "mikrotik-REALSERIAL1").one()
    assert device.client_id == client.id
    assert device.assignment_source == "enrollment_token"
    assert clf.classify_category(device) == clf.CATEGORY_NETWORK

    # The heartbeat script never carries the token (connector is minimal) —
    # the enroll-created device must be found by stable agent_id and its
    # assignment left untouched, exactly like every other platform's heartbeat.
    device, _ = DeviceHeartbeatService(s).process_heartbeat(AgentHeartbeatPayload(
        agent_id="mikrotik-REALSERIAL1",
        platform="mikrotik",
        hostname="rb-real",
        architecture="arm64",
        local_ip="192.168.88.1",
        os_name="RouterOS",
        os_version="7.15.3",
        agent_version="1.0.0",
        cpu_percent=12.0,
        ram_percent=34.0,
        capabilities=["connect"],
    ))
    assert device.client_id == client.id
    assert device.assignment_source == "enrollment_token"
    assert s.query(Device).count() == 1

    # Resource-card percentages reuse the existing generic telemetry pipeline —
    # no MikroTik-specific storage.
    telemetry = s.query(DeviceTelemetry).filter(DeviceTelemetry.device_id == device.id).one()
    assert telemetry.cpu_percent == 12.0
    assert telemetry.ram_percent == 34.0


def test_mikrotik_heartbeat_without_enrollment_stays_unassigned(monkeypatch):
    """Documents the failure mode the RouterOS on-error guard now prevents:
    if enrollment never ran (e.g. the enroll fetch failed), a bare heartbeat
    auto-creates a device with no client — this is why the connector script
    must halt on enrollment failure rather than continue to the scheduler."""
    monkeypatch.setattr(settings, "FEATURE_PLATFORM_CORE", True)
    s = _session()
    device, _ = DeviceHeartbeatService(s).process_heartbeat(AgentHeartbeatPayload(
        agent_id="mikrotik-NEVERENROLLED",
        platform="mikrotik",
        hostname="rb-orphan",
        architecture="arm64",
        os_name="RouterOS",
        os_version="7.15.3",
        capabilities=["connect"],
    ))
    assert device.client_id is None
    assert device.assignment_source == "system_auto"
