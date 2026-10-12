"""pg_stat_statements: per-query execution statistics.

The library is preloaded by the postgres service (docker-compose.yml); the
extension makes its view queryable. Guarded: a database without the
preloaded library, or a role that may not create extensions, skips this
instead of failing the upgrade — the statistics are diagnostic, not data.

Revision ID: b1c2d3e4f5a6
Revises: a9b8c7d6e5f4
"""

from alembic import op

revision = "b1c2d3e4f5a6"
down_revision = "a9b8c7d6e5f4"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(
        """
        DO $$ BEGIN
            CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'pg_stat_statements not created: %', SQLERRM;
        END $$
        """
    )


def downgrade():
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP EXTENSION IF EXISTS pg_stat_statements")
