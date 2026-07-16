from pathlib import Path
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
WXS_PATH = ROOT / "agent" / "installer" / "remote-support.wxs"
HELPER_PATH = ROOT / "agent" / "installer" / "remote-support-helper.ps1"
BUILD_PATH = ROOT / "agent" / "installer" / "build-remote-support.sh"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "build-agent-msi.yml"


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


def test_remote_support_stop_actions_use_msi_safe_process_filter():
    text = _wxs_text()
    assert text.count(
        "Where-Object -Property ExecutablePath -In -Value $approved"
    ) == 2
    assert "[IO.Path]" not in text
    assert "Where-Object {" not in text


def test_remote_support_remove_action_preserves_spaced_service_name():
    text = _wxs_text()
    assert "&amp; (Join-Path $s 'sc.exe') delete 'TECHI Remote Support'" in text
    assert "-ArgumentList @('delete','TECHI Remote Support')" not in text


def test_remote_support_configure_action_logs_helper_output_to_msi():
    text = _wxs_text()
    assert 'Id="ConfigureRemoteSupportRuntime.SetParam"' in text
    assert 'Property="ConfigureRemoteSupportRuntime"' in text
    assert 'BinaryRef="Wix4UtilCA_$(sys.BUILDARCHSHORT)"' in text
    assert 'DllEntry="WixQuietExec"' in text
    assert 'Return="check"' in text
    assert (
        '<Custom Action="ConfigureRemoteSupportRuntime" '
        'After="ConfigureRemoteSupportRuntime.SetParam"'
    ) in text


def test_remote_support_helper_handles_clean_and_existing_service():
    helper = _helper_text()
    assert "if ($status -eq 'missing')" in helper
    assert "@('create', $serviceName" in helper
    assert "@('config', $serviceName" in helper
    assert "@('delete', $serviceName" not in helper
    assert "Wait-RSServiceRunning -TimeoutSeconds 30" in helper
    assert "AllowedExitCodes @(0, 1056) -Fatal" in helper


def test_remote_support_helper_reports_exact_fatal_step_and_native_output():
    helper = _helper_text()
    assert "stdout=$stdoutText stderr=$stderrText" in helper
    assert "fatal step=$script:currentStep error=$message" in helper
    assert "ConfigureRemoteSupportRuntime failed: step=$script:currentStep" in helper
    assert "[Security.Principal.WindowsIdentity]::GetCurrent().Name" in helper


def test_remote_support_helper_keeps_only_unusable_runtime_failures_fatal():
    helper = _helper_text()
    assert "required runtime file not found" in helper
    assert "required runtime file is empty" in helper
    assert "service did not reach Running within 30 seconds" in helper
    assert "warning step=stop_owned_processes" in helper
    assert "warning step=configure_tray_task" in helper
    assert "configure_service_recovery" in helper
    recovery_line = next(
        line for line in helper.splitlines() if "-Step 'configure_service_recovery'" in line
    )
    assert "-Fatal" not in recovery_line


def test_remote_support_build_script_outputs_distinct_msi_name():
    build = BUILD_PATH.read_text(encoding="utf-8")
    assert 'OUTPUT="TECHI-Remote-Support-${VERSION}.msi"' in build
    assert "remote-support.wxs" in build
    assert "installer.wxs" not in build
    assert "agent-update.wxs" not in build
    assert "-ext WixToolset.Util.wixext" in build


def test_remote_support_windows_build_installs_util_extension_and_runs_msi_tests():
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    assert "WixToolset.Util.wixext/7.0.0" in workflow
    assert "test-remote-support-msi.ps1" in workflow
