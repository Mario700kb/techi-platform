"""Browser sessions: HttpOnly cookies, CSRF header, refresh rotation,
revocation, the legacy-token exchange, and TOTP two-factor sign-in."""
from datetime import timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.v1.endpoints import auth as auth_module
from app.api.v1.endpoints import operators as operators_module
from app.core import totp, vault_cipher
from app.core.agent_auth import _SlidingWindowRateLimiter
from app.core.auth import create_operator_token, hash_password
from app.core.config import settings
from app.core.time import utcnow
from app.db.base import Base
from app.db.session import get_db
from app.models.audit_log import AuditLog
from app.models.operator import Operator
from app.models.operator_session import OperatorSession
from app.models.team import Team, TeamMember
from app.services.session_service import ACCESS_COOKIE, CSRF_HEADER, REFRESH_COOKIE

CSRF = {CSRF_HEADER: "1"}
PASSWORD = "correct horse battery"


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAULT_MASTER_KEY_FILE", str(tmp_path / "vault_master.key"))
    vault_cipher.reset_master_key_cache_for_tests()
    monkeypatch.setattr(settings, "MFA_REQUIRED_ROLES", [])
    monkeypatch.setattr(auth_module, "mfa_limiter", _SlidingWindowRateLimiter(limit=50, window_seconds=300))
    monkeypatch.setattr(auth_module, "login_limiter", _SlidingWindowRateLimiter(limit=50, window_seconds=60))
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(
        bind=engine,
        tables=[Operator.__table__, OperatorSession.__table__, Team.__table__, TeamMember.__table__, AuditLog.__table__],
    )
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    vault_cipher.reset_master_key_cache_for_tests()


def _operator(db, username="alice", role="operator") -> Operator:
    operator = Operator(
        username=username,
        email=f"{username}@test.com",
        hashed_password=hash_password(PASSWORD),
        role=role,
        is_active=True,
        is_superuser=False,
    )
    db.add(operator)
    db.commit()
    db.refresh(operator)
    return operator


def _client(db) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[get_db] = lambda: db
    app.include_router(auth_module.router, prefix="/api/v1/auth")
    app.include_router(operators_module.router, prefix="/api/v1/operators")
    # https so the Secure cookies are stored and sent back, as in a browser.
    return TestClient(app, base_url="https://testserver", raise_server_exceptions=False)


def _login(client, username="alice"):
    return client.post("/api/v1/auth/login", json={"username": username, "password": PASSWORD})


# -- cookies -----------------------------------------------------------------


def test_login_sets_httponly_cookies_and_no_token_in_body(db):
    _operator(db)
    client = _client(db)
    response = _login(client)
    assert response.status_code == 200
    body = response.json()
    assert "access_token" not in body
    assert body["user"]["username"] == "alice"
    cookies = response.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith(f"{ACCESS_COOKIE}="))
    refresh = next(c for c in cookies if c.startswith(f"{REFRESH_COOKIE}="))
    for cookie in (access, refresh):
        assert "HttpOnly" in cookie and "Secure" in cookie and "samesite=strict" in cookie.lower()
    assert "Path=/api/v1/auth" in refresh


def test_cookie_authenticates_reads(db):
    _operator(db)
    client = _client(db)
    _login(client)
    response = client.get("/api/v1/auth/session")
    assert response.status_code == 200
    assert response.json()["session_expires_at"]


def test_cookie_write_without_csrf_header_is_refused(db):
    _operator(db)
    client = _client(db)
    _login(client)
    body = {"current_password": PASSWORD, "new_password": "another long password"}
    assert client.post("/api/v1/auth/change-password", json=body).status_code == 403
    assert client.post("/api/v1/auth/change-password", json=body, headers=CSRF).status_code == 200


def test_bearer_token_still_works_without_csrf(db):
    operator = _operator(db)
    client = _client(db)
    token = create_operator_token(operator)
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200


def _replay(db, refresh_token):
    other = _client(db)
    other.cookies.set(REFRESH_COOKIE, refresh_token, domain="testserver.local", path="/api/v1/auth")
    return other.post("/api/v1/auth/refresh", headers=CSRF)


def test_refresh_rotates_and_old_refresh_token_dies_after_the_grace(db):
    _operator(db)
    client = _client(db)
    _login(client)
    old_refresh = client.cookies.get(REFRESH_COOKIE)
    response = client.post("/api/v1/auth/refresh", headers=CSRF)
    assert response.status_code == 200
    assert client.cookies.get(REFRESH_COOKIE) != old_refresh

    row = db.query(OperatorSession).one()
    row.refresh_rotated_at = utcnow() - timedelta(seconds=31)
    db.commit()
    assert _replay(db, old_refresh).status_code == 401


