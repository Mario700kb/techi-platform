"""Enterprise client reports: every builder on a realistic fleet, the PDF/CSV
renderers, the catalog/preview/generate API and schedules with a report type."""
import csv
import importlib.util
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.v1.endpoints import reports as reports_endpoint
from app.core.auth import get_current_operator, get_operator_scope
from app.core.config import settings
from app.core.scope import AllowedScope
from app.core.time import ensure_utc, utcnow, utcnow_naive
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.device_inventory import DeviceInventory
from app.models.device_status_history import DeviceStatusHistory
from app.models.device_telemetry import DeviceTelemetry
from app.models.report import ReportRun, ReportSchedule
from app.models.telemetry_pipeline import TelemetryRollup1h
from app.models.terminal_session import TerminalSession
from app.models.vault_credential import VaultCredential
from app.schemas.client_report import ReportDocument
from app.services.client_reports import access, availability, capacity, executive, lifecycle, patch, security
from app.services.client_reports.common import ReportContext, os_build_number, parse_ram_gb, parse_storage
from app.services.client_reports.render import render_document_csv, render_document_pdf
from app.services.client_reports.service import build_report
from app.services.report_service import ReportService
from app.workers import report_worker as worker_module
from app.workers.report_worker import ReportWorker

NOW = datetime(2026, 10, 17, 10, 0, tzinfo=timezone.utc)  # a Saturday
OLD = datetime(2026, 1, 1)

SECURE = {
    "collected_at": "2026-10-17T06:00:00+00:00",
    "defender": {"present": True, "antivirus_enabled": True, "realtime_enabled": True, "signature_age_days": 1},
    "third_party_av": [],
    "firewall": {"domain": True, "private": True, "public": True},
    "bitlocker": {"system_drive": "C:", "protection": "on", "encryption_percent": 100.0},
    "uac_enabled": True, "secure_boot": True, "local_admins": ["PC\\Administrator", "ACME\\Domain Admins"],
}


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return engine


def _fleet(db):
    acme = Client(name="Acme Sh.p.k.", slug="acme", is_active=True)
    other = Client(name="Other", slug="other", is_active=True)
    db.add_all([acme, other])
    db.commit()

    def device(id, hostname, caption, build, **extra):
        values = dict(id=id, hostname=hostname, os_caption=caption, os_build=build, platform="windows",
                      client_id=acme.id, registered_at=OLD, status=DeviceStatus.ONLINE, last_seen=utcnow_naive(),
                      agent_version="2.1.20", device_type=DeviceType.CLIENT)
        values.update(extra)
        return Device(**values)

    db.add_all([
        device(1, "PC-WIN10", "Microsoft Windows 10 Pro", "10.0.19045", ram="4 GB",
               storage="10 GB free / 237 GB total", status=DeviceStatus.OFFLINE),
        device(2, "PC-W11-PRO", "Microsoft Windows 11 Pro", "10.0.26100", ram="16 GB",
               storage="300 GB free / 476 GB total", agent_version="2.1.31"),
        device(3, "PC-W11-ENT", "Microsoft Windows 11 Enterprise", "10.0.26100", ram="7.9 GB",
               storage="80 GB free / 238 GB total", agent_version="2.1.31"),
        device(4, "SRV-01", "Microsoft Windows Server 2016 Standard", "10.0.14393", ram="32 GB",
               storage="200 GB free / 500 GB total", agent_version="2.1.29", device_type=DeviceType.SERVER),
        device(5, "SRV-02", "Microsoft Windows Server 2022 Standard", "10.0.20348", ram="64 GB",
               storage="900 GB free / 1000 GB total", device_type=DeviceType.SERVER),
        Device(id=9, hostname="OTHER-PC", client_id=other.id, registered_at=OLD, status=DeviceStatus.ONLINE),
    ])
    db.commit()
    return acme, other


def _inventory(db, device_id, patch=None, security_value=None):
    row = DeviceInventory(device_id=device_id, patch_json=json.dumps(patch) if patch else None)
    if security_value is not None:
        row.security_json = json.dumps(security_value)
    db.add(row)
    db.commit()


@pytest.fixture
def db():
    session = sessionmaker(bind=_engine())()
    yield session
    session.close()


def _ctx(db, acme, now=NOW, days=7):
    return ReportContext(db, client_id=acme.id, client_name=acme.name, start=now - timedelta(days=days), end=now, now=now)


