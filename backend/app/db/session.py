import logging

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

logger = logging.getLogger("techi.sql.enrollment_tokens")


def _build_engine():
    url = settings.DATABASE_URL
    kwargs = {"future": True, "pool_pre_ping": True}

    if url.startswith("sqlite"):
        # SQLite: disable same-thread check (FastAPI uses multiple threads via
        # thread-pool executor for sync endpoints) and keep a single connection.
        kwargs["connect_args"] = {"check_same_thread": False}

    engine = create_engine(url, **kwargs)

    if url.startswith("sqlite"):
        # Enable WAL mode so concurrent readers don't block writes.
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_conn, _record):
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    @event.listens_for(engine, "before_cursor_execute")
    def _log_enrollment_token_sql(_conn, _cursor, statement, parameters, _context, _executemany):
        if "enrollment_tokens" in statement:
            logger.warning("enrollment_tokens SQL: %s | params=%r", statement, parameters)

    return engine


engine = _build_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, future=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
