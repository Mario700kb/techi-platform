from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WINDOWS_ACTIONS = ROOT / "agent" / "actions_windows.go"
RUSTDESK_DISCOVERY = ROOT / "agent" / "rustdesk.go"


def _actions() -> str:
    return WINDOWS_ACTIONS.read_text(encoding="utf-8")


def _discovery() -> str:
    return RUSTDESK_DISCOVERY.read_text(encoding="utf-8")


def test_reinstall_uses_remote_support_msi_deploy_flow():
    text = _actions()
    assert 'reinstallParams["force_reinstall"] = true' in text
    assert "executeDeployRemoteSupport(cfg, reinstallParams)" in text


def test_deploy_verifies_msi_before_stop_and_cleans_up_after_install():
    text = _actions()
    download = text.index("ensureCachedMSI(&dlCfg, cachePath)")
    stop = text.index("stopLegacyRemoteSupportRuntime()")
    cleanup = text.index("cleanupLegacyRemoteSupportArtifacts(legacyBefore)")
    install = text.index("runMSIInstall(cachePath)")
    assert download < stop < install < cleanup
    assert 'sha256 := stringParam(params, "sha256")' in text
    assert "dlCfg.RustDeskMSIChecksumSHA256 = sha256" in text


def test_protocol_handler_uses_hklm_classes_not_hkcr_drive():
    text = _actions()
    assert r"HKLM\SOFTWARE\Classes\rustdesk\shell\open\command" in text
    assert "HKLM:\\SOFTWARE\\Classes\\rustdesk" in text
    assert "HKCR:" not in text


def test_discovery_prefers_msi_product_version_and_reports_conflict():
    text = _discovery()
    assert "selectRemoteSupportVersion" in text
    assert "detectRemoteSupportMSIRegistration" in text
    assert '"conflicting_dual_install"' in text
    assert '"tray_only"' in text


def test_discovery_uses_the_current_product_code_and_keeps_the_old_one_as_legacy():
    """Field fix: the agent searched for the obsolete ProductCode while the
    installed MSI registered under a new one. The current ProductCode is now the
    primary lookup; the obsolete one is retained only as a legacy fallback."""
    text = _discovery()
    assert 'managedRemoteSupportProductCode = "{528FACDB-7405-40F2-B8D5-F316F516FBB4}"' in text
    assert "legacyRemoteSupportProductCodes" in text
    # The obsolete ProductCode must survive ONLY inside the legacy list, never as
    # the managed constant.
    assert 'managedRemoteSupportProductCode = "{74CEDF4A' not in text
    assert "{74CEDF4A-E226-4151-BC7A-5154F0BC9E79}" in text


def test_discovery_logging_is_clean_and_non_misleading():
    text = _discovery()
    # The canonical success line.
    assert "TECHI Remote Support MSI found ProductCode=" in text
    # The informational-only executable fallback (not an error).
    assert "MSI registration missing, using executable semantic version" in text
    # The misleading warnings are gone.
    assert "falling back to ARP name scan" not in text
    assert "no managed Remote Support MSI registration found" not in text


def test_discovery_has_an_in_process_registry_reader_on_windows():
    """The reg.exe DisplayName scan proved unreliable in the field; Windows now
    reads the uninstall registry in-process."""
    reg = (ROOT / "agent" / "rustdesk_registry_windows.go").read_text(encoding="utf-8")
    assert "winRegDisplayVersionForProductCode" in reg
    assert "winRegScanRemoteSupportByDisplayName" in reg
    assert "golang.org/x/sys/windows/registry" in reg


# --------------------------------------------------------------------------- #
# Tray deprecation (Phase 2): the agent may only REMOVE tray startup.          #
# --------------------------------------------------------------------------- #

RUSTDESK_MANAGE = ROOT / "agent" / "rustdesk_manage.go"
BOOTSTRAP_WINDOWS = ROOT / "agent" / "bootstrap_windows.go"
INSTALLER_WXS = ROOT / "agent" / "installer" / "installer.wxs"


def test_agent_has_no_tray_start_helpers():
    manage = RUSTDESK_MANAGE.read_text(encoding="utf-8")
    actions = _actions()
    for text in (manage, actions):
        assert "func ensureRustDeskTrayRunning" not in text
        assert "func startRustDeskTray" not in text
        assert "startRustDeskTray()" not in text


def test_bootstrap_subcommand_removes_the_tray_task_instead_of_creating_it():
    text = BOOTSTRAP_WINDOWS.read_text(encoding="utf-8")
    assert "func runRemoveTrayArtifactsCommand() int" in text
    assert "removeManagedTrayArtifacts()" in text
    # The task XML builder that registered the --tray logon task is gone.
    assert "rsTrayTaskXML" not in text
    assert "<Arguments>--tray</Arguments>" not in text
    assert "/Create" not in text


def test_bootstrap_msi_removes_the_tray_task():
    text = INSTALLER_WXS.read_text(encoding="utf-8")
    assert 'CustomAction Id="RemoveRustDeskTrayTask"' in text
    assert "remove-tray-artifacts" in text
    assert 'CustomAction Id="CreateRustDeskTrayTask"' not in text


def test_deploy_removes_tray_artifacts_and_ensures_the_service():
    text = _actions()
    assert "removeManagedTrayArtifacts()" in text
    assert "ensureRustDeskService()" in text
    assert '"--tray"' not in text


def test_service_state_has_a_single_scm_implementation():
    runtime = (ROOT / "agent" / "rustdesk_runtime_windows.go").read_text(encoding="utf-8")
    assert "func windowsServiceState(" in runtime
    assert "svc/mgr" in runtime
    # No sc.exe output parsing remains in the Remote Support path.
    for path in (RUSTDESK_MANAGE, WINDOWS_ACTIONS, RUSTDESK_DISCOVERY):
        assert '"sc", "query"' not in path.read_text(encoding="utf-8")


