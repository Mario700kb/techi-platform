"""Request connections carry server-side limits; maintenance ones are unbounded."""
from app.core.config import settings
from app.db.session import engine_kwargs

PG = "postgresql+psycopg://techi:x@db/techi"


def test_request_connections_get_statement_and_idle_transaction_limits():
    options = engine_kwargs(PG, statement_timeout_ms=60_000, pool_size=30, max_overflow=50)["connect_args"]["options"]
    assert "-c statement_timeout=60000" in options
    assert f"-c idle_in_transaction_session_timeout={settings.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}" in options


def test_maintenance_connections_have_no_statement_limit_but_keep_the_idle_one():
    options = engine_kwargs(PG, statement_timeout_ms=None, pool_size=2, max_overflow=2)["connect_args"]["options"]
    assert "statement_timeout" not in options
    assert "idle_in_transaction_session_timeout" in options


def test_connections_are_named_for_pg_stat_activity():
    kwargs = engine_kwargs(PG, statement_timeout_ms=60_000, pool_size=30, max_overflow=50)
    assert kwargs["connect_args"]["application_name"] == "techi-backend"


def test_sqlite_gets_no_server_options():
    kwargs = engine_kwargs("sqlite://", statement_timeout_ms=60_000, pool_size=30, max_overflow=50)
    assert kwargs["connect_args"] == {"check_same_thread": False}
