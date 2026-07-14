import json
from datetime import timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints.agent import _record_heartbeat_trust_transition
from app.core.time import utcnow
from app.db.base import Base
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus
from scripts.cleanup_legacy_heartbeat_audit import ACTION, cleanup


def _db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine,
        tables=[Device.__table__, AuditLog.__table__],
    )
    return sessionmaker(bind=engine)()


def test_repeated_legacy_heartbeats_audit_only_transitions():
    db = _db()
    device = Device(hostname="bounded", status=DeviceStatus.ONLINE)
    db.add(device)
    db.commit()
    db.refresh(device)

    for _ in range(100):
        _record_heartbeat_trust_transition(
            db,
            device=device,
            state="legacy_restricted",
            source_ip="127.0.0.1",
            mode="observe",
            reason="missing_auth",
        )
    for _ in range(100):
        _record_heartbeat_trust_transition(
            db,
            device=device,
            state="authenticated",
            source_ip="127.0.0.1",
            mode="observe",
            reason="authenticated",
        )

    rows = db.query(AuditLog).order_by(AuditLog.id).all()
    assert [row.action for row in rows] == [
        "agent_heartbeat_legacy_accepted",
        "agent_heartbeat_authenticated",
    ]
    assert all("secret" not in (row.details_json or "").lower() for row in rows)


def test_cleanup_is_dry_run_by_default_and_preserves_first_latest_and_unrelated():
    db = _db()
    old = utcnow() - timedelta(days=3)
    for index in range(5):
        db.add(
            AuditLog(
                operator_username="system",
                action=ACTION,
                entity_type="device",
                entity_id=11,
                details_json=json.dumps({"index": index}),
                created_at=old + timedelta(minutes=index),
            )
        )
    db.add(
        AuditLog(
            operator_username="system",
            action="unrelated",
            entity_type="device",
            entity_id=11,
            created_at=old,
        )
    )
    db.commit()

    assert cleanup(db, older_than_hours=24, execute=False) == 3
    assert db.query(AuditLog).count() == 6
    assert cleanup(db, older_than_hours=24, execute=True) == 3
    remaining = db.query(AuditLog).order_by(AuditLog.id).all()
    assert [row.action for row in remaining].count(ACTION) == 2
    assert [row.action for row in remaining].count("unrelated") == 1