def _section(doc, key):
    return next(s for s in doc.sections if s.key == key)


def _kpi(doc, label):
    return next(k for k in doc.summary if k.label == label)


# ── parsing ─────────────────────────────────────────────────────────────────

def test_agent_strings_parse():
    assert parse_ram_gb("13 GB") == 13.0 and parse_ram_gb("8192 MB") == 8.0 and parse_ram_gb(None) is None
    assert parse_storage("109 GB free / 237 GB total") == (109.0, 237.0)
    assert parse_storage("garbage") is None
    assert os_build_number(SimpleNamespace(os_build="10.0.19045", os_version=None)) == 19045
    assert os_build_number(SimpleNamespace(os_build="26100.2033", os_version=None)) == 26100


# ── builders ────────────────────────────────────────────────────────────────

def test_patch_compliance(db):
    acme, _ = _fleet(db)
    _inventory(db, 1, {"pending_updates": 12, "reboot_required": True, "last_update_at": "2026-08-01", "patch_state": "pending"})
    _inventory(db, 2, {"pending_updates": 0, "reboot_required": False, "last_update_at": "2026-10-10", "patch_state": "up_to_date"})
    _inventory(db, 4, {"pending_updates": 2, "reboot_required": False, "last_update_at": "2026-10-05", "patch_state": "pending"})
    _inventory(db, 3)  # inventory without patch data
    built = patch.build(_ctx(db, acme))
    doc = built.document
    assert _kpi(doc, "Compliance").value == pytest.approx(33.3)
    needs = _section(doc, "needs_updates").rows
    assert [r["device"] for r in needs] == ["PC-WIN10", "SRV-01"] and needs[0]["pending"] == 12
    assert [r["device"] for r in _section(doc, "reboot_required").rows] == ["PC-WIN10"]
    stale = _section(doc, "not_updated").rows
    assert [r["device"] for r in stale] == ["PC-WIN10"] and stale[0]["age_days"] == 77
    assert {r["device"] for r in _section(doc, "no_data").rows} == {"PC-W11-ENT", "SRV-02"}
    assert any("not updated" in i.text for i in built.issues)
    assert all(r["_device_id"] for r in needs)


def test_lifecycle_against_a_fixed_today(db):
    acme, _ = _fleet(db)
    built = lifecycle.build(_ctx(db, acme))
    doc = built.document
    unsupported = {r["device"]: r for r in _section(doc, "unsupported").rows}
    assert set(unsupported) == {"PC-WIN10", "PC-W11-PRO"}
    assert unsupported["PC-WIN10"]["end"] == "2025-10-14"
    assert unsupported["PC-W11-PRO"]["end"] == "2026-10-13"  # 24H2 Home/Pro ended four days before "today"
    assert unsupported["PC-W11-PRO"]["product"] == "Windows 11 Pro 24H2"
    ending = {r["device"]: r for r in _section(doc, "ending_soon").rows}
    assert set(ending) == {"PC-W11-ENT", "SRV-01"}  # Enterprise 24H2 2027-10-12, Server 2016 2027-01-12
    assert ending["SRV-01"]["end"] == "2027-01-12"
    assert _kpi(doc, "Unsupported OS").value == 2
    assert _kpi(doc, "RAM under 8 GB").value == 1  # 4 GB; "7.9 GB" is an 8 GB machine
    hardware = {r["device"]: r for r in _section(doc, "hardware").rows}
    assert "PC-WIN10" in hardware and "PC-W11-ENT" not in hardware
    assert "System disk under 20% free" in hardware["PC-WIN10"]["issue"]
    overview = {r["product"]: r for r in _section(doc, "os_overview").rows}
    assert overview["Windows Server 2022 Standard"]["status"] == "Supported"
    texts = [r.text for r in built.recommendations]
    assert any(t.startswith("Replace or upgrade the 1 device on Windows 10 (unsupported since 14 Oct 2025)") for t in texts)
    assert any("Windows 11 Pro 24H2 to Windows 11 25H2 (support ended 13 Oct 2026)" in t for t in texts)