def test_tabs_renewing_together_all_stay_signed_in(db):
    """Tabs share the cookie and renew at the same moment: the second one
    arrives with the token the first has just rotated."""
    _operator(db)
    client = _client(db)
    _login(client)
    shared = client.cookies.get(REFRESH_COOKIE)

    first = _replay(db, shared)
    second = _replay(db, shared)

    assert first.status_code == 200
    assert second.status_code == 200
    assert db.query(OperatorSession).count() == 1  # one session, renewed twice


def test_a_token_two_rotations_old_is_refused(db):
    _operator(db)
    client = _client(db)
    _login(client)
    oldest = client.cookies.get(REFRESH_COOKIE)
    client.post("/api/v1/auth/refresh", headers=CSRF)
    client.post("/api/v1/auth/refresh", headers=CSRF)

    assert _replay(db, oldest).status_code == 401


def test_a_signed_out_browser_gets_204_not_401(db):
    client = _client(db)
    response = client.get("/api/v1/auth/session")
    assert response.status_code == 204
    assert response.content == b""


def test_an_expired_access_cookie_with_a_refresh_cookie_still_answers_401(db):
    """The app renews on 401; only a browser with no session at all gets 204."""
    _operator(db)
    client = _client(db)
    _login(client)
    client.cookies.delete(ACCESS_COOKIE, domain="testserver.local", path="/")
    assert client.get("/api/v1/auth/session").status_code == 401


def test_refresh_requires_csrf_header(db):
    _operator(db)
    client = _client(db)
    _login(client)
    assert client.post("/api/v1/auth/refresh").status_code == 403


def test_logout_revokes_the_session_server_side(db):
    _operator(db)
    client = _client(db)
    _login(client)
    stolen_access = client.cookies.get(ACCESS_COOKIE)
    assert client.post("/api/v1/auth/logout", headers=CSRF).status_code == 204

    attacker = _client(db)
    attacker.cookies.set(ACCESS_COOKIE, stolen_access, domain="testserver.local", path="/")
    assert attacker.get("/api/v1/auth/session").status_code == 401


def test_idle_session_expires(db, monkeypatch):
    _operator(db)
    client = _client(db)
    _login(client)
    row = db.query(OperatorSession).one()
    row.last_used_at = utcnow() - timedelta(minutes=settings.SESSION_IDLE_MINUTES + 1)
    db.commit()
    assert client.get("/api/v1/auth/session").status_code == 401
    assert client.post("/api/v1/auth/refresh", headers=CSRF).status_code == 401


def test_revoke_other_sessions_keeps_this_one(db):
    _operator(db)
    phone, laptop = _client(db), _client(db)
    _login(phone)
    _login(laptop)
    assert laptop.post("/api/v1/auth/sessions/revoke-others", headers=CSRF).json() == {"revoked": 1}
    assert laptop.get("/api/v1/auth/session").status_code == 200
    assert phone.get("/api/v1/auth/session").status_code == 401


def test_token_exchange_moves_a_legacy_token_to_cookies(db):
    operator = _operator(db)
    client = _client(db)
    legacy = create_operator_token(operator)
    response = client.post("/api/v1/auth/token-exchange", headers={"Authorization": f"Bearer {legacy}"})
    assert response.status_code == 200
    assert client.cookies.get(ACCESS_COOKIE)
    assert client.get("/api/v1/auth/session").status_code == 200


def test_token_exchange_refuses_session_tokens(db):
    _operator(db)
    client = _client(db)
    _login(client)
    session_token = client.cookies.get(ACCESS_COOKIE)
    fresh = _client(db)
    response = fresh.post("/api/v1/auth/token-exchange", headers={"Authorization": f"Bearer {session_token}"})
    assert response.status_code == 401


# -- two-factor authentication ----------------------------------------------------


def _enable_mfa(client) -> tuple:
    setup = client.post("/api/v1/auth/mfa/setup", headers=CSRF).json()
    secret = setup["secret"]
    assert setup["otpauth_uri"].startswith("otpauth://totp/")
    response = client.post("/api/v1/auth/mfa/enable", json={"code": totp.code_at(secret, totp.current_step())}, headers=CSRF)
    assert response.status_code == 200, response.text
    return secret, response.json()["recovery_codes"]


def test_mfa_enable_rejects_a_wrong_code(db):
    _operator(db)
    client = _client(db)
    _login(client)
    client.post("/api/v1/auth/mfa/setup", headers=CSRF)
    response = client.post("/api/v1/auth/mfa/enable", json={"code": "000000"}, headers=CSRF)
    assert response.status_code == 400
    assert client.get("/api/v1/auth/mfa").json()["enabled"] is False


def test_mfa_sign_in_needs_the_second_factor(db):
    _operator(db)
    client = _client(db)
    _login(client)
    secret, _codes = _enable_mfa(client)

    fresh = _client(db)
    first = _login(fresh).json()
    assert first["mfa_required"] is True and first["mfa_token"]
    assert fresh.cookies.get(ACCESS_COOKIE) is None
    # The challenge token is not an access token.
    assert fresh.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {first['mfa_token']}"}).status_code == 401

    code = totp.code_at(secret, totp.current_step() + 1)
    second = fresh.post("/api/v1/auth/login/mfa", json={"mfa_token": first["mfa_token"], "code": code})
    assert second.status_code == 200
    assert fresh.get("/api/v1/auth/session").status_code == 200


