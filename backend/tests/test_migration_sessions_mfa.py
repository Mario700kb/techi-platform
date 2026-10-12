"""operator_sessions + MFA columns: existing operators keep signing in with MFA off."""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "f2a3b4c5d6e7_operator_sessions_and_mfa.py"


def _migration():
    spec = importlib.util.spec_from_file_location("sessions_mfa_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(engine, step):
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(_migration(), step)()


def _engine_with_operator():
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text(
            "CREATE TABLE operators (id INTEGER PRIMARY KEY, username VARCHAR(80) NOT NULL, "
            "hashed_password VARCHAR(255) NOT NULL, role VARCHAR(32) NOT NULL)"
        ))
        conn.execute(sa.text("INSERT INTO operators VALUES (1, 'alice', 'x', 'admin')"))
    return engine


def test_upgrade_adds_sessions_and_leaves_mfa_off():
    engine = _engine_with_operator()
    _run(engine, "upgrade")
    inspector = sa.inspect(engine)
    assert "operator_sessions" in inspector.get_table_names()
    columns = {c["name"] for c in inspector.get_columns("operators")}
    assert {"mfa_enabled", "mfa_secret_ciphertext", "mfa_recovery_codes", "mfa_last_step"} <= columns
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT mfa_enabled FROM operators WHERE id = 1")).scalar() in (0, False)


def test_downgrade_restores_the_previous_schema():
    engine = _engine_with_operator()
    _run(engine, "upgrade")
    _run(engine, "downgrade")
    inspector = sa.inspect(engine)
    assert "operator_sessions" not in inspector.get_table_names()
    assert "mfa_enabled" not in {c["name"] for c in inspector.get_columns("operators")}
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT username FROM operators WHERE id = 1")).scalar() == "alice"
