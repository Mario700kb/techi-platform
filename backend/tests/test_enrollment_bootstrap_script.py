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
import json
import re
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.endpoints import bootstrap as bootstrap_endpoint
from app.schemas.enrollment_bootstrap import (
    AvailabilityProfile,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
)
from app.services.enrollment_bootstrap_service import EnrollmentBootstrapService


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
        rustdesk_default_password="Durres.12",
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

    def test_generated_script_uses_official_programdata_path(self):
        assert '$InstallDir = "C:\\ProgramData\\TECHI"' in self.script
        assert '$InstallDir = "C:\\ProgramData\\TechiAgent"' not in self.script

    def test_agent_self_update_flow(self):
        _check_agent_self_update_flow(self.script, "token-installer")


class TestRustDeskForceMigrationScript:
    def setup_method(self):
        self.svc = _StubService()
        req = _make_rustdesk_req()
        cfg = self.svc._config_template("http://10.5.50.63:8000", "tok123tok123tok123", req)
        _, self.script = self.svc._windows_bootstrap(
            "http://10.5.50.63:8000", "tok123tok123tok123", cfg, req
        )

    def test_stops_service_and_process_before_config_cleanup(self):
        service_index = self.script.index("Stopping TECHI Remote Support service")
        process_index = self.script.index("Stopping TECHI Remote Support process")
        cleanup_index = self.script.index("Old TECHI Remote Support config found")

        assert service_index < cleanup_index
        assert process_index < cleanup_index

    def test_removes_all_requested_config_locations(self):
        assert "C:\\ProgramData\\TECHI Remote Support" in self.script
        assert "C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\TECHI Remote Support" in self.script
        assert "Join-Path $env:APPDATA 'TECHI Remote Support'" in self.script
        assert "Join-Path $env:LOCALAPPDATA 'TECHI Remote Support'" in self.script

    def test_removes_requested_config_files_and_config_contents(self):
        assert "'TECHI Remote Support.toml', 'TECHI Remote Support2.toml'" in self.script
        assert "-Filter '*.toml'" in self.script
        assert "Join-Path $Root 'config'" in self.script
        assert "Remove-Item -LiteralPath $_.FullName -Recurse -Force" in self.script

    def test_profile_cleanup_is_access_denied_safe(self):
        assert "function Test-PathSafe" in self.script
        assert "Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue" in self.script
        assert "function Get-ChildItemSafe" in self.script
        assert "Get-ChildItem -LiteralPath $Path" in self.script
        assert "WARNING: TECHI Remote Support path inaccessible, skipping" in self.script
        assert "WARNING: TECHI Remote Support profile scan inaccessible, skipping" in self.script
        assert "TECHI Remote Support config root not present or inaccessible" in self.script

    def test_profile_rewrite_is_access_denied_safe(self):
        assert "function New-DirectorySafe" in self.script
        assert "function Write-TechiConfigSafe" in self.script
        assert "WARNING: TECHI Remote Support directory inaccessible, skipping" in self.script
        assert "WARNING: TECHI Remote Support config write inaccessible, skipping" in self.script
        assert "WARNING: TECHI Remote Support TECHI config verification failed; continuing bootstrap" in self.script
        assert "ERROR: TECHI Remote Support TECHI config verification failed" not in self.script

    def test_rewrites_techi_config_and_verifies_host(self):
        assert "rendezvous_server = '$TechiRendezvous'" in self.script
        assert "relay-server = '$TechiRelay'" in self.script
        assert "key = '$TechiKey'" in self.script
        assert "TECHI Remote Support config rewritten" in self.script
        assert "$Written.Contains($TechiRendezvous)" in self.script
        assert "TECHI Remote Support TECHI config verified" in self.script

    def test_restarts_rustdesk_and_logs_migration(self):
        assert "Restarting TECHI Remote Support service" in self.script
        assert "TECHI Remote Support restarted" in self.script
        assert "TECHI Remote Support forced migration complete" in self.script

    def test_sets_unattended_password_with_cli_without_logging_secret(self):
        assert "$TechiPassword = 'Durres.12'" in self.script
        assert "'C:\\Program Files\\TECHI Remote Support\\rustdesk.exe'" in self.script
        assert "'C:\\Program Files (x86)\\TECHI Remote Support\\rustdesk.exe'" in self.script
        assert "Get-CimInstance Win32_Service" in self.script
        assert "$Service.PathName" in self.script
        assert "Start-Process -FilePath $TechiExe -ArgumentList @('--password', $TechiPassword)" in self.script
        assert "TECHI Remote Support unattended access password configured." in self.script
        assert "WARNING: TECHI Remote Support password CLI failed; continuing bootstrap." in self.script
        assert 'Write-Log "Durres.12' not in self.script
        assert "Write-Log 'Durres.12" not in self.script

    def test_password_set_happens_before_restart(self):
        password_index = self.script.index("Setting TECHI Remote Support unattended access password via CLI")
        restart_index = self.script.index("Restarting TECHI Remote Support service")

        assert password_index < restart_index

    def test_idempotent_cleanup_then_rewrite_order(self):
        remove_index = self.script.index("TECHI Remote Support config removed")
        rewrite_index = self.script.index("Write-TechiConfigSafe -Path $Path")

        assert remove_index < rewrite_index

    def test_public_endpoint_enables_techi_rustdesk_migration(self, monkeypatch):
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
        assert captured["payload"].rustdesk_default_password == "Durres.12"


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

    def test_generated_script_uses_official_programdata_path(self):
        assert '$InstallDir = "C:\\ProgramData\\TECHI"' in self.script
        assert '$InstallDir = "C:\\ProgramData\\TechiAgent"' not in self.script

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
        step4b_start = self.script.index("Hapi 4b: Shkarkimi i MSI")
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
        assert "set NETLOGON_MSI=\\\\%DOMAIN%\\NETLOGON\\TECHI-Agent-%ACTIVE_VERSION%.msi" in self.script
        assert 'msiexec /i "%NETLOGON_MSI%"' in self.script
        # Versioni fallback i baked-in i gjenerimit
        assert "if not defined ACTIVE_VERSION set ACTIVE_VERSION=2.1.0" in self.script

    def test_deploy_cmd_has_correct_label_structure(self):
        """Labels: :do_install para :already_uptodate."""
        do_install = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        assert do_install < already

    def test_deploy_cmd_install_detects_product_before_choosing_msi_flags(self):
        """do_install kontrollon registry para msiexec — REINSTALL vs ENROLLMENT_TOKEN."""
        do_install_pos = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[do_install_pos:already_pos]

        assert "set PRODUCT_INSTALLED=" in section
        assert 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"' in section
        assert "if defined PRODUCT_INSTALLED goto :do_reinstall_lan" in section
        assert 'msiexec /i "%NETLOGON_MSI%" REINSTALL=ALL REINSTALLMODE=vomus /quiet /norestart' in section
        assert 'msiexec /i "%NETLOGON_MSI%" ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL% /quiet /norestart' in section
        assert 'msiexec /i "%NETLOGON_MSI%" TOKEN=%TOKEN%' not in self.script

    def test_deploy_cmd_stops_service_before_install(self):
        """Shërbimi ndalet para instalimit."""
        assert "net stop TechiAgent 2>nul" in self.script
        assert "taskkill /f /im techi-agent.exe 2>nul" in self.script

    def test_deploy_cmd_deletes_service_before_uninstall(self):
        """sc.exe delete TechiAgent para uninstall — shmang konflikte service gjatë upgrade."""
        do_install = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[do_install:already]
        assert "sc.exe stop TechiAgent 2>nul" in section
        assert "sc.exe delete TechiAgent 2>nul" in section

    def test_deploy_cmd_uninstalls_old_v104_before_install(self):
        """Uninstall eksplicit i v1.0.4 (TECHI Endpoint Deployment) para install v2.1.0."""
        do_install = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[do_install:already]
        assert '"TECHI Endpoint Deployment"' in section
        assert 'msiexec /x "{%%j}" /quiet /norestart 2>nul' in section
        assert 'msiexec /x "{134568B7-BCB0-4341-933B-C24DA78DEF6E}" /quiet /norestart 2>nul' in section
        assert 'msiexec /x "{110919C6-83C4-444F-821F-61F755FE5081}" /quiet /norestart 2>nul' in section

    def test_deploy_cmd_has_deploy_log(self):
        """CMD shkruan deploy.log me timestamp, result dhe version."""
        assert 'set LOG=%INSTALL_DIR%\\deploy.log' in self.script
        assert "start domain=%DOMAIN% install_dir=%INSTALL_DIR% agent=%AGENT_EXE%" in self.script
        assert "current_version=%CURRENT_VERSION%" in self.script
        assert "active_version=%ACTIVE_VERSION% source=%VERSION_SOURCE%" in self.script
        assert "msi_path=%NETLOGON_MSI%" in self.script
        assert "msi_exit_code=%MSI_EXIT%" in self.script
        assert "service_before=%SERVICE_STATUS_BEFORE%" in self.script
        assert "service_after=%SERVICE_STATUS_AFTER%" in self.script
        assert 'result=0 version=%ACTIVE_VERSION% msi_exit_code=%MSI_EXIT% >> "%LOG%"' in self.script
        assert 'result=0-manual version=%ACTIVE_VERSION% msi_exit_code=%MSI_EXIT% >> "%LOG%"' in self.script
        assert 'result=1603 version=%ACTIVE_VERSION% msi_exit_code=%MSI_EXIT% >> "%LOG%"' in self.script
        assert 'result=uptodate version=%ACTIVE_VERSION% current_version=%CURRENT_VERSION% >> "%LOG%"' in self.script

    def test_deploy_cmd_uses_techiagent_install_path_and_migrates_legacy(self):
        assert "set INSTALL_DIR=C:\\ProgramData\\TechiAgent" in self.script
        assert "set LEGACY_INSTALL_DIR=C:\\ProgramData\\TECHI" in self.script
        assert "set CONFIG=%INSTALL_DIR%\\agent.config.json" in self.script
        assert "set LEGACY_CONFIG=%LEGACY_INSTALL_DIR%\\agent.config.json" in self.script
        assert 'if not exist "%CONFIG%" if exist "%LEGACY_CONFIG%" copy /y "%LEGACY_CONFIG%" "%CONFIG%"' in self.script

    def test_deploy_cmd_already_uptodate_starts_service_if_stopped(self):
        """:already_uptodate kontrollon nëse shërbimi ecën, nëse jo e starton."""
        assert 'sc query TechiAgent | findstr /i "RUNNING" >nul 2>&1' in self.script
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[already_pos:]
        assert "net start TechiAgent 2>nul" in section

    def test_deploy_cmd_manual_replace_lan_triggered_on_reinstall_failure(self):
        """:manual_replace_lan aktivizohet kur REINSTALL=ALL kthen error (1603 file lock)."""
        do_install = re.search(r"^:do_install\b", self.script, re.MULTILINE).start()
        already = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        section = self.script[do_install:already]
        assert ":do_reinstall_lan" in section
        assert "if not \"%MSI_EXIT%\"==\"0\" goto :manual_replace_lan" in section

    def test_deploy_cmd_manual_replace_lan_extracts_from_netlogon_msi(self):
        """:manual_replace_lan ekstrakton MSI nga NETLOGON me msiexec /a."""
        assert 'msiexec /a "%NETLOGON_MSI%" /qn TARGETDIR="%EXTRACT_DIR%"' in self.script
        assert 'set EXTRACT_DIR=%TEMP%\\TechiExtract' in self.script

    def test_deploy_cmd_manual_replace_lan_uses_committed_agent_path(self):
        """:manual_replace_lan kopjon techi-agent.exe nga CommApp\\TechiAgent."""
        assert '%EXTRACT_DIR%\\CommApp\\TechiAgent\\techi-agent.exe' in self.script
        assert 'copy /y "%EXTRACTED_AGENT%" "%AGENT_EXE%" >nul 2>&1' in self.script

    def test_deploy_cmd_manual_replace_lan_falls_back_to_install_failed(self):
        """:manual_replace_lan shkon te :install_failed nëse copy dështon."""
        assert "if not defined EXTRACTED_AGENT goto :install_failed" in self.script
        assert "if errorlevel 1 goto :install_failed" in self.script

    def test_deploy_cmd_manual_replace_lan_creates_service_if_missing(self):
        """:manual_replace_lan krijon service me sc.exe nëse nuk ekziston (v1.0.4 skip-install bug)."""
        assert 'sc query TechiAgent >nul 2>&1' in self.script
        assert 'sc.exe create TechiAgent binPath= "%AGENT_EXE%" start= auto DisplayName= "TECHI Agent"' in self.script
        assert 'sc.exe description TechiAgent "TECHI Solutions endpoint monitoring and management service"' in self.script
        assert 'sc.exe failure TechiAgent reset= 60 actions= restart/60000/restart/60000/restart/300000' in self.script

    def test_deploy_cmd_install_failed_logs_1603_and_exits_1(self):
        """:install_failed regjistron result=1603 dhe del me exit /b 1."""
        assert 'result=1603 version=%ACTIVE_VERSION% msi_exit_code=%MSI_EXIT% >> "%LOG%"' in self.script
        assert "exit /b 1" in self.script

    def test_deploy_cmd_done_label_before_already_uptodate(self):
        """:done ekziston dhe vjen para :already_uptodate."""
        done_pos = re.search(r"^:done\b", self.script, re.MULTILINE).start()
        already_pos = re.search(r"^:already_uptodate\b", self.script, re.MULTILINE).start()
        assert done_pos < already_pos

    # ── PS1-level Step 4b: MSI download te NETLOGON ───────────────────────────

    def test_ps1_has_backend_url_and_msi_download_url_variables(self):
        """PS1 ka $BackendUrl dhe $MsiDownloadUrl para hapi 1."""
        backend_var = self.script.index("$BackendUrl    = 'https://api-rdp.techi.com.al'")
        msi_var = self.script.index("$MsiDownloadUrl = 'https://api-rdp.techi.com.al/api/v1/agent-packages/platform/windows-amd64/download'")
        hapi1 = self.script.index("Hapi 1: Importimi i moduleve")
        assert backend_var < hapi1
        assert msi_var < hapi1

    def test_ps1_step4b_downloads_msi_to_netlogon(self):
        """PS1 Hapi 4b shkarkon MSI tek NETLOGON."""
        assert "Hapi 4b: Shkarkimi i MSI ne NETLOGON" in self.script
        assert "$MsiNetlogonPath = Join-Path $NetlogonPath" in self.script
        assert "(New-Object Net.WebClient).DownloadFile($MsiDownloadUrl, $MsiNetlogonPath)" in self.script

    def test_ps1_step4b_has_retry_loop(self):
        """PS1 Hapi 4b ka retry loop me 3 tentativa."""
        assert "for ($i = 1; $i -le 3; $i++) {" in self.script
        assert "$downloaded = $false" in self.script
        assert "$downloaded = $true" in self.script
        assert "3 tentativave" in self.script

    def test_ps1_step4b_uses_tls12_for_msi_download(self):
        """PS1 Hapi 4b aktivizon TLS 1.2 para download."""
        step4b = self.script.index("Hapi 4b: Shkarkimi i MSI")
        section = self.script[step4b:]
        assert "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12" in section

    def test_ps1_step4b_writes_version_file(self):
        """PS1 Hapi 4b shkruan techi-version.txt pas download."""
        assert "$VersionFilePath = Join-Path $NetlogonPath" in self.script
        assert "Out-File $VersionFilePath -Encoding ASCII -NoNewline" in self.script

    def test_ps1_step4b_skips_download_if_msi_exists(self):
        """PS1 Hapi 4b kalon download nëse MSI i njëjtë ekziston."""
        assert "tashme ekziston ne NETLOGON -- skip download" in self.script

    def test_ps1_step4b_cleans_old_msi_versions(self):
        """PS1 Hapi 4b fshin versione të vjetra MSI para download."""
        assert "Get-ChildItem $NetlogonPath -Filter 'TECHI-Agent-*.msi'" in self.script
        assert "Remove-Item -Force -ErrorAction SilentlyContinue" in self.script

    def test_ps1_step4b_displays_sha256(self):
        """PS1 Hapi 4b shfaq SHA256 hash të MSI-t pas download."""
        assert "Get-FileHash $MsiNetlogonPath -Algorithm SHA256" in self.script
        assert 'Write-Host "   MSI SHA256: $LocalHash"' in self.script

    # ── PS1-level: Test-Path verifikime post-write ────────────────────────────

    def test_ps1_has_test_path_after_deploy_cmd_write(self):
        """PS1 verifikon me Test-Path se techi-deploy.cmd u shkrua."""
        write_pos = self.script.index(
            "[System.IO.File]::WriteAllText($DeployScriptPath, $DeployContent"
        )
        step4b_pos = self.script.index("Hapi 4b: Shkarkimi i MSI")
        section = self.script[write_pos:step4b_pos]
        assert "Test-Path $DeployScriptPath" in section
        assert "GABIM KRITIK" in section

    def test_ps1_has_test_path_after_msi_download(self):
        """PS1 verifikon me Test-Path se MSI u shkarkua."""
        assert "GABIM KRITIK: MSI nuk u gjend pas download" in self.script

    def test_ps1_has_test_path_after_version_file_write(self):
        """PS1 verifikon me Test-Path se techi-version.txt u shkrua."""
        assert "GABIM KRITIK: techi-version.txt nuk u shkrua" in self.script

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
        assert "<UserId>NT AUTHORITY\\System</UserId>" in self.script
        assert "<LogonType>ServiceAccount</LogonType>" in self.script
        assert "<RunLevel>HighestAvailable</RunLevel>" in self.script

    def test_ps1_scheduled_task_uses_cmd_exe_netlogon_action(self):
        """Scheduled Task action perdor cmd.exe /c per techi-deploy.cmd ne NETLOGON."""
        assert "$NetlogonScr = \"\\\\$DomainDNS\\NETLOGON\\techi-deploy.cmd\"" in self.script
        assert "<Command>cmd.exe</Command>" in self.script
        assert '<Arguments>/c "$NetlogonScr"</Arguments>' in self.script
        assert "<Command>$NetlogonScr</Command>" not in self.script

    def test_ps1_scheduled_task_has_daily_13_and_21_triggers(self):
        """Scheduled Task ka trigger-et ditore 13:00 dhe 21:00."""
        assert '$ScheduleTime1 = "13:00"' in self.script
        assert '$ScheduleTime2 = "21:00"' in self.script
        assert "<CalendarTrigger>" in self.script
        assert "<DaysInterval>1</DaysInterval>" in self.script

    def test_ps1_has_test_path_after_scripts_ini_write(self):
        """PS1 verifikon me Test-Path se scripts.ini dhe kopja e CMD u shkruan."""
        assert "GABIM KRITIK: techi-deploy.cmd nuk u kopjua te Startup Scripts!" in self.script
        assert "GABIM KRITIK: $ScriptsIniPath nuk u shkrua! Ndalim." in self.script

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
