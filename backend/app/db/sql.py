"""SQL building blocks shared by repositories and services."""
from typing import Iterable

from sqlalchemy import Integer, any_, bindparam
from sqlalchemy.dialects.postgresql import ARRAY


def id_in(column, ids: Iterable[int], dialect_name: str):
    """`column IN ids`, as one array parameter on PostgreSQL.

    An IN list renders one placeholder per id, so every list length is a new
    statement: the quick counts alone left 6,918 near-identical entries in
    pg_stat_statements (a 356 MB text file on a nearly full disk) and each
    length is planned afresh. `column = ANY($1)` is one statement whatever the
    length, and uses the same index. SQLite (tests) keeps the IN list.
    """
    ids = list(ids)
    if dialect_name == "postgresql":
        return column == any_(bindparam(None, ids, type_=ARRAY(Integer)))
    return column.in_(ids)
