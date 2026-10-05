"""hour_utc -> hour_local keeps every existing schedule's next run unchanged."""
import importlib.util
from datetime import datetime
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "e1f2a3b4c5d6_report_schedule_hour_local.py"


def _migration():
    spec = importlib.util.spec_from_file_location("hour_local_migration", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _engine_with_schedules(rows):
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(sa.text(
            "CREATE TABLE report_schedules (id INTEGER PRIMARY KEY, cadence VARCHAR(16) NOT NULL, "
            "hour_utc INTEGER NOT NULL, day_of_week INTEGER, day_of_month INTEGER, next_run_at DATETIME NOT NULL)"
        ))
        for row in rows:
            conn.execute(sa.text(
                "INSERT INTO report_schedules VALUES (:id, :cadence, :hour, :dow, :dom, :next_run_at)"
            ), row)
    return engine


def _run(engine, step):
    with engine.begin() as conn:
        with Operations.context(MigrationContext.configure(conn)):
            getattr(_migration(), step)()


def _schedules(engine, hour_column):
    with engine.connect() as conn:
        return {
            r.id: r for r in conn.execute(sa.text(
                f"SELECT id, {hour_column} AS hour, day_of_week, day_of_month FROM report_schedules"
            ))
        }


ROWS = [
    # daily 06:00 UTC in summer -> 08:00 Tirana
    {"id": 1, "cadence": "daily", "hour": 6, "dow": None, "dom": None, "next_run_at": datetime(2026, 10, 6, 6, 0)},
    # weekly Sunday 23:00 UTC -> Monday 01:00 Tirana (day moves with it)
    {"id": 2, "cadence": "weekly", "hour": 23, "dow": 6, "dom": None, "next_run_at": datetime(2026, 10, 11, 23, 0)},
    # monthly 1st 06:00 UTC in winter -> 07:00 Tirana
    {"id": 3, "cadence": "monthly", "hour": 6, "dow": None, "dom": 1, "next_run_at": datetime(2026, 12, 1, 6, 0)},
]


def test_upgrade_converts_each_schedule_from_its_next_run():
    engine = _engine_with_schedules(ROWS)
    _run(engine, "upgrade")
    rows = _schedules(engine, "hour_local")

    assert rows[1].hour == 8
    assert (rows[2].hour, rows[2].day_of_week) == (1, 0)
    assert (rows[3].hour, rows[3].day_of_month) == (7, 1)


def test_downgrade_restores_utc_hours():
    engine = _engine_with_schedules(ROWS)
    _run(engine, "upgrade")
    _run(engine, "downgrade")
    rows = _schedules(engine, "hour_utc")

    assert rows[1].hour == 6
    assert (rows[2].hour, rows[2].day_of_week) == (23, 6)
    assert (rows[3].hour, rows[3].day_of_month) == (6, 1)