def test_availability_server_outage_and_working_hours(db):
    acme, _ = _fleet(db)
    start = NOW - timedelta(days=7)
    online, offline = DeviceStatus.ONLINE, DeviceStatus.OFFLINE

    def change(device_id, at, prev, new, reason):
        db.add(DeviceStatusHistory(device_id=device_id, previous_status=prev, new_status=new, reason=reason,
                                   created_at=at.replace(tzinfo=None)))

    change(4, start - timedelta(days=2), offline, online, "heartbeat")
    change(4, NOW - timedelta(days=3), online, offline, "network_lost")
    change(4, NOW - timedelta(days=3) + timedelta(hours=2), offline, online, "heartbeat")
    change(4, NOW - timedelta(days=2), online, offline, "shutdown")  # a minute: not an outage
    change(4, NOW - timedelta(days=2) + timedelta(minutes=1), offline, online, "heartbeat")
    change(4, NOW - timedelta(hours=1), online, offline, "network_lost")  # still offline at the end
    db.commit()
    built = availability.build(_ctx(db, acme))
    doc = built.document
    servers = {r["device"]: r for r in _section(doc, "servers").rows}
    expected = 100 * (7 * 86400 - 2 * 3600 - 60 - 3600) / (7 * 86400)
    assert servers["SRV-01"]["availability"] == pytest.approx(expected, abs=0.05)
    assert servers["SRV-02"]["availability"] == 100.0
    assert _section(doc, "servers").rows[0]["device"] == "SRV-01"  # lowest first
    outages = _section(doc, "outages").rows
    assert [o["duration"] for o in outages] == [7200, 3600]
    assert outages[0]["reason"] == "network lost" and outages[0]["state"] == "Resolved"
    assert outages[1]["state"] == "Ongoing" and outages[1]["end"] is None
    assert _kpi(doc, "Outages").value == 2
    assert _kpi(doc, "Longest outage").value == 7200
    assert _kpi(doc, "Servers under 99%").value == 1
    work = {r["device"]: r for r in _section(doc, "workstations").rows}
    assert work["PC-WIN10"]["availability"] == 0.0 and work["PC-W11-PRO"]["availability"] == 100.0
    assert any("SRV-01 is offline since" in i.text for i in built.issues)


def test_capacity_full_disk_and_forecast(db):
    acme, _ = _fleet(db)
    now = utcnow()  # disk_trends reads relative to the real clock
    db.add(DeviceTelemetry(device_id=1, disk_percent=95.8, created_at=utcnow_naive() - timedelta(minutes=5)))
    base = (utcnow_naive() - timedelta(days=10)).replace(hour=10, minute=0, second=0, microsecond=0)
    for day in range(10):
        db.add(TelemetryRollup1h(device_id=4, bucket=base + timedelta(days=day), samples=60, expected=60,
                                 disks=[{"mount": "D:", "used_pct": 70 + day, "free_gb": 150 - day * 5, "total_gb": 500}]))
    db.commit()
    built = capacity.build(_ctx(db, acme, now=now))
    doc = built.document
    at_risk = _section(doc, "at_risk").rows
    assert [(r["device"], r["disk"], r["used_pct"]) for r in at_risk] == [("PC-WIN10", "C:", 95.8)]
    filling = _section(doc, "filling_up").rows
    assert filling[0]["device"] == "SRV-01" and filling[0]["disk"] == "D:" and 0 < filling[0]["days_to_90"] <= 30
    assert filling[0]["growth"] == pytest.approx(5.0, abs=0.01)
    assert _kpi(doc, "Disks 90%+ full").value == 1
    assert _kpi(doc, "Reach 90% within 30 days").value == 1
    sources = {(r["device"], r["source"]) for r in _section(doc, "all_disks").rows}
    assert ("SRV-01", "Telemetry") in sources and ("PC-W11-PRO", "Heartbeat") in sources
    assert any("PC-WIN10 C: is 95.8% full" in i.text for i in built.issues)


def _audit(db, client_id, action, at, details, *, device_id=None, entity_type="device", entity_id=None, operator=None):
    entry = AuditLog(action=action, entity_type=entity_type, entity_id=entity_id, device_id=device_id,
                     client_id=client_id, operator_username=operator, details_json=json.dumps(details),
                     created_at=at.replace(tzinfo=None))
    db.add(entry)
    db.commit()
    return entry