def test_mfa_code_cannot_be_replayed(db):
    _operator(db)
    client = _client(db)
    _login(client)
    secret, _codes = _enable_mfa(client)
    code = totp.code_at(secret, totp.current_step() + 1)

    first = _client(db)
    token = _login(first).json()["mfa_token"]
    assert first.post("/api/v1/auth/login/mfa", json={"mfa_token": token, "code": code}).status_code == 200

    second = _client(db)
    token = _login(second).json()["mfa_token"]
    assert second.post("/api/v1/auth/login/mfa", json={"mfa_token": token, "code": code}).status_code == 401


def test_recovery_code_works_once(db):
    _operator(db)
    client = _client(db)
    _login(client)
    _secret, codes = _enable_mfa(client)
    assert len(codes) == 10

    first = _client(db)
    token = _login(first).json()["mfa_token"]
    assert first.post("/api/v1/auth/login/mfa", json={"mfa_token": token, "code": codes[0].upper()}).status_code == 200
    assert first.get("/api/v1/auth/mfa").json()["recovery_codes_remaining"] == 9

    second = _client(db)
    token = _login(second).json()["mfa_token"]
    assert second.post("/api/v1/auth/login/mfa", json={"mfa_token": token, "code": codes[0]}).status_code == 401


def test_enabling_mfa_ends_password_only_sessions(db):
    _operator(db)
    other, client = _client(db), _client(db)
    _login(other)
    _login(client)
    _enable_mfa(client)
    assert client.get("/api/v1/auth/session").status_code == 200
    assert other.get("/api/v1/auth/session").status_code == 401


def test_mfa_disable_needs_password_and_code(db):
    _operator(db)
    client = _client(db)
    _login(client)
    secret, _codes = _enable_mfa(client)
    code = totp.code_at(secret, totp.current_step() + 1)
    bad = client.post("/api/v1/auth/mfa/disable", json={"password": "wrong", "code": code}, headers=CSRF)
    assert bad.status_code == 400
    good = client.post("/api/v1/auth/mfa/disable", json={"password": PASSWORD, "code": code}, headers=CSRF)
    assert good.status_code == 204
    assert client.get("/api/v1/auth/mfa").json()["enabled"] is False


def test_admin_reset_turns_off_mfa_and_signs_the_operator_out(db):
    alice = _operator(db)
    _operator(db, username="boss", role="admin")
    alice_client, boss = _client(db), _client(db)
    _login(alice_client)
    _enable_mfa(alice_client)
    _login(boss, "boss")

    response = boss.post(f"/api/v1/operators/{alice.id}/mfa/reset", headers=CSRF)
    assert response.status_code == 200
    assert response.json()["mfa_enabled"] is False
    assert alice_client.get("/api/v1/auth/session").status_code == 401


def test_operator_cannot_reset_someone_elses_mfa(db):
    _operator(db)
    boss = _operator(db, username="boss", role="admin")
    client = _client(db)
    _login(client)
    assert client.post(f"/api/v1/operators/{boss.id}/mfa/reset", headers=CSRF).status_code == 403


def test_required_role_must_enrol_before_anything_else(db, monkeypatch):
    monkeypatch.setattr(settings, "MFA_REQUIRED_ROLES", ["admin"])
    _operator(db, username="boss", role="admin")
    client = _client(db)
    _login(client, "boss")
    session = client.get("/api/v1/auth/session")
    assert session.status_code == 200
    assert session.json()["mfa_enrollment_required"] is True

    blocked = client.get("/api/v1/operators/")
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "mfa_enrollment_required"

    _enable_mfa(client)
    assert client.get("/api/v1/operators/").status_code == 200


# -- renewing before expiry ----------------------------------------------------


def _parse(ts: str):
    from datetime import datetime

    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def test_login_refresh_and_session_report_when_the_access_cookie_expires(db):
    from datetime import timedelta

    _operator(db)
    client = _client(db)
    access_window = timedelta(minutes=settings.SESSION_ACCESS_MINUTES)

    login = _login(client).json()
    login_exp = _parse(login["access_expires_at"])
    assert abs((login_exp - utcnow()) - access_window) < timedelta(seconds=5)

    session = client.get("/api/v1/auth/session").json()
    # The session endpoint reports the expiry of the cookie that was sent.
    assert abs(_parse(session["access_expires_at"]) - login_exp) < timedelta(seconds=2)

    refreshed = client.post("/api/v1/auth/refresh", headers=CSRF).json()
    assert abs((_parse(refreshed["access_expires_at"]) - utcnow()) - access_window) < timedelta(seconds=5)
