from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AgentPackagePlatform(str, Enum):
    WINDOWS = "windows"
    WINDOWS_AMD64 = "windows-amd64"
    WINDOWS_ARM64 = "windows-arm64"
    LINUX_AMD64 = "linux-amd64"
    LINUX_ARM64 = "linux-arm64"
    LINUX_ARMHF = "linux-armhf"
    DARWIN_ARM64 = "darwin-arm64"


class AgentFileType(str, Enum):
    # Combined full-bootstrap MSI (agent + TECHI Remote Support). Served to
    # GPO/NETLOGON bootstrap flows; historical entries without file_type are
    # read as this.
    MSI = "msi"
    # Standalone techi-agent.exe used by binary-swap self_update (>= 2.1.1).
    AGENT_BINARY = "agent_binary"
    # Agent Update Bridge MSI (agent only, no Remote Support). Served to
    # legacy msiexec-based agents (< 2.1.1) for UI self_update, so routine
    # agent upgrades never reinstall Remote Support.
    AGENT_UPDATE_MSI = "agent_update_msi"


class AgentPackageOut(BaseModel):
    id: str
    version: str
    platform: AgentPackagePlatform
    file_type: AgentFileType = AgentFileType.MSI
    filename: str
    uploaded_at: datetime
    uploaded_by: Optional[str] = None
    is_active: bool = False
    download_url: str
    sha256: Optional[str] = None


class AgentPackageUploadResponse(BaseModel):
    package: AgentPackageOut


class AgentPackageActivationRequest(BaseModel):
    is_active: bool = Field(default=True)
