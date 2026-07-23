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