def _sessions(db, acme):
    now = utcnow()
    click = now - timedelta(days=2)
    started = click + timedelta(seconds=3)
    _audit(db, acme.id, "remote_connect", click, {"techi_remote_id": "123"}, device_id=2, entity_id=2, operator="mario")
    _audit(db, acme.id, "remote_session_started", started,
           {"attribution": "connect_request", "connect_requested_at": ensure_utc(click).isoformat()},
           device_id=2, entity_id=2, operator="mario")
    _audit(db, acme.id, "remote_session_ended", started + timedelta(minutes=20),
           {"started_at": ensure_utc(started).isoformat(), "ended_at": ensure_utc(started + timedelta(minutes=20)).isoformat(),
            "reason": "session_closed"}, device_id=2, entity_id=2)
    lonely = now - timedelta(days=1)
    _audit(db, acme.id, "remote_session_started", lonely, {"attribution": "unattributed", "peer_name": "HOME-PC"},
           device_id=4, entity_id=4)
    _audit(db, acme.id, "remote_session_ended", lonely + timedelta(minutes=5),
           {"started_at": ensure_utc(lonely).isoformat(), "ended_at": ensure_utc(lonely + timedelta(minutes=5)).isoformat(),
            "reason": "session_closed"}, device_id=4, entity_id=4)
    opened = (now - timedelta(hours=5)).replace(tzinfo=None)
    db.add(TerminalSession(id="t" * 32, device_id=4, operator_id=1, operator_username="anna", status="closed",
                           engine="powershell", operator_ticket_hash="x", agent_ticket_hash="y", created_at=opened,
                           started_at=opened, ended_at=opened + timedelta(minutes=10), disconnect_reason="operator_closed",
                           expires_at=opened + timedelta(minutes=5), recording_path="/rec/t.log"))
    db.commit()
    _audit(db, acme.id, "terminal_session_opened", opened, {"session_id": "t" * 32, "device_id": 4, "engine": "powershell"},
           device_id=4, entity_type="terminal_session", operator="anna")
    _audit(db, acme.id, "console_script_run", opened + timedelta(minutes=2),
           {"session_id": "t" * 32, "script_id": 1, "name": "Free disk space", "version": 3}, device_id=4, entity_id=4, operator="anna")
    _audit(db, acme.id, "remote_support_alarm", now - timedelta(hours=3),
           {"reason": "wrong password", "caller": "unknown", "caller_ip": "203.0.113.9"}, device_id=2, entity_id=2, operator="rustdesk")
    credential = VaultCredential(name="SRV-01 local admin", credential_type="password", scope_type="client",
                                 client_id=acme.id, ciphertext="x", dek_wrapped="y")
    db.add(credential)
    db.commit()
    _audit(db, None, "vault_credential_revealed", now - timedelta(hours=2), {"name": "SRV-01 local admin", "reason": "ticket 42"},
           entity_type="vault_credential", entity_id=credential.id, operator="mario")
    # another client's session is never in this report
    _audit(db, acme.id + 1, "remote_connect", click, {}, device_id=9, entity_id=9, operator="mario")
    return now


def test_access_audit(db):
    acme, _ = _fleet(db)
    now = _sessions(db, acme)
    built = access.build(_ctx(db, acme, now=now, days=30))
    doc = built.document
    remote = _section(doc, "remote_support").rows
    by_outcome = {r["outcome"]: r for r in remote}
    assert by_outcome["Session"]["duration"] == 1200 and by_outcome["Session"]["operator"] == "mario"
    assert by_outcome["No Connect click"]["duration"] == 300 and by_outcome["No Connect click"]["from"] == "HOME-PC"
    assert len(remote) == 2
    (terminal,) = _section(doc, "terminal").rows
    assert terminal["type"] == "PowerShell" and terminal["duration"] == 600 and terminal["recorded"] == "Yes"
    assert terminal["operator"] == "anna" and terminal["end_reason"] == "operator closed"
    assert _section(doc, "scripts").rows[0]["script"] == "Free disk space"
    assert _section(doc, "refused").rows[0]["caller_ip"] == "203.0.113.9"
    assert _section(doc, "reveals").rows[0]["credential"] == "SRV-01 local admin"
    assert _kpi(doc, "Sessions").value == 3
    assert _kpi(doc, "Session time").value == 1200 + 300 + 600
    assert _kpi(doc, "Operators").value == 2
    assert _kpi(doc, "Without a Connect click").value == 1
    assert _kpi(doc, "Refused logins").value == 1


