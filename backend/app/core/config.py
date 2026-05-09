import os
from typing import List

from pydantic_settings import BaseSettings
from pydantic import PostgresDsn, validator


class Settings(BaseSettings):
    PROJECT_NAME: str = "TECHI Platform"
    PROJECT_VERSION: str = "0.1.0"
    ENVIRONMENT: str = "development"
    API_PREFIX: str = "/api/v1"
    BACKEND_CORS_ORIGINS: List[str] = ["http://localhost:5173"]

    DATABASE_URL: str = "sqlite:///./techi.db"  # Use SQLite for local development

    SECRET_KEY: str = "please-change-this-secret"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    @validator("BACKEND_CORS_ORIGINS", pre=True)
    def assemble_cors_origins(cls, value):
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    class Config:
        env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
        env_file_encoding = "utf-8"


settings = Settings()
