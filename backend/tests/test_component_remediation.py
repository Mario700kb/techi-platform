"""Component Auto-Remediation (Operational M12): detect an unhealthy component and,
if policy allows, queue the recommended remediation via the EXISTING action path.
Detection is patched (the real status is manifest-driven) so cases are deterministic.
"""
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
import app.services.component_remediation_service as rem
from app.db.base import Base
from app.models.device import Device, DeviceStatus, DeviceType
from app.models.remote_action import RemoteAction
from app.services.component_package_service import ComponentPackageStatus
from app.services.component_remediation_service import ComponentRemediationService


def _db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(bind=engine)()
    db.add(Device(
        id=7, hostname="win-1", platform="windows", capabilities=None,
        device_type=DeviceType.CLIENT, status=DeviceStatus.ONLINE,
    ))
    db.commit()
    return db


def _device(db):
    return db.query(Device).filter(Device.id == 7).first()


def _status(cid, installed=None, desired=None, available=None, outdated=False):
    return ComponentPackageStatus(cid, installed, desired, available, outdated)


def _svc(db, status):
    svc = ComponentRemediationService(db)
    svc._packages.status_for = lambda device, cid: status
    return svc


# --------------------------------------------------------------------------- #
# Detection                                                                   #
# --------------------------------------------------------------------------- #
def test_detect_outdated_recommends_update():
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.5", desired="2.1.14", outdated=True))
    plan = svc.detect(_device(db), "agent")
    assert plan.operation == "update" and plan.reason == "outdated"


def test_detect_missing_agent_has_no_executable_remediation():
    # Agent install is GPO/out-of-band and it has no reinstall → nothing to do.
    db = _db()
    svc = _svc(db, _status("agent", installed=None, desired="2.1.14"))
    plan = svc.detect(_device(db), "agent")
    assert plan.operation is None and plan.reason == "no_executable_remediation"


def test_detect_missing_remote_support_recommends_install():
    db = _db()
    svc = _svc(db, _status("remote_support", installed=None, desired="1.4.8"))
    plan = svc.detect(_device(db), "remote_support")
    assert plan.operation == "install" and plan.reason == "missing"


def test_detect_healthy_recommends_nothing():
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.14", desired="2.1.14", outdated=False))
    plan = svc.detect(_device(db), "agent")
    assert plan.operation is None and plan.reason == "healthy"


# --------------------------------------------------------------------------- #
# Remediate (manual path — queues through the existing pipeline)              #
# --------------------------------------------------------------------------- #
def test_remediate_queues_update_for_outdated():
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.5", desired="2.1.14", outdated=True))
    result = svc.remediate(_device(db), "agent", created_by="mario")
    assert result.acted is True and result.reason == "queued"
    assert result.action.action_type == "self_update"
    assert db.query(RemoteAction).count() == 1


def test_remediate_dry_run_does_not_queue():
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.5", desired="2.1.14", outdated=True))
    result = svc.remediate(_device(db), "agent", created_by="mario", dry_run=True)
    assert result.acted is False and result.reason == "dry_run"
    assert result.plan.operation == "update"
    assert db.query(RemoteAction).count() == 0


def test_remediate_healthy_is_noop():
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.14", desired="2.1.14"))
    result = svc.remediate(_device(db), "agent", created_by="mario")
    assert result.acted is False and result.reason == "healthy"


# --------------------------------------------------------------------------- #
# Auto (unattended) gate                                                      #
# --------------------------------------------------------------------------- #
def test_auto_remediation_disabled_by_default(monkeypatch):
    db = _db()
    svc = _svc(db, _status("agent", installed="2.1.5", desired="2.1.14", outdated=True))
    result = svc.remediate(_device(db), "agent", created_by="system", auto=True)
    assert result.acted is False and result.reason == "auto_remediation_disabled"
    assert db.query(RemoteAction).count() == 0


def test_auto_remediation_runs_when_policy_enabled(monkeypatch):
    db = _db()
    monkeypatch.setattr(rem, "GLOBAL_AUTO_REMEDIATION", rem.AutoRemediationPolicy(enabled=True))
    svc = _svc(db, _status("agent", installed="2.1.5", desired="2.1.14", outdated=True))
    result = svc.remediate(_device(db), "agent", created_by="system", auto=True)
    assert result.acted is True and result.reason == "queued"


def test_auto_remediation_allowed_default_false():
    assert rem.auto_remediation_allowed("agent") is False