def test_security_posture_scores_and_no_data(db):
    acme, _ = _fleet(db)
    risky = {**SECURE,
             "firewall": {"domain": True, "private": True, "public": False},
             "bitlocker": {"system_drive": "C:", "protection": "off", "encryption_percent": 0.0},
             "local_admins": ["PC-W11-PRO\\Administrator", "PC-W11-PRO\\mario"]}
    unprotected = {**SECURE, "defender": {"present": True, "antivirus_enabled": False, "realtime_enabled": False,
                                          "signature_age_days": 30}}
    _inventory(db, 2, security_value=risky)
    _inventory(db, 3, security_value=SECURE)
    _inventory(db, 4, security_value={**unprotected, "third_party_av": []})
    built = security.build(_ctx(db, acme))
    doc = built.document
    scores = {r["device"]: r["score"] for r in _section(doc, "devices").rows}
    assert scores == {"PC-W11-ENT": 100, "PC-W11-PRO": 100 - 5 - 15 - 5, "SRV-01": 100 - 30 - 15 - 10}
    issues = _section(doc, "issues").rows
    assert issues[0]["device"] == "SRV-01" and issues[0]["issue"] == "No antivirus enabled" and issues[0]["_tone"] == "crit"
    assert {"Firewall off: Public", "BitLocker off on C:", "1 extra local administrator: PC-W11-PRO\\mario"} <= {
        r["issue"] for r in issues if r["device"] == "PC-W11-PRO"}
    assert _kpi(doc, "Protected").value == pytest.approx(66.7)
    assert _kpi(doc, "No antivirus").value == 1
    assert _kpi(doc, "Firewall off").value == 1
    assert _kpi(doc, "System disk not encrypted").value == 1
    no_data = {r["device"]: r["reason"] for r in _section(doc, "no_data").rows}
    assert no_data == {"PC-WIN10": "Agent 2.1.20: needs 2.1.31", "SRV-02": "Agent 2.1.20: needs 2.1.31"}


def test_security_builder_reads_a_fake_inventory_without_the_column():
    score, issues, values = security.evaluate({**SECURE, "third_party_av": ["ESET Endpoint Security"],
                                               "defender": {"present": True, "antivirus_enabled": False,
                                                            "realtime_enabled": False, "signature_age_days": None}})
    assert score == 100 and issues == [] and values["antivirus"] == "ESET Endpoint Security"
    assert security._security_of(SimpleNamespace()) is None


def test_security_without_any_data_asks_for_the_agent(db):
    acme, _ = _fleet(db)
    doc = security.build(_ctx(db, acme)).document
    assert _kpi(doc, "Protected").value == "needs agent 2.1.31"


def test_executive_summary_collects_the_worst(db):
    acme, _ = _fleet(db)
    _inventory(db, 1, {"pending_updates": 12, "reboot_required": True, "last_update_at": "2026-08-01"})
    built = executive.build(_ctx(db, acme))
    doc = built.document
    labels = [k.label for k in doc.summary]
    assert labels == ["Patch compliance", "Server availability", "Unsupported OS", "Disks at risk",
                      "Remote sessions", "Security: protected"]
    assert _kpi(doc, "Security: protected").value == "needs agent 2.1.31"
    issues = _section(doc, "top_issues").rows
    assert 0 < len(issues) <= 10 and issues[0]["severity"] == "Critical"
    recs = [r["recommendation"] for r in _section(doc, "recommendations").rows]
    assert any(r.startswith("Replace or upgrade the 1 device on Windows 10") for r in recs)
    # An area no device reports yet is "No data", not "OK".
    areas = {r["area"]: r for r in _section(doc, "areas").rows}
    security_area = next(r for title, r in areas.items() if "ecurity" in title)
    assert (security_area["status"], security_area["_tone"]) == ("No data", "neutral")
    assert "outages" not in _kpi(doc, "Server availability").hint or not _kpi(doc, "Server availability").hint.startswith("1 outages")
    ReportDocument.model_validate_json(doc.model_dump_json())  # JSON round trip


# ── rendering ───────────────────────────────────────────────────────────────

