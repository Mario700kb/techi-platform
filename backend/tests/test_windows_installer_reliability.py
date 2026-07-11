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


def test_operational_health_is_a_fatal_msi_gate_before_auxiliary_work():
    assert 'Id="ValidateAgentOperational"' in WXS
    assert 'ExeCommand="&quot;[INSTALLFOLDER]techi-agent.exe&quot; installer-health-check"' in WXS
    assert '<Custom Action="ValidateAgentOperational" After="EnsureServiceCreated"' in WXS
    assert WXS.index('<Custom Action="ValidateAgentOperational"') < WXS.index('<Custom Action="CreateRustDeskTrayTask"')


def test_tray_task_is_auxiliary_and_nonfatal():
    start = WXS.index('<CustomAction Id="CreateRustDeskTrayTask"')
    block = WXS[start:WXS.index('/>', start) + 2]
    assert 'Return="ignore"' in block


def test_msi_has_no_embedded_fleet_password_and_hides_secret_targets():
    assert 'Value="Durres.12"' not in WXS
    for prop in ("ENROLLMENT_TOKEN", "REMOTE_PASSWORD", "REMOTE_KEY"):
        assert f'<Property Id="{prop}"' in WXS
    assert WXS.count('HideTarget="yes"') >= 5
    assert 'MsiHiddenProperties' in WXS
    assert 'ENROLLMENT_TOKEN;REMOTE_PASSWORD;REMOTE_KEY;WriteAgentConfig' in WXS


def test_bootstraps_require_fresh_live_operational_state():
    assert BOOTSTRAP.count("$state.state -eq 'operational' -and $live -and $fresh") >= 2
    assert "equal_version_unhealthy forcing_repair=1" in BOOTSTRAP
    assert "set VERSION_STATE=mixed" in BOOTSTRAP
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
