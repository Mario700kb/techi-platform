from datetime import datetime
from enum import Enum
from typing import Any, Optional

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
    # Agent-only bootstrap/repair MSI. Historical entries without file_type are
    # read as this, but current Windows deployment treats it as Agent-only.
    MSI = "msi"
    # Standalone techi-agent.exe used by binary-swap self_update (>= 2.1.1).
    AGENT_BINARY = "agent_binary"
    # Agent Update Bridge MSI (agent only, no Remote Support). Served to
    # legacy msiexec-based agents (< 2.1.1) for UI self_update, so routine
    # agent upgrades never reinstall Remote Support.
    AGENT_UPDATE_MSI = "agent_update_msi"
    # TECHI Remote Support MSI, versioned/deployed independently from Agent.
    # Reserved for FIRST-INSTALL fallback only — never the recovery payload.
    REMOTE_SUPPORT_MSI = "remote_support_msi"
    # macOS TECHI Remote Support application bundle distributed as a DMG.
    REMOTE_SUPPORT_DMG = "remote_support_dmg"
    # Recommended macOS TECHI Remote Support updater package.
    REMOTE_SUPPORT_PKG = "remote_support_pkg"
    # TECHI Remote Support native bundle (deterministic .zip) consumed by
    # techi-bootstrap.exe repair-remote-support. This is the recovery payload;
    # the MSI is not. Filename: TECHI-Remote-Support-<version>-windows-amd64.zip.
    REMOTE_SUPPORT_BUNDLE = "remote_support_bundle"


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
    build_version: Optional[str] = None
    manifest_filename: Optional[str] = None
    manifest_sha256: Optional[str] = None
    bundle_metadata: Optional[dict[str, Any]] = None


class AgentPackageUploadResponse(BaseModel):
    package: AgentPackageOut


class AgentPackageActivationRequest(BaseModel):
    is_active: bool = Field(default=True)
