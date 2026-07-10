from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.config import settings
from app.core.time import utcnow
from app.db.base import Base
from app.models.client import Client
from app.models.device import Device
from app.models.report import ReportRun, ReportRunStatus, ReportSchedule
from app.workers import report_worker as worker_module
from app.workers.report_worker import ReportWorker


def test_due_schedule_generates_report_and_advances(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "REPORT_STORAGE_DIR", str(tmp_path))
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    factory = sessionmaker(bind=engine)
    Base.metadata.create_all(bind=engine)
    db = factory()
    client = Client(name="Acme", slug="acme", is_active=True)
    db.add(client); db.commit(); db.refresh(client)
    db.add(Device(hostname="PC", client_id=client.id))
    schedule = ReportSchedule(
        name="Daily", client_id=client.id, report_format="pdf", cadence="daily", period_days=7,
        hour_utc=6, enabled=True, next_run_at=utcnow() - timedelta(minutes=1), created_by="mario",
    )
    db.add(schedule); db.commit(); db.refresh(schedule)
    old_next = schedule.next_run_at
    db.close()
    monkeypatch.setattr(worker_module, "SessionLocal", factory)

    worker = ReportWorker()
    assert worker.run_once() == 1
    check = factory()
    run = check.query(ReportRun).one()
    updated = check.query(ReportSchedule).one()
    assert run.status == ReportRunStatus.COMPLETED.value
    assert run.schedule_id == updated.id
    assert updated.next_run_at > old_next
    assert updated.last_run_at is not None
