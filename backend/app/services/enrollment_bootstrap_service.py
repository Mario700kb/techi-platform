import json
from textwrap import dedent
from typing import Optional

from sqlalchemy.orm import Session

from app.schemas.enrollment_bootstrap import (
    EnrollmentBootstrapMode,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
    EnrollmentBootstrapResponse,
)
from app.services.agent_package_service import AgentPackageService
from app.services.enrollment_token_service import EnrollmentTokenService


class EnrollmentBootstrapService:
    NOTICE = "Temporary pre-production bootstrap. Replace placeholder binary URLs before real deployment."
    WINDOWS_AGENT_URL_PLACEHOLDER = "<TECHI_AGENT_WINDOWS_EXE_URL>"

    def __init__(self, db: Session):
        self.token_service = EnrollmentTokenService(db)

    def generate(self, payload: EnrollmentBootstrapRequest) -> EnrollmentBootstrapResponse:
        backend_url = payload.backend_url.rstrip("/")

        if payload.mode == EnrollmentBootstrapMode.GPO:
            return self._generate_gpo(payload, backend_url)

        # Token enrollment mode
        self.token_service.get_active_token(payload.enrollment_token_id)
        if payload.enrollment_token:
            self.token_service.validate_plaintext_for_token_id(
                payload.enrollment_token_id, payload.enrollment_token
            )

        enrollment_token = payload.enrollment_token or f"<ENROLLMENT_TOKEN_FOR_ID_{payload.enrollment_token_id}>"
        config_template = self._config_template(backend_url, enrollment_token, payload)

        if payload.platform == EnrollmentBootstrapPlatform.WINDOWS:
            command, script = self._windows_bootstrap(backend_url, enrollment_token, config_template)
        else:
            command, script = self._posix_bootstrap(payload.platform, backend_url, enrollment_token, config_template)

        return EnrollmentBootstrapResponse(
            mode=payload.mode,
            enrollment_token_id=payload.enrollment_token_id,
            platform=payload.platform,
            backend_url=backend_url,
            bootstrap_command=command,
            bootstrap_script=script,
            config_template=config_template,
            preproduction_notice=self.NOTICE,
        )

    def _generate_gpo(self, payload: EnrollmentBootstrapRequest, backend_url: str) -> EnrollmentBootstrapResponse:
        enrollment_token = payload.enrollment_token or ""
        config_template = self._config_template(backend_url, enrollment_token, payload)
        command, script = self._gpo_windows_bootstrap(backend_url, enrollment_token, config_template, payload)
        notice = (
            "GPO/Domain deployment mode. "
            "Requires TRUSTED_DOMAIN_AUTO_ENROLLMENT=true on the backend. "
            "No enrollment token is needed for domain-joined machines."
        )
        return EnrollmentBootstrapResponse(
            mode=payload.mode,
            enrollment_token_id=None,
            platform=payload.platform,
            backend_url=backend_url,
            bootstrap_command=command,
            bootstrap_script=script,
            config_template=config_template,
            preproduction_notice=notice,
        )

    def _config_template(
        self, backend_url: str, enrollment_token: str, payload: EnrollmentBootstrapRequest
    ) -> str:
        cfg: dict = {
            "api_url": backend_url,
            "backend_url": f"{backend_url}/api/v1/agent/heartbeat",
            "agent_name": "<HOSTNAME>",
            "public_ip_service": "https://api.ipify.org?format=text",
            "timeout_seconds": 10,
            "retries": 3,
            "retry_delay_seconds": 5,
            "collect_processes": False,
            "collect_services": False,
            "collect_software": False,
        }
        if enrollment_token:
            cfg["enrollment_token"] = enrollment_token

        # RustDesk self-healing fields
        if payload.rustdesk_manage_enabled:
            cfg["rustdesk_manage_enabled"] = True
            if payload.rustdesk_msi_url:
                cfg["rustdesk_msi_url"] = payload.rustdesk_msi_url
            if payload.rustdesk_rendezvous_server:
                cfg["rustdesk_rendezvous_server"] = payload.rustdesk_rendezvous_server
            if payload.rustdesk_relay_server:
                cfg["rustdesk_relay_server"] = payload.rustdesk_relay_server
            if payload.rustdesk_api_server:
                cfg["rustdesk_api_server"] = payload.rustdesk_api_server
            if payload.rustdesk_key:
                cfg["rustdesk_key"] = payload.rustdesk_key
            if payload.rustdesk_default_password:
                cfg["rustdesk_default_password"] = payload.rustdesk_default_password
        else:
            cfg["rustdesk_manage_enabled"] = False

        return json.dumps(cfg, indent=2)

    def _gpo_windows_bootstrap(
        self,
        backend_url: str,
        enrollment_token: str,
        config_template: str,
        payload: EnrollmentBootstrapRequest,
    ) -> tuple[str, str]:
        package_url, expected_sha256 = self._windows_package_info(backend_url)
        sha256_block = self._sha256_block(expected_sha256)
        token_install_arg = f"-enrollment-token {enrollment_token}" if enrollment_token else ""

        script = dedent(f"""
            $ErrorActionPreference = "Stop"
            # GPO / Trusted Domain deployment script — run as Administrator via GPO.
            # No enrollment token required for domain-joined machines when
            # TRUSTED_DOMAIN_AUTO_ENROLLMENT=true is set on the backend.

            $InstallDir = "C:\\ProgramData\\TechiAgent"
            $LogDir     = Join-Path $InstallDir "logs"
            $AgentUrl   = "{package_url}"
            $AgentPath  = Join-Path $InstallDir "techi-agent.exe"
            $ConfigPath = Join-Path $InstallDir "agent.config.json"

            New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
            New-Item -ItemType Directory -Force -Path $LogDir     | Out-Null

            # Download agent binary if URL is configured
            if ($AgentUrl -like "<*>" -or [string]::IsNullOrWhiteSpace($AgentUrl)) {{
              if (-not (Test-Path $AgentPath)) {{
                throw "Place techi-agent.exe at $AgentPath or set a real agent download URL."
              }}
              Write-Host "Using existing agent binary at $AgentPath — checksum skipped for local binary."
            }} else {{
              Write-Host "Downloading Techi Agent from $AgentUrl"
              Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath -UseBasicParsing
            {sha256_block}
            }}

            # Write config without BOM (UTF8NoBOM)
            $ConfigContent = @'
__CONFIG_TEMPLATE__
'@ -replace '<HOSTNAME>', $env:COMPUTERNAME
            [System.IO.File]::WriteAllText($ConfigPath, $ConfigContent, [System.Text.UTF8Encoding]::new($false))
            Write-Host "Config written: $ConfigPath"

            # Install and start the service
            $svc = Get-Service -Name "TechiAgent" -ErrorAction SilentlyContinue
            if ($svc -eq $null) {{
              & $AgentPath install -config $ConfigPath {token_install_arg}
              Write-Host "TechiAgent service installed."
            }} else {{
              Write-Host "TechiAgent service already installed — skipping install step."
            }}

            & $AgentPath start
            Start-Sleep -Seconds 3
            & $AgentPath status

            $Service = Get-Service -Name "TechiAgent" -ErrorAction Stop
            if ($Service.Status -ne "Running") {{
              throw "TechiAgent service is $($Service.Status), expected Running."
            }}

            Write-Host "TechiAgent running. Domain auto-enrollment will occur on next heartbeat."
            Write-Host "Config : $ConfigPath"
            Write-Host "Logs   : $LogDir\\agent.log"
        """).strip()
        script = script.replace("__CONFIG_TEMPLATE__", config_template)
        command = 'powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-gpo-bootstrap.ps1'
        return command, script

    def _windows_bootstrap(self, backend_url: str, enrollment_token: str, config_template: str) -> tuple[str, str]:
        package_url, expected_sha256 = self._windows_package_info(backend_url)
        sha256_block = self._sha256_block(expected_sha256)

        script_template = dedent(
            f"""
            $ErrorActionPreference = "Stop"
            # Run this PowerShell session as Administrator.
            $InstallDir = "C:\\ProgramData\\TechiAgent"
            $LogDir = Join-Path $InstallDir "logs"
            $AgentUrl = "{package_url}"
            $AgentPath = Join-Path $InstallDir "techi-agent.exe"
            $ConfigPath = Join-Path $InstallDir "agent.config.json"
            $EnrollmentToken = "{enrollment_token}"

            New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
            New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

            if ($AgentUrl -like "<*>" -or [string]::IsNullOrWhiteSpace($AgentUrl)) {{
              if (-not (Test-Path $AgentPath)) {{
                throw "Agent binary hosting is not ready. Place techi-agent.exe at $AgentPath or replace `$AgentUrl with a real download URL."
              }}
              Write-Host "Using existing agent binary at $AgentPath — checksum verification skipped for local binary."
            }} else {{
              Write-Host "Downloading Techi Agent from $AgentUrl"
              Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath
            {sha256_block}
            }}

            @'
            __CONFIG_TEMPLATE__
            '@ -replace '<HOSTNAME>', $env:COMPUTERNAME | Set-Content -Encoding UTF8 -Path $ConfigPath

            & $AgentPath install -config $ConfigPath -enrollment-token $EnrollmentToken
            & $AgentPath start

            Start-Sleep -Seconds 2
            & $AgentPath status

            $Service = Get-Service -Name "TechiAgent" -ErrorAction Stop
            if ($Service.Status -ne "Running") {{
              throw "TechiAgent service is $($Service.Status), expected Running."
            }}

            Write-Host "TechiAgent service installed and running."
            Write-Host "Config: $ConfigPath"
            Write-Host "Logs: C:\\ProgramData\\TechiAgent\\logs\\agent.log"
            """
        ).strip()
        script = script_template.replace("__CONFIG_TEMPLATE__", config_template)
        command = 'powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-agent-service-bootstrap.ps1'
        return command, script

    @staticmethod
    def _sha256_block(expected_sha256: str) -> str:
        if expected_sha256:
            return dedent(f"""
              $ExpectedSHA256 = "{expected_sha256}"
              $ActualSHA256   = (Get-FileHash -Algorithm SHA256 -Path $AgentPath).Hash.ToLower()
              if ($ActualSHA256 -ne $ExpectedSHA256.ToLower()) {{
                Remove-Item -Force $AgentPath -ErrorAction SilentlyContinue
                throw "SHA256 mismatch — download may be corrupted or tampered.`nExpected: $ExpectedSHA256`nActual:   $ActualSHA256"
              }}
              Write-Host "SHA256 verified: $ActualSHA256"
            """).rstrip()
        return "              Write-Host 'Warning: no SHA256 checksum available — skipping integrity check.'"

    def _windows_package_info(self, backend_url: str) -> tuple[str, str]:
        svc = AgentPackageService()
        package = svc.latest_active("windows-amd64")
        if package is None:
            return self.WINDOWS_AGENT_URL_PLACEHOLDER, ""
        url = f"{backend_url.rstrip('/')}{svc.latest_download_url('windows-amd64')}"
        return url, package.sha256 or ""

    def _posix_bootstrap(
        self,
        platform: EnrollmentBootstrapPlatform,
        backend_url: str,
        enrollment_token: str,
        config_template: str,
    ) -> tuple[str, str]:
        binary_name = "darwin" if platform == EnrollmentBootstrapPlatform.MACOS else "linux"
        script = dedent(
            f"""
            #!/usr/bin/env bash
            set -euo pipefail

            INSTALL_DIR="${{HOME}}/.techi-agent"
            AGENT_URL="https://downloads.example.invalid/techi-agent/{binary_name}/techi-agent"
            AGENT_PATH="${{INSTALL_DIR}}/techi-agent"
            CONFIG_PATH="${{INSTALL_DIR}}/config.json"
            HOSTNAME_VALUE="$(hostname)"

            mkdir -p "${{INSTALL_DIR}}"
            curl -fsSL "${{AGENT_URL}}" -o "${{AGENT_PATH}}"
            chmod +x "${{AGENT_PATH}}"

            cat > "${{CONFIG_PATH}}" <<'JSON'
            {config_template}
            JSON
            sed -i.bak "s/<HOSTNAME>/${{HOSTNAME_VALUE}}/g" "${{CONFIG_PATH}}"
            rm -f "${{CONFIG_PATH}}.bak"

            "${{AGENT_PATH}}" -config "${{CONFIG_PATH}}" -enrollment-token "{enrollment_token}"
            """
        ).strip()
        command = "bash ./techi-bootstrap.sh"
        return command, script
