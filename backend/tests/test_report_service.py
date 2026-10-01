from datetime import datetime, timedelta
import re

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.config import settings
from app.core.time import utcnow
from app.db.base import Base
from app.models.alert import AlertSeverity, AlertState, DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.report import ReportCadence, ReportRunStatus
from app.models.device_activity_event import DeviceActivityEvent
from app.models.device_note import DeviceNote
from app.services.report_service import ReportService, next_schedule_time


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def _seed(db):
    client = Client(name="Acme & Sons", slug="acme", is_active=True)
    db.add(client)
    db.commit()
    db.refresh(client)
    device = Device(
        hostname="ACME-SRV", client_id=client.id, status=DeviceStatus.ONLINE,
        device_type=DeviceType.SERVER, last_seen=utcnow(), os_caption="Windows Server 2022",
        agent_version="2.1.6", platform="windows",
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    db.add(DeviceAlert(
        device_id=device.id, kind="device_offline", severity=AlertSeverity.CRITICAL,
        state=AlertState.OPEN, message="Device offline", created_at=utcnow(), updated_at=utcnow(),
    ))
    db.commit()
    return client, device


@pytest.mark.parametrize("report_format,signature", [("pdf", b"%PDF-1.4"), ("csv", b"\xef\xbb\xbf")])
def test_generate_client_report(report_format, signature, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    client, _ = _seed(db)
    run = ReportService(db).generate(
        client_id=client.id, report_format=report_format, period_days=30, generated_by="mario",
    )
    assert run.status == ReportRunStatus.COMPLETED.value
    content = ReportService.resolve_download_path(run).read_bytes()
    assert content.startswith(signature)
    assert run.size_bytes == len(content)
    assert run.filename.startswith("CLIENT_Acme-Sons_Full_")
    assert run.filename.endswith(f".{report_format}")
    if report_format == "csv":
        decoded = content.decode("utf-8-sig")
        assert "ACME-SRV" in decoded
        assert "Device offline" in decoded
    else:
        assert b"Executive Summary" in content
        assert b"Device Inventory" in content
        assert b"Page 1" in content
        assert b"Operator: mario" in content
        assert len(re.findall(rb"/Type\s*/Page\b", content)) >= 2


def test_generation_failure_is_persisted(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    client, _ = _seed(db)
    with pytest.raises(ValueError):
        ReportService(db).generate(client_id=client.id, report_format="xlsx", period_days=30, generated_by="m")
    run = db.query(app.models.ReportRun).one()
    assert run.status == ReportRunStatus.FAILED.value
    assert "Unsupported report format" in run.error_message


def test_schedule_calculation_and_validation():
    after = datetime(2026, 7, 10, 8, 0)
    assert next_schedule_time("daily", hour_utc=6, after=after) == datetime(2026, 7, 11, 6, 0)
    assert next_schedule_time("weekly", hour_utc=9, day_of_week=0, after=after) == datetime(2026, 7, 13, 9, 0)
    assert next_schedule_time("monthly", hour_utc=7, day_of_month=15, after=after) == datetime(2026, 7, 15, 7, 0)


def test_create_schedule_sets_next_run():
    db = _db()
    client, _ = _seed(db)
    schedule = ReportService(db).create_schedule(
        name="Monthly", client_id=client.id, report_format="pdf", cadence=ReportCadence.MONTHLY.value,
        period_days=30, hour_utc=6, day_of_week=None, day_of_month=1, enabled=True, created_by="mario",
    )
    assert schedule.next_run_at > datetime.utcnow()
    assert schedule.client_id == client.id


def test_cleanup_removes_old_file_and_row(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "REPORT_RETENTION_DAYS", 30)
    db = _db()
    client, _ = _seed(db)
    run = ReportService(db).generate(client_id=client.id, report_format="pdf", period_days=30, generated_by="m")
    path = ReportService.resolve_download_path(run)
    run.created_at = utcnow() - timedelta(days=31)
    db.commit()
    assert ReportService(db).cleanup_expired() == 1
    assert not path.exists()


@pytest.mark.parametrize("report_type", [
    "full", "overview", "user_activity", "status_uptime", "health", "alerts",
    "actions", "software", "remote_support", "assignments", "notes", "event_history",
])
def test_generate_device_report_types(report_type, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    client, device = _seed(db)
    db.add(DeviceActivityEvent(
        device_id=device.id, event_type="user_changed", summary="User changed to ACME\\alice",
        detail="Previous: ACME\\bob", actor="agent", occurred_at=utcnow(),
    ))
    db.commit()
    end = utcnow()
    run = ReportService(db).generate_device(
        device_id=device.id, report_type=report_type, report_format="pdf",
        period_start=end - timedelta(days=30), period_end=end, generated_by="mario",
    )
    assert run.status == "completed"
    assert run.scope_type == "device"
    assert run.device_id == device.id
    assert run.client_id == client.id
    content = ReportService.resolve_download_path(run).read_bytes()
    assert content.startswith(b"%PDF-1.4")
    assert b"TECHI PLATFORM" in content
    assert b"Executive Summary" in content
    assert b"Page 1" in content
    assert run.filename.startswith(f"DEVICE_ACME-SRV_{report_type}_")
    assert b"remote_support_password_ciphertext" not in content
    if report_type in ("full", "user_activity"):
        assert b"ACME" in content
        assert b"Source retention is 7 days" in content


@pytest.mark.parametrize("report_type", [
    "overview", "user_activity", "status_uptime", "health", "alerts", "actions",
    "software", "remote_support", "assignments", "notes", "event_history",
])
def test_device_category_csv_and_custom_range(report_type, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    _, device = _seed(db)
    end = utcnow()
    run = ReportService(db).generate_device(
        device_id=device.id, report_type=report_type, report_format="csv",
        period_start=end - timedelta(hours=24), period_end=end, generated_by="mario",
    )
    content = ReportService.resolve_download_path(run).read_bytes().decode("utf-8-sig")
    assert run.filename.startswith(f"DEVICE_ACME-SRV_{report_type}_")
    assert run.filename.endswith(".csv")
    assert "TECHI Device Report" in content
    assert "ACME-SRV" in content
    assert "remote_support_password_ciphertext" not in content


def test_full_device_report_redacts_known_secret_fields_and_note_values(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    _, device = _seed(db)
    device.remote_support_password_ciphertext = "CIPHERTEXT-DO-NOT-EXPORT"
    db.add(DeviceNote(device_id=device.id, note="password: hunter2", created_by="operator"))
    db.commit()
    end = utcnow()
    run = ReportService(db).generate_device(
        device_id=device.id, report_type="full", report_format="pdf",
        period_start=end - timedelta(days=1), period_end=end, generated_by="mario",
    )
    content = ReportService.resolve_download_path(run).read_bytes()
    assert b"hunter2" not in content
    assert b"CIPHERTEXT-DO-NOT-EXPORT" not in content
    assert b"[redacted]" in content


@pytest.mark.parametrize("report_format", ["pdf", "csv"])
def test_device_notes_export_redacts_pasted_secrets(tmp_path, monkeypatch, report_format):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    _, device = _seed(db)
    for note in (
        "-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE-MATERIAL\n-----END PRIVATE KEY-----",
        "Authorization: Bearer FAKE-TEST-TOKEN",
        "wrapped_dek=FAKE-TEST-DEK",
        "api_key: FAKE-TEST-KEY",
        "=SUM(1+1)",
    ):
        db.add(DeviceNote(device_id=device.id, note=note, created_by="operator"))
    db.commit()
    end = utcnow()
    run = ReportService(db).generate_device(
        device_id=device.id, report_type="notes", report_format=report_format,
        period_start=end - timedelta(days=1), period_end=end, generated_by="mario",
    )
    content = ReportService.resolve_download_path(run).read_bytes()
    for secret in (b"FAKE-PRIVATE-MATERIAL", b"FAKE-TEST-TOKEN", b"FAKE-TEST-DEK", b"FAKE-TEST-KEY"):
        assert secret not in content
    assert b"[redacted]" in content
    if report_format == "csv":
        assert b"'=SUM(1+1)" in content


@pytest.mark.parametrize("report_format", ["pdf", "csv"])
def test_client_alert_export_redacts_secret_and_escapes_csv_formula(tmp_path, monkeypatch, report_format):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    db = _db()
    client, device = _seed(db)
    db.add_all([
        DeviceAlert(device_id=device.id, kind="device_offline", severity=AlertSeverity.WARNING,
                    state=AlertState.OPEN, message="Bearer FAKE-CLIENT-TOKEN", created_at=utcnow(), updated_at=utcnow()),
        DeviceAlert(device_id=device.id, kind="device_offline", severity=AlertSeverity.WARNING,
                    state=AlertState.OPEN, message="=SUM(1+1)", created_at=utcnow(), updated_at=utcnow()),
    ])
    db.commit()
    run = ReportService(db).generate(client_id=client.id, report_format=report_format,
                                      period_days=1, generated_by="mario")
    content = ReportService.resolve_download_path(run).read_bytes()
    assert b"FAKE-CLIENT-TOKEN" not in content
    assert b"[redacted]" in content
    if report_format == "csv":
        assert b"'=SUM(1+1)" in content
