"""Regression: the Linux package chain — upload validation accepts raw .bin
binaries, and package resolution returns Windows→MSI / Linux→agent binary
without ambiguity. Windows validation is unchanged.
"""
import io

import pytest

from app.core.config import settings
from app.services.agent_package_service import AgentPackageService


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "AGENT_PACKAGE_STORAGE_DIR", str(tmp_path))
    return AgentPackageService()


def _upload(svc, *, filename, platform, file_type, version="2.1.5", data=b"x", build_version=None):
    if build_version is None and platform == "darwin-arm64":
        build_version = "148.2"
    return svc.upload(
        version=version, platform=platform, filename=filename,
        uploaded_by="tester", stream=io.BytesIO(data), file_type=file_type,
        build_version=build_version or "",
    )


def test_upload_accepts_raw_linux_bin(svc):
    pkg = _upload(svc, filename="techi-agent-linux-amd64.bin",
                  platform="linux-amd64", file_type="agent_binary")
    assert pkg.filename == "techi-agent-linux-amd64.bin"


def test_upload_still_accepts_windows_msi_and_exe(svc):
    # Windows validation unchanged.
    _upload(svc, filename="techi-agent.msi", platform="windows-amd64", file_type="msi")
    _upload(svc, filename="techi-agent.exe", platform="windows-amd64", file_type="agent_binary")


def test_remote_support_msi_version_is_canonical_from_filename(svc):
    pkg = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.6.msi",
        platform="windows-amd64",
        file_type="remote_support_msi",
        version="1.4.6",
    )

    assert pkg.version == "1.4.6"
    assert pkg.filename == "TECHI-Remote-Support-1.4.6.msi"


def test_remote_support_msi_upload_rejects_agent_version_contamination(svc):
    with pytest.raises(ValueError, match="Remote Support MSI version must match filename"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.6.msi",
            platform="windows-amd64",
            file_type="remote_support_msi",
            version="2.1.8",
        )


def test_macos_remote_support_dmg_version_is_canonical(svc):
    pkg = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.8-darwin-arm64.dmg",
        platform="darwin-arm64",
        file_type="remote_support_dmg",
        version="1.4.8",
    )

    assert pkg.version == "1.4.8"
    assert pkg.build_version == "148.2"
    assert pkg.platform.value == "darwin-arm64"


def test_macos_remote_support_pkg_version_and_build_are_canonical(svc):
    pkg = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.8-darwin-arm64.pkg",
        platform="darwin-arm64",
        file_type="remote_support_pkg",
        version="1.4.8",
        build_version="148.2",
    )

    assert pkg.version == "1.4.8"
    assert pkg.build_version == "148.2"


def test_macos_remote_support_requires_build_and_rejects_reused_build_bytes(svc):
    with pytest.raises(ValueError, match="numeric internal build version"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.8-darwin-arm64.pkg",
            platform="darwin-arm64",
            file_type="remote_support_pkg",
            version="1.4.8",
            build_version="",
        )

    first = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.8-darwin-arm64.pkg",
        platform="darwin-arm64",
        file_type="remote_support_pkg",
        version="1.4.8",
        build_version="148.2",
        data=b"first",
    )
    assert first.sha256
    with pytest.raises(ValueError, match="Different package bytes"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.8-darwin-arm64.pkg",
            platform="darwin-arm64",
            file_type="remote_support_pkg",
            version="1.4.8",
            build_version="148.2",
            data=b"second",
        )


def test_macos_remote_support_dmg_rejects_malformed_identity(svc):
    with pytest.raises(ValueError, match="macOS Remote Support filename"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.8.dmg",
            platform="darwin-arm64",
            file_type="remote_support_dmg",
            version="1.4.8",
        )

    with pytest.raises(ValueError, match="macOS Remote Support version must match filename"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.8-darwin-arm64.dmg",
            platform="darwin-arm64",
            file_type="remote_support_dmg",
            version="2.1.12",
        )

    with pytest.raises(ValueError, match="requires darwin-arm64"):
        _upload(
            svc,
            filename="TECHI-Remote-Support-1.4.8-darwin-arm64.dmg",
            platform="windows-amd64",
            file_type="remote_support_dmg",
            version="1.4.8",
        )


def test_existing_remote_support_manifest_entry_reads_version_from_filename(svc):
    """ADPASCUCCI regression: manifest had version=2.1.8 but RS MSI filename=1.4.6."""
    svc._write_manifest(
        [
            {
                "id": "remote-support-prod",
                "version": "2.1.8",
                "platform": "windows-amd64",
                "file_type": "remote_support_msi",
                "filename": "TECHI-Remote-Support-1.4.6.msi",
                "uploaded_at": "2026-07-11T23:15:07.698459+00:00",
                "uploaded_by": "tester",
                "is_active": True,
                "sha256": "cbc4c8828ece949510fbc7f6f6b754c8a7e393a5bdf658ba50ec0fe2c7b51253",
            }
        ]
    )

    active = svc.latest_active("windows-amd64", file_type="remote_support_msi")
    assert active is not None
    assert active.version == "1.4.6"
    assert active.filename == "TECHI-Remote-Support-1.4.6.msi"


def test_upload_rejects_unknown_extension(svc):
    with pytest.raises(ValueError, match="Unsupported package file extension"):
        _upload(svc, filename="notes.txt", platform="linux-amd64", file_type="agent_binary")


def test_resolution_windows_msi_linux_binary_unambiguous(svc):
    # Windows MSI active, Linux binary active — each platform resolves to its own.
    win = _upload(svc, filename="techi-agent.msi", platform="windows-amd64", file_type="msi")
    lin = _upload(svc, filename="techi-agent-linux-amd64.bin",
                  platform="linux-amd64", file_type="agent_binary")
    svc.set_active(win.id, True)
    svc.set_active(lin.id, True)

    assert svc.latest_active("windows-amd64", file_type="msi").id == win.id
    assert svc.latest_active("linux-amd64", file_type="agent_binary").id == lin.id
    # No cross-contamination: no MSI for linux, no agent_binary MSI for windows.
    assert svc.latest_active("linux-amd64", file_type="msi") is None
    assert svc.latest_active("windows-amd64", file_type="agent_binary") is None


def test_active_selection_is_exclusive_per_platform_and_type(svc):
    first = _upload(svc, filename="techi-agent-linux-amd64.bin",
                    platform="linux-amd64", file_type="agent_binary", version="2.1.4")
    second = _upload(svc, filename="techi-agent-linux-amd64.bin",
                     platform="linux-amd64", file_type="agent_binary", version="2.1.5")
    svc.set_active(first.id, True)
    svc.set_active(second.id, True)  # activating second must deactivate first

    active = svc.latest_active("linux-amd64", file_type="agent_binary")
    assert active.id == second.id
    ids = {p.id for p in svc.list_packages(include_inactive=False) if p.platform.value == "linux-amd64"}
    assert first.id not in ids and second.id in ids
