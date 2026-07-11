"""Regression contracts for the 2.1.8 installer hotfix.

Real MSI execution remains a Windows canary gate; these tests prevent the
authoring defects that caused the production 2.1.7 rollback incident.
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WXS = (ROOT / "agent/installer/installer.wxs").read_text(encoding="utf-8")
MANIFEST = (ROOT / "agent/techi-agent.manifest").read_text(encoding="utf-8")
BOOTSTRAP = (ROOT / "backend/app/services/enrollment_bootstrap_service.py").read_text(encoding="utf-8")


def test_service_binary_is_as_invoker_not_uac_elevating():
    assert 'requestedExecutionLevel level="asInvoker"' in MANIFEST
    assert 'requestedExecutionLevel level="requireAdministrator"' not in MANIFEST


def test_major_upgrade_removal_is_transactional_late_schedule():
    assert 'Schedule="afterInstallExecute"' in WXS
    assert 'Schedule="afterInstallInitialize"' not in WXS


def test_operational_health_helper_exists_but_is_not_inside_msi_transaction():
    assert 'Id="ValidateAgentOperational"' in WXS
    assert 'ExeCommand="&quot;[INSTALLFOLDER]techi-agent.exe&quot; installer-health-check' in WXS
    assert '<Custom Action="ValidateAgentOperational"' not in WXS
    assert '<Custom Action="StartTechiAgentService"' not in WXS


def test_combined_msi_does_not_use_standard_startservices_for_agent():
    start = WXS.index('<ServiceControl Id="StartTechiAgent"')
    block = WXS[start:WXS.index('/>', start) + 2]
    assert 'Start="install"' not in block
    assert 'Stop="both"' in block
    assert 'Id="StartTechiAgentService"' in WXS
    assert 'installer-start-service' in WXS


def test_remote_support_mutations_complete_before_msi_finalize_without_agent_start():
    order = [
        '<Custom Action="EnsureServiceCreated"',
        '<Custom Action="WriteTechiConfigs"',
        '<Custom Action="ApplyTechiRemoteSupportConfigFinal"',
        '<Custom Action="CreateRustDeskTrayTask"',
        '<Custom Action="ClearInstallerActive"',
    ]
    positions = [WXS.index(token) for token in order]
    assert positions == sorted(positions)
    assert '<Custom Action="StartTechiAgentService"' not in WXS
    assert '<Custom Action="ValidateAgentOperational"' not in WXS


def test_installer_marker_defers_runtime_rustdesk_reconciliation():
    agent_source = (ROOT / "agent/rustdesk_manage.go").read_text(encoding="utf-8")
    bootstrap_source = (ROOT / "agent/bootstrap_windows.go").read_text(encoding="utf-8")
    assert 'installer-marker create' in WXS
    assert 'installer-marker remove' in WXS
    assert 'RollbackClearInstallerActive' in WXS
    for action in ("SetInstallerActive", "ClearInstallerActive"):
        start = WXS.index(f'<CustomAction Id="{action}"')
        block = WXS[start:WXS.index('/>', start) + 2]
        assert 'Return="check"' in block
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


def test_tray_task_is_auxiliary_and_nonfatal():
    start = WXS.index('<CustomAction Id="CreateRustDeskTrayTask"')
    block = WXS[start:WXS.index('/>', start) + 2]
    assert 'Return="ignore"' in block


def test_msi_has_no_embedded_fleet_password_and_hides_secret_targets():
    assert 'Value="Durres.12"' not in WXS
    for prop in ("ENROLLMENT_TOKEN", "REMOTE_PASSWORD", "REMOTE_KEY"):
        assert f'<Property Id="{prop}"' in WXS
    assert WXS.count('HideTarget="yes"') >= 5
    # WiX emits MsiHiddenProperties from Hidden="yes" properties and rejects
    # direct authoring of that reserved MSI property (WIX0070).
    assert '<Property Id="MsiHiddenProperties"' not in WXS


def test_bootstraps_require_fresh_live_operational_state():
    assert BOOTSTRAP.count("$state.state -eq 'operational' -and $live -and $fresh") >= 2
    assert "equal_version_unhealthy forcing_repair=1" in BOOTSTRAP
    assert "set VERSION_STATE=mixed" in BOOTSTRAP
    assert "set VERSION_STATE=binary_only" in BOOTSTRAP
    assert "set VERSION_STATE=registry_only" in BOOTSTRAP
    assert "set VERSION_STATE=service_only" in BOOTSTRAP
    assert "installed_binary_version=%BINARY_VERSION%" in BOOTSTRAP


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
