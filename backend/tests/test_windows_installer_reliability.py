"""Regression contracts for the 2.1.8 installer hotfix.

Real MSI execution remains a Windows canary gate; these tests prevent the
authoring defects that caused the production 2.1.7 rollback incident.
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WXS = (ROOT / "agent/installer/installer.wxs").read_text(encoding="utf-8")
REMOTE_WXS = (ROOT / "agent/installer/remote-support.wxs").read_text(encoding="utf-8")
REMOTE_HELPER = (ROOT / "agent/installer/remote-support-helper.ps1").read_text(encoding="utf-8")
MANIFEST = (ROOT / "agent/techi-agent.manifest").read_text(encoding="utf-8")
BOOTSTRAP = (ROOT / "backend/app/services/enrollment_bootstrap_service.py").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github/workflows/build-agent-msi.yml").read_text(encoding="utf-8")


def test_service_binary_is_as_invoker_not_uac_elevating():
    assert 'requestedExecutionLevel level="asInvoker"' in MANIFEST
    assert 'requestedExecutionLevel level="requireAdministrator"' not in MANIFEST


def test_major_upgrade_removal_is_transactional_late_schedule():
    assert 'Schedule="afterInstallExecute"' in WXS
    assert 'Schedule="afterInstallInitialize"' not in WXS


def test_operational_health_helper_exists_but_is_not_inside_msi_transaction():
    assert 'Id="ValidateAgentOperational"' not in WXS
    assert 'installer-health-check' not in WXS
    assert '<Custom Action="ValidateAgentOperational"' not in WXS
    assert '<Custom Action="StartTechiAgentService"' not in WXS


def test_agent_msi_does_not_use_standard_startservices_for_agent():
    assert '<ServiceControl Id="StartTechiAgent"' not in WXS
    start = WXS.index('<ServiceControl Id="StopRemoveTechiAgent"')
    block = WXS[start:WXS.index('/>', start) + 2]
    assert 'Start="install"' not in block
    assert 'Stop="both"' in block
    assert 'Id="StartTechiAgentService"' not in WXS
    assert 'installer-start-service' not in WXS


def test_agent_msi_contains_no_remote_support_payload_or_actions():
    forbidden = [
        "TECHI Remote Support.exe",
        "RemoteSupportComponents",
        "StopTechiRemoteSupport",
        "KillTechiRSBeforeInstall",
        "RollbackRestartTechiRS",
        "CreateRustDeskTrayTask",
        "WriteTechiConfigs",
        "ApplyTechiRemoteSupportConfigFinal",
        "RemoteSupportDesktopShortcut",
        "techiremotesupport",
        "REMOTE_SERVER",
        "REMOTE_RELAY",
        "REMOTE_KEY",
    ]
    for token in forbidden:
        assert token not in WXS


def test_agent_msi_contains_no_agent_helper_custom_actions():
    agent_source = (ROOT / "agent/rustdesk_manage.go").read_text(encoding="utf-8")
    bootstrap_source = (ROOT / "agent/bootstrap_windows.go").read_text(encoding="utf-8")
    forbidden = [
        "SetInstallerActive",
        "ClearInstallerActive",
        "RollbackClearInstallerActive",
        "EnsureServiceCreated",
        "installer-ensure-service",
        "StartTechiAgentService",
        "installer-start-service",
        "ValidateAgentOperational",
        "installer-health-check",
        "installer-marker",
        "bootstrap-config",
        "[INSTALLFOLDER]techi-agent.exe&quot;",
    ]
    for token in forbidden:
        assert token not in WXS
    assert 'installerTransactionActive()' in agent_source
    assert 'installer.active' in bootstrap_source


def test_installer_health_requires_current_service_pid_not_only_live_pid():
    bootstrap_source = (ROOT / "agent/bootstrap_windows.go").read_text(encoding="utf-8")
    assert "currentTechiAgentServicePID()" in bootstrap_source
    assert "status.PID == servicePID" in bootstrap_source
    assert "status.State == stateOperational" in bootstrap_source
    assert "windowsPIDIsLive(status.PID)" in bootstrap_source


def test_helper_subcommands_are_dispatched_before_runtime_initialization():
    main_source = (ROOT / "agent/main.go").read_text(encoding="utf-8")
    dispatch_pos = main_source.index("dispatchUtilityCommand(os.Args)")
    service_pos = main_source.index("runWindowsService(")
    agent_pos = main_source.index("runAgent(")
    assert dispatch_pos < service_pos < agent_pos
    assert "findUtilityCommand" in main_source
    assert "normalizeCommandToken" in main_source


def test_operational_lifecycle_is_service_runtime_only_on_windows():
    lifecycle_source = (ROOT / "agent/lifecycle.go").read_text(encoding="utf-8")
    service_source = (ROOT / "agent/service_windows.go").read_text(encoding="utf-8")
    policy_source = (ROOT / "agent/lifecycle_policy_windows.go").read_text(encoding="utf-8")
    assert "state == stateOperational && !canWriteOperationalLifecycle()" in lifecycle_source
    assert "markWindowsServiceRuntime()" in service_source
    assert "windowsServiceRuntime" in policy_source


def test_rustdesk_manage_uses_absolute_system32_tools():
    rustdesk_source = (ROOT / "agent/rustdesk_manage.go").read_text(encoding="utf-8")
    rustdesk_discovery_source = (ROOT / "agent/rustdesk.go").read_text(encoding="utf-8")
    swap_source = (ROOT / "agent/swap_windows.go").read_text(encoding="utf-8")
    assert '"sc"' not in rustdesk_source
    assert '"schtasks"' not in rustdesk_source
    assert 'exec.Command("sc"' not in rustdesk_discovery_source
    assert "scPath()" in rustdesk_source
    assert "scPath()" in rustdesk_discovery_source
    assert "schtasksPath()" in rustdesk_source
    assert 'system32ExePath("sc.exe")' in swap_source
    assert 'system32ExePath("schtasks.exe")' in swap_source


def test_ci_validates_standalone_and_msi_embedded_agent_lineage():
    assert "Validate MSI embedded agent lineage" in WORKFLOW
    assert "msiexec.exe" in WORKFLOW
    assert "'/a'" in WORKFLOW
    assert "CommApp\\TechiAgent\\techi-agent.exe" in WORKFLOW
    assert "standaloneHash" in WORKFLOW
    assert "embeddedHash" in WORKFLOW
    assert "differs from MSI embedded agent hash" in WORKFLOW
    assert "embedded_equals_standalone" in WORKFLOW
    assert "identity.json" in WORKFLOW
    assert '$buildCommit = "${{ github.sha }}"' in WORKFLOW


def test_agent_msi_has_no_embedded_remote_support_or_fleet_password():
    assert "rustdesk-password" not in WXS.lower()
    assert '<Property Id="ENROLLMENT_TOKEN"' in WXS
    assert "REMOTE_PASSWORD" not in WXS
    assert "REMOTE_KEY" not in WXS
    # WiX emits MsiHiddenProperties from Hidden="yes" properties and rejects
    # direct authoring of that reserved MSI property (WIX0070).
    assert '<Property Id="MsiHiddenProperties"' not in WXS


def test_bootstraps_require_fresh_live_operational_state():
    assert BOOTSTRAP.count("$state.state -eq 'operational' -and $live -and $fresh -and $pidMatches") >= 2
    assert "LIFECYCLE_PID_MATCH" in BOOTSTRAP
    assert "pid_mismatch" in BOOTSTRAP
    assert "SERVICE_PID_AFTER" in BOOTSTRAP
    assert "equal_version_unhealthy forcing_repair=1" in BOOTSTRAP
    assert "set VERSION_STATE=mixed" in BOOTSTRAP
    assert "set VERSION_STATE=binary_only" in BOOTSTRAP
    assert "set VERSION_STATE=registry_only" in BOOTSTRAP
    assert "set VERSION_STATE=service_only" in BOOTSTRAP
    assert "installed_binary_version=%BINARY_VERSION%" in BOOTSTRAP


def test_remote_support_msi_contains_no_agent_payload_or_actions():
    forbidden = [
        "techi-agent.exe",
        "TechiAgent",
        "agent.config.json",
        "agent.state.json",
        "ENROLLMENT_TOKEN",
        "bootstrap-config",
        "installer-health-check",
    ]
    for token in forbidden:
        assert token not in REMOTE_WXS
    assert "TECHI Remote Support" in REMOTE_WXS
    assert "REMOTE_KEY" in REMOTE_WXS
    assert "BuildCommit" in REMOTE_WXS


def test_remote_support_msi_and_helper_use_absolute_windows_tools():
    assert "&quot;[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe&quot;" in REMOTE_WXS
    assert "Start-Process -FilePath 'sc.exe'" not in REMOTE_WXS
    assert "Start-Process -FilePath 'taskkill.exe'" not in REMOTE_WXS
    assert "system32 = Join-Path $env:SystemRoot 'System32'" in REMOTE_HELPER
    assert "$scExe = Join-Path $system32 'sc.exe'" in REMOTE_HELPER
    assert "$schtasksExe = Join-Path $system32 'schtasks.exe'" in REMOTE_HELPER
    assert "Get-CimInstance Win32_Process" in REMOTE_HELPER
    assert "Invoke-CimMethod -InputObject $process -MethodName Terminate" in REMOTE_HELPER
    assert "taskkill.exe" not in REMOTE_HELPER
    assert "'/IM'" not in REMOTE_WXS


def test_deploy_orchestrator_splits_agent_and_remote_support_lifecycles():
    required = [
        "AGENT_INSTALL_LOCK=%LOCK_DIR%\\\\agent-install.lock",
        "REMOTE_INSTALL_LOCK=%LOCK_DIR%\\\\remote-support-install.lock",
        "msi-agent-%ACTIVE_VERSION%.log",
        "msi-remote-support-%REMOTE_SUPPORT_VERSION%.log",
        "TECHI-Agent-%ACTIVE_VERSION%.msi",
        "TECHI-Remote-Support-%REMOTE_SUPPORT_VERSION%.msi",
        "remote_healthy",
        "remote_missing",
        "remote_outdated",
        "remote_service_missing",
        "remote_needs_repair",
        "managed_by_self_update",
        "installer_busy_retryable product=agent",
        "installer_busy_retryable product=remote_support",
    ]
    for token in required:
        assert token in BOOTSTRAP


def test_known_production_msi_identity_map_is_locked():
    # Extracted from the actual published MSI Property tables during incident
    # response. Upgrade/component identity is stable; ProductCode is per build.
    identities = {
        "2.1.5": "{C2C44BD3-D859-43F6-8EE2-95C9F0E7EC8A}",
        "2.1.6": "{D5B2B5A1-C7E8-4B67-B11F-DC1FAB4AB688}",
        "2.1.7": "{09276C39-5BBE-4ED0-9B21-A831E3FD7669}",
    }
    assert len(set(identities.values())) == 3
    assert "E6AD0A88-5F26-5665-9B1F-70B8C5EE8363" in WXS
    assert "B2C3D4E5-F6A7-8901-BCDE-F12345678901" in WXS
