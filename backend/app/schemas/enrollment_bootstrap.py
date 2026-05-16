from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class EnrollmentBootstrapPlatform(str, Enum):
    WINDOWS = "windows"
    MACOS = "macos"
    LINUX = "linux"


class EnrollmentBootstrapMode(str, Enum):
    TOKEN = "token"          # standard token-based enrollment
    GPO = "gpo"              # trusted domain / GPO deployment (no token required)


class EnrollmentBootstrapRequest(BaseModel):
    mode: EnrollmentBootstrapMode = EnrollmentBootstrapMode.TOKEN
    enrollment_token_id: Optional[int] = Field(default=None, ge=1)
    backend_url: str = Field(min_length=8, max_length=512)
    platform: EnrollmentBootstrapPlatform
    enrollment_token: Optional[str] = Field(default=None, min_length=16, max_length=256)

    # RustDesk self-healing fields — embedded in GPO config (optional)
    rustdesk_manage_enabled: bool = False
    rustdesk_msi_url: str = ""
    rustdesk_rendezvous_server: str = ""
    rustdesk_relay_server: str = ""
    rustdesk_api_server: str = ""
    rustdesk_key: str = ""
    rustdesk_default_password: str = ""


class EnrollmentBootstrapResponse(BaseModel):
    mode: EnrollmentBootstrapMode = EnrollmentBootstrapMode.TOKEN
    enrollment_token_id: Optional[int] = None
    platform: EnrollmentBootstrapPlatform
    backend_url: str
    bootstrap_command: str
    bootstrap_script: str
    config_template: str
    preproduction_notice: str