def test_pdf_and_csv_render_every_report(db):
    acme, _ = _fleet(db)
    _inventory(db, 1, {"pending_updates": 3, "reboot_required": False, "last_update_at": "2026-10-01"}, SECURE)
    for key in ("executive", "patch_compliance", "lifecycle", "availability", "capacity", "access_audit", "security_posture"):
        doc = build_report(db, key, client_id=acme.id, client_name=acme.name, start=NOW - timedelta(days=30), end=NOW, now=NOW)
        pdf = render_document_pdf(doc, "mario")
        assert pdf.startswith(b"%PDF")
        text = render_document_csv(doc, "mario").decode("utf-8-sig")
        rows = list(csv.reader(io.StringIO(text)))
        titles = {row[0] for row in rows if row}
        for section in doc.sections:
            assert section.title in titles
    wide = build_report(db, "access_audit", client_id=acme.id, client_name=acme.name, start=NOW - timedelta(days=30), end=NOW)
    assert b"/MediaBox [ 0 0 841.8898 595.2756 ]" in render_document_pdf(wide, "mario")  # 7 columns: landscape


def test_csv_neutralises_formulas_and_keeps_numbers(db):
    acme, _ = _fleet(db)
    db.get(Device, 1).hostname = "=HYPERLINK(1)"
    db.commit()
    _inventory(db, 1, {"pending_updates": 12, "reboot_required": False, "last_update_at": "2026-10-01"})
    doc = build_report(db, "patch_compliance", client_id=acme.id, client_name=acme.name, start=NOW - timedelta(days=30), end=NOW, now=NOW)
    text = render_document_csv(doc).decode("utf-8-sig")
    assert "'=HYPERLINK(1)" in text and ",12," in text


# ── API ─────────────────────────────────────────────────────────────────────

def _api(monkeypatch, tmp_path, *, scope=None, role="admin"):
    monkeypatch.setattr(settings, "FEATURE_REPORTING", True)
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = sessionmaker(bind=_engine())()
    acme, other = _fleet(db)
    app = FastAPI()
    app.include_router(reports_endpoint.router)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_operator] = lambda: SimpleNamespace(id=1, username="mario", role=role)
    app.dependency_overrides[get_operator_scope] = lambda: scope
    app.dependency_overrides[reports_endpoint._require_view] = lambda: None
    return TestClient(app), db, acme, other


def test_catalog(monkeypatch, tmp_path):
    client, *_ = _api(monkeypatch, tmp_path)
    items = {i["key"]: i for i in client.get("/catalog").json()}
    assert set(items) == {"executive", "patch_compliance", "lifecycle", "availability", "capacity", "access_audit",
                          "security_posture", "full"}
    assert items["security_posture"]["needs"] == "agent 2.1.31"
    assert items["executive"]["formats"] == ["pdf"] and items["full"]["preview"] is False
    assert items["capacity"]["formats"] == ["pdf", "csv"] and items["capacity"]["needs"] is None


def test_preview_returns_the_document(monkeypatch, tmp_path):
    client, _, acme, _ = _api(monkeypatch, tmp_path)
    response = client.get("/preview", params={"client_id": acme.id, "report_type": "lifecycle", "period_days": 30})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["key"] == "lifecycle" and body["client_name"] == acme.name
    assert {s["key"] for s in body["sections"]} == {"unsupported", "ending_soon", "hardware", "os_overview"}
    assert all(set(k) >= {"label", "value", "kind", "hint", "tone"} for k in body["summary"])
    custom = client.get("/preview", params={"client_id": acme.id, "report_type": "availability",
                                            "period_from": "2026-10-01T00:00:00Z", "period_to": "2026-10-08T00:00:00Z"})
    assert custom.status_code == 200 and custom.json()["period_start"].startswith("2026-10-01")
    assert client.get("/preview", params={"client_id": acme.id, "report_type": "full"}).status_code == 422
    assert client.get("/preview", params={"client_id": acme.id, "report_type": "nope"}).status_code == 422
    assert client.get("/preview", params={"client_id": 999, "report_type": "capacity"}).status_code == 404


def test_scope_hides_other_clients(monkeypatch, tmp_path):
    scope = AllowedScope(client_ids=frozenset({1}))
    client, _, acme, other = _api(monkeypatch, tmp_path, scope=scope)
    assert client.get("/preview", params={"client_id": other.id, "report_type": "capacity"}).status_code == 404
    assert client.post("/generate", json={"client_id": other.id, "report_type": "capacity", "report_format": "pdf"}).status_code == 404
    assert client.get("/preview", params={"client_id": acme.id, "report_type": "capacity"}).status_code == 200


def test_view_permission_is_required(monkeypatch, tmp_path):
    client, *_ = _api(monkeypatch, tmp_path)
    client.app.dependency_overrides.pop(reports_endpoint._require_view)
    client.app.dependency_overrides[reports_endpoint._require_view] = _forbid
    assert client.get("/catalog").status_code == 403
    assert client.get("/preview", params={"client_id": 1, "report_type": "capacity"}).status_code == 403


