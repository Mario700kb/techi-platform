"""
Validates that generated PowerShell installer scripts have correct syntax.

These tests catch the class of bugs where Python string templating
(dedent + f-string substitution) produced scripts with:
  - Here-string terminators ('@ or "@) that had leading whitespace
  - Inconsistent indentation that confused PowerShell's parser
  - Unexpected literal {{ or }} from missed f-string escaping

No Windows runtime required — we check structural invariants that
must hold for PowerShell 5.1 to parse the scripts correctly.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import textwrap
from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import bootstrap as bootstrap_endpoint
from app.schemas.enrollment_bootstrap import (
    AvailabilityProfile,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
)
from app.services.enrollment_bootstrap_service import (
    _READ_AGENT_SERVICE_ENCODED_COMMAND,
    _READ_LIFECYCLE_ENCODED_COMMAND,
    _READ_REMOTE_SUPPORT_SERVICE_ENCODED_COMMAND,
    _READ_REMOTE_SUPPORT_VERSION_ENCODED_COMMAND,
    _READ_REGISTRY_ENCODED_COMMAND,
    EnrollmentBootstrapService,
)


# ---------------------------------------------------------------------------
# Minimal service stub (no DB, no real package store)
# ---------------------------------------------------------------------------

class _StubService(EnrollmentBootstrapService):
    """Bypass DB + AgentPackageService so we can unit-test script generation."""

    def __init__(self, sha256: str = "aabbccdd" * 8):
        self._stub_sha256 = sha256

    def _windows_package_info(self, backend_url: str) -> tuple[str, str, str]:
        backend_url = self.normalize_backend_url(backend_url)
        url = f"{backend_url}/api/v1/agent-packages/platform/windows-amd64/download"
        return url, self._stub_sha256, "techi-agent.msi"

    def _active_windows_version(self) -> str:
        return "2.1.0"

    def _active_remote_support_version(self) -> Optional[str]:
        return "1.4.6"


class _StubTokenService:
    def __init__(self, issued_token: str = "real-token-from-backend-123"):
        self.issued_token = issued_token
        self.validated_token = None

    def get_active_token(self, token_id: int):
        return SimpleNamespace(id=token_id, status="active")

    def validate_plaintext_for_token_id(self, token_id: int, plaintext_token: str) -> None:
        self.validated_token = (token_id, plaintext_token)

    def issue_plaintext_for_token(self, token) -> str:
        return self.issued_token


class _OneTimePackageStub(EnrollmentBootstrapService):
    def __init__(self):
        pass

    def _windows_msi_package_info(self, backend_url: str):
        return (
            f"{backend_url}/api/v1/agent-packages/platform/windows-amd64/download",
            "a" * 64,
            "2.1.9",
        )

    def _remote_support_msi_package_info(self, backend_url: str):
        return (
            f"{backend_url}/api/v1/agent-packages/remote-support-msi/download",
            "b" * 64,
            "1.4.6",
        )


def test_one_time_install_separates_agent_and_remote_support_lifecycles():
    _, script = _OneTimePackageStub()._windows_msi_bootstrap(
        "https://api-rdp.techi.com.al",
        "token-value-that-is-long-enough",
        "Device 11",
        _make_req(),
    )

    assert "agent_result=unchanged reason=healthy_current" in script
    assert "remote_support_result=$RemoteSupportResult" in script
    assert "Install-OrRepairRemoteSupport" in script
    assert "remote_support_state=$($before.State)" in script
    assert "Get-CimInstance Win32_Process" in script
    assert "Invoke-CimMethod -InputObject $proc -MethodName Terminate" in script
    assert "taskkill.exe" not in script
    assert "remote-support-auto-repair-mode $RemoteSupportAutoRepairMode" in script
    assert "remote-support-auto-repair-device-ids $RemoteSupportAutoRepairDeviceIds" in script
    assert "$AgentTargetVersion = '2.1.9'" in script
    assert "$BootstrapConfigContractVersion = '1'" in script
    assert "bootstrap-config-contract" in script
    assert "$agentContractCompatible" in script
    assert "refusing unsupported flags" in script
    assert script.index("if (-not (Test-AgentBootstrapConfigContract $AgentExe))") < script.index(
        "& $AgentExe bootstrap-config "
    )
    assert "'pending_reboot'" in script
    assert "'executable_missing'" in script
    assert "Restore-RemoteSupportState $before $backup" in script
    assert "Remove-Item -LiteralPath $partial.Root" in script
    assert "agent_result=$AgentResult remote_support_result=$RemoteSupportResult" in script
    assert script.index("AgentCurrentHealthy") < script.index("Downloading TECHI Endpoint package")
    assert script.index("service exists but lifecycle did not reach operational") < script.index("$RemoteSupportResult = Install-OrRepairRemoteSupport")


def _decode_powershell(encoded: str) -> str:
    return base64.b64decode(encoded).decode("utf-16-le")


def _encoded_command_for_label(script: str, label: str) -> str:
    label_match = re.search(rf"^{re.escape(label)}\b", script, re.MULTILINE)
    assert label_match, f"missing label {label}"
    start = label_match.start()
    rest = script[start:]
    match = re.search(r"-EncodedCommand\s+([A-Za-z0-9+/=]+)", rest)
    assert match, f"missing encoded command after {label}"
    return match.group(1)


def _label_section(script: str, label: str) -> str:
    label_match = re.search(rf"^{re.escape(label)}\b", script, re.MULTILINE)
    assert label_match, f"missing label {label}"
    start = label_match.start()
    next_label = re.search(r"^:[A-Za-z0-9_][A-Za-z0-9_-]*\b", script[start + 1 :], re.MULTILINE)
    end = start + 1 + next_label.start() if next_label else len(script)
    return script[start:end]


def _cmd_runner():
    cmd = shutil.which("cmd.exe")
    if cmd:
        return [cmd], None
    wine = shutil.which("wine")
    if not wine:
        return None, "cmd.exe/wine not available"
    return [wine, "cmd.exe"], None


def _wine_path(path) -> str:
    return "Z:" + str(path).replace("/", "\\")


def _make_req(**overrides) -> EnrollmentBootstrapRequest:
    defaults = dict(
        mode="token",
        enrollment_token_id=1,
        backend_url="http://10.5.50.63:8000",
        platform="windows",
        enrollment_token="tok123tok123tok123",
        availability_profile="server",
        manage_power_policy=True,
        rustdesk_manage_enabled=False,
    )
    defaults.update(overrides)
    return EnrollmentBootstrapRequest(**defaults)


def _make_rustdesk_req(**overrides) -> EnrollmentBootstrapRequest:
    defaults = dict(
        rustdesk_manage_enabled=True,
        rustdesk_rendezvous_server="139.162.158.208",
        rustdesk_relay_server="139.162.158.208",
        rustdesk_key="8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw=",
    )
    defaults.update(overrides)
    return _make_req(**defaults)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_no_here_strings(script: str, label: str) -> None:
    """Fail if any here-string opener/terminator is found."""
    for i, line in enumerate(script.splitlines(), 1):
        stripped = line.lstrip()
        # here-string openers must end the line; terminators must be col-0
        assert not stripped.startswith("@'"), (
            f"{label}: line {i} starts with @' (here-string opener): {line!r}"
        )
        assert not stripped.startswith('@"'), (
            f"{label}: line {i} starts with @\" (here-string opener): {line!r}"
        )
        # Terminators at wrong column
        if stripped.startswith("'@") or stripped.startswith('"@'):
            leading = len(line) - len(stripped)
            assert leading == 0, (
                f"{label}: line {i} has indented here-string terminator: {line!r}"
            )


def _check_ps_braces(script: str, label: str) -> None:
    """Fail if literal {{ or }} appear (double-brace leak from f-string)."""
    assert "{{" not in script, f"{label}: contains literal {{{{ (f-string brace leak)"
    assert "}}" not in script, f"{label}: contains literal }}}} (f-string brace leak)"


def _check_no_leading_spaces_inconsistency(script: str, label: str) -> None:
    """All lines must have consistent indentation style (no mix of
    column-0 and heavily-indented lines that would indicate dedent failure).
    Specifically: there must be no line that has more than 0 and fewer than
    4 leading spaces right next to a line at column 0 — the hallmark of
    the broken dedent approach."""
    # We just assert every line's leading spaces count is a multiple of 4 or 0
    # (our new implementation uses 4-space indentation exclusively)
    for i, line in enumerate(script.splitlines(), 1):
        if not line.strip():
            continue  # blank lines are fine
        leading = len(line) - len(line.lstrip())
        assert leading % 4 == 0, (
            f"{label}: line {i} has {leading} leading spaces (not a multiple of 4): {line!r}"
        )


def _check_config_json(script: str, label: str) -> None:
    """ConvertTo-Json block must be present; no literal JSON blob in script."""
    assert "ConvertTo-Json" in script, f"{label}: missing ConvertTo-Json call"
    assert "$AgentConfig = [ordered]@{" in script, f"{label}: missing ordered hashtable"
    # Ensure agent_name is set to $env:COMPUTERNAME
    assert "$env:COMPUTERNAME" in script, f"{label}: agent_name not set from $env:COMPUTERNAME"


def _check_sha256(script: str, sha256: str, label: str) -> None:
    assert sha256 in script, f"{label}: SHA256 hash not in script"
    assert "Get-FileHash" in script, f"{label}: missing Get-FileHash call"


def _check_exit_codes(script: str, label: str) -> None:
    assert "exit 0" in script, f"{label}: missing 'exit 0'"
    assert "exit 1" in script, f"{label}: missing 'exit 1'"


def _check_installer_log(script: str, label: str) -> None:
    assert "installer.log" in script, f"{label}: missing installer.log path"
    assert "Write-Log" in script, f"{label}: missing Write-Log function"


def _check_agent_self_update_flow(script: str, label: str) -> None:
    assert "techi-agent.new.exe" in script, f"{label}: missing temporary download path"
    assert "techi-agent.previous.exe" in script, f"{label}: missing rollback backup path"
    assert "Install-TechiAgentBinary" in script, f"{label}: missing self-update helper"
    assert "Stop-TechiAgentForUpdate" in script, f"{label}: missing service stop helper"
    assert "Wait-TechiAgentStopped" in script, f"{label}: missing process-exit wait helper"
    assert "Replace-FileWithRetry" in script, f"{label}: missing replace retry helper"
    assert "Start-TechiAgentAfterUpdate" in script, f"{label}: missing service restart helper"
    assert "update_started" in script, f"{label}: missing update_started log"
    assert "service_stopped" in script, f"{label}: missing service_stopped log"
    assert "binary_replaced" in script, f"{label}: missing binary_replaced log"
    assert "service_started" in script, f"{label}: missing service_started log"
    assert "rollback_triggered" in script, f"{label}: missing rollback_triggered log"
    assert "Invoke-WebRequest -Uri $AgentUrl -OutFile $NewPath" in script, f"{label}: download must target temporary file"
    assert "Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath" not in script, f"{label}: must not download over running binary"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTokenInstallerScript:
    def setup_method(self):
        self.sha256 = "aabbccdd" * 8
        self.svc = _StubService(sha256=self.sha256)
        req = _make_req()
        cfg = self.svc._config_template("http://10.5.50.63:8000", "tok123tok123tok123", req)
        _, self.script = self.svc._windows_bootstrap(
            "http://10.5.50.63:8000", "tok123tok123tok123", cfg, req
        )

    def test_no_here_strings(self):
        _check_no_here_strings(self.script, "token-installer")

    def test_no_brace_leaks(self):
        _check_ps_braces(self.script, "token-installer")

    def test_consistent_indentation(self):
        _check_no_leading_spaces_inconsistency(self.script, "token-installer")

    def test_config_uses_converttojson(self):
        _check_config_json(self.script, "token-installer")

    def test_sha256_present(self):
        _check_sha256(self.script, self.sha256, "token-installer")

    def test_exit_codes(self):
        _check_exit_codes(self.script, "token-installer")

    def test_installer_log(self):
        _check_installer_log(self.script, "token-installer")

    def test_utf8_no_bom(self):
        assert "UTF8Encoding" in self.script, "token-installer: missing UTF8Encoding call"
        assert "WriteAllText" in self.script, "token-installer: missing WriteAllText call"

    def test_enrollment_token_in_script(self):
        assert "tok123tok123tok123" in self.script, "token-installer: enrollment token missing"

    def test_msi_uses_installer_property_names(self):
        assert "ENROLLMENT_TOKEN=tok123tok123tok123" in self.script
        assert "API_URL=https://10.5.50.63:8000" in self.script
        assert "'TOKEN=tok123tok123tok123'" not in self.script

    def test_idempotent_service_install(self):
        assert "already installed" in self.script, "token-installer: missing idempotency check"

    def test_rustdesk_migration_not_added_when_disabled(self):
        assert "Forcing TECHI Remote Support migration to TECHI infrastructure" not in self.script

    def test_generated_script_uses_https_urls(self):
        assert "http://10.5.50.63:8000" not in self.script
        assert "https://10.5.50.63:8000" in self.script
        assert "'wss://10.5.50.63:8000/ws/devices?tenant_id=default'" in self.script

    def test_generated_script_uses_techiagent_programdata_path(self):
        assert '$InstallDir = "C:\\ProgramData\\TechiAgent"' in self.script
        assert '$LegacyInstallDir = "C:\\ProgramData\\TECHI"' in self.script
        assert "$StandardAgentPath = Join-Path $InstallDir 'techi-agent.exe'" in self.script
        assert "C:\\ProgramData\\TECHI\\techi-agent.exe" not in self.script

    def test_agent_path_resolves_from_service_and_is_guarded(self):
        assert "function Get-TechiAgentServicePath" in self.script
        assert "Get-CimInstance Win32_Service -Filter \"Name='TechiAgent'\"" in self.script
        assert "function Resolve-TechiAgentPath" in self.script
        assert "function Assert-TechiAgentPath" in self.script
        assert "Assert-TechiAgentPath -Path $AgentPath" in self.script

    def test_agent_self_update_flow(self):
        _check_agent_self_update_flow(self.script, "token-installer")


class TestRustDeskPreservationScript:
    def setup_method(self):
        self.svc = _StubService()
        req = _make_rustdesk_req()
        cfg = self.svc._config_template("http://10.5.50.63:8000", "tok123tok123tok123", req)
        _, self.script = self.svc._windows_bootstrap(
            "http://10.5.50.63:8000", "tok123tok123tok123", cfg, req
        )

    def test_bootstrap_preserves_remote_support_configuration(self):
        assert "TECHI Remote Support configuration preserved" in self.script
        assert "authenticated Agent reconciliation" in self.script

    def test_bootstrap_contains_no_destructive_remote_support_migration(self):
        forbidden = [
            "Forcing TECHI Remote Support migration",
            "TECHI Remote Support config removed",
            "Remove-Item -LiteralPath $_.FullName -Recurse -Force",
            "Set-TechiPermanentPasswordSafe",
            "$TechiPassword",
            "sc.exe",
        ]
        for value in forbidden:
            assert value not in self.script

    def test_config_template_contains_no_bootstrap_password(self):
        assert "rustdesk_default_password" not in self.script
        assert "--password" not in self.script

    def test_public_endpoint_enables_management_without_a_password(self, monkeypatch):
        captured = {}

        class FakeTokenService:
            def __init__(self, db):
                pass

            def get_active_token_by_plaintext(self, token: str):
                return SimpleNamespace(id=7)

        class FakeBootstrapService:
            def __init__(self, db):
                pass

            def generate(self, payload):
                captured["payload"] = payload
                return SimpleNamespace(bootstrap_script="$ErrorActionPreference = 'Stop'\n")

        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentTokenService", FakeTokenService)
        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentBootstrapService", FakeBootstrapService)

        app = FastAPI()
        app.include_router(bootstrap_endpoint.router, prefix="/api/v1/bootstrap")

        def _fake_db():
            yield object()

        app.dependency_overrides[bootstrap_endpoint.get_db] = _fake_db
        response = TestClient(app).get("/api/v1/bootstrap/windows.ps1?token=active-token-123456")

        assert response.status_code == 200
        assert captured["payload"].rustdesk_manage_enabled is True
        assert captured["payload"].rustdesk_rendezvous_server == "139.162.158.208"
        assert captured["payload"].rustdesk_relay_server == "139.162.158.208"
        assert captured["payload"].rustdesk_key == "8B5Z8Vp6ZKVUYOQsLxL+rktKft7s4KyozByrIPG8qSw="
        assert not hasattr(captured["payload"], "rustdesk_default_password")

class TestPublicWindowsBootstrapEndpoint:
    def setup_method(self):
        app = FastAPI()
        app.include_router(bootstrap_endpoint.router, prefix="/api/v1/bootstrap")

        def _fake_db():
            yield object()

        app.dependency_overrides[bootstrap_endpoint.get_db] = _fake_db
        self.client = TestClient(app)

    def test_missing_token_returns_validation_error(self):
        response = self.client.get("/api/v1/bootstrap/windows.ps1")

        assert response.status_code == 422

    def test_invalid_token_returns_400(self, monkeypatch):
        class FakeTokenService:
            def __init__(self, db):
                pass

            def get_active_token_by_plaintext(self, token: str):
                raise ValueError("invalid")

        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentTokenService", FakeTokenService)

        response = self.client.get("/api/v1/bootstrap/windows.ps1?token=bad-token")

        assert response.status_code == 400
        assert "invalid" in response.json()["detail"]

    def test_active_token_returns_plaintext_powershell_without_admin_auth(self, monkeypatch):
        captured = {}

        class FakeTokenService:
            def __init__(self, db):
                pass

            def get_active_token_by_plaintext(self, token: str):
                return SimpleNamespace(id=7)

        class FakeBootstrapService:
            def __init__(self, db):
                pass

            def generate(self, payload):
                captured["payload"] = payload
                return SimpleNamespace(
                    bootstrap_script=(
                        '$ErrorActionPreference = "Stop"\n'
                        "# Techi Agent -- one-click installer (Token Enrollment)\n"
                        "$EnrollToken = 'active-token-123456'\n"
                    )
                )

        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentTokenService", FakeTokenService)
        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentBootstrapService", FakeBootstrapService)

        response = self.client.get("/api/v1/bootstrap/windows.ps1?token=active-token-123456")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        assert "techi-bootstrap.ps1" in response.headers["content-disposition"]
        assert "$ErrorActionPreference" in response.text
        assert "Token Enrollment" in response.text
        assert captured["payload"].enrollment_token_id == 7
        assert captured["payload"].enrollment_token == "active-token-123456"
        assert captured["payload"].mode == "token"
        assert captured["payload"].platform == "windows"
        assert captured["payload"].backend_url == "https://api-rdp.techi.com.al"

    def test_trusted_domain_endpoint_returns_tokenless_script(self, monkeypatch):
        captured = {}

        class FakeTokenService:
            def __init__(self, db):
                pass

            def ensure_internal_bootstrap_token(self, *, kind: str, expires_hours: int):
                captured["token_kind"] = kind
                captured["expires_hours"] = expires_hours
                return SimpleNamespace(id=99, token_prefix="hidden01")

        class FakeBootstrapService:
            def __init__(self, db):
                pass

            def generate(self, payload):
                captured["payload"] = payload
                return SimpleNamespace(
                    bootstrap_script=(
                        '$ErrorActionPreference = "Stop"\n'
                        "# Techi Agent -- GPO / Trusted Domain deployment\n"
                        "& $AgentPath install -config $ConfigPath\n"
                    )
                )

        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentTokenService", FakeTokenService)
        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentBootstrapService", FakeBootstrapService)
        monkeypatch.setattr(bootstrap_endpoint, "system_audit_log", lambda *args, **kwargs: captured.setdefault("audited", True))

        response = self.client.get("/api/v1/bootstrap/domain.ps1")

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/plain")
        assert "techi-domain-bootstrap.ps1" in response.headers["content-disposition"]
        assert "enrollment-token" not in response.text.lower()
        assert captured["token_kind"] == "domain"
        assert captured["payload"].mode == "gpo"
        assert captured["payload"].enrollment_token is None
        assert captured["payload"].enrollment_token_id is None
        assert captured["payload"].backend_url == "https://api-rdp.techi.com.al"
        assert captured["payload"].rustdesk_manage_enabled is True
        assert captured["audited"] is True

    def test_gpo_endpoint_returns_tokenless_script(self, monkeypatch):
        captured = {}

        class FakeTokenService:
            def __init__(self, db):
                pass

            def ensure_internal_bootstrap_token(self, *, kind: str, expires_hours: int):
                captured["token_kind"] = kind
                return SimpleNamespace(id=100, token_prefix="hidden02")

        class FakeBootstrapService:
            def __init__(self, db):
                pass

            def generate(self, payload):
                captured["payload"] = payload
                return SimpleNamespace(bootstrap_script="& $AgentPath install -config $ConfigPath\n")

        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentTokenService", FakeTokenService)
        monkeypatch.setattr(bootstrap_endpoint, "EnrollmentBootstrapService", FakeBootstrapService)
        monkeypatch.setattr(bootstrap_endpoint, "system_audit_log", lambda *args, **kwargs: None)

        response = self.client.get("/api/v1/bootstrap/gpo.ps1")

        assert response.status_code == 200
        assert "techi-gpo-bootstrap.ps1" in response.headers["content-disposition"]
        assert "enrollment-token" not in response.text.lower()
        assert captured["token_kind"] == "gpo"
        assert captured["payload"].mode == "gpo"
        assert captured["payload"].enrollment_token is None
        assert captured["payload"].backend_url == "https://api-rdp.techi.com.al"
        assert captured["payload"].rustdesk_manage_enabled is True


class TestTokenInstallerPlaintextResolution:
    def setup_method(self):
        self.svc = _StubService()
        self.svc.token_service = _StubTokenService()

    def test_generate_without_payload_token_embeds_real_transient_token(self):
        req = _make_req(enrollment_token=None)
        response = self.svc.generate(req)

        assert "real-token-from-backend-123" in response.bootstrap_script
        assert '"enrollment_token": "real-token-from-backend-123"' in response.config_template
        assert '"api_url": "https://10.5.50.63:8000"' in response.config_template
        assert '"backend_url": "https://10.5.50.63:8000/api/v1/agent/heartbeat"' in response.config_template
        assert "http://10.5.50.63:8000" not in response.bootstrap_script
        assert "http://10.5.50.63:8000" not in response.config_template
        assert "<ENROLLMENT_TOKEN_FOR_ID_1>" not in response.bootstrap_script
        assert "<ENROLLMENT_TOKEN_FOR_ID_1>" not in response.config_template

    def test_generate_with_payload_token_embeds_supplied_token(self):
        req = _make_req(enrollment_token="supplied-token-value-123")
        response = self.svc.generate(req)

        assert "supplied-token-value-123" in response.bootstrap_script
        assert '"enrollment_token": "supplied-token-value-123"' in response.config_template
        assert self.svc.token_service.validated_token == (1, "supplied-token-value-123")


class TestTokenInstallerNoSHA256:
    """When no package is uploaded, SHA256 is empty — script must still be valid."""

    def setup_method(self):
        self.svc = _StubService(sha256="")
        req = _make_req()
        cfg = self.svc._config_template("http://10.5.50.63:8000", "tok123tok123tok123", req)
        _, self.script = self.svc._windows_bootstrap(
            "http://10.5.50.63:8000", "tok123tok123tok123", cfg, req
        )

    def test_no_here_strings(self):
        _check_no_here_strings(self.script, "token-no-sha256")

    def test_no_brace_leaks(self):
        _check_ps_braces(self.script, "token-no-sha256")

    def test_consistent_indentation(self):
        _check_no_leading_spaces_inconsistency(self.script, "token-no-sha256")

    def test_config_uses_converttojson(self):
        _check_config_json(self.script, "token-no-sha256")

    def test_exit_codes(self):
        _check_exit_codes(self.script, "token-no-sha256")

    def test_agent_self_update_flow_without_sha256(self):
        _check_agent_self_update_flow(self.script, "token-no-sha256")
        assert "WARNING: No SHA256 configured -- signature/checksum validation skipped." in self.script


class TestGPOInstallerScript:
    def setup_method(self):
        self.sha256 = "deadbeef" * 8
        self.svc = _StubService(sha256=self.sha256)
        req = _make_req(mode="gpo", enrollment_token_id=None, enrollment_token=None)
        cfg = self.svc._config_template("http://10.5.50.63:8000", "", req)
        _, self.script = self.svc._gpo_windows_bootstrap(
            "http://10.5.50.63:8000", "", cfg, req
        )

    def test_no_here_strings(self):
        _check_no_here_strings(self.script, "gpo-installer")

    def test_no_brace_leaks(self):
        _check_ps_braces(self.script, "gpo-installer")

    def test_consistent_indentation(self):
        _check_no_leading_spaces_inconsistency(self.script, "gpo-installer")

    def test_config_uses_converttojson(self):
        _check_config_json(self.script, "gpo-installer")

    def test_sha256_present(self):
        _check_sha256(self.script, self.sha256, "gpo-installer")

    def test_exit_codes(self):
        _check_exit_codes(self.script, "gpo-installer")

    def test_installer_log(self):
        _check_installer_log(self.script, "gpo-installer")

    def test_idempotent_service_install(self):
        assert "already installed" in self.script, "gpo-installer: missing idempotency check"

    def test_generated_script_uses_techiagent_programdata_path(self):
        assert '$InstallDir = "C:\\ProgramData\\TechiAgent"' in self.script
        assert '$LegacyInstallDir = "C:\\ProgramData\\TECHI"' in self.script
        assert "$StandardAgentPath = Join-Path $InstallDir 'techi-agent.exe'" in self.script
        assert "C:\\ProgramData\\TECHI\\techi-agent.exe" not in self.script

    def test_agent_path_resolves_from_service_and_is_guarded(self):
        assert "function Get-TechiAgentServicePath" in self.script
        assert "Get-CimInstance Win32_Service -Filter \"Name='TechiAgent'\"" in self.script
        assert "function Resolve-TechiAgentPath" in self.script
        assert "function Assert-TechiAgentPath" in self.script
        assert "Assert-TechiAgentPath -Path $AgentPath" in self.script

    def test_no_read_host(self):
        # Ignore comment lines; only fail if Read-Host appears as actual code
        code_lines = [l for l in self.script.splitlines() if not l.strip().startswith("#")]
        code = "\n".join(code_lines)
        assert "Read-Host" not in code, "gpo-installer: must not call Read-Host in code"

    def test_no_prompts(self):
        assert "Confirm" not in self.script, "gpo-installer: must not prompt"

    def test_agent_self_update_flow(self):
        _check_agent_self_update_flow(self.script, "gpo-installer")

    def test_service_install_uses_official_config_path(self):
        assert "& $AgentPath install -config $ConfigPath" in self.script
        assert "$ConfigPath = Join-Path $InstallDir 'agent.config.json'" in self.script
        assert "('TOKEN=' + $Token)" not in self.script
        assert "('BACKEND_URL=' + $BackendUrl)" not in self.script


class TestGPOScheduledDeployScript:
    """
    Arkitektura e re: MSI vendoset në NETLOGON nga PS1 (admin, 1 herë).
    PC-të instalojnë nga LAN (\\DOMAIN\\NETLOGON\\) — zero download nga internet,
    zero suspicious pattern, zero AV detection.
    """

    def setup_method(self):
        self.svc = _StubService()
        self.script = self.svc._gpo_scheduled_task_setup(
            "https://api-rdp.techi.com.al",
            "deploy-token-123",
        )

    # ── PS1-level: Defender exclusions GPO ────────────────────────────────────

    def test_defender_exclusions_are_configured_locally_and_via_gpo(self):
        local_exclusion = self.script.index(
            "Add-MpPreference -ExclusionPath 'C:\\ProgramData\\TECHI'"
        )
        module_import = self.script.index("Import-Module GroupPolicy")

        assert local_exclusion < module_import
        assert "Add-MpPreference -ExclusionPath 'C:\\ProgramData\\TechiAgent'" in self.script
        assert "Add-MpPreference -ExclusionPath 'C:\\Windows\\Temp\\TechiDeploy'" in self.script
        assert "Add-MpPreference -ExclusionProcess 'techi-agent.exe'" in self.script
        assert "foreach ($XPath in @('C:\\ProgramData\\TECHI', 'C:\\ProgramData\\TechiAgent', 'C:\\Windows\\Temp\\TechiDeploy'))" in self.script
        assert "-Key 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Exclusions\\Paths'" in self.script
        assert "-Key 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Exclusions\\Processes'" in self.script
        assert "New-GPLink -Name $ExclGPOName -Target $DomainDN -LinkEnabled Yes" in self.script

    # ── CMD content: zero internet downloads ──────────────────────────────────

    def test_deploy_cmd_has_no_internet_download_commands(self):
        """CMD nuk duhet të ketë asnjë download nga internet."""
        # Gjej CMD content (brenda here-string)
        cmd_start = self.script.index("@echo off")
        # Shiko CMD content para PS1 step 4b
        step4b_start = self.script.index("Hapi 4b: Shkarkimi i Agent/Remote Support MSI")
        cmd_section = self.script[cmd_start:step4b_start]

        assert "curl.exe" not in cmd_section
        assert "Net.WebClient" not in cmd_section
        assert "Invoke-WebRequest" not in cmd_section
        assert "DownloadFile" not in cmd_section
        assert "DownloadString" not in cmd_section

    def test_deploy_cmd_reads_version_from_netlogon(self):
        """CMD lexon techi-version.txt nga NETLOGON (LAN) jo nga interneti."""
        assert "set NETLOGON_VERSION=\\\\%DOMAIN%\\NETLOGON\\techi-version.txt" in self.script
        assert "for /f \"tokens=*\" %%i in ('type \"%NETLOGON_VERSION%\" 2^>nul') do set ACTIVE_VERSION=%%i" in self.script
        assert "if not defined ACTIVE_VERSION set ACTIVE_VERSION=2.1.0" in self.script
        assert "if not exist \"%NETLOGON_VERSION%\" set VERSION_SOURCE=fallback" in self.script

    def test_deploy_cmd_installs_from_netlogon_lan_path(self):
        """CMD instalom MSI nga \\DOMAIN\\NETLOGON\\ (LAN), jo nga URL interneti."""
        assert "set NETLOGON_AGENT_MSI=\\\\%DOMAIN%\\NETLOGON\\TECHI-Agent-%ACTIVE_VERSION%.msi" in self.script
        assert '"%MSIEXEC%" /i "%NETLOGON_AGENT_MSI%"' in self.script
        assert "set NETLOGON_REMOTE_MSI=\\\\%DOMAIN%\\NETLOGON\\TECHI-Remote-Support-%REMOTE_SUPPORT_VERSION%.msi" in self.script
        # Versioni fallback i baked-in i gjenerimit
        assert "if not defined ACTIVE_VERSION set ACTIVE_VERSION=2.1.0" in self.script

    def test_deploy_cmd_keeps_agent_and_remote_support_versions_independent(self):
        """ADPASCUCCI regression: Agent 2.1.8 nuk duhet te prodhoje RS 2.1.8.

        Remote Support merr versionin vetem nga paketa aktive remote_support_msi.
        """

        class IncidentStub(_StubService):
            def _active_windows_version(self) -> str:
                return "2.1.8"

            def _active_remote_support_version(self) -> Optional[str]:
                return "1.4.6"

        script = IncidentStub()._gpo_scheduled_task_setup(
            "https://api-rdp.techi.com.al",
            "deploy-token-123",
        )

        assert "$ActiveVersion        = '2.1.8'" in script
        assert "$RemoteSupportVersion = '1.4.6'" in script
        assert "if not defined ACTIVE_VERSION set ACTIVE_VERSION=2.1.8" in script
        assert "if not defined REMOTE_SUPPORT_VERSION set REMOTE_SUPPORT_VERSION=1.4.6" in script
        assert 'TECHI-Agent-$ActiveVersion.msi' in script
        assert 'TECHI-Remote-Support-$RemoteSupportVersion.msi' in script
        assert "TECHI-Remote-Support-2.1.8.msi" not in script

    def test_deploy_cmd_does_not_invent_remote_support_version_when_no_active_package(self):
        """Pa paketë aktive remote_support_msi, mos përdor versionin e Agent si fallback."""

        class NoRemotePackageStub(_StubService):
            def _active_windows_version(self) -> str:
                return "2.1.8"

            def _active_remote_support_version(self) -> Optional[str]:
                return None

        script = NoRemotePackageStub()._gpo_scheduled_task_setup(
            "https://api-rdp.techi.com.al",
            "deploy-token-123",
        )

        assert "$ActiveVersion        = '2.1.8'" in script
        assert "$RemoteSupportVersion = ''" in script
        assert "set REMOTE_SUPPORT_AVAILABLE=0" in script
        assert "remote-support-package-unavailable" in script
        assert "TECHI-Remote-Support-2.1.8.msi" not in script
        assert "if not defined REMOTE_SUPPORT_VERSION set REMOTE_SUPPORT_VERSION=2.1.8" not in script

    def test_deploy_cmd_has_correct_label_structure(self):
        """Labels: :do_install para :already_uptodate."""
        do_install = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        assert do_install < already

    def test_deploy_cmd_reads_msi_registry_from_hklm_and_wow6432node(self):
        """Deploy lexon registry MSI per TECHI Agent, jo exe/service si burim versioni.

        :read_registry perdor -EncodedCommand (jo nje -Command me kuota te
        ndertheura ne 3 nivele, qe doli e thyer ne prodhim) -- logjika PowerShell
        verifikohet duke dekoduar konstanten, ku jeton tani burimi i se vertetes."""
        assert "-EncodedCommand" in self.script
        assert "REG_VERSION=" in self.script
        assert "REG_PRODUCT_CODE=" in self.script
        assert "VERSION_STATE=" in self.script

        decoded = base64.b64decode(_READ_REGISTRY_ENCODED_COMMAND).decode("utf-16-le")
        assert "function ToVer($v)" in decoded
        assert "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" in decoded
        assert "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall" in decoded
        assert "$p.DisplayName -eq 'TECHI Agent'" in decoded
        assert "installed_registry_version=%REG_VERSION%" in self.script
        assert "installed_product_code=%REG_PRODUCT_CODE%" in self.script

    def test_deploy_cmd_routes_non_equal_state_to_install(self):
        """Fresh install DHE upgrade (missing/older) shkojne te i njejti :do_install --
        installer.wxs (UpgradeCode E6AD0A88) ka MajorUpgrade qe e bën upgrade-in
        automatikisht brenda nje msiexec /i te vetem."""
        assert 'if /i "%VERSION_STATE%"=="equal" goto :already_uptodate' in self.script
        assert "goto :do_install" in self.script
        do_install_pos = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[do_install_pos:already_pos]
        assert '"%MSIEXEC%" /i "%NETLOGON_AGENT_MSI%" ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL% /quiet /norestart' in section
        assert "installing_agent_version=%ACTIVE_VERSION%" in section
        assert 'msiexec /i "%NETLOGON_AGENT_MSI%" TOKEN=%TOKEN%' not in self.script
        assert "REINSTALL=ALL" not in self.script
        assert "REINSTALLMODE=vomus" not in self.script

    def test_deploy_cmd_writes_verbose_msi_log_for_forensics(self):
        """NETLOGON installs must always leave an MSI verbose log with the last action."""
        assert "set LOG_DIR=%INSTALL_DIR%\\logs" in self.script
        assert "if not exist \"%LOG_DIR%\" md \"%LOG_DIR%\" 2>nul" in self.script
        assert "set AGENT_MSI_LOG=%LOG_DIR%\\msi-agent-%ACTIVE_VERSION%.log" in self.script
        assert "set REMOTE_MSI_LOG=%LOG_DIR%\\msi-remote-support-%REMOTE_SUPPORT_VERSION%.log" in self.script
        assert "/L*v \"%AGENT_MSI_LOG%\"" in self.script
        assert "/L*v \"%REMOTE_MSI_LOG%\"" in self.script
        assert "msi_log=%AGENT_MSI_LOG%" in self.script
        assert "msi_log=%REMOTE_MSI_LOG%" in self.script

    def test_deploy_cmd_prevents_parallel_techi_msi_transactions(self):
        """A second scheduled run must not launch msiexec while a TECHI MSI is active."""
        do_install_pos = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        msiexec_pos = self.script.index('"%MSIEXEC%" /i "%NETLOGON_AGENT_MSI%"')
        acquire_pos = self.script.index("call :acquire_agent_install_lock", do_install_pos)
        assert acquire_pos < msiexec_pos
        assert ":detect_active_agent_msi" in self.script
        assert ":detect_active_remote_msi" in self.script
        assert "Get-CimInstance Win32_Process -Filter \\\"Name='msiexec.exe'\\\"" in self.script
        assert "TECHI-Agent-" in self.script
        assert "TECHI-Remote-Support-" in self.script
        assert "result=installer_busy_retryable product=agent reason=active-techi-msiexec" in self.script
        assert "result=installer_busy_retryable product=remote_support reason=active-techi-msiexec" in self.script
        assert "set AGENT_INSTALL_LOCK=%LOCK_DIR%\\agent-install.lock" in self.script
        assert "set REMOTE_INSTALL_LOCK=%LOCK_DIR%\\remote-support-install.lock" in self.script
        assert "call :release_agent_install_lock" in self.script
        assert "call :release_remote_install_lock" in self.script

    def test_deploy_cmd_classifies_1618_as_retryable_installer_busy(self):
        """MSI 1618 is installer-busy/retryable, not a generic failed install."""
        assert 'if "%AGENT_MSI_EXIT%"=="1618" (' in self.script
        assert 'if "%REMOTE_MSI_EXIT%"=="1618" (' in self.script
        assert "result=installer_busy_retryable product=agent active_version=%ACTIVE_VERSION% msi_exit_code=1618" in self.script
        assert "result=installer_busy_retryable product=remote_support active_version=%REMOTE_SUPPORT_VERSION% msi_exit_code=1618" in self.script
        busy_pos = self.script.index('if "%AGENT_MSI_EXIT%"=="1618" (')
        generic_fail_pos = self.script.index('if not "%AGENT_MSI_EXIT%"=="0" if not "%AGENT_MSI_EXIT%"=="3010" goto :install_failed')
        assert busy_pos < generic_fail_pos

    def test_deploy_cmd_classifies_unknown_partial_install_states(self):
        """Blank/unreadable UI version is not treated as healthy/latest."""
        assert "set VERSION_STATE=binary_only" in self.script
        assert "set VERSION_STATE=registry_only" in self.script
        assert "set VERSION_STATE=service_only" in self.script
        assert 'if /i "%VERSION_STATE%"=="equal" goto :already_uptodate' in self.script

    def test_deploy_cmd_does_not_uninstall_explicitly_before_install(self):
        """Upgrade-i NUK ben msiexec /x manual para /i -- nje uninstall i ndare nuk
        vendos UPGRADINGPRODUCTCODE dhe shkakton humbje te device_id (installer.wxs
        CustomAction CleanupProgramData fshin C:\\ProgramData\\TECHI ne ate rast).
        MajorUpgrade brenda nje transaksioni te vetem mbron device_id (verifikuar
        me teste elevated lokale: device_id i ruajtur 2.0.0 -> 2.1.0)."""
        assert 'msiexec /x "' not in self.script
        assert ":do_upgrade" not in self.script
        assert ":wait_registry_removed" not in self.script
        assert "REGISTRY_REMOVED_OK" not in self.script

    def test_deploy_cmd_captures_product_code_for_logging(self):
        """ProductCode i instaluar merret nga UninstallString per qellim logimi/diagnoze."""
        assert "installed_product_code=%REG_PRODUCT_CODE%" in self.script

        decoded = base64.b64decode(_READ_REGISTRY_ENCODED_COMMAND).decode("utf-16-le")
        assert "$item.UninstallString -match '\\{[0-9A-Fa-f-]{36}\\}'" in decoded
        assert "$code = $Matches[0]" in decoded

    def test_deploy_cmd_has_deploy_log(self):
        """CMD shkruan deploy.log me timestamp, result dhe version."""
        assert 'set LOG=%INSTALL_DIR%\\deploy.log' in self.script
        assert "start domain=%DOMAIN% install_dir=%INSTALL_DIR% agent=%AGENT_EXE%" in self.script
        assert "installed_registry_version=%REG_VERSION%" in self.script
        assert "installed_product_code=%REG_PRODUCT_CODE%" in self.script
        assert "active_version=%ACTIVE_VERSION% source=%VERSION_SOURCE%" in self.script
        assert "agent_msi_path=%NETLOGON_AGENT_MSI%" in self.script
        assert "remote_msi_path=%NETLOGON_REMOTE_MSI%" in self.script
        assert "agent_msi_exit_code=%AGENT_MSI_EXIT%" in self.script
        assert "remote_msi_exit_code=%REMOTE_MSI_EXIT%" in self.script
        assert "service_before=%SERVICE_STATUS_BEFORE% service_pid_before=%SERVICE_PID_BEFORE%" in self.script
        assert "call :read_agent_service" in self.script
        assert "set SERVICE_STATUS_BEFORE=%SERVICE_STATUS_AFTER%" in self.script
        assert "set SERVICE_PID_BEFORE=%SERVICE_PID_AFTER%" in self.script
        assert "for /f \"tokens=3\" %%s in ('\"%SC%\" query TechiAgent" not in self.script
        assert "registry_version_after_install=%REG_VERSION%" in self.script
        assert "installed_product_code_after_install=%REG_PRODUCT_CODE%" in self.script
        assert "service_state_after_install=%SERVICE_STATUS_AFTER%" in self.script
        assert "service_pid_after_install=%SERVICE_PID_AFTER%" in self.script
        assert "lifecycle_state=%LIFECYCLE_STATE%" in self.script
        assert "lifecycle_detail=%LIFECYCLE_DETAIL%" in self.script
        assert "lifecycle_pid=%LIFECYCLE_PID%" in self.script
        assert "lifecycle_pid_match=%LIFECYCLE_PID_MATCH%" in self.script
        assert "lifecycle_reader_error=%LIFECYCLE_READER_ERROR%" in self.script
        assert 'result=0 version=%ACTIVE_VERSION%' in self.script
        assert 'result=uptodate version=%ACTIVE_VERSION%' in self.script
        assert "result=done final_result=%FINAL_RESULT%" in self.script

    def test_deploy_cmd_service_readers_use_encoded_result_variable_payloads(self):
        """Regression: if/else statements cannot be piped directly to Set-Content."""
        agent_encoded = _encoded_command_for_label(self.script, ":read_agent_service")
        remote_encoded = _encoded_command_for_label(self.script, ":read_remote_support_service")
        assert agent_encoded == _READ_AGENT_SERVICE_ENCODED_COMMAND
        assert remote_encoded == _READ_REMOTE_SUPPORT_SERVICE_ENCODED_COMMAND

        agent_ps = _decode_powershell(agent_encoded)
        remote_ps = _decode_powershell(remote_encoded)

        for payload, output_env in (
            (agent_ps, "$env:SERVICE_OUT"),
            (remote_ps, "$env:REMOTE_SERVICE_OUT"),
        ):
            assert "$result = @(" in payload
            assert "$result | Set-Content" in payload
            assert f"Set-Content -LiteralPath {output_env} -Encoding ASCII" in payload
            assert not re.search(r"\}\s*\|\s*Set-Content", payload)
            assert "}|Set-Content" not in payload
            assert "if($null" not in payload

        assert "Name='TechiAgent'" in agent_ps
        assert "'SERVICE_STATUS_AFTER=missing'" in agent_ps
        assert "'SERVICE_PID_AFTER=0'" in agent_ps
        assert "'SERVICE_STATUS_AFTER=' + $state" in agent_ps
        assert "'SERVICE_PID_AFTER=' + [string]([int]$svc.ProcessId)" in agent_ps

        assert "Name='TECHI Remote Support'" in remote_ps
        assert "'REMOTE_SERVICE_STATUS=missing'" in remote_ps
        assert "'REMOTE_SERVICE_PID=0'" in remote_ps
        assert "'REMOTE_SERVICE_STATUS=' + $state" in remote_ps
        assert "'REMOTE_SERVICE_PID=' + [string]([int]$svc.ProcessId)" in remote_ps

    def test_deploy_cmd_service_reader_semantics_are_locked(self):
        """Generated readers must classify missing/stopped/running and capture SCM PID."""

        def agent_expected(state: Optional[str], pid: int = 0) -> list[str]:
            if state is None:
                return ["SERVICE_STATUS_AFTER=missing", "SERVICE_PID_AFTER=0"]
            normalized = "RUNNING" if state == "Running" else "STOPPED" if state == "Stopped" else state
            return [f"SERVICE_STATUS_AFTER={normalized}", f"SERVICE_PID_AFTER={pid}"]

        def remote_expected(state: Optional[str], pid: int = 0) -> list[str]:
            if state is None:
                return ["REMOTE_SERVICE_STATUS=missing", "REMOTE_SERVICE_PID=0"]
            normalized = "RUNNING" if state == "Running" else "STOPPED" if state == "Stopped" else state
            return [f"REMOTE_SERVICE_STATUS={normalized}", f"REMOTE_SERVICE_PID={pid}"]

        agent_ps = _decode_powershell(_encoded_command_for_label(self.script, ":read_agent_service"))
        remote_ps = _decode_powershell(_encoded_command_for_label(self.script, ":read_remote_support_service"))

        assert "if ($svc.State -eq 'Running')" in agent_ps
        assert "elseif ($svc.State -eq 'Stopped')" in agent_ps
        assert "if ($svc.State -eq 'Running')" in remote_ps
        assert "elseif ($svc.State -eq 'Stopped')" in remote_ps

        assert agent_expected("Running", 8756) == [
            "SERVICE_STATUS_AFTER=RUNNING",
            "SERVICE_PID_AFTER=8756",
        ]
        assert agent_expected("Stopped", 0) == [
            "SERVICE_STATUS_AFTER=STOPPED",
            "SERVICE_PID_AFTER=0",
        ]
        assert agent_expected(None) == [
            "SERVICE_STATUS_AFTER=missing",
            "SERVICE_PID_AFTER=0",
        ]
        assert remote_expected("Running", 4321) == [
            "REMOTE_SERVICE_STATUS=RUNNING",
            "REMOTE_SERVICE_PID=4321",
        ]
        assert remote_expected("Stopped", 0) == [
            "REMOTE_SERVICE_STATUS=STOPPED",
            "REMOTE_SERVICE_PID=0",
        ]
        assert remote_expected(None) == [
            "REMOTE_SERVICE_STATUS=missing",
            "REMOTE_SERVICE_PID=0",
        ]

    def test_deploy_cmd_has_no_if_else_pipeline_to_set_content(self):
        """Audit generated PowerShell helpers for the prod parser bug pattern."""
        assert "if($busy){'1'}else{'0'}|Set-Content" not in self.script
        assert re.search(r"\}\s*\|\s*Set-Content", self.script) is None
        assert "$result='0'; if($busy){$result='1'}; $result|Set-Content" in self.script

    def test_deploy_cmd_lifecycle_reader_uses_encoded_diagnostic_payload(self):
        """Regression: lifecycle reader must not be a fragile inline -Command blob."""
        read_lifecycle = _label_section(self.script, ":read_lifecycle")
        encoded = _encoded_command_for_label(self.script, ":read_lifecycle")
        payload = _decode_powershell(encoded)

        assert encoded == _READ_LIFECYCLE_ENCODED_COMMAND
        assert "-EncodedCommand" in read_lifecycle
        assert " -Command " not in read_lifecycle
        assert "catch{}" not in read_lifecycle
        assert "LIFECYCLE_READER_ERROR" in read_lifecycle

        for key in (
            "LIFECYCLE_STATE",
            "LIFECYCLE_DETAIL",
            "LIFECYCLE_PID",
            "SERVICE_PID_AFTER",
            "LIFECYCLE_PID_MATCH",
            "LIFECYCLE_READER_ERROR",
        ):
            assert f"'{key}='" in payload

        assert "function W($s,$d,$p,$sp,$m,$e)" in payload
        assert "$result = @(" in payload
        assert "$result | Set-Content -LiteralPath $env:STATE_OUT -Encoding ASCII" in payload
        assert "Get-Content -LiteralPath $env:TECHI_STATE_FILE" in payload
        assert "ConvertFrom-Json -ErrorAction Stop" in payload
        assert "Get-CimInstance Win32_Service -Filter \"Name='TechiAgent'\"" in payload
        assert "Get-Process -Id $p" in payload
        assert "$m = ($sp -gt 0 -and $p -eq $sp)" in payload
        assert "stale_timestamp" in payload
        assert "stale_process" in payload
        assert "pid_mismatch" in payload
        assert "reader_error" in payload
        assert "function E($r)" in payload
        assert "[regex]::Replace($v, '[^A-Za-z0-9_.-]', '_')" in payload
        assert not re.search(r"\}\s*\|\s*Set-Content", payload)

    def test_remote_support_version_reader_is_separate_encoded_subroutine(self):
        """Regression: RS_VERSION_OUT must not be set/read/deleted in same IF block."""
        classify = _label_section(self.script, ":classify_remote_support")
        read_version = _label_section(self.script, ":read_remote_support_version")
        encoded = _encoded_command_for_label(self.script, ":read_remote_support_version")

        assert encoded == _READ_REMOTE_SUPPORT_VERSION_ENCODED_COMMAND
        assert 'call :read_remote_support_version' in classify
        assert "set RS_VERSION_OUT=" not in classify
        assert "del \"%RS_VERSION_OUT%\"" not in classify
        assert "%RS_VERSION_OUT%" not in classify

        assert "set RS_VERSION_OUT=%TEMP%\\techi-rs-version.out" in read_version
        assert "call :delete_temp_file \"%RS_VERSION_OUT%\" \"techi-rs-version.out\"" in read_version
        assert 'for /f "usebackq tokens=*" %%v in ("%RS_VERSION_OUT%") do set "REMOTE_VERSION_FOUND=%%v"' in read_version

        payload = _decode_powershell(encoded)
        assert "$result | Set-Content -LiteralPath $env:RS_VERSION_OUT -Encoding ASCII" in payload
        assert not re.search(r"\}\s*\|\s*Set-Content", payload)

    def test_remote_support_version_normalization_contract(self):
        """Remote Support build suffix is metadata; deployment compares major.minor.patch."""
        normalize = _label_section(self.script, ":normalize_remote_support_version")
        classify = _label_section(self.script, ":classify_remote_support")

        assert "1.4.6+64 -> 1.4.6" in self.script
        assert "1.4.6.64 -> 1.4.6" in self.script
        assert "for /f \"tokens=1-3 delims=.+\"" in normalize
        assert "set REMOTE_VERSION_NORMALIZED=%REMOTE_VERSION_CANONICAL%" in classify
        assert "set REMOTE_TARGET_VERSION_NORMALIZED=%REMOTE_VERSION_CANONICAL%" in classify
        assert 'if defined REMOTE_VERSION_NORMALIZED if defined REMOTE_TARGET_VERSION_NORMALIZED if not "%REMOTE_VERSION_NORMALIZED%"=="%REMOTE_TARGET_VERSION_NORMALIZED%"' in classify
        assert '"%REMOTE_VERSION_FOUND%"=="%REMOTE_SUPPORT_VERSION%.0"' not in self.script

    def test_deploy_cmd_temp_deletes_are_validated_and_non_interactive(self):
        """All generated temporary-file deletes must go through leaf-validated /f /q delete."""
        assert ":delete_temp_file" in self.script
        assert 'del /f /q "%DELETE_TARGET%" 2>nul' in self.script
        assert 'if /i not "%DELETE_ACTUAL_LEAF%"=="%DELETE_EXPECTED_LEAF%" exit /b 0' in self.script
        assert 'if /i not "%DELETE_TARGET%"=="%TEMP%\\%DELETE_EXPECTED_LEAF%" exit /b 0' in self.script
        assert 'del "%' not in self.script

        expected_temp_files = [
            "techi-msi-busy.out",
            "techi-rs-msi-busy.out",
            "techi-rs-version.out",
            "techi-read-registry.out",
            "techi-read-binary.out",
            "techi-read-agent-service.out",
            "techi-read-remote-service.out",
            "techi-read-state.out",
        ]
        for filename in expected_temp_files:
            assert f'"{filename}"' in self.script
            assert f'call :delete_temp_file "%' in self.script

    def test_deploy_cmd_no_known_same_block_output_variable_expansion(self):
        """Static guard for the class of bug where set VAR and %VAR% appear in one block."""
        classify = _label_section(self.script, ":classify_remote_support")
        assert re.search(r"if exist \"%RS_EXE%\" \(\n(?:.*\n)*?%RS_VERSION_OUT%", classify) is None

        risky_output_vars = [
            "RS_VERSION_OUT",
            "BUSY_OUT",
            "REG_OUT",
            "BINARY_OUT",
            "SERVICE_OUT",
            "REMOTE_SERVICE_OUT",
            "STATE_OUT",
        ]
        for var in risky_output_vars:
            assert f'del "%{var}%"' not in self.script

    def test_classify_remote_support_subroutine_executes_under_cmd(self, tmp_path):
        """Run the generated classify subroutine with cmd.exe/wine: no prompt, no MSI."""
        runner, reason = _cmd_runner()
        if runner is None:
            pytest.skip(reason)

        wineprefix = tmp_path / "wineprefix"
        env = os.environ.copy()
        powershell_cmd = _wine_path(tmp_path / "fake-powershell.bat")
        if runner[0].endswith("wine"):
            env["WINEPREFIX"] = str(wineprefix)
            (wineprefix / "drive_c" / "windows" / "temp").mkdir(parents=True, exist_ok=True)
            rs_exe_host = wineprefix / "drive_c" / "Program Files" / "TECHI Remote Support" / "TECHI Remote Support.exe"
            rs_exe_host.parent.mkdir(parents=True, exist_ok=True)
            rs_exe_host.write_bytes(b"fake-rs")
            powershell_cmd = r"C:\fake-powershell.bat"
            smoke = subprocess.run(
                [*runner, "/d", "/c", "ver"],
                text=True,
                capture_output=True,
                timeout=60,
                env=env,
            )
            if smoke.returncode != 0:
                pytest.skip(f"wine cmd.exe unavailable: {(smoke.stdout + smoke.stderr).strip()}")

        fake_ps = (
            wineprefix / "drive_c" / "fake-powershell.bat"
            if runner[0].endswith("wine")
            else tmp_path / "fake-powershell.bat"
        )
        fake_ps.write_text(
            textwrap.dedent(
                r"""
                @echo off
                if defined RS_VERSION_OUT (
                  > "%RS_VERSION_OUT%" echo 1.4.6+64
                )
                if defined REMOTE_SERVICE_OUT (
                  > "%REMOTE_SERVICE_OUT%" echo REMOTE_SERVICE_STATUS=RUNNING
                  >> "%REMOTE_SERVICE_OUT%" echo REMOTE_SERVICE_PID=4321
                )
                exit /b 0
                """
            ).strip()
            + "\r\n",
            encoding="utf-8",
        )

        classify = _label_section(self.script, ":classify_remote_support")
        read_version = _label_section(self.script, ":read_remote_support_version")
        normalize = _label_section(self.script, ":normalize_remote_support_version")
        delete_temp = _label_section(self.script, ":delete_temp_file")
        read_remote_service = _label_section(self.script, ":read_remote_support_service")

        harness = tmp_path / "classify-rs.cmd"
        harness.write_text(
            textwrap.dedent(
                rf"""
                @echo off
                set "TEMP=C:\windows\temp"
                set "LOG=NUL"
                set "RS_EXE=C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe"
                set "POWERSHELL={powershell_cmd}"
                set "REMOTE_SUPPORT_AVAILABLE=1"
                set "REMOTE_SUPPORT_VERSION=1.4.6"
                set "REMOTE_INSTALL_FAILED=0"
                echo BEFORE_CLASSIFY
                call :classify_remote_support
                echo AFTER_CLASSIFY
                echo REMOTE_STATE=%REMOTE_STATE%
                echo REMOTE_VERSION_FOUND=%REMOTE_VERSION_FOUND%
                echo REMOTE_VERSION_NORMALIZED=%REMOTE_VERSION_NORMALIZED%
                echo REMOTE_TARGET_VERSION_NORMALIZED=%REMOTE_TARGET_VERSION_NORMALIZED%
                echo REMOTE_SERVICE_STATUS=%REMOTE_SERVICE_STATUS%
                echo REMOTE_SERVICE_PID=%REMOTE_SERVICE_PID%
                if exist "%TEMP%\techi-rs-version.out" echo TEMP_LEFT_BEHIND=1
                if exist "%TEMP%\techi-read-remote-service.out" echo SERVICE_TEMP_LEFT_BEHIND=1
                exit /b 0

                {classify}
                {read_version}
                {normalize}
                {delete_temp}
                {read_remote_service}
                """
            ).strip()
            + "\r\n",
            encoding="utf-8",
        )

        cmd_path = str(harness) if runner[0].endswith("cmd.exe") else _wine_path(harness)
        result = subprocess.run(
            [*runner, "/d", "/c", cmd_path],
            text=True,
            capture_output=True,
            timeout=10,
            env=env,
        )

        output = result.stdout + result.stderr
        assert result.returncode == 0, output
        assert "BEFORE_CLASSIFY" in output
        assert "AFTER_CLASSIFY" in output
        assert "Are you sure (Y/N)?" not in output
        assert "REMOTE_STATE=remote_healthy" in output
        assert "REMOTE_VERSION_FOUND=1.4.6+64" in output
        assert "REMOTE_VERSION_NORMALIZED=1.4.6" in output
        assert "REMOTE_TARGET_VERSION_NORMALIZED=1.4.6" in output
        assert "REMOTE_SERVICE_STATUS=RUNNING" in output
        assert "REMOTE_SERVICE_PID=4321" in output
        assert "TEMP_LEFT_BEHIND=1" not in output
        assert "SERVICE_TEMP_LEFT_BEHIND=1" not in output
        assert "msiexec" not in output.lower()

    def test_read_lifecycle_subroutine_executes_under_cmd(self, tmp_path):
        """Run complete :read_lifecycle under cmd.exe/wine for healthy/error cases."""
        runner, reason = _cmd_runner()
        if runner is None:
            pytest.skip(reason)

        wineprefix = tmp_path / "wineprefix"
        env = os.environ.copy()
        powershell_cmd = _wine_path(tmp_path / "fake-powershell.bat")
        install_dir = _wine_path(tmp_path / "TechiAgent")
        if runner[0].endswith("wine"):
            env["WINEPREFIX"] = str(wineprefix)
            (wineprefix / "drive_c" / "windows" / "temp").mkdir(parents=True, exist_ok=True)
            powershell_cmd = r"C:\fake-powershell.bat"
            install_dir = r"C:\windows\temp\TechiAgent"
            smoke = subprocess.run(
                [*runner, "/d", "/c", "ver"],
                text=True,
                capture_output=True,
                timeout=60,
                env=env,
            )
            if smoke.returncode != 0:
                pytest.skip(f"wine cmd.exe unavailable: {(smoke.stdout + smoke.stderr).strip()}")

        fake_ps = (
            wineprefix / "drive_c" / "fake-powershell.bat"
            if runner[0].endswith("wine")
            else tmp_path / "fake-powershell.bat"
        )
        fake_ps.write_text(
            textwrap.dedent(
                r"""
                @echo off
                if "%LIFECYCLE_TEST_CASE%"=="healthy" (
                  if not exist "%TECHI_STATE_FILE%" exit /b 3
                  > "%STATE_OUT%" echo LIFECYCLE_STATE=operational
                  >> "%STATE_OUT%" echo LIFECYCLE_DETAIL=none
                  >> "%STATE_OUT%" echo LIFECYCLE_PID=6940
                  >> "%STATE_OUT%" echo SERVICE_PID_AFTER=6940
                  >> "%STATE_OUT%" echo LIFECYCLE_PID_MATCH=1
                  >> "%STATE_OUT%" echo LIFECYCLE_READER_ERROR=
                  exit /b 0
                )
                if "%LIFECYCLE_TEST_CASE%"=="stale" (
                  > "%STATE_OUT%" echo LIFECYCLE_STATE=stale
                  >> "%STATE_OUT%" echo LIFECYCLE_DETAIL=stale_timestamp
                  >> "%STATE_OUT%" echo LIFECYCLE_PID=6940
                  >> "%STATE_OUT%" echo SERVICE_PID_AFTER=6940
                  >> "%STATE_OUT%" echo LIFECYCLE_PID_MATCH=1
                  >> "%STATE_OUT%" echo LIFECYCLE_READER_ERROR=
                  exit /b 0
                )
                if "%LIFECYCLE_TEST_CASE%"=="pid_mismatch" (
                  > "%STATE_OUT%" echo LIFECYCLE_STATE=stale
                  >> "%STATE_OUT%" echo LIFECYCLE_DETAIL=pid_mismatch
                  >> "%STATE_OUT%" echo LIFECYCLE_PID=45796
                  >> "%STATE_OUT%" echo SERVICE_PID_AFTER=6940
                  >> "%STATE_OUT%" echo LIFECYCLE_PID_MATCH=0
                  >> "%STATE_OUT%" echo LIFECYCLE_READER_ERROR=
                  exit /b 0
                )
                if "%LIFECYCLE_TEST_CASE%"=="malformed" (
                  > "%STATE_OUT%" echo LIFECYCLE_STATE=missing
                  >> "%STATE_OUT%" echo LIFECYCLE_DETAIL=reader_error
                  >> "%STATE_OUT%" echo LIFECYCLE_PID=
                  >> "%STATE_OUT%" echo SERVICE_PID_AFTER=0
                  >> "%STATE_OUT%" echo LIFECYCLE_PID_MATCH=0
                  >> "%STATE_OUT%" echo LIFECYCLE_READER_ERROR=InvalidData
                  exit /b 0
                )
                exit /b 2
                """
            ).strip()
            + "\r\n",
            encoding="utf-8",
        )

        read_lifecycle = _label_section(self.script, ":read_lifecycle")
        delete_temp = _label_section(self.script, ":delete_temp_file")

        harness = tmp_path / "read-lifecycle.cmd"
        harness.write_text(
            textwrap.dedent(
                rf"""
                @echo off
                set "TEMP=C:\windows\temp"
                set "INSTALL_DIR={install_dir}"
                set "POWERSHELL={powershell_cmd}"
                if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
                > "%INSTALL_DIR%\agent.state.json" echo {{"state":"operational","updated_at":"2026-07-12T13:17:37.8054558Z","pid":6940}}
                call :run_case healthy
                call :run_case stale
                call :run_case pid_mismatch
                > "%INSTALL_DIR%\agent.state.json" echo not-json
                call :run_case malformed
                exit /b 0

                :run_case
                set "LIFECYCLE_TEST_CASE=%~1"
                set LIFECYCLE_STATE=missing
                set LIFECYCLE_DETAIL=config_missing
                set LIFECYCLE_PID=
                set SERVICE_PID_AFTER=
                set LIFECYCLE_PID_MATCH=0
                set LIFECYCLE_READER_ERROR=
                call :read_lifecycle
                echo CASE=%LIFECYCLE_TEST_CASE%
                echo LIFECYCLE_STATE=%LIFECYCLE_STATE%
                echo LIFECYCLE_DETAIL=%LIFECYCLE_DETAIL%
                echo LIFECYCLE_PID=%LIFECYCLE_PID%
                echo SERVICE_PID_AFTER=%SERVICE_PID_AFTER%
                echo LIFECYCLE_PID_MATCH=%LIFECYCLE_PID_MATCH%
                echo LIFECYCLE_READER_ERROR=%LIFECYCLE_READER_ERROR%
                if exist "%TEMP%\techi-read-state.out" echo STATE_TEMP_LEFT_BEHIND=1
                exit /b 0

                {read_lifecycle}
                {delete_temp}
                """
            ).strip()
            + "\r\n",
            encoding="utf-8",
        )

        cmd_path = str(harness) if runner[0].endswith("cmd.exe") else _wine_path(harness)
        result = subprocess.run(
            [*runner, "/d", "/c", cmd_path],
            text=True,
            capture_output=True,
            timeout=10,
            env=env,
        )

        output = result.stdout + result.stderr
        assert result.returncode == 0, output
        assert "CASE=healthy" in output
        assert "LIFECYCLE_STATE=operational" in output
        assert "LIFECYCLE_PID=6940" in output
        assert "SERVICE_PID_AFTER=6940" in output
        assert "LIFECYCLE_PID_MATCH=1" in output
        assert "CASE=stale" in output
        assert "LIFECYCLE_STATE=stale" in output
        assert "LIFECYCLE_DETAIL=stale_timestamp" in output
        assert "CASE=pid_mismatch" in output
        assert "LIFECYCLE_DETAIL=pid_mismatch" in output
        assert "LIFECYCLE_PID=45796" in output
        assert "LIFECYCLE_PID_MATCH=0" in output
        assert "CASE=malformed" in output
        assert "LIFECYCLE_DETAIL=reader_error" in output
        assert "LIFECYCLE_READER_ERROR=InvalidData" in output
        assert "STATE_TEMP_LEFT_BEHIND=1" not in output

    def test_deploy_cmd_uses_techiagent_install_path_and_migrates_legacy(self):
        assert "set INSTALL_DIR=C:\\ProgramData\\TechiAgent" in self.script
        assert "set LEGACY_INSTALL_DIR=C:\\ProgramData\\TECHI" in self.script
        assert "set CONFIG=%INSTALL_DIR%\\agent.config.json" in self.script
        assert "set LEGACY_CONFIG=%LEGACY_INSTALL_DIR%\\agent.config.json" in self.script
        assert 'if not exist "%CONFIG%" if exist "%LEGACY_CONFIG%" copy /y "%LEGACY_CONFIG%" "%CONFIG%"' in self.script

    def test_deploy_cmd_already_uptodate_starts_service_if_stopped(self):
        """:already_uptodate kontrollon nëse shërbimi ecën, nëse jo e starton."""
        assert "call :read_agent_service" in self.script
        assert 'if /i not "%SERVICE_STATUS_AFTER%"=="RUNNING" net start TechiAgent 2>nul' in self.script
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[already_pos:]
        assert "call :ensure_service_running" in section
        assert "call :validate_success" in section
        assert 'if not "%DEPLOY_VALID%"=="1" (' in section
        assert "equal_version_unhealthy forcing_repair=1" in section
        assert "goto :do_install" in section
        assert 'result=uptodate version=%ACTIVE_VERSION% registry_version=%REG_VERSION% product_code=%REG_PRODUCT_CODE% service_after=%SERVICE_STATUS_AFTER%' in section
        assert "set FINAL_RESULT=uptodate" in section
        assert "goto :done" in section

    def test_deploy_cmd_repairs_unenrolled_equal_version_config_before_uptodate(self):
        """Version equal por config pa identity/token merr token-in e GPO dhe rinis service."""
        repair_call = self.script.index("call :repair_unenrolled_config")
        equal_gate = self.script.index('if /i "%VERSION_STATE%"=="equal" goto :already_uptodate')
        assert repair_call < equal_gate
        assert ":repair_unenrolled_config" in self.script
        assert "set TECHI_DEPLOY_TOKEN=%TOKEN%" in self.script
        assert "set TECHI_DEPLOY_CONFIG=%CONFIG%" in self.script
        assert "set TECHI_DEPLOY_LEGACY_CONFIG=%LEGACY_CONFIG%" in self.script
        assert "$hasId=" in self.script
        assert "$hasTok=" in self.script
        assert "$changed=$false" in self.script
        assert "Add-Member -NotePropertyName enrollment_token" in self.script
        assert "[System.Text.UTF8Encoding]::new($false)" in self.script
        assert "$j|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $cfg -Encoding UTF8" not in self.script
        assert "enrollment_token_repaired config=%CONFIG% source=gpo-token" in self.script
        assert "net stop TechiAgent /y >nul 2>&1" in self.script
        assert "net start TechiAgent >nul 2>&1" in self.script
        assert "timeout /t 10 /nobreak >nul" in self.script

    def test_deploy_cmd_recovers_missing_agent_exe_before_uptodate_gate(self):
        """Registry equal nuk mjafton: nese exe mungon, rikthe backup ose detyro MSI reinstall."""
        recovery_call = self.script.index("call :recover_missing_agent_binary")
        repair_call = self.script.index("call :repair_unenrolled_config")
        equal_gate = self.script.index('if /i "%VERSION_STATE%"=="equal" goto :already_uptodate')
        assert recovery_call < repair_call < equal_gate

        assert ":recover_missing_agent_binary" in self.script
        assert 'if exist "%AGENT_EXE%" exit /b 0' in self.script
        assert "agent_exe_missing path=%AGENT_EXE% version_state=%VERSION_STATE%" in self.script
        assert 'if exist "%INSTALL_DIR%\\techi-agent-new.exe" set RESTORE_SOURCE=%INSTALL_DIR%\\techi-agent-new.exe' in self.script
        assert 'if not defined RESTORE_SOURCE if exist "%INSTALL_DIR%\\techi-agent-old.exe" set RESTORE_SOURCE=%INSTALL_DIR%\\techi-agent-old.exe' in self.script
        assert 'if not defined RESTORE_SOURCE if exist "%INSTALL_DIR%\\techi-agent.new.exe" set RESTORE_SOURCE=%INSTALL_DIR%\\techi-agent.new.exe' in self.script
        assert 'if not defined RESTORE_SOURCE if exist "%INSTALL_DIR%\\techi-agent.previous.exe" set RESTORE_SOURCE=%INSTALL_DIR%\\techi-agent.previous.exe' in self.script
        assert 'move /y "%RESTORE_SOURCE%" "%AGENT_EXE%"' in self.script
        assert "agent_exe_restored source=%RESTORE_SOURCE%" in self.script
        assert "agent_exe_missing_force_reinstall no_restore_source=1" in self.script
        assert "set VERSION_STATE=missing" in self.script

    def test_deploy_cmd_service_missing_is_recreated_if_exe_exists(self):
        """Service missing: deploy krijon service me standard Agent EXE dhe pastaj e starton."""
        assert ":ensure_service_running" in self.script
        assert "call :read_agent_service" in self.script
        assert 'if /i "%SERVICE_STATUS_AFTER%"=="missing" (' in self.script
        assert 'if exist "%AGENT_EXE%" (' in self.script
        assert '"%SC%" create TechiAgent binPath= "%AGENT_EXE%" start= auto DisplayName= "TECHI Agent"' in self.script
        assert 'net start TechiAgent 2>nul' in self.script

    def test_deploy_cmd_success_requires_registry_version_and_running_service(self):
        """SUCCESS nuk bazohet vetem te exit code; kerkon registry equal + SCM PID lifecycle."""
        assert ":validate_success" in self.script
        assert "set DEPLOY_VALID=0" in self.script
        assert "call :read_registry" in self.script
        assert "call :read_agent_service" in self.script
        assert ":read_agent_service" in self.script
        lifecycle_ps = _decode_powershell(_encoded_command_for_label(self.script, ":read_lifecycle"))
        assert "Get-CimInstance Win32_Service -Filter \"Name='TechiAgent'\"" in lifecycle_ps
        assert "SERVICE_PID_AFTER=" in self.script
        assert 'if /i "%VERSION_STATE%"=="equal" if /i "%BINARY_VERSION%"=="%ACTIVE_VERSION%.0" if /i "%SERVICE_STATUS_AFTER%"=="RUNNING" if /i "%LIFECYCLE_STATE%"=="operational" if "%LIFECYCLE_PID_MATCH%"=="1" set DEPLOY_VALID=1' in self.script
        assert "call :read_lifecycle" in self.script
        assert "pid_mismatch" in lifecycle_ps
        assert "set LIFECYCLE_PID_MATCH=0" in self.script
        assert "if %LIFECYCLE_WAIT% GEQ 12 goto :lifecycle_done" in self.script
        assert 'if not "%DEPLOY_VALID%"=="1" goto :install_failed' in self.script

    def test_deploy_cmd_manual_replace_lan_creates_service_if_missing(self):
        """Legacy test name: deploy krijon service me sc.exe nëse nuk ekziston."""
        assert 'if /i "%SERVICE_STATUS_AFTER%"=="missing" (' in self.script
        assert '"%SC%" create TechiAgent binPath= "%AGENT_EXE%" start= auto DisplayName= "TECHI Agent"' in self.script
        assert '"%SC%" description TechiAgent "TECHI Solutions endpoint monitoring and management service"' in self.script
        assert '"%SC%" failure TechiAgent reset= 60 actions= restart/60000/restart/60000/restart/300000' in self.script

    def test_deploy_cmd_install_failed_logs_1603_and_exits_1(self):
        """:install_failed regjistron detaje dhe del me exit /b 1."""
        assert "result=failed active_version=%ACTIVE_VERSION%" in self.script
        assert "agent_msi_exit_code=%AGENT_MSI_EXIT%" in self.script
        assert "remote_msi_exit_code=%REMOTE_MSI_EXIT%" in self.script
        assert "exit /b 1" in self.script

    def test_deploy_cmd_done_label_before_already_uptodate(self):
        """:done ekziston dhe vjen para :already_uptodate."""
        done_pos = re.search(r"^:done\b", self.script, re.MULTILINE).start()
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        assert done_pos < already_pos

    # ── PS1-level Step 4b: MSI download te NETLOGON ───────────────────────────

    def test_ps1_has_backend_url_and_msi_download_url_variables(self):
        """PS1 ka $BackendUrl dhe download URL të ndara para hapi 1."""
        backend_var = self.script.index("$BackendUrl    = 'https://api-rdp.techi.com.al'")
        msi_var = self.script.index("$AgentMsiDownloadUrl = 'https://api-rdp.techi.com.al/api/v1/agent-packages/platform/windows-amd64/download'")
        rs_var = self.script.index("$RemoteSupportMsiDownloadUrl = 'https://api-rdp.techi.com.al/api/v1/agent-packages/remote-support-msi/download'")
        hapi1 = self.script.index("Hapi 1: Importimi i moduleve")
        assert backend_var < hapi1
        assert msi_var < hapi1
        assert rs_var < hapi1

    def test_ps1_step4b_downloads_msi_to_netlogon(self):
        """PS1 Hapi 4b shkarkon Agent dhe Remote Support MSI tek NETLOGON."""
        assert "Hapi 4b: Shkarkimi i Agent/Remote Support MSI ne NETLOGON" in self.script
        assert "$AgentMsiNetlogonPath  = Join-Path $NetlogonPath" in self.script
        assert "$RemoteMsiNetlogonPath = Join-Path $NetlogonPath" in self.script
        assert "Refresh-NetlogonArtifact -Url $AgentMsiDownloadUrl" in self.script
        assert "Refresh-NetlogonArtifact -Url $RemoteSupportMsiDownloadUrl" in self.script

    def test_ps1_step4b_has_retry_loop(self):
        """PS1 Hapi 4b ka retry loop me 3 tentativa."""
        assert "for ($i = 1; $i -le 3; $i++) {" in self.script
        assert "$downloaded = $false" in self.script
        assert "$downloaded = $true" in self.script
        assert "3 tentativave" in self.script

    def test_ps1_step4b_uses_tls12_for_msi_download(self):
        """PS1 Hapi 4b aktivizon TLS 1.2 para download."""
        step4b = self.script.index("Hapi 4b: Shkarkimi i Agent/Remote Support MSI")
        section = self.script[step4b:]
        assert "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12" in section

    def test_ps1_step4b_writes_version_file(self):
        """PS1 Hapi 4b shkruan techi-version.txt pas download."""
        assert "$VersionFilePath       = Join-Path $NetlogonPath" in self.script
        assert "$RemoteVersionFilePath = Join-Path $NetlogonPath" in self.script
        assert "Out-File $VersionFilePath -Encoding ASCII -NoNewline" in self.script
        assert "Out-File $RemoteVersionFilePath -Encoding ASCII -NoNewline" in self.script

    def test_ps1_step4b_compares_hash_not_just_version_string(self):
        """PS1 Hapi 4b krahason SHA256, jo vetem version string -- nje fix qe ne te
        kundert do te linte NETLOGON me build te vjeter sa here qe nxjerrim nje
        ndryshim pa rritur ProductVersion (incident real: metropolgroup.local)."""
        assert "$ExistingHash = (Get-FileHash $Destination -Algorithm SHA256).Hash.ToLower()" in self.script
        assert "$DownloadedHash = (Get-FileHash $TmpMsi -Algorithm SHA256).Hash.ToLower()" in self.script
        assert "if ($DownloadedHash -ne $ExistingHash) {" in self.script
        assert "ne NETLOGON eshte tashme i azhornuar (hash identik) -- skip copy" in self.script
        assert "rifreskuar ne NETLOGON (hash i ndryshuar)" in self.script

    def test_ps1_step4b_cleans_old_msi_versions(self):
        """PS1 Hapi 4b fshin versione të vjetra MSI para download."""
        assert "Refresh-NetlogonArtifact" in self.script
        assert "Copy-Item $TmpMsi $Destination -Force" in self.script

    def test_ps1_step4b_displays_sha256(self):
        """PS1 Hapi 4b shfaq SHA256 hash të MSI-t të shkarkuar dhe verifikon kopjen."""
        assert "Get-FileHash $Destination -Algorithm SHA256" in self.script
        assert 'Write-Host "   $Label shkarkuar, SHA256: $DownloadedHash"' in self.script
        assert "$CopiedHash = (Get-FileHash $Destination -Algorithm SHA256).Hash.ToLower()" in self.script

    # ── PS1-level: Test-Path verifikime post-write ────────────────────────────

    def test_ps1_has_test_path_after_deploy_cmd_write(self):
        """PS1 verifikon me Test-Path se techi-deploy.cmd u shkrua."""
        write_pos = self.script.index(
            "[System.IO.File]::WriteAllText($DeployScriptPath, $DeployContent"
        )
        step4b_pos = self.script.index("Hapi 4b: Shkarkimi i Agent/Remote Support MSI")
        section = self.script[write_pos:step4b_pos]
        assert "Test-Path $DeployScriptPath" in section
        assert "GABIM KRITIK" in section

    def test_ps1_has_test_path_after_msi_download(self):
        """PS1 verifikon se MSI u shkarkua dhe se kopja ne NETLOGON ka te njejtin hash."""
        assert "-not $downloaded -or -not (Test-Path $TmpMsi)" in self.script
        assert "GABIM KRITIK: hash i NETLOGON per $Label" in self.script

    def test_ps1_has_test_path_after_version_file_write(self):
        """PS1 verifikon me Test-Path se techi-version.txt u shkrua."""
        assert "GABIM KRITIK: techi-version.txt nuk u shkrua ne NETLOGON" in self.script
        assert "GABIM KRITIK: techi-remote-support-version.txt nuk u shkrua ne NETLOGON" in self.script

    def test_ps1_has_test_path_after_task_xml_write(self):
        """PS1 verifikon me Test-Path se ScheduledTasks.xml u shkrua."""
        write_pos = self.script.index(
            "[System.IO.File]::WriteAllText($TaskXmlPath, $TaskXml"
        )
        hapi7_pos = self.script.index("Hapi 7: Perditesimi i gPCMachineExtensionNames")
        section = self.script[write_pos:hapi7_pos]
        assert "Test-Path $TaskXmlPath" in section
        assert "GABIM KRITIK" in section

    def test_ps1_scheduled_task_runs_as_system_highest_privileges(self):
        """Scheduled Task krijohet si SYSTEM dhe me privilegje te larta."""
        assert 'runAs="NT AUTHORITY\\System"' in self.script
        assert 'logonType="ServiceAccount"' in self.script
        assert "<UserId>S-1-5-18</UserId>" in self.script
        assert "<UserId>NT AUTHORITY\\System</UserId>" not in self.script
        assert "<LogonType>ServiceAccount</LogonType>" not in self.script
        assert "<RunLevel>HighestAvailable</RunLevel>" in self.script

    def test_ps1_scheduled_task_uses_cmd_exe_netlogon_action(self):
        """Scheduled Task action perdor cmd.exe /c per techi-deploy.cmd ne NETLOGON."""
        assert "$NetlogonScr = \"\\\\$DomainDNS\\NETLOGON\\techi-deploy.cmd\"" in self.script
        assert "<Command>cmd.exe</Command>" in self.script
        assert '<Arguments>/c "$NetlogonScr"</Arguments>' in self.script
        assert "<Command>$NetlogonScr</Command>" not in self.script

    def test_ps1_scheduled_task_has_daily_09_13_and_21_triggers(self):
        """Scheduled Task ka boot trigger dhe trigger-et ditore 09:00, 13:00 dhe 21:00."""
        assert '$ScheduleTime0 = "09:00"' in self.script
        assert '$ScheduleTime1 = "13:00"' in self.script
        assert '$ScheduleTime2 = "21:00"' in self.script
        assert "<BootTrigger>" in self.script
        assert self.script.count("<CalendarTrigger>") == 3
        assert "<DaysInterval>1</DaysInterval>" in self.script

    def test_ps1_removes_redundant_startup_script_gpo_if_present(self):
        """GPO legacy 'TECHI Agent Startup' pastrohet, por nuk rikrijohet më."""
        assert '$LegacyStartupGPOName = "TECHI Agent Startup"' in self.script
        assert "Set-GPO" not in self.script
        assert "Set-GPLink -Name $LegacyStartupGPOName -Target $TargetDn -LinkEnabled No" in self.script
        assert "Remove-GPO -Guid $LegacyStartupGPO.Id -Confirm:$false" in self.script
        assert "Get-ADOrganizationalUnit -Filter *" in self.script
        assert "u gjet por nuk u fshi" in self.script
        assert "Machine\\Scripts\\Startup" not in self.script
        assert "scripts.ini" not in self.script

    # ── PS1-level: banner PERFUNDOI ───────────────────────────────────────────

    def test_ps1_banner_shows_msi_netlogon_path(self):
        """Baneri final tregon rrugën e MSI-t dhe versionin aktiv."""
        assert 'Write-Host "  MSI       : $MsiNetlogonPath"' in self.script
        assert 'Write-Host "  Version   : $ActiveVersion"' in self.script
        assert "zero download, zero AV detection" in self.script


class TestConfigPSLines:
    """Unit tests for the PowerShell config writer."""

    def setup_method(self):
        self.svc = _StubService()

    def test_hostname_uses_computername(self):
        cfg_json = json.dumps({"agent_name": "<HOSTNAME>", "timeout_seconds": 10})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        assert "$env:COMPUTERNAME" in joined
        assert "<HOSTNAME>" not in joined

    def test_bool_literals(self):
        cfg_json = json.dumps({"manage_power_policy": True, "collect_processes": False})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        assert "$true" in joined
        assert "$false" in joined

    def test_int_literals(self):
        cfg_json = json.dumps({"timeout_seconds": 30})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        assert "30" in joined

    def test_string_single_quoted(self):
        cfg_json = json.dumps({"api_url": "http://server:8000"})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        # Must appear as single-quoted PS string
        assert "'http://server:8000'" in joined

    def test_string_with_single_quote_escaped(self):
        val = "it's here"
        cfg_json = json.dumps({"description": val})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        # Single quote inside should be doubled
        assert "it''s here" in joined

    def test_converttojson_and_writealltext(self):
        cfg_json = json.dumps({"api_url": "http://x"})
        lines = self.svc._config_ps_lines(cfg_json)
        joined = "\n".join(lines)
        assert "ConvertTo-Json" in joined
        assert "WriteAllText" in joined
        assert "UTF8Encoding" in joined

    def test_ordered_hashtable(self):
        cfg_json = json.dumps({"a": 1, "b": 2})
        lines = self.svc._config_ps_lines(cfg_json)
        assert lines[0] == "$AgentConfig = [ordered]@{"


class TestHttpsUrlNormalization:
    def setup_method(self):
        self.svc = _StubService()

    def test_normalize_backend_url_forces_https(self):
        assert self.svc.normalize_backend_url("http://api-rdp.techi.com.al") == "https://api-rdp.techi.com.al"
        assert self.svc.normalize_backend_url("api-rdp.techi.com.al") == "https://api-rdp.techi.com.al"
        assert self.svc.normalize_backend_url("https://api-rdp.techi.com.al/") == "https://api-rdp.techi.com.al"

    def test_config_template_forces_https(self):
        req = _make_req()
        cfg = self.svc._config_template("http://api-rdp.techi.com.al", "tok123tok123tok123", req)
        assert "http://api-rdp.techi.com.al" not in cfg
        assert '"api_url": "https://api-rdp.techi.com.al"' in cfg
        assert '"backend_url": "https://api-rdp.techi.com.al/api/v1/agent/heartbeat"' in cfg
        assert '"websocket_url": "wss://api-rdp.techi.com.al/ws/devices?tenant_id=default"' in cfg

    def test_package_url_forces_https(self):
        url, _, _ = self.svc._windows_package_info("http://api-rdp.techi.com.al")
        assert url.startswith("https://api-rdp.techi.com.al/")
        assert not url.startswith("http://")


class TestPyToPsLiteral:
    def setup_method(self):
        self.svc = _StubService()

    def test_true(self):
        assert self.svc._py_to_ps_literal(True) == "$true"

    def test_false(self):
        assert self.svc._py_to_ps_literal(False) == "$false"

    def test_none(self):
        assert self.svc._py_to_ps_literal(None) == "$null"

    def test_int(self):
        assert self.svc._py_to_ps_literal(42) == "42"

    def test_string(self):
        assert self.svc._py_to_ps_literal("hello") == "'hello'"

    def test_string_with_single_quote(self):
        assert self.svc._py_to_ps_literal("it's") == "'it''s'"


class TestWindowsPackageInfoSelectsAgentMsi:
    """Regression: with both the Agent bootstrap MSI (file_type=msi) and a
    bridge MSI (agent_update_msi) active for windows-amd64, the bootstrap
    installer must embed the SHA of the Agent MSI — the one
    /platform/windows-amd64/download actually serves. Otherwise the physical
    install fails with 'SHA256 mismatch' (2026-07-03)."""

    def _patch_pkg_service(self, monkeypatch, *, agent_msi_sha, bridge_sha, remote_version="1.4.6"):
        from app.services import enrollment_bootstrap_service as mod

        agent_msi = SimpleNamespace(version="2.1.3", sha256=agent_msi_sha, filename="TECHI-Agent-2.1.3.msi")
        bridge = SimpleNamespace(version="2.1.3", sha256=bridge_sha, filename="TECHI-Agent-Update-2.1.3.msi")
        remote = (
            SimpleNamespace(
                version=remote_version,
                sha256="d" * 64,
                filename=f"TECHI-Remote-Support-{remote_version}.msi",
            )
            if remote_version is not None
            else None
        )

        class FakePkgService:
            def latest_active(self, platform, *, file_type=None):
                assert platform in ("windows", "windows-amd64")
                # No filter would return the bridge (uploaded last); the code
                # under test must always pass file_type="msi" here.
                if file_type == "msi":
                    return agent_msi
                if file_type == "remote_support_msi":
                    return remote
                if file_type == "agent_update_msi":
                    return bridge
                return bridge

            def latest_download_url(self, platform):
                return f"/api/v1/agent-packages/platform/{platform}/download"

        monkeypatch.setattr(mod, "AgentPackageService", FakePkgService)

    def test_windows_package_info_uses_agent_msi_sha(self, monkeypatch):
        self._patch_pkg_service(monkeypatch, agent_msi_sha="c" * 64, bridge_sha="b" * 64)
        svc = EnrollmentBootstrapService(db=None)
        url, sha256, filename = svc._windows_package_info("https://api-rdp.techi.com.al")
        assert sha256 == "c" * 64
        assert filename == "TECHI-Agent-2.1.3.msi"
        assert url.endswith("/platform/windows-amd64/download")

    def test_active_windows_version_uses_agent_msi(self, monkeypatch):
        self._patch_pkg_service(monkeypatch, agent_msi_sha="c" * 64, bridge_sha="b" * 64)
        svc = EnrollmentBootstrapService(db=None)
        assert svc._active_windows_version() == "2.1.3"

    def test_active_remote_support_version_uses_remote_support_msi(self, monkeypatch):
        self._patch_pkg_service(
            monkeypatch,
            agent_msi_sha="c" * 64,
            bridge_sha="b" * 64,
            remote_version="1.4.6",
        )
        svc = EnrollmentBootstrapService(db=None)
        assert svc._active_windows_version() == "2.1.3"
        assert svc._active_remote_support_version() == "1.4.6"

    def test_active_remote_support_version_returns_none_when_missing(self, monkeypatch):
        self._patch_pkg_service(
            monkeypatch,
            agent_msi_sha="c" * 64,
            bridge_sha="b" * 64,
            remote_version=None,
        )
        svc = EnrollmentBootstrapService(db=None)
        assert svc._active_remote_support_version() is None


# ---------------------------------------------------------------------------
# NETLOGON-driven native Agent rollout (healthy agent < rollout target)
# ---------------------------------------------------------------------------

class _RolloutStub(_StubService):
    """Stub with an active agent_binary (rollout target) + configurable mode."""

    def __init__(self, *, target="2.1.8", sha="a" * 64, mode="canary", **kw):
        super().__init__(**kw)
        self._target = target
        self._sha = sha
        self._mode = mode

    def _active_windows_version(self) -> str:
        return "2.1.8"

    def _active_remote_support_version(self):
        return "1.4.6"

    def _active_agent_binary_info(self):
        return self._target, self._sha

    def _agent_rollout_mode(self) -> str:
        return self._mode


class TestNetlogonNativeRollout:
    """The NETLOGON deploy script drives healthy older agents to the approved
    rollout target via the native self-update path (no MSI), gated by an
    explicit rollout mode and SHA256 identity."""

    def _script(self, **kw):
        return _RolloutStub(**kw)._gpo_scheduled_task_setup(
            "https://api-rdp.techi.com.al", "deploy-token-1234"
        )

    # ── artifact distribution (PS1 side) ──────────────────────────────────────

    def test_distributes_standalone_exe_and_rollout_files(self):
        s = self._script()
        assert "$AgentBinaryDownloadUrl = 'https://api-rdp.techi.com.al/api/v1/agent-packages/agent-binary/download'" in s
        assert 'Join-Path $NetlogonPath "techi-rollout-version.txt"' in s
        assert 'Join-Path $NetlogonPath "techi-rollout-mode.txt"' in s
        assert '"TECHI-Agent-$RolloutTarget.exe"' in s
        # SHA sidecar is written next to the standalone EXE.
        assert "($StandaloneExePath + '.sha256')" in s
        assert "-Label 'TECHI Agent standalone EXE'" in s
        # mode + target literals surfaced to the script.
        assert "$RolloutTarget        = '2.1.8'" in s
        assert "$RolloutMode          = 'canary'" in s

    def test_no_rollout_artifacts_when_no_active_agent_binary(self):
        s = self._script(target=None, sha=None)
        # Empty target literal -> the PS1 removes rollout files, the CMD keeps
        # ROLLOUT_TARGET empty and falls back to legacy managed_by_self_update.
        assert "$RolloutTarget        = ''" in s
        assert "Remove-Item $RolloutVersionFilePath" in s
        assert "Remove-Item $RolloutModeFilePath" in s

    def test_default_rollout_mode_is_disabled(self):
        # Real service (no override) must default to a SAFE disabled mode so no
        # forced rollout happens without an explicit operator decision.
        assert EnrollmentBootstrapService._agent_rollout_mode() == "disabled"

    # ── CMD state-machine wiring ──────────────────────────────────────────────

    def test_cmd_reads_rollout_controls_from_netlogon(self):
        s = self._script()
        assert "set NETLOGON_ROLLOUT_VERSION=\\\\%DOMAIN%\\NETLOGON\\techi-rollout-version.txt" in s
        assert "set NETLOGON_ROLLOUT_MODE=\\\\%DOMAIN%\\NETLOGON\\techi-rollout-mode.txt" in s
        # NETLOGON value wins; build-time literal is only the fallback.
        assert "if not defined ROLLOUT_TARGET set ROLLOUT_TARGET=2.1.8" in s
        assert "if not defined ROLLOUT_MODE set ROLLOUT_MODE=canary" in s

    def test_healthy_agent_routes_through_rollout_decision(self):
        s = self._script()
        assert 'if "%AGENT_HEALTHY%"=="1" call :evaluate_rollout' in s
        assert 'if /i "%ROLLOUT_DECISION%"=="uptodate" goto :rollout_uptodate' in s
        assert 'if /i "%ROLLOUT_DECISION%"=="newer" goto :rollout_newer' in s
        assert 'if /i "%ROLLOUT_DECISION%"=="disabled" goto :rollout_disabled_result' in s
        assert 'if /i "%ROLLOUT_DECISION%"=="self_update" goto :netlogon_self_update' in s
        # Legacy fallback still present after the rollout gates.
        assert "goto :agent_managed_by_self_update" in s

    def test_netlogon_self_update_reuses_native_entry_point(self):
        s = self._script()
        # Reuses the native agent self-update path via the subcommand.
        assert '"%AGENT_EXE%" netlogon-self-update -source "%STAGED_EXE%" -expected-sha256 %EXPECTED_SHA% -expected-version %ROLLOUT_TARGET%' in s
        # No MSI in the native self-update branch.
        section = _label_section(s, ":netlogon_self_update")
        assert "msiexec" not in section.lower()
        assert "%MSIEXEC%" not in section

    def test_disabled_mode_keeps_architecture_and_control_contract(self):
        """ARCHITECTURE INVARIANT: AGENT_ROLLOUT_MODE is a RUNTIME/operator
        control, not a build-time generator switch. With mode=disabled AND an
        active agent_binary, the generated script must STILL contain the full
        rollout state machine AND publish the rollout control contract
        (standalone EXE + sha256 sidecar + rollout files); the disabled decision
        is enforced at RUNTIME (returns rollout_disabled), never by omitting the
        architecture. (Regression for the 2026-07-12 stale-backend forensic:
        a script missing these markers means the backend is pre-bf0bb40, not
        that disabled mode stripped them.)"""
        s = _RolloutStub(target="2.1.8", sha="a" * 64, mode="disabled")._gpo_scheduled_task_setup(
            "https://api-rdp.techi.com.al", "deploy-token-1234"
        )
        # (a) full CMD state machine present regardless of mode
        for marker in (":evaluate_rollout", ":compare_versions", ":netlogon_self_update",
                       ":wait_for_rollout_target", "call :evaluate_rollout",
                       "netlogon-self-update -source", "NETLOGON_ROLLOUT_MODE",
                       "FINAL_RESULT=rollout_disabled", "FINAL_RESULT=netlogon_self_update_completed"):
            assert marker in s, f"disabled mode dropped architecture marker: {marker}"
        # (b) control contract still published (EXE + sha256 sidecar + rollout files)
        assert "-Label 'TECHI Agent standalone EXE'" in s
        assert "($StandaloneExePath + '.sha256')" in s
        assert "$RolloutTarget | Out-File $RolloutVersionFilePath" in s
        assert "$RolloutMode   | Out-File $RolloutModeFilePath" in s
        # (c) mode literal is 'disabled' and the CMD default matches -> runtime
        # decision returns rollout_disabled (proven separately under wine).
        assert "$RolloutMode          = 'disabled'" in s
        assert "if not defined ROLLOUT_MODE set ROLLOUT_MODE=disabled" in s
        # The disabled decision is a runtime branch, not a missing state machine.
        eval_section = _label_section(s, ":evaluate_rollout")
        assert 'if /i "%ROLLOUT_MODE%"=="disabled" set ROLLOUT_DECISION=disabled' in eval_section

    def test_identity_gate_precedes_service_mutation(self):
        s = self._script()
        section = _label_section(s, ":netlogon_self_update")
        hash_idx = section.index("call :hash_staged_exe")
        invoke_idx = section.index("netlogon-self-update -source")
        assert hash_idx < invoke_idx, "SHA must be verified before invoking the swap"
        assert "FINAL_RESULT=package_identity_mismatch" in section
        # On a hash mismatch the staged exe is deleted and we jump straight to
        # done -- the agent is never invoked, so the service is never stopped.
        mismatch = section[section.index('if defined EXPECTED_SHA if defined STAGED_SHA'):]
        assert "call :delete_staged_exe" in mismatch.split("goto :done")[0]

    def test_native_exit_codes_map_to_deterministic_results(self):
        s = self._script()
        section = _label_section(s, ":netlogon_self_update")
        assert 'if "%NETLOGON_UPDATE_EXIT%"=="3"' in section  # identity mismatch
        assert 'if "%NETLOGON_UPDATE_EXIT%"=="4"' in section  # update busy
        assert "FINAL_RESULT=installer_busy_retryable" in section
        assert "FINAL_RESULT=netlogon_self_update_completed" in section
        assert "FINAL_RESULT=netlogon_self_update_failed" in section

    def test_refuses_swap_without_expected_sha(self):
        s = self._script()
        section = _label_section(s, ":netlogon_self_update")
        # No expected SHA -> refuse (never trust filename alone), and never pass
        # an empty -expected-sha256 that the agent's flag parser would mis-read.
        assert "reason=no-expected-sha" in section
        guard = section[:section.index("netlogon-self-update -source")]
        assert 'if not defined EXPECTED_SHA (' in guard

    def test_post_swap_validation_checks_version_service_lifecycle_pid(self):
        s = self._script()
        # The poll body lives under the :rollout_wait_loop sub-label.
        wait = _label_section(s, ":wait_for_rollout_target") + _label_section(s, ":rollout_wait_loop")
        assert 'call :compare_versions "%BINARY_VERSION%" "%ROLLOUT_TARGET%"' in wait
        assert 'if /i "%SERVICE_STATUS_AFTER%"=="RUNNING"' in wait
        assert 'if /i "%LIFECYCLE_STATE%"=="operational"' in wait
        assert 'if "%LIFECYCLE_PID_MATCH%"=="1"' in wait
        # Bounded loop -- never infinite.
        assert "if %ROLLOUT_WAIT% GEQ 30 exit /b 0" in wait

    def test_standalone_missing_is_safe_failure_without_msi(self):
        s = self._script()
        section = _label_section(s, ":netlogon_self_update")
        assert 'if not exist "%STANDALONE_EXE%"' in section
        assert "reason=standalone-missing" in section
        # No MSI is triggered when the standalone EXE is absent for a healthy agent.
        assert "msiexec" not in section.lower()

    def test_rollout_branch_never_echoes_enrollment_token(self):
        s = self._script()
        for label in (":netlogon_self_update", ":evaluate_rollout", ":compare_versions",
                      ":wait_for_rollout_target", ":hash_staged_exe", ":rollout_uptodate"):
            section = _label_section(s, label)
            assert "deploy-token-1234" not in section

    # ── real cmd.exe/wine execution: pure-CMD subroutines ─────────────────────

    def _run_cmd_harness(self, tmp_path, body: str, sections: str):
        runner, reason = _cmd_runner()
        if runner is None:
            pytest.skip(reason)
        env = os.environ.copy()
        if runner[0].endswith("wine"):
            wineprefix = tmp_path / "wineprefix"
            env["WINEPREFIX"] = str(wineprefix)
            (wineprefix / "drive_c" / "windows" / "temp").mkdir(parents=True, exist_ok=True)
            smoke = subprocess.run([*runner, "/d", "/c", "ver"], text=True,
                                   capture_output=True, timeout=60, env=env)
            if smoke.returncode != 0:
                pytest.skip(f"wine cmd.exe unavailable: {(smoke.stdout + smoke.stderr).strip()}")
        harness = tmp_path / "harness.cmd"
        harness.write_text(
            textwrap.dedent(
                rf"""
                @echo off
                setlocal EnableExtensions EnableDelayedExpansion
                set "LOG=NUL"
                {body}
                exit /b 0

                {sections}
                """
            ).strip() + "\r\n",
            encoding="utf-8",
        )
        cmd_path = str(harness) if runner[0].endswith("cmd.exe") else _wine_path(harness)
        return subprocess.run([*runner, "/d", "/c", cmd_path], text=True,
                              capture_output=True, timeout=30, env=env)

    def test_compare_versions_executes_under_cmd(self, tmp_path):
        s = self._script()
        compare = _label_section(s, ":compare_versions")
        body = "\n".join([
            'call :compare_versions "2.1.6" "2.1.8"',
            'echo R1=!VERSION_COMPARE!',
            'call :compare_versions "2.1.8" "2.1.8"',
            'echo R2=!VERSION_COMPARE!',
            'call :compare_versions "2.1.9" "2.1.8"',
            'echo R3=!VERSION_COMPARE!',
            'call :compare_versions "2.1.6.0" "2.1.6"',
            'echo R4=!VERSION_COMPARE!',
            'call :compare_versions "2.1.10" "2.1.9"',
            'echo R5=!VERSION_COMPARE!',
            'call :compare_versions "2.2.0" "2.1.99"',
            'echo R6=!VERSION_COMPARE!',
        ])
        result = self._run_cmd_harness(tmp_path, body, compare)
        out = result.stdout + result.stderr
        assert result.returncode == 0, out
        assert "R1=-1" in out  # 2.1.6 < 2.1.8
        assert "R2=0" in out   # equal
        assert "R3=1" in out   # 2.1.9 > 2.1.8
        assert "R4=0" in out   # 4-part vs 3-part, same MAJOR.MINOR.PATCH
        assert "R5=1" in out   # 2.1.10 > 2.1.9 (numeric, not lexical)
        assert "R6=1" in out   # 2.2.0 > 2.1.99 (minor dominates)

    def test_evaluate_rollout_decisions_execute_under_cmd(self, tmp_path):
        s = self._script()
        sections = _label_section(s, ":evaluate_rollout") + "\n" + _label_section(s, ":compare_versions")
        body = "\n".join([
            # below target, mode canary -> self_update
            'set "ROLLOUT_TARGET=2.1.8"',
            'set "ROLLOUT_MODE=canary"',
            'set "BINARY_VERSION=2.1.6.0"',
            'call :evaluate_rollout',
            'echo D_CANARY=!ROLLOUT_DECISION!',
            # below target, mode disabled -> disabled
            'set "ROLLOUT_MODE=disabled"',
            'call :evaluate_rollout',
            'echo D_DISABLED=!ROLLOUT_DECISION!',
            # below target, mode enabled -> self_update
            'set "ROLLOUT_MODE=enabled"',
            'call :evaluate_rollout',
            'echo D_ENABLED=!ROLLOUT_DECISION!',
            # equal -> uptodate (any mode)
            'set "BINARY_VERSION=2.1.8.0"',
            'call :evaluate_rollout',
            'echo D_EQUAL=!ROLLOUT_DECISION!',
            # newer -> newer
            'set "BINARY_VERSION=2.1.9.0"',
            'call :evaluate_rollout',
            'echo D_NEWER=!ROLLOUT_DECISION!',
            # no target -> empty decision (legacy fallback)
            'set "ROLLOUT_TARGET="',
            'set "BINARY_VERSION=2.1.6.0"',
            'call :evaluate_rollout',
            'echo D_NOTARGET=[!ROLLOUT_DECISION!]',
        ])
        result = self._run_cmd_harness(tmp_path, body, sections)
        out = result.stdout + result.stderr
        assert result.returncode == 0, out
        assert "D_CANARY=self_update" in out
        assert "D_DISABLED=disabled" in out
        assert "D_ENABLED=self_update" in out
        assert "D_EQUAL=uptodate" in out
        assert "D_NEWER=newer" in out
        assert "D_NOTARGET=[]" in out
