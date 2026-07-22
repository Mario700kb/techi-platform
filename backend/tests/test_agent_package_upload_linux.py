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


def _upload(svc, *, filename, platform, file_type, version="2.1.5", data=b"x"):
    return svc.upload(
        version=version, platform=platform, filename=filename,
        uploaded_by="tester", stream=io.BytesIO(data), file_type=file_type,
    )


def test_upload_accepts_raw_linux_bin(svc):
    pkg = _upload(svc, filename="techi-agent-linux-amd64.bin",
                  platform="linux-amd64", file_type="agent_binary")
    assert pkg.filename == "techi-agent-linux-amd64.bin"


def test_upload_still_accepts_windows_msi_and_exe(svc):
    # Windows validation unchanged.
    _upload(svc, filename="techi-agent.msi", platform="windows-amd64", file_type="msi")
    _upload(svc, filename="techi-agent.exe", platform="windows-amd64", file_type="agent_binary")


def test_remote_support_msi_upload_extracts_real_metadata(svc):
    data = (
        b"PropertyStringPool"
        b"ProductCode{11111111-2222-3333-4444-555555555555}"
        b"ProductLanguage1033"
        b"ProductNameTECHI Remote Support"
        b"ProductVersion1.4.6.0"
        b"UpgradeCode{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"
        b"SecureCustomProperties"
    )
    pkg = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.6.msi",
        platform="windows-amd64",
        file_type="remote_support_msi",
        version="manual-version",
        data=data,
    )

    assert pkg.version == "1.4.6.0"
    assert pkg.product_name == "TECHI Remote Support"
    assert pkg.product_version == "1.4.6.0"
    assert pkg.product_code == "{11111111-2222-3333-4444-555555555555}"
    assert pkg.upgrade_code == "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"
    assert pkg.file_size == len(data)
    assert pkg.sha256
    assert pkg.metadata_status == "ok"
    assert pkg.metadata_error is None


def test_remote_support_msi_activation_refuses_incomplete_metadata(svc):
    pkg = _upload(
        svc,
        filename="TECHI-Remote-Support-1.4.6.msi",
        platform="windows-amd64",
        file_type="remote_support_msi",
        data=b"ProductNameTECHI Remote SupportProductVersion1.4.6.0",
    )

    with pytest.raises(ValueError, match="active Remote Support MSI metadata is incomplete"):
        svc.set_active(pkg.id, True)


def test_remote_support_msi_activation_uses_single_active_per_type(svc):
    data = (
        b"ProductCode{11111111-2222-3333-4444-555555555555}"
        b"ProductNameTECHI Remote Support"
        b"ProductVersion1.4.6.0"
        b"UpgradeCode{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"
        b"SecureCustomProperties"
    )
    first = _upload(svc, filename="TECHI-Remote-Support-a.msi", platform="windows-amd64", file_type="remote_support_msi", data=data)
    second = _upload(svc, filename="TECHI-Remote-Support-b.msi", platform="windows-amd64", file_type="remote_support_msi", data=data)

    svc.set_active(first.id, True)
    svc.set_active(second.id, True)

    active = [p for p in svc.list_packages(include_inactive=False) if p.file_type.value == "remote_support_msi"]
    assert [p.id for p in active] == [second.id]


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
