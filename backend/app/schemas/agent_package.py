from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AgentPackagePlatform(str, Enum):
    WINDOWS_AMD64 = "windows-amd64"
    WINDOWS_ARM64 = "windows-arm64"
    LINUX_AMD64 = "linux-amd64"
    DARWIN_ARM64 = "darwin-arm64"


class AgentPackageOut(BaseModel):
    id: str
    version: str
    platform: AgentPackagePlatform
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
