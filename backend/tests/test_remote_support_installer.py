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
    assert "WriteTechiConfigs" in text
    assert "ApplyTechiRemoteSupportConfigFinal" in text


def test_remote_support_helper_installs_the_service_and_never_a_tray():
    """Case A: a fresh managed install creates the service and NO tray task."""
    helper = _helper_text()
    assert "$serviceName = 'TECHI Remote Support'" in helper
    assert "--service" in helper
    assert "sc.exe" in helper
    assert "techi-agent" not in helper.lower()

    # Tray mode is deprecated: the helper must not register or launch one...
    assert "Register-ScheduledTask" not in helper
    assert "New-ScheduledTaskAction" not in helper
    assert "--tray" not in helper
    # ...and must remove a tray task left behind by an earlier install.
    assert "Unregister-ScheduledTask -TaskName $taskName" in helper


def test_remote_support_installer_keeps_the_on_demand_ui_shortcut():
    """Case F: the user-facing shortcut survives and launches with NO arguments."""
    root = ET.parse(WXS_PATH).getroot()
    ns = {"w": "http://wixtoolset.org/schemas/v4/wxs"}
    shortcuts = root.findall(".//w:Shortcut", ns)
    assert shortcuts, "the Start Menu shortcut that opens the UI must exist"
    for shortcut in shortcuts:
        target = shortcut.get("Target", "")
        assert "TECHI Remote Support.exe" in target
        # No Arguments attribute at all => plain UI launch, not tray mode.
        assert shortcut.get("Arguments") is None
        assert "--tray" not in target


def test_remote_support_installer_removes_tray_task_on_uninstall():
    text = _wxs_text()
    assert "Unregister-ScheduledTask -TaskName 'TECHI Remote Support Tray'" in text


def test_remote_support_installer_stops_processes_by_pid_not_by_image_name():
    combined = _wxs_text() + "\n" + _helper_text()
    assert "Stop-Process -Id $_.ProcessId -Force" in combined
    # No executable line may run a blanket image-name kill (comments explaining
    # why we do not are fine).
    for line in combined.splitlines():
        stripped = line.strip()
        if stripped.startswith(("#", "<!--")):
            continue
        assert "taskkill" not in stripped.lower(), stripped


def test_remote_support_build_script_outputs_distinct_msi_name():
    build = BUILD_PATH.read_text(encoding="utf-8")
    assert 'OUTPUT="TECHI-Remote-Support-${VERSION}.msi"' in build
    assert "remote-support.wxs" in build
    assert "installer.wxs" not in build
    assert "agent-update.wxs" not in build


def test_all_wix_installers_are_well_formed():
    """'--' is illegal inside an XML comment: a stray "--tray" in a comment makes
    the whole MSI fail to build."""
    installer_dir = ROOT / "agent" / "installer"
    for wxs in sorted(installer_dir.glob("*.wxs")):
        ET.parse(wxs)
