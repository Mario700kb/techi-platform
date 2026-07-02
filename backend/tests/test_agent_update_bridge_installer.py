from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
WXS_PATH = ROOT / "agent" / "installer" / "agent-update.wxs"
HELPER_PATH = ROOT / "agent" / "installer" / "agent-update-helper.ps1"
BUILD_PATH = ROOT / "agent" / "installer" / "build-agent-update.sh"


def _wxs_text() -> str:
    return WXS_PATH.read_text(encoding="utf-8")


def _helper_text() -> str:
    return HELPER_PATH.read_text(encoding="utf-8")


def test_agent_update_bridge_wxs_is_well_formed():
    ET.parse(WXS_PATH)


def test_agent_update_bridge_has_no_major_upgrade_or_combined_upgrade_code():
    text = _wxs_text()
    assert "<MajorUpgrade" not in text
    assert "E6AD0A88-5F26-5665-9B1F-70B8C5EE8363" not in text
    assert "2E4B47F2-42A6-5B84-9A08-34B8E1A87111" in text


def test_agent_update_bridge_does_not_ship_remote_support():
    combined = _wxs_text() + "\n" + _helper_text()
    forbidden = [
        "RemoteSupportComponents",
        "REMOTESUPPORTFOLDER",
        "KillTechiRS",
        "TECHI Remote Support.exe",
        "librustdesk.dll",
        "flutter_windows.dll",
        "TECHI-Remote-Support",
        "RemoveRustDeskTrayArtifacts",
        "CreateRustDeskTrayTask",
    ]
    for needle in forbidden:
        assert needle not in combined


def test_agent_update_bridge_only_controls_techi_agent_service():
    helper = _helper_text()
    assert "$serviceName = 'TechiAgent'" in helper
    assert "sc.exe" in helper
    assert "net.exe" in helper
    assert "TECHI Agent" in helper
    assert "TECHI Remote Support" not in helper
    assert "rustdesk" not in helper.lower()


def test_agent_update_bridge_preserves_existing_config_and_only_creates_if_missing():
    helper = _helper_text()
    assert "config preserved path=$configPath" in helper
    assert "if (Test-Path -LiteralPath $configPath)" in helper
    assert "config missing and no enrollment token supplied" in helper
    assert "device_id" not in helper
    assert "Remove-Item" not in helper


def test_agent_update_bridge_build_script_outputs_distinct_msi_name():
    build = BUILD_PATH.read_text(encoding="utf-8")
    assert 'OUTPUT="TECHI-Agent-Update-${VERSION}.msi"' in build
    assert "agent-update.wxs" in build
    assert "installer.wxs" not in build
