import json
import logging
import os
import secrets
from typing import Annotated, Any, List

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode


def _string_list(value: Any) -> Any:
    """A list setting from the environment, either JSON (`["a","b"]`) or
    comma-separated (`a,b`). NoDecode on the field stops pydantic-settings
    from insisting on JSON — with it, `MFA_REQUIRED_ROLES=owner,admin`
    failed settings parsing and the backend would not start."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text.startswith("["):
        return json.loads(text)
    return [item.strip() for item in text.split(",") if item.strip()]


class Settings(BaseSettings):
    PROJECT_NAME: str = "TECHI Connect"
    PROJECT_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEV_ALLOW_RANDOM_SECRET: bool = False
    API_PREFIX: str = "/api/v1"
    PUBLIC_BACKEND_URL: str = "https://api-rdp.techi.com.al"
    # Timezone for human-readable times (reports). Storage and APIs stay UTC.
    DISPLAY_TIMEZONE: str = "Europe/Tirane"
    # Host backup folder, mounted read-only for the System status panel.
    BACKUP_DIR: str = "/backups"
    BACKEND_CORS_ORIGINS: Annotated[List[str], NoDecode] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    # Set to true for LAN / real-device testing to allow all origins.
    # Never enable in production without a strict BACKEND_CORS_ORIGINS list.
    BACKEND_CORS_ALLOW_ALL: bool = False

    DATABASE_URL: str = "sqlite:///./techi.db"  # Use SQLite for local development

    SECRET_KEY: str = ""
    # Server-side limits on every request connection (PostgreSQL). Maintenance
    # work — nightly cleanup, VACUUM, reports — uses a separate engine
    # without the statement limit (app/db/session.py).
    DB_STATEMENT_TIMEOUT_MS: int = 60_000
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int = 120_000
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    # Browser sessions (HttpOnly cookies). The access token is short and is
    # renewed by a rotating refresh token; the session itself ends after
    # SESSION_MAX_HOURS no matter what, and after SESSION_IDLE_MINUTES with
    # no refresh (a closed laptop, an abandoned tab).
    SESSION_ACCESS_MINUTES: int = 15
    SESSION_IDLE_MINUTES: int = 120
    SESSION_MAX_HOURS: int = 12
    # False only for a plain-http dev setup that is not localhost.
    SESSION_COOKIE_SECURE: bool = True
    # Comma-separated roles that must use two-factor authentication, e.g.
    # "owner,admin". Empty = MFA is optional for everyone.
    MFA_REQUIRED_ROLES: Annotated[List[str], NoDecode] = []
    MFA_ISSUER: str = "TECHI Connect"
    BOOTSTRAP_OWNER_USERNAME: str = "owner"
    BOOTSTRAP_OWNER_EMAIL: str = "owner@localhost"
    BOOTSTRAP_OWNER_PASSWORD: str = ""
    HEARTBEAT_TIMEOUT_SECONDS: int = 300
    RECONCILIATION_INTERVAL_SECONDS: int = 30
    # Heartbeats handled at once (side effects included) before new ones get
    # 503 + Retry-After; keeps the queue shorter than the agents' 10 s timeout.
    HEARTBEAT_MAX_IN_FLIGHT: int = 24
    # After a start, agents reconnect their command channel within ~65 s;
    # reconciling before that marks connected devices offline and back.
    RECONCILIATION_STARTUP_GRACE_SECONDS: int = 150
    RECONCILIATION_BATCH_SIZE: int = 500
    STALE_DEVICE_CLEANUP_DAYS: int = 0
    # Offline alerts (app/services/offline_alerts.py). Always-on devices
    # (servers, network, storage, hypervisors) alert around the clock once out
    # of contact this long; workstations only when contact is lost inside
    # working hours and stays lost this long; any device unseen for
    # OFFLINE_ALERT_ABSENT_DAYS (0 = never) raises one warning.
    OFFLINE_ALERT_ALWAYS_ON_MINUTES: int = 10
    # 120 min: measured on production 6–9 Oct, 30 min would still raise ~185
    # warnings a workday (lunch, leaving early, laptops); 120 min ~40.
    OFFLINE_ALERT_WORKSTATION_MINUTES: int = 120
    OFFLINE_ALERT_ABSENT_DAYS: int = 7
    # Working hours in DISPLAY_TIMEZONE: ISO weekdays (1 = Monday) and HH:MM.
    WORK_DAYS: Annotated[List[int], NoDecode] = [1, 2, 3, 4, 5]
    WORK_START: str = "08:00"
    WORK_END: str = "17:00"
    AGENT_PACKAGE_STORAGE_DIR: str = "agent_packages"
    RUSTDESK_SERVER_HOST: str = "139.162.158.208"
    RUSTDESK_RELAY_HOST: str = "139.162.158.208"
    RUSTDESK_PUBLIC_KEY: str = "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw="
    # The legacy fleet-wide Remote Support password, still held by agents
    # older than 2.1.5 until they update. Set only in the server's .env, never
    # in code or in any script: it was public and is treated as compromised.
    RUSTDESK_DEFAULT_PASSWORD: str = ""
    # Per-device Remote Support passwords are replaced this often at the
    # nightly run (0 = never); "rotate all" in Settings does it at once.
    REMOTE_SUPPORT_PASSWORD_ROTATION_DAYS: int = 30
    # At most this many per night, oldest first, so a rotation never touches
    # the whole fleet at once (the first cycle spreads over several nights).
    REMOTE_SUPPORT_PASSWORD_ROTATION_PER_NIGHT: int = 150
    RUSTDESK_DEEP_LINK_PASSWORD_ENABLED: bool = True
    RUSTDESK_SERVER_DB_PATH: str = ""
    RUSTDESK_RESOLVER_ENABLED: bool = False
    TRUSTED_DOMAIN_AUTO_ENROLLMENT: bool = False
    TRUSTED_DOMAIN_ALLOWLIST: str = ""  # comma-separated domains; empty = any non-WORKGROUP domain
    INTERNAL_BOOTSTRAP_TOKEN_EXPIRES_HOURS: int = 24
    DEFAULT_DEPLOYMENT_TOKEN_ENABLED: bool = True
    DEFAULT_DEPLOYMENT_TOKEN_MAX_USES: int = 500
    DEFAULT_DEPLOYMENT_TOKEN_EXPIRES_DAYS: int = 0

    # Enterprise Credential Vault (Phase 4). Key lives OUTSIDE repo/DB; in the
    # backend container "data/" is the backend_data volume (same as agent_policy).
    VAULT_MASTER_KEY_FILE: str = "data/vault_master.key"

    # Platform Expansion feature flags (docs/reference/PLATFORM-EXPANSION-AUDIT.md §11).
    # Default OFF. Contract: any flag OFF ⇒ behavior bit-identical to production.
    FEATURE_PLATFORM_CORE: bool = False
    FEATURE_LINUX: bool = False
    FEATURE_VAULT: bool = False
    FEATURE_TERMINAL: bool = False
    # Embedded SSH. OFF by design, not by oversight: the feature dials the
    # device from the backend (terminal.py, host = local_ip or public_ip),
    # which no NAT'd endpoint can satisfy — it always timed out, and the
    # public_ip fallback would mean exposing port 22 on customer servers.
    # Turn ON only for devices the platform can route to directly, or once
    # SSH is carried over the agent tunnel. See RISK-SSH-001.
    FEATURE_SSH: bool = False
    FEATURE_MIKROTIK: bool = False
    FEATURE_STORAGE: bool = False
    FEATURE_HYPERVISOR: bool = False
    FEATURE_NOTIFICATIONS: bool = False
    FEATURE_REPORTING: bool = False

    # Generated client reports live in backend_data (persistent Docker volume).
    REPORT_STORAGE_DIR: str = "data/reports"
    REPORT_RETENTION_DAYS: int = 365

    # SMTP secrets and webhook shared secrets on notification channels are
    # encrypted with the same AES-256-GCM cipher/master key as the
    # Credential Vault (app/core/vault_cipher.py) — no separate key material.

    # Generic rollout scoping (see the "rollout" module under the platform
    # expansion package) — narrows a fleet-wide FEATURE_* flag to a subset of
    # the fleet for staged enablement. Reusable by any feature; Web Terminal
    # is the first consumer. Default scope "none" = nobody, even if the flag
    # is ON (fail closed).
    FEATURE_TERMINAL_SCOPE: str = "none"
    FEATURE_TERMINAL_ALLOWED_DEVICE_IDS: str = ""
    FEATURE_TERMINAL_ALLOWED_GROUPS: str = ""
    FEATURE_TERMINAL_ALLOWED_CLIENTS: str = ""

    @model_validator(mode="before")
    @classmethod
    def resolve_secret_key(cls, data: Any) -> Any:
        raw = data if isinstance(data, dict) else {}
        explicit = (
            os.environ.get("JWT_SECRET", "").strip()
            or os.environ.get("SECRET_KEY", "").strip()
            or str(raw.get("SECRET_KEY", "")).strip()
        )
        environment = (
            os.environ.get("ENVIRONMENT", "").strip()
            or str(raw.get("ENVIRONMENT", "development"))
        ).lower()
        allow_random = (
            os.environ.get("DEV_ALLOW_RANDOM_SECRET", "").lower() in ("true", "1", "yes")
            or str(raw.get("DEV_ALLOW_RANDOM_SECRET", "false")).lower() in ("true", "1", "yes")
        )

        if explicit:
            if isinstance(data, dict):
                data["SECRET_KEY"] = explicit
            return data

        if environment == "development" or allow_random:
            logging.getLogger("techi.config").warning(
                "JWT_SECRET not configured — using ephemeral random secret (sessions will reset on restart)"
            )
            if isinstance(data, dict):
                data["SECRET_KEY"] = secrets.token_urlsafe(32)
            return data

        raise ValueError(
            "JWT_SECRET must be explicitly set in production. "
            "Set the JWT_SECRET environment variable, or set DEV_ALLOW_RANDOM_SECRET=true for development."
        )

    @field_validator("MFA_REQUIRED_ROLES", mode="before")
    @classmethod
    def assemble_mfa_roles(cls, value):
        roles = _string_list(value)
        return [str(role).strip().lower() for role in roles] if isinstance(roles, list) else roles

    @field_validator("WORK_DAYS", mode="before")
    @classmethod
    def assemble_work_days(cls, value):
        days = _string_list(value)
        return [int(day) for day in days] if isinstance(days, list) else days

    @field_validator("WORK_START", "WORK_END")
    @classmethod
    def check_clock_time(cls, value: str) -> str:
        hours, _, minutes = value.partition(":")
        if not (hours.isdigit() and minutes.isdigit() and 0 <= int(hours) <= 23 and 0 <= int(minutes) <= 59):
            raise ValueError("expected HH:MM, e.g. 08:00")
        return f"{int(hours):02d}:{int(minutes):02d}"

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, value):
        return _string_list(value)

    class Config:
        env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
        env_file_encoding = "utf-8"


settings = Settings()
