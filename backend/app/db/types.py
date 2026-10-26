import json
from typing import Any, Optional

from sqlalchemy import Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import TypeDecorator


class JSONBText(TypeDecorator):
    """A JSON document the code reads and writes as text (json.dumps /
    json.loads), stored as jsonb on PostgreSQL so it can be queried and
    indexed (e.g. which devices have an app installed); Text elsewhere.

    On PostgreSQL the text is parsed and bound as jsonb, and the jsonb psycopg
    hands back parsed is turned back into text."""

    impl = Text
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(JSONB() if dialect.name == "postgresql" else Text())

    def process_bind_param(self, value: Optional[str], dialect) -> Any:
        if dialect.name == "postgresql" and isinstance(value, str):
            return json.loads(value)
        return value

    def process_result_value(self, value: Any, dialect) -> Optional[str]:
        if value is None or isinstance(value, str):
            return value
        return json.dumps(value)
