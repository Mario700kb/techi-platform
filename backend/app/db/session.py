import logging
from typing import Optional

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

logger = logging.getLogger("techi.db")


def engine_kwargs(url: str, *, statement_timeout_ms: Optional[int], pool_size: int, max_overflow: int) -> dict:
    """Connection settings for one engine.

    On PostgreSQL every connection gets server-side limits: a statement that
    runs past `statement_timeout_ms` is cancelled, and a session that sits
    idle inside an open transaction (holding locks and a snapshot that stops
    VACUUM) is ended. Without them one stuck query or forgotten transaction
    could hold the database indefinitely. `None` leaves statements unbounded,
    for maintenance work (nightly cleanup, VACUUM, reports).
    """
    kwargs: dict = {"future": True, "pool_pre_ping": True}
    if url.startswith("sqlite"):
        # SQLite: disable same-thread check (FastAPI uses multiple threads via
        # thread-pool executor for sync endpoints) and keep a single connection.
        kwargs["connect_args"] = {"check_same_thread": False}
        return kwargs

    options = [f"-c idle_in_transaction_session_timeout={settings.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS}"]
    if statement_timeout_ms:
        options.append(f"-c statement_timeout={statement_timeout_ms}")
    kwargs.update(
        {
            "pool_size": pool_size,
            "max_overflow": max_overflow,
            "pool_timeout": 30,
            "pool_recycle": 1800,
            "connect_args": {"options": " ".join(options), "application_name": "techi-backend"},
        }
    )
    return kwargs


def _build_engine(*, statement_timeout_ms: Optional[int], pool_size: int, max_overflow: int):
    url = settings.DATABASE_URL
    engine = create_engine(
        url, **engine_kwargs(url, statement_timeout_ms=statement_timeout_ms, pool_size=pool_size, max_overflow=max_overflow)
    )

    if url.startswith("sqlite"):
        # Enable WAL mode so concurrent readers don't block writes.
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


engine = _build_engine(statement_timeout_ms=settings.DB_STATEMENT_TIMEOUT_MS, pool_size=30, max_overflow=50)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)

# Long-running maintenance (nightly cleanup with VACUUM, report generation):
# same database, no statement timeout, a small pool of its own so it never
# competes with request handling for connections.
maintenance_engine = (
    engine
    if settings.DATABASE_URL.startswith("sqlite")
    else _build_engine(statement_timeout_ms=None, pool_size=2, max_overflow=2)
)
MaintenanceSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=maintenance_engine, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
