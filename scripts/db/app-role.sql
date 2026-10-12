-- Least-privilege role for the TECHI backend (RISK: the app connected as the
-- cluster superuser `techi`, so any SQL injection or bug had full control of
-- PostgreSQL — files, programs, every database, every role).
--
-- techi_app owns the application's tables and sequences (so migrations and
-- the nightly VACUUM keep working) but is NOT a superuser: no CREATE ROLE,
-- no CREATE DATABASE, no server-side file or program access, no other
-- databases. `techi` stays the superuser for backups (pg_dumpall) and
-- administration only.
--
-- Idempotent. Run as the superuser, against the application database:
--   docker exec -i techi-platform-postgres-1 psql -U techi -d techi \
--     -v ON_ERROR_STOP=1 -v app_password="'<new password>'" < scripts/db/app-role.sql
-- then set DATABASE_URL in .env to techi_app with that password.
-- Rollback: point DATABASE_URL back at techi (ownership needs no change).

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'techi_app') THEN
        CREATE ROLE techi_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;

ALTER ROLE techi_app PASSWORD :app_password;
-- Same server-side limits the backend sets per connection, as a backstop
-- for anything that connects as this role without them (psql, scripts).
ALTER ROLE techi_app SET idle_in_transaction_session_timeout = '5min';

DO $$ BEGIN
    EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO techi_app', current_database());
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO techi_app;
-- Read pg_stat_statements / pg_stat_activity for every role, not only its own.
GRANT pg_read_all_stats TO techi_app;

-- Hand over ownership of every application object in public that the
-- superuser owns. Extension members (pg_stat_statements' views) stay put.
DO $$
DECLARE
    obj record;
BEGIN
    FOR obj IN
        SELECT c.oid, c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
          AND pg_get_userbyid(c.relowner) = 'techi'
          AND NOT EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )
          -- Sequences owned by a column move with their table.
          AND NOT (c.relkind = 'S' AND EXISTS (
              SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i')
          ))
    LOOP
        EXECUTE format(
            'ALTER %s %I OWNER TO techi_app',
            CASE obj.relkind
                WHEN 'S' THEN 'SEQUENCE'
                WHEN 'v' THEN 'VIEW'
                WHEN 'm' THEN 'MATERIALIZED VIEW'
                ELSE 'TABLE'
            END,
            obj.relname
        );
    END LOOP;
END $$;

-- Report: what the role can and cannot do, and anything still owned by techi.
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'techi_app';
SELECT count(*) AS objects_still_owned_by_techi
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) = 'techi'
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