def test_no_blanket_image_name_kills_in_installers_or_agent():
    """Every process stop must be targeted; `taskkill /IM` is indiscriminate."""
    paths = [
        WINDOWS_ACTIONS,
        RUSTDESK_DISCOVERY,
        RUSTDESK_MANAGE,
        BOOTSTRAP_WINDOWS,
        INSTALLER_WXS,
        ROOT / "agent" / "installer" / "remote-support.wxs",
        ROOT / "agent" / "installer" / "remote-support-helper.ps1",
    ]
    for path in paths:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith(("//", "#", "<!--")) or "NUK perdoret" in stripped:
                continue  # comments documenting the ban are fine
            assert "/IM" not in stripped or "taskkill" not in stripped, f"{path.name}: {stripped}"


def test_managed_runtime_states_have_no_tray_vocabulary():
    text = _discovery()
    assert "managed_degraded" not in text
    for state in ('"running"', '"starting"', '"stopped"', '"service_error"', '"conflicting_dual_install"'):
        assert state in text
    # tray_only survives ONLY as the unmanaged-legacy discovery marker.
    assert '"tray_only"' in text


def test_installers_stop_the_runtime_by_pid():
    installer = INSTALLER_WXS.read_text(encoding="utf-8")
    assert "stop-remote-support-runtime" in installer

    for path in (ROOT / "agent" / "installer" / "remote-support.wxs",
                 ROOT / "agent" / "installer" / "remote-support-helper.ps1"):
        text = path.read_text(encoding="utf-8")
        assert "Stop-Process -Id $_.ProcessId" in text
        assert "taskkill.exe" not in text
        # Path-validated: only executables inside a Remote Support install
        # directory may be terminated, never everything sharing the filename.
        assert "$_.ExecutablePath -like '*\\TECHI Remote Support\\*'" in text
        assert "$_.ExecutablePath -like '*\\RustDesk\\*'" in text


def test_pre_install_stop_is_self_contained_and_pid_targeted():
    """KillTechiRSBeforeInstall must stop RS without invoking the agent binary
    (the old-binary fall-through hang), PID-targeted and path-validated, never
    /IM, and bounded — so it can run on any pre-existing agent version safely."""
    import xml.etree.ElementTree as ET

    ns = {"w": "http://wixtoolset.org/schemas/v4/wxs"}
    root = ET.parse(INSTALLER_WXS).getroot()
    actions = [
        action for action in root.findall(".//w:CustomAction", ns)
        if action.get("Id") == "KillTechiRSBeforeInstall"
    ]
    assert actions, "KillTechiRSBeforeInstall custom action must exist"
    command = actions[0].get("ExeCommand", "")
    assert "techi-agent.exe" not in command          # no agent-binary dependency
    assert "if exist" not in command                 # no old-binary branch
    assert "Stop-Process -Id $_.ProcessId" in command
    assert "$_.ExecutablePath -like '*\\TECHI Remote Support\\*'" in command
    assert "Start-Job" in command and "-Timeout" in command
    assert "/IM" not in command


# --------------------------------------------------------------------------- #
# MSI custom-action hang fix (stop-remote-support-runtime)                     #
# --------------------------------------------------------------------------- #

MAIN_GO = ROOT / "agent" / "main.go"


def _installer_wxs() -> str:
    return INSTALLER_WXS.read_text(encoding="utf-8")


def test_kill_rs_custom_actions_do_not_invoke_the_agent_binary():
    """Root cause of the >1h msiexec hang: the KillTechiRS* custom actions invoked
    'techi-agent.exe stop-remote-support-runtime' on the PRE-EXISTING binary; an
    agent older than the subcommand fell through into the normal agent loop and
    never exited, blocking the synchronous custom action. The stop must be
    self-contained (no agent binary)."""
    import xml.etree.ElementTree as ET

    ns = {"w": "http://wixtoolset.org/schemas/v4/wxs"}
    root = ET.parse(INSTALLER_WXS).getroot()
    actions = {
        ca.get("Id"): ca.get("ExeCommand", "")
        for ca in root.findall(".//w:CustomAction", ns)
        if ca.get("Id") in ("KillTechiRS", "KillTechiRSBeforeInstall")
    }
    assert set(actions) == {"KillTechiRS", "KillTechiRSBeforeInstall"}
    for cmd in actions.values():
        assert "techi-agent.exe" not in cmd, "kill action must not invoke the agent binary"
        # Bounded: Start-Job + Wait-Job -Timeout, and logs to deploy.log.
        assert "Start-Job" in cmd and "Wait-Job" in cmd and "-Timeout" in cmd
        assert "deploy.log" in cmd
        # Stops, never deletes, the managed service (don't disrupt healthy RS).
        assert "'stop','TECHI Remote Support'" in cmd
        assert "sc delete" not in cmd.lower()


def test_dispatch_handles_stop_subcommand_before_the_agent_loop():
    src = MAIN_GO.read_text(encoding="utf-8")
    run_agent = src.index("runAgent(ctx")
    for sub in ('case "stop-remote-support-runtime":', 'case "remove-tray-artifacts", "rs-tray-task":'):
        assert sub in src
        assert src.index(sub) < run_agent, f"{sub} must dispatch before the agent loop"


def test_maintenance_subcommands_are_bounded():
    boot = BOOTSTRAP_WINDOWS.read_text(encoding="utf-8")
    assert "func boundedOneShot(" in (ROOT / "agent" / "boundedoneshot.go").read_text(encoding="utf-8")
    assert 'runBoundedOneShot("[stop-remote-support-runtime]"' in boot
    assert 'runBoundedOneShot("[remove-tray-artifacts]"' in boot
