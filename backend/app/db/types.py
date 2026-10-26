import json
from typing import Any, Optional

from sqlalchemy import Text
from sqlalchemy.types import TypeDecorator


class JSONBText(TypeDecorator):
    """A JSON document the code reads and writes as text (json.dumps /
    json.loads), stored as jsonb on PostgreSQL so it can be queried and
    indexed (e.g. which devices have an app installed).

    Text goes in as it is (psycopg sends it untyped, so PostgreSQL parses it
    into jsonb); psycopg hands jsonb back parsed, so it is turned back into
    text. Works on a text column too, so code and migration can ship in either
    order."""

    impl = Text
    cache_ok = True

    def process_result_value(self, value: Any, dialect) -> Optional[str]:
        if value is None or isinstance(value, str):
            return value
        return json.dumps(value)
