from datetime import datetime, timedelta

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
    assert "Acme-Sons" in run.filename
    if report_format == "csv":
        decoded = content.decode("utf-8-sig")
        assert "ACME-SRV" in decoded
        assert "Device offline" in decoded


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
