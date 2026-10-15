"""id_in: one statement whatever the number of ids on PostgreSQL, so
pg_stat_statements keeps one entry instead of one per list length."""
from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite

from app.db.sql import id_in
from app.models.device import Device


def _sql(ids, dialect):
    return str(select(Device.id).where(id_in(Device.id, ids, dialect.name)).compile(dialect=dialect))


def test_postgres_gets_one_array_parameter_whatever_the_length():
    pg = postgresql.dialect()
    three, nine_hundred = _sql([1, 2, 3], pg), _sql(range(900), pg)
    assert "= ANY (" in three
    assert three == nine_hundred
    assert len(three) < 300


def test_other_databases_keep_an_in_list():
    lite = sqlite.dialect()
    assert " IN (" in _sql([1, 2, 3], lite)
