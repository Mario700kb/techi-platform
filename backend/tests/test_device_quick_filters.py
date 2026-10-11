"""Devices quick filters, their counts and sorting are computed server-side.

They used to run in the browser over the 20 rows of the current page: clicking
"Critical 15" showed 0-2 rows under "Showing 1-20 of 700", sorting reordered
only that page, and the tab, chip and explorer counts came from three
different sources. The invariant guarded here is the one the operator relies
on: for every quick filter, the number on the chip equals the rows it opens,
across pages.
"""
import json
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.auth import get_current_operator, get_operator_scope
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.alert import AlertKind, AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_group import DeviceGroup
from app.models.device_inventory import DeviceInventory
from app.repositories.device_repository import QUICK_FILTERS
from app.services import device_overview_service
from app.services.device_overview_service import DeviceHealthIndexEntry, invalidate_overview_cache
from app.services.device_service import DeviceService


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    invalidate_overview_cache()
    yield session
    session.close()
    invalidate_overview_cache()


def _device(db, name, *, last_seen_ago=timedelta(minutes=1), **fields):
    defaults = dict(
        hostname=name,
        rustdesk_id=f"RD-{name}",
        status=DeviceStatus.ONLINE,
        device_type=DeviceType.CLIENT,
        last_seen=None if last_seen_ago is None else (utcnow() - last_seen_ago).replace(tzinfo=None),
        rustdesk_install_status="installed",
        rustdesk_status="running",
        agent_version="2.1.20",
    )
    defaults.update(fields)
    device = Device(**defaults)
    db.add(device)
    db.flush()
    return device


def _patch(db, device, state):
    db.add(DeviceInventory(device_id=device.id, patch_json=json.dumps({"patch_state": state, "pending_updates": 3})))


def _critical_alerts(db, device, n=2):
    for _ in range(n):
        db.add(DeviceAlert(device_id=device.id, kind=AlertKind.HIGH_CPU, severity=AlertSeverity.CRITICAL,
                           state=AlertState.OPEN, message="cpu"))


@pytest.fixture()
def fleet(db):
    acme = Client(name="Acme", slug="acme")
    globex = Client(name="Globex", slug="globex")
    db.add_all([acme, globex])
    db.flush()
    servers = DeviceGroup(name="Servers", client_id=acme.id)
    client_pc = DeviceGroup(name="Client PC", client_id=acme.id)
    db.add_all([servers, client_pc])
    db.flush()

    devices = {
        "srv-ok": _device(db, "srv-ok", client_id=acme.id, group_id=servers.id, device_type=DeviceType.SERVER),
        "srv-alerts": _device(db, "srv-alerts", client_id=acme.id, group_id=servers.id, device_type=DeviceType.SERVER),
        "pc-stale": _device(db, "pc-stale", last_seen_ago=timedelta(minutes=10), client_id=acme.id, group_id=client_pc.id),
        "pc-old": _device(db, "pc-old", last_seen_ago=timedelta(days=40), client_id=acme.id, group_id=client_pc.id),
        "pc-never": _device(db, "pc-never", last_seen_ago=None, client_id=globex.id),
        "pc-patch": _device(db, "pc-patch", client_id=globex.id),
        "pc-reboot": _device(db, "pc-reboot", client_id=globex.id, agent_version=None),
        "pc-rs-off": _device(db, "pc-rs-off", client_id=globex.id, rustdesk_status="stopped"),
        "pc-maint": _device(db, "pc-maint", client_id=globex.id, is_in_maintenance=True, agent_version="2.0.0"),
    }
    _critical_alerts(db, devices["srv-alerts"])
    _patch(db, devices["pc-patch"], "updates_available")
    _patch(db, devices["pc-reboot"], "reboot_required")
    db.commit()
    return {"devices": devices, "acme": acme, "globex": globex}


def test_every_quick_filter_count_equals_the_rows_it_opens(db, fleet):
    svc = DeviceService(db)
    counts = svc.get_device_counts()["counts"]

    assert counts["all"] == len(fleet["devices"])
    for key in QUICK_FILTERS:
        rows = svc.get_devices(quick_filter=key, limit=1000)
        assert counts[key] == svc.get_devices_count(quick_filter=key) == len(rows), key


def test_quick_counts_follow_the_explorer_scope(db, fleet):
    svc = DeviceService(db)
    acme = svc.get_device_counts(client_id=fleet["acme"].id)["counts"]

    assert acme["all"] == 4
    assert acme["servers"] == 2
    assert acme["workstations"] == 2
    assert acme["stale"] == 1
    for key in QUICK_FILTERS:
        assert acme[key] == svc.get_devices_count(quick_filter=key, client_id=fleet["acme"].id), key


def test_known_signals_land_in_the_right_filters(db, fleet):
    svc = DeviceService(db)
    names = lambda key: {d.hostname for d in svc.get_devices(quick_filter=key, limit=1000)}

    assert names("servers") == {"srv-ok", "srv-alerts"}
    assert names("needs_updates") == {"pc-patch", "pc-reboot"}
    assert names("reboot_required") == {"pc-reboot"}
    assert names("rustdesk_issues") == {"pc-rs-off"}
    assert names("maintenance") == {"pc-maint"}
    assert names("offline") == {"pc-old", "pc-never"}
    assert {"srv-alerts", "pc-stale", "pc-old", "pc-never"} <= names("needs_attention")
    assert "srv-ok" not in names("needs_attention")