def _forbid():
    from fastapi import HTTPException
    raise HTTPException(status_code=403, detail="Forbidden")


def test_generate_every_type(monkeypatch, tmp_path):
    client, db, acme, _ = _api(monkeypatch, tmp_path)
    for key, fmt in (("security_posture", "pdf"), ("access_audit", "csv"), ("executive", "pdf"), ("full", "csv")):
        response = client.post("/generate", json={"client_id": acme.id, "report_type": key, "report_format": fmt, "period_days": 30})
        assert response.status_code == 200, response.text
        run = response.json()
        assert run["report_type"] == key and run["status"] == "completed"
        content = client.get(f"/runs/{run['id']}/download").content
        if fmt == "pdf":
            assert content.startswith(b"%PDF")
        else:
            text = content.decode("utf-8-sig")
            assert ("Remote Support sessions" in text) if key == "access_audit" else ("Devices" in text)
    assert db.query(ReportRun).filter(ReportRun.report_type == "access_audit").one().filename.startswith("CLIENT_Acme-Sh.p.k_AccessAudit_")
    rejected = client.post("/generate", json={"client_id": acme.id, "report_type": "executive", "report_format": "csv"})
    assert rejected.status_code == 422
    assert client.post("/generate", json={"client_id": acme.id, "report_type": "bogus"}).status_code == 422


def test_schedule_with_report_type(monkeypatch, tmp_path):
    client, db, acme, _ = _api(monkeypatch, tmp_path)
    body = {"name": "Monthly security", "client_id": acme.id, "report_type": "security_posture", "report_format": "pdf",
            "cadence": "monthly", "day_of_month": 1}
    created = client.post("/schedules", json=body)
    assert created.status_code == 200, created.text
    assert created.json()["report_type"] == "security_posture"
    assert client.get("/schedules").json()[0]["report_type"] == "security_posture"
    assert client.post("/schedules", json={**body, "report_type": "executive", "report_format": "csv"}).status_code == 422
    schedule_id = created.json()["id"]
    assert client.patch(f"/schedules/{schedule_id}", json={"report_type": "executive", "report_format": "csv"}).status_code == 422
    updated = client.patch(f"/schedules/{schedule_id}", json={"report_type": "capacity", "report_format": "csv"})
    assert updated.status_code == 200 and updated.json()["report_type"] == "capacity"
    # the default stays the original report
    plain = client.post("/schedules", json={**{k: v for k, v in body.items() if k != "report_type"}, "name": "Plain"})
    assert plain.json()["report_type"] == "full"


def test_worker_generates_the_scheduled_type(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    factory = sessionmaker(bind=_engine())
    db = factory()
    acme, _ = _fleet(db)
    db.add(ReportSchedule(name="Weekly capacity", client_id=acme.id, report_type="capacity", report_format="csv",
                          cadence="daily", period_days=7, hour_local=6, enabled=True,
                          next_run_at=utcnow() - timedelta(minutes=1), created_by="mario"))
    db.commit()
    db.close()
    monkeypatch.setattr(worker_module, "SessionLocal", factory)
    assert ReportWorker().run_once() == 1
    run = factory().query(ReportRun).one()
    assert run.report_type == "capacity" and run.filename.endswith(".csv")
    assert "All disks" in Path(run.storage_path).read_text(encoding="utf-8-sig")


def test_full_report_unchanged(db, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    acme, _ = _fleet(db)
    run = ReportService(db).generate(client_id=acme.id, report_format="pdf", period_days=30, generated_by="mario")
    assert run.report_type == "full" and "_Full_" in run.filename


# ── migration ───────────────────────────────────────────────────────────────

def test_migration_adds_report_type_with_full_default():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "r6s7t8u9v0w1_report_schedule_type.py"
    spec = importlib.util.spec_from_file_location("report_type_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "q5r6s7t8u9v0"
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE report_schedules (id INTEGER PRIMARY KEY, name VARCHAR(160))"))
        conn.execute(sa.text("INSERT INTO report_schedules VALUES (1, 'old')"))
        with Operations.context(MigrationContext.configure(conn)):
            module.upgrade()
    with engine.begin() as conn:
        assert conn.execute(sa.text("SELECT report_type FROM report_schedules")).scalar() == "full"
