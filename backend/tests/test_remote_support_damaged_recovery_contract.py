from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_one_time_bootstrap_uses_current_agent_reinstall_for_damage():
    source = (ROOT / "backend/app/services/enrollment_bootstrap_service.py").read_text()
    assert "if ($before.State -eq 'missing')" in source
    assert "Remote Support clean-install MSI failed" in source
    assert "& $AgentExe bootstrap-remote-support" in source
    assert "--observed-state $before.State" in source
    bootstrap = source.split("def _remote_support_one_time_ps_lines", 1)[1].split("def _windows_msi_bootstrap", 1)[0]
    assert "repair-remote-support" not in bootstrap
    assert "Native Remote Support recovery did not reach healthy state" not in bootstrap
    agent_command = (ROOT / "agent/bootstrap_remote_support.go").read_text()
    assert "handleReinstallRustDesk" in agent_command


def test_agent_and_native_recovery_share_one_machine_lock():
    manage = (ROOT / "agent/rustdesk_manage.go").read_text()
    actions = (ROOT / "agent/actions_windows.go").read_text()
    execute = (ROOT / "agent/bootstrap_native_execute_windows.go").read_text()
    assert "acquireRemoteSupportRepairLock()" in manage
    assert actions.count("acquireRemoteSupportRepairLock()") >= 5
    assert "native.AcquireExecutionLock(params.LockRoot)" in execute
    assert "C:\\ProgramData\\TechiAgent" in execute


def test_manual_reinstall_uses_bound_remote_support_msi_and_never_agent_repair():
    actions = (ROOT / "agent/actions_windows.go").read_text()
    reinstall = (ROOT / "agent/rs_reinstall_windows.go").read_text()
    action_service = (ROOT / "backend/app/services/remote_action_service.py").read_text()
    assert "executeRemoteSupportReinstall" in actions
    assert "handleNativeRemoteSupportRepair" not in actions.split("func handleReinstallRustDesk", 1)[1].split("func handleReopenRustDesk", 1)[0]
    assert 'file_type="remote_support_msi"' in action_service
    assert "remote_support_msi_sha256" in action_service
    assert "native_bundle_sha256" not in action_service
    assert "/remote-support-msi/download" in reinstall
    assert 'remoteSupportMSIDisplayName = "TECHI Remote Support"' in reinstall
    assert "TechiAgent" not in reinstall
