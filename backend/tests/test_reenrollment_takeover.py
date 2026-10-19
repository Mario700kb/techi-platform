"""A re-enrollment that matches a device already owned by another agent must
not take it over. Until 2026-10-16 it did: enroll with any token plus a
device's RustDesk id (readable from an unauthenticated heartbeat) and the
device moved to the caller. Now it is held for an admin, and the caller runs as
its own device.
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.device import Device
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus
from app.models.reenrollment_request import ReenrollmentRequest
from app.schemas.agent import AgentEnrollmentRequest
from app.services.agent_enrollment_service import AgentEnrollmentService
from app.services.enrollment_token_service import EnrollmentTokenService
from app.services.reenrollment_service import ReenrollmentService


def _db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def _token(db, plaintext="tok-value-0123456789", client_id=None):
    token = EnrollmentToken(
        name="T", token_hash=EnrollmentTokenService.hash_token(plaintext), token_prefix=plaintext[:8],
        status=EnrollmentTokenStatus.ACTIVE, max_uses=50, use_count=0, client_id=client_id,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return plaintext


def _victim(db, *, agent_id="agent_REAL_victim", rustdesk_id="123456789", hostname="VICTIM-PC", client_id=None):
    d = Device(
        agent_id=agent_id, hostname=hostname, platform="windows", rustdesk_id=rustdesk_id,
        public_ip="203.0.113.1", local_ip="10.0.0.9", client_id=client_id,
        cpu=None, ram=None, storage=None,
    )
    d.is_archived = False
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


def _enroll(db, plaintext, **kw):
    payload = AgentEnrollmentRequest(
        enrollment_token=plaintext, hostname=kw.get("hostname", "VICTIM-PC"),
        current_user="u", platform="windows", os_name="Windows 11",
        local_ip=kw.get("local_ip", "10.0.0.9"), public_ip=kw.get("public_ip", "203.0.113.1"),
        rustdesk_id=kw.get("rustdesk_id"), agent_id=kw.get("agent_id"),
    )
    return AgentEnrollmentService(db).enroll(
        payload, heartbeat_url="https://x/heartbeat", websocket_url="wss://x/ws"
    )


def test_a_foreign_agent_with_the_rustdesk_id_does_not_take_the_device(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)

    resp = _enroll(db, plaintext, agent_id="attacker-agent", rustdesk_id="123456789")

    assert resp.device_id != victim.id  # enrolled as its own device
    db.expire_all()
    assert db.query(Device).get(victim.id).agent_id == "agent_REAL_victim"
    request = db.query(ReenrollmentRequest).one()
    assert request.device_id == victim.id and request.status == "pending"
    assert request.matched_by == "rustdesk_id" and request.new_device_id == resp.device_id


def test_the_held_agents_heartbeat_does_not_touch_the_victim(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)
    resp = _enroll(db, plaintext, agent_id="attacker-agent", rustdesk_id="123456789")

    # The placeholder device is a real, separate device with its own agent_id.
    placeholder = db.query(Device).get(resp.device_id)
    assert placeholder.agent_id == "attacker-agent"
    assert placeholder.rustdesk_id is None
    assert placeholder.duplicate_of_device_id == victim.id


def test_the_same_agent_reattaches_without_a_hold(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)

    resp = _enroll(db, plaintext, agent_id="agent_REAL_victim", rustdesk_id="123456789")

    assert resp.device_id == victim.id
    assert db.query(ReenrollmentRequest).count() == 0


def test_an_agent_that_lost_its_config_reattaches_by_rustdesk_id(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)

    # No agent_id (fresh config), but the RustDesk id still matches: same machine.
    resp = _enroll(db, plaintext, agent_id=None, rustdesk_id="123456789")

    assert resp.device_id == victim.id
    assert db.query(ReenrollmentRequest).count() == 0


def test_hostname_match_ignores_case(db=None):
    # 2026-10-19: the same PC enrolled as "kleivid-pc" (os.Hostname) and then
    # as "KLEIVID-PC" (%COMPUTERNAME%) with a new RustDesk id; the
    # case-sensitive compare missed it and a plain second device appeared.
    db = _db()
    plaintext = _token(db)
    victim = _victim(db, hostname="kleivid-pc")

    resp = _enroll(db, plaintext, hostname="KLEIVID-PC", agent_id=None, rustdesk_id="987654321")

    request = db.query(ReenrollmentRequest).one()
    assert request.device_id == victim.id and request.new_device_id == resp.device_id
    assert db.query(Device).get(resp.device_id).duplicate_candidate is True


def test_approve_moves_the_device_and_archives_the_placeholder(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)
    resp = _enroll(db, plaintext, agent_id="new-agent", rustdesk_id="123456789")
    request = db.query(ReenrollmentRequest).one()

    ReenrollmentService(db).approve(request.id, operator="admin")

    db.expire_all()
    assert db.query(Device).get(victim.id).agent_id == "new-agent"
    assert db.query(Device).get(victim.id).reenrolled_from_agent_id == "agent_REAL_victim"
    assert db.query(Device).get(resp.device_id).is_archived is True
    assert db.query(ReenrollmentRequest).get(request.id).status == "decided"


def test_reject_keeps_two_separate_devices(db=None):
    db = _db()
    plaintext = _token(db)
    victim = _victim(db)
    resp = _enroll(db, plaintext, agent_id="other-machine", rustdesk_id="123456789")
    request = db.query(ReenrollmentRequest).one()

    ReenrollmentService(db).reject(request.id, operator="admin")

    db.expire_all()
    assert db.query(Device).get(victim.id).agent_id == "agent_REAL_victim"
    assert db.query(Device).get(resp.device_id).is_archived is False
    assert db.query(ReenrollmentRequest).get(request.id).decision == "rejected"
