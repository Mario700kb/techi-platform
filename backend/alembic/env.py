import os
import sys

from logging.config import fileConfig

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings
from app.db.base import Base
# Registers every model on Base.metadata so `alembic revision --autogenerate`
# sees the whole schema. Imported for that side effect only.
import app.models  # noqa: F401

# this is the Alembic Config object, which provides access to the values within the .ini file in use.
config = context.config
fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", str(settings.DATABASE_URL))

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # A migration that cannot get its lock within 10 s fails instead of
    # queueing every heartbeat behind it (devices is written constantly). Set
    # per connection: a SET statement here would open the transaction that
    # autocommit_block() migrations expect alembic to own.
    url = config.get_main_option("sqlalchemy.url") or ""
    extra = {"connect_args": {"options": "-c lock_timeout=10s"}} if url.startswith("postgresql") else {}
    connectable = engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        **extra,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