def _stub_index(monkeypatch, scores):
    index = {
        device_id: DeviceHealthIndexEntry(
            score=score,
            state="critical" if score < 50 else "warning" if score < 80 else "healthy",
            patch_state="unknown",
            has_pending_patches=False,
            critical_alerts=0,
            agent_outdated=False,
            archived=False,
        )
        for device_id, score in scores.items()
    }
    monkeypatch.setattr(device_overview_service, "get_health_index", lambda db, scope=None: index)


def test_a_health_filter_reaches_past_the_first_page(db, monkeypatch):
    devices = [_device(db, f"host-{i:02d}") for i in range(45)]
    db.commit()
    critical = {devices[3].id, devices[27].id, devices[44].id}
    _stub_index(monkeypatch, {d.id: (20 if d.id in critical else 95) for d in devices})

    svc = DeviceService(db)
    page = svc.get_devices(quick_filter="critical", skip=0, limit=20)

    assert {d.id for d in page} == critical
    assert svc.get_devices_count(quick_filter="critical") == 3


def test_sorting_is_global_not_per_page(db, monkeypatch):
    names = ["delta", "alpha", "echo", "charlie", "bravo"] * 5
    devices = [_device(db, f"{name}-{i:02d}") for i, name in enumerate(names)]
    db.commit()
    svc = DeviceService(db)

    first = svc.get_devices(sort="hostname", order="asc", limit=5)
    assert [d.hostname for d in first] == sorted(d.hostname for d in devices)[:5]

    last = svc.get_devices(sort="hostname", order="desc", limit=1)
    assert last[0].hostname == max(d.hostname for d in devices)

    _stub_index(monkeypatch, {d.id: 100 - i for i, d in enumerate(devices)})
    worst = svc.get_devices(sort="health", order="asc", skip=0, limit=3)
    assert [d.id for d in worst] == [devices[-1].id, devices[-2].id, devices[-3].id]
    second_page = svc.get_devices(sort="health", order="asc", skip=3, limit=3)
    assert [d.id for d in second_page] == [devices[-4].id, devices[-5].id, devices[-6].id]


def test_sort_by_display_name_prefers_the_operator_label(db):
    _device(db, "zz-host", display_name="Accounting PC")
    _device(db, "bb-host")
    db.commit()

    rows = DeviceService(db).get_devices(sort="hostname", order="asc")
    assert [d.hostname for d in rows] == ["zz-host", "bb-host"]


def test_hide_offline_days_drops_long_gone_and_never_seen_devices(db, fleet):
    svc = DeviceService(db)
    shown = {d.hostname for d in svc.get_devices(hide_offline_days=30, limit=1000)}

    assert "pc-old" not in shown
    assert "pc-never" not in shown
    assert "pc-stale" in shown
    assert svc.get_device_counts(hide_offline_days=30)["counts"]["all"] == len(fleet["devices"]) - 2


def test_favorites_and_agent_versions_are_counted_server_side(db, fleet):
    svc = DeviceService(db)
    favorite_ids = [fleet["devices"]["srv-ok"].id, fleet["devices"]["pc-patch"].id]
    result = svc.get_device_counts(favorite_ids=favorite_ids)

    assert result["counts"]["favorites"] == 2
    assert result["agent_versions"] == {"2.1.20": 7, "2.0.0": 1, "unknown": 1}
    assert {d.hostname for d in svc.get_devices(device_ids=favorite_ids)} == {"srv-ok", "pc-patch"}
    assert {d.hostname for d in svc.get_devices(agent_version="unknown")} == {"pc-reboot"}
    assert svc.get_devices_count(agent_version="2.0.0") == 1


def test_overview_tiles_agree_with_the_quick_counts(db, fleet):
    overview = device_overview_service.DeviceOverviewService(db).get_overview()
    counts = DeviceService(db).get_device_counts()["counts"]

    assert overview.critical == counts["critical"]
    assert overview.warnings == counts["warnings"]
    assert overview.agents_outdated == counts["needs_agent_update"]
    assert overview.needs_updates == counts["needs_updates"]


@pytest.fixture()
def client(db):
    app = FastAPI()
    from app.api.v1.endpoints.devices import router

    app.include_router(router, prefix="/api/v1/devices")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_operator_scope] = lambda: None
    app.dependency_overrides[get_current_operator] = lambda: None
    return TestClient(app)


def test_endpoints_validate_filters_and_sorting(client, fleet):
    assert client.get("/api/v1/devices/", params={"quick_filter": "nope"}).status_code == 400
    assert client.get("/api/v1/devices/", params={"sort": "nope"}).status_code == 422
    assert client.get("/api/v1/devices/", params={"ids": "1,x"}).status_code == 400

    listed = client.get("/api/v1/devices/", params={"quick_filter": "offline", "sort": "hostname"})
    assert listed.status_code == 200
    assert [d["hostname"] for d in listed.json()["devices"]] == ["pc-never", "pc-old"]

    counts = client.get("/api/v1/devices/quick-counts", params={"favorite_ids": "1,2"})
    assert counts.status_code == 200
    assert counts.json()["counts"]["offline"] == listed.json()["total"] == 2
