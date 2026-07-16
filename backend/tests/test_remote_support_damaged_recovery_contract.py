from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_one_time_bootstrap_uses_msi_only_for_missing_and_native_bundle_for_damage():
    source = (ROOT / "backend/app/services/enrollment_bootstrap_service.py").read_text()
    assert "if ($before.State -eq 'missing')" in source
    assert "Remote Support clean-install MSI failed" in source
    assert "MSI repair is refused for damaged state" in source
    assert "repair-remote-support --policy $policyPath" in source
    assert "--execute --json" in source
    assert "$policy.remote_support.recovery_mode = 'canary'" in source


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
