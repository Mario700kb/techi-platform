import logging
import os
import secrets
from typing import Any, List

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "TECHI Platform"
    PROJECT_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEV_ALLOW_RANDOM_SECRET: bool = False
    API_PREFIX: str = "/api/v1"
    PUBLIC_BACKEND_URL: str = "https://api-rdp.techi.com.al"
    BACKEND_CORS_ORIGINS: List[str] = [
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
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    BOOTSTRAP_OWNER_USERNAME: str = "owner"
    BOOTSTRAP_OWNER_EMAIL: str = "owner@localhost"
    BOOTSTRAP_OWNER_PASSWORD: str = ""
    HEARTBEAT_TIMEOUT_SECONDS: int = 300
    RECONCILIATION_INTERVAL_SECONDS: int = 30
    RECONCILIATION_BATCH_SIZE: int = 500
    STALE_DEVICE_CLEANUP_DAYS: int = 0
    AGENT_PACKAGE_STORAGE_DIR: str = "agent_packages"
    RUSTDESK_SERVER_HOST: str = "139.162.158.208"
    RUSTDESK_RELAY_HOST: str = "139.162.158.208"
    RUSTDESK_PUBLIC_KEY: str = "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw="
    RUSTDESK_DEFAULT_PASSWORD: str = "Durres.12"
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
    FEATURE_MIKROTIK: bool = False
    FEATURE_STORAGE: bool = False
    FEATURE_HYPERVISOR: bool = False

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

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, value):
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    class Config:
        env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
        env_file_encoding = "utf-8"


settings = Settings()
