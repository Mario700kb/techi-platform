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


class AvailabilityProfile(str, Enum):
    SERVER = "server"          # prevent sleep + hibernate on AC; lock allowed
    WORKSTATION = "workstation"  # configurable sleep; lock always allowed
    CUSTOM = "custom"          # caller controls all flags explicitly


class EnrollmentBootstrapRequest(BaseModel):
    mode: EnrollmentBootstrapMode = EnrollmentBootstrapMode.TOKEN
    enrollment_token_id: Optional[int] = Field(default=None, ge=1)
    backend_url: str = Field(min_length=8, max_length=512)
    platform: EnrollmentBootstrapPlatform
    enrollment_token: Optional[str] = Field(default=None, min_length=16, max_length=256)

    # RustDesk self-healing fields — embedded in agent config (Windows only)
    rustdesk_manage_enabled: bool = False
    rustdesk_msi_url: str = ""
    rustdesk_msi_checksum_sha256: str = ""
    rustdesk_package_version: str = ""
    rustdesk_rendezvous_server: str = ""
    rustdesk_relay_server: str = ""
    rustdesk_api_server: str = ""
    rustdesk_key: str = ""
    rustdesk_default_password: str = ""

    # Availability / power profile — embedded in agent config (Windows only).
    # Lock screen is NEVER disabled regardless of profile.
    availability_profile: AvailabilityProfile = AvailabilityProfile.WORKSTATION
    manage_power_policy: bool = False
    prevent_sleep_on_ac: bool = False
    prevent_hibernate: bool = False
    allow_display_off_on_ac: bool = True


class EnrollmentBootstrapResponse(BaseModel):
    mode: EnrollmentBootstrapMode = EnrollmentBootstrapMode.TOKEN
    enrollment_token_id: Optional[int] = None
    platform: EnrollmentBootstrapPlatform
    backend_url: str
    bootstrap_command: str
    bootstrap_script: str
    config_template: str
    preproduction_notice: str
    installer_filename: str = ""   # suggested .ps1 filename for download
