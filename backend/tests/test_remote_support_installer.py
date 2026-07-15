from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
WXS_PATH = ROOT / "agent" / "installer" / "remote-support.wxs"
HELPER_PATH = ROOT / "agent" / "installer" / "remote-support-helper.ps1"
BUILD_PATH = ROOT / "agent" / "installer" / "build-remote-support.sh"


def _wxs_text() -> str:
    return WXS_PATH.read_text(encoding="utf-8")


def _helper_text() -> str:
    return HELPER_PATH.read_text(encoding="utf-8")


def test_remote_support_wxs_is_well_formed():
    ET.parse(WXS_PATH)


def test_remote_support_installer_does_not_include_agent_or_enrollment():
    combined = _wxs_text() + "\n" + _helper_text()
    forbidden = [
        "TechiAgent",
        "TECHI Agent",
        "techi-agent.exe",
        "agent.config.json",
        "ENROLLMENT_TOKEN",
        "EnrollmentToken",
        "UpdateBridge",
        "TECHI-Agent-Update",
    ]
    for needle in forbidden:
        assert needle not in combined


def test_remote_support_installer_ships_remote_support_runtime():
    text = _wxs_text()
    assert 'Name="TECHI Remote Support"' in text
    assert "TECHI-Remote-Support\\**" in text
    assert "TECHI Remote Support.exe" in text
    assert "techiremotesupport" in text
    assert "techi-remote-support-bridge.exe" in text
    assert 'Value="&quot;[REMOTESUPPORTFOLDER]techi-remote-support-bridge.exe&quot; &quot;%1&quot;"' in text
    assert 'Value="&quot;[REMOTESUPPORTFOLDER]TECHI Remote Support.exe&quot; &quot;%1&quot;"' not in text
    assert "WriteTechiConfigs" in text
    assert "ApplyTechiRemoteSupportConfigFinal" in text


def test_remote_support_helper_manages_only_remote_support_service_and_tray():
    helper = _helper_text()
    assert "$serviceName = 'TECHI Remote Support'" in helper
    assert "$taskName = 'TECHI Remote Support Tray'" in helper
    assert "--service" in helper
    assert "--tray" in helper
    assert "sc.exe" in helper
    assert "Register-ScheduledTask" in helper
    assert "techi-agent" not in helper.lower()


def test_remote_support_build_script_outputs_distinct_msi_name():
    build = BUILD_PATH.read_text(encoding="utf-8")
    assert 'OUTPUT="TECHI-Remote-Support-${VERSION}.msi"' in build
    assert "remote-support.wxs" in build
    assert "installer.wxs" not in build
    assert "agent-update.wxs" not in build
