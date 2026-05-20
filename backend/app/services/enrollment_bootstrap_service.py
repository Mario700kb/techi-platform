import json
from typing import Optional

from sqlalchemy.orm import Session

from app.schemas.enrollment_bootstrap import (
    AvailabilityProfile,
    EnrollmentBootstrapMode,
    EnrollmentBootstrapPlatform,
    EnrollmentBootstrapRequest,
    EnrollmentBootstrapResponse,
)
from app.services.agent_package_service import AgentPackageService
from app.services.enrollment_token_service import EnrollmentTokenService


class EnrollmentBootstrapService:
    NOTICE = (
        "Lock screen stays enabled — remote access (RustDesk) works via Windows service. "
        "Sleep/hibernate makes the device unreachable; use Server profile or Wake-on-LAN to prevent this."
    )
    WINDOWS_AGENT_URL_PLACEHOLDER = "<TECHI_AGENT_WINDOWS_EXE_URL>"

    def __init__(self, db: Session):
        self.token_service = EnrollmentTokenService(db)

    # ─── Public entry point ────────────────────────────────────────────────────

    def generate(self, payload: EnrollmentBootstrapRequest) -> EnrollmentBootstrapResponse:
        backend_url = payload.backend_url.rstrip("/")

        if payload.mode == EnrollmentBootstrapMode.GPO:
            return self._generate_gpo(payload, backend_url)

        token = self.token_service.get_active_token(payload.enrollment_token_id)
        enrollment_token = (payload.enrollment_token or "").strip()
        if enrollment_token:
            self.token_service.validate_plaintext_for_token_id(
                payload.enrollment_token_id, enrollment_token
            )
        else:
            enrollment_token = self.token_service.issue_plaintext_for_token(token)
        config_template = self._config_template(backend_url, enrollment_token, payload)

        if payload.platform == EnrollmentBootstrapPlatform.WINDOWS:
            command, script = self._windows_bootstrap(
                backend_url, enrollment_token, config_template, payload
            )
            filename = "techi-installer.ps1"
        else:
            command, script = self._posix_bootstrap(
                payload.platform, backend_url, enrollment_token, config_template
            )
            filename = "techi-bootstrap.sh"

        return EnrollmentBootstrapResponse(
            mode=payload.mode,
            enrollment_token_id=payload.enrollment_token_id,
            platform=payload.platform,
            backend_url=backend_url,
            bootstrap_command=command,
            bootstrap_script=script,
            config_template=config_template,
            preproduction_notice=self.NOTICE,
            installer_filename=filename,
        )

    def _generate_gpo(
        self, payload: EnrollmentBootstrapRequest, backend_url: str
    ) -> EnrollmentBootstrapResponse:
        enrollment_token = payload.enrollment_token or ""
        config_template = self._config_template(backend_url, enrollment_token, payload)
        command, script = self._gpo_windows_bootstrap(
            backend_url, enrollment_token, config_template, payload
        )
        notice = (
            "GPO/Domain deployment — runs at every startup, idempotent. "
            "Lock screen stays enabled. "
            "Domain-joined machines enroll automatically "
            "(TRUSTED_DOMAIN_AUTO_ENROLLMENT=true required). "
            "WORKGROUP machines will not enroll via GPO — use Token Enrollment for those."
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
            installer_filename="techi-gpo-bootstrap.ps1",
        )

    # ─── Config template (JSON) ───────────────────────────────────────────────

    def _config_template(
        self,
        backend_url: str,
        enrollment_token: str,
        payload: EnrollmentBootstrapRequest,
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
            "availability_profile": payload.availability_profile.value,
            "manage_power_policy": payload.manage_power_policy,
        }
        if enrollment_token:
            cfg["enrollment_token"] = enrollment_token

        if payload.manage_power_policy:
            if payload.availability_profile == AvailabilityProfile.SERVER:
                cfg["prevent_sleep_on_ac"] = True
                cfg["prevent_hibernate"] = True
                cfg["allow_display_off_on_ac"] = True
            else:
                cfg["prevent_sleep_on_ac"] = payload.prevent_sleep_on_ac
                cfg["prevent_hibernate"] = payload.prevent_hibernate
                cfg["allow_display_off_on_ac"] = payload.allow_display_off_on_ac

        if payload.rustdesk_manage_enabled:
            cfg["rustdesk_manage_enabled"] = True
            if payload.rustdesk_msi_url:
                cfg["rustdesk_msi_url"] = payload.rustdesk_msi_url
            if payload.rustdesk_msi_checksum_sha256:
                cfg["rustdesk_msi_checksum_sha256"] = payload.rustdesk_msi_checksum_sha256
            if payload.rustdesk_package_version:
                cfg["rustdesk_package_version"] = payload.rustdesk_package_version
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

    # ─── PowerShell config writer (no here-string) ────────────────────────────

    @staticmethod
    def _py_to_ps_literal(value) -> str:
        """Convert a Python scalar to a PowerShell literal.  Strings are
        single-quoted (single quotes inside are doubled) so the value is
        never subject to variable or escape expansion."""
        if value is True:
            return "$true"
        if value is False:
            return "$false"
        if value is None:
            return "$null"
        if isinstance(value, (int, float)):
            return str(value)
        # Single-quoted PS string — safe for any string content
        escaped = str(value).replace("'", "''")
        return f"'{escaped}'"

    def _config_ps_lines(self, config_json: str) -> list[str]:
        """Return PowerShell lines that write agent.config.json without using
        a here-string.  Uses [ordered]@{} + ConvertTo-Json so the output is
        pretty-printed and avoids all indentation/terminator issues.
        'agent_name' is always set to $env:COMPUTERNAME at runtime."""
        cfg: dict = json.loads(config_json)
        lines = ["$AgentConfig = [ordered]@{"]
        for key, value in cfg.items():
            if key == "agent_name":
                lines.append(f"    {key} = $env:COMPUTERNAME")
            else:
                ps_val = self._py_to_ps_literal(value)
                lines.append(f"    {key} = {ps_val}")
        lines.append("}")
        lines.append("$ConfigJson = $AgentConfig | ConvertTo-Json -Depth 5")
        lines.append(
            "[System.IO.File]::WriteAllText("
            "$ConfigPath, $ConfigJson, [System.Text.UTF8Encoding]::new($false))"
        )
        return lines

    def _rustdesk_force_migration_ps_lines(self, payload: EnrollmentBootstrapRequest) -> list[str]:
        if not payload.rustdesk_manage_enabled:
            return []
        rendezvous = (payload.rustdesk_rendezvous_server or "").strip()
        relay = (payload.rustdesk_relay_server or rendezvous).strip()
        key = (payload.rustdesk_key or "").strip()
        if not rendezvous or not key:
            return [
                "",
                "# -- RustDesk force migration skipped: missing TECHI server/key",
                'Write-Log "RustDesk force migration skipped: missing TECHI server/key"',
            ]

        safe_rendezvous = rendezvous.replace("'", "''")
        safe_relay = relay.replace("'", "''")
        safe_key = key.replace("'", "''")
        return [
            "",
            "# -- Force RustDesk migration to TECHI self-hosted server",
            f"$RustDeskRendezvous = '{safe_rendezvous}'",
            f"$RustDeskRelay = '{safe_relay}'",
            f"$RustDeskKey = '{safe_key}'",
            'Write-Log "Forcing RustDesk migration to TECHI infrastructure..."',
            "$RustDeskServices = @('RustDesk', 'rustdesk')",
            "foreach ($ServiceName in $RustDeskServices) {",
            "    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "    if ($null -ne $svc -and $svc.Status -ne 'Stopped') {",
            '        Write-Log "Stopping RustDesk service: $ServiceName"',
            "        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue",
            "    }",
            "}",
            "Get-Process -Name 'RustDesk', 'rustdesk' -ErrorAction SilentlyContinue | ForEach-Object {",
            '    Write-Log "Stopping RustDesk process: $($_.ProcessName) pid=$($_.Id)"',
            "    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue",
            "}",
            "Start-Sleep -Seconds 2",
            "$RustDeskRoots = @(",
            "    'C:\\ProgramData\\RustDesk',",
            "    'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk'",
            ")",
            "if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {",
            "    $RustDeskRoots += (Join-Path $env:APPDATA 'RustDesk')",
            "}",
            "if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {",
            "    $RustDeskRoots += (Join-Path $env:LOCALAPPDATA 'RustDesk')",
            "}",
            "$RustDeskRoots = $RustDeskRoots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique",
            "foreach ($Root in $RustDeskRoots) {",
            "    if (Test-Path $Root) {",
            '        Write-Log "Old RustDesk config found: $Root"',
            "        foreach ($Name in @('RustDesk.toml', 'RustDesk2.toml')) {",
            "            $Path = Join-Path $Root $Name",
            "            if (Test-Path $Path) {",
            "                Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue",
            '                Write-Log "RustDesk config removed: $Path"',
            "            }",
            "        }",
            "        Get-ChildItem -Path $Root -Filter '*.toml' -File -ErrorAction SilentlyContinue | ForEach-Object {",
            "            Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue",
            '            Write-Log "RustDesk config removed: $($_.FullName)"',
            "        }",
            "        $ConfigDir = Join-Path $Root 'config'",
            "        if (Test-Path $ConfigDir) {",
            "            Get-ChildItem -Path $ConfigDir -Force -ErrorAction SilentlyContinue | ForEach-Object {",
            "                Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue",
            '                Write-Log "RustDesk config removed: $($_.FullName)"',
            "            }",
            "        }",
            "    } else {",
            '        Write-Log "RustDesk config root not present: $Root"',
            "    }",
            "}",
            "$RustDeskToml = @(",
            "    \"rendezvous_server = '$RustDeskRendezvous'\",",
            "    'nat_type = 1',",
            "    'serial = 0',",
            "    '',",
            "    '[options]',",
            "    \"custom-rendezvous-server = '$RustDeskRendezvous'\",",
            "    \"relay-server = '$RustDeskRelay'\",",
            "    \"key = '$RustDeskKey'\"",
            ") -join \"`n\"",
            "foreach ($Root in $RustDeskRoots) {",
            "    $ConfigDir = Join-Path $Root 'config'",
            "    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null",
            "    foreach ($Path in @((Join-Path $Root 'RustDesk2.toml'), (Join-Path $ConfigDir 'RustDesk2.toml'))) {",
            "        [System.IO.File]::WriteAllText($Path, $RustDeskToml, [System.Text.UTF8Encoding]::new($false))",
            '        Write-Log "RustDesk config rewritten: $Path"',
            "        $Written = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue",
            "        if ($Written -and $Written.Contains($RustDeskRendezvous)) {",
            '            Write-Log "RustDesk TECHI config verified: $Path"',
            "        } else {",
            '            Write-Log "ERROR: RustDesk TECHI config verification failed: $Path"',
            "            exit 1",
            "        }",
            "    }",
            "}",
            "foreach ($ServiceName in $RustDeskServices) {",
            "    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "    if ($null -ne $svc) {",
            '        Write-Log "Restarting RustDesk service: $ServiceName"',
            "        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "        Start-Sleep -Seconds 3",
            "        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "        if ($null -ne $svc) {",
            '            Write-Log "RustDesk restarted: $ServiceName status=$($svc.Status)"',
            "        }",
            "    }",
            "}",
            'Write-Log "RustDesk forced migration complete."',
        ]

    # ─── Windows token-mode installer ─────────────────────────────────────────

    def _windows_bootstrap(
        self,
        backend_url: str,
        enrollment_token: str,
        config_template: str,
        payload: EnrollmentBootstrapRequest,
    ) -> tuple[str, str]:
        package_url, sha256 = self._windows_package_info(backend_url)
        config_lines = self._config_ps_lines(config_template)
        rustdesk_migration_lines = self._rustdesk_force_migration_ps_lines(payload)

        # Single-quote the token so PowerShell doesn't expand it as a variable
        safe_token = enrollment_token.replace("'", "''")

        L: list[str] = []

        def A(*lines: str) -> None:
            L.extend(lines)

        A(
            '$ErrorActionPreference = "Stop"',
            "# Techi Agent -- one-click installer (Token Enrollment)",
            "# Run as Administrator:",
            "#   powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-installer.ps1",
            "",
            '$InstallDir = "C:\\ProgramData\\TechiAgent"',
            "$LogDir     = Join-Path $InstallDir 'logs'",
            "$LogFile    = Join-Path $LogDir 'installer.log'",
            f"$AgentUrl   = '{package_url}'",
            "$AgentPath  = Join-Path $InstallDir 'techi-agent.exe'",
            "$ConfigPath = Join-Path $InstallDir 'agent.config.json'",
            f"$EnrollToken = '{safe_token}'",
            "",
            "function Write-Log {",
            "    param([string]$Msg)",
            "    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
            '    $line = "$ts  $Msg"',
            "    Write-Host $line",
            "    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}",
            "}",
            "",
            "New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null",
            "New-Item -ItemType Directory -Force -Path $LogDir | Out-Null",
            'Write-Log "=== Techi Agent Installer (Token mode) ==="',
            "",
            "# -- Download or verify binary",
            "if ($AgentUrl -like '<*>' -or [string]::IsNullOrWhiteSpace($AgentUrl)) {",
            "    if (-not (Test-Path $AgentPath)) {",
            '        Write-Log "ERROR: No download URL and no binary at $AgentPath"',
            "        exit 1",
            "    }",
            '    Write-Log "Using existing binary at $AgentPath -- checksum skipped (local binary)."',
            "} else {",
            "    $NeedDownload = $true",
            "    if (Test-Path $AgentPath) {",
        )
        if sha256:
            A(
                "        $Cur = (Get-FileHash -Algorithm SHA256 -Path $AgentPath).Hash.ToLower()",
                f"        if ($Cur -eq '{sha256}') {{",
                "            $NeedDownload = $false",
                '            Write-Log "Binary checksum matches -- skipping download."',
                "        }",
            )
        else:
            A("        # No checksum configured -- will re-download each time")
        A(
            "    }",
            "    if ($NeedDownload) {",
            '        Write-Log "Downloading Techi Agent from $AgentUrl"',
            "        try {",
            "            Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath -UseBasicParsing",
            "        } catch {",
            '            Write-Log "ERROR: Download failed: $_"',
            "            exit 1",
            "        }",
        )
        if sha256:
            A(
                "        $Got = (Get-FileHash -Algorithm SHA256 -Path $AgentPath).Hash.ToLower()",
                f"        if ($Got -ne '{sha256}') {{",
                "            Remove-Item -Force $AgentPath -ErrorAction SilentlyContinue",
                f"            Write-Log \"ERROR: SHA256 mismatch. Expected={sha256} Actual=$Got\"",
                "            exit 1",
                "        }",
                '        Write-Log "SHA256 verified: $Got"',
            )
        else:
            A('        Write-Log "WARNING: No SHA256 configured -- skipping integrity check."')
        A(
            '        Write-Log "Binary downloaded."',
            "    } else {",
            '        Write-Log "Binary up-to-date -- skipping download."',
            "    }",
            "}",
        )
        A(*rustdesk_migration_lines)
        A(
            "",
            "# -- Write config (UTF-8 without BOM) using ConvertTo-Json",
            'Write-Log "Writing config to $ConfigPath"',
        )
        A(*config_lines)
        A(
            'Write-Log "Config written."',
            "",
            "# -- Install service (idempotent)",
            '$svc = Get-Service -Name "TechiAgent" -ErrorAction SilentlyContinue',
            "if ($null -eq $svc) {",
            '    Write-Log "Installing TechiAgent service..."',
        )
        if enrollment_token:
            A("    & $AgentPath install -config $ConfigPath -enrollment-token $EnrollToken")
        else:
            A("    & $AgentPath install -config $ConfigPath")
        A(
            '    Write-Log "Service installed."',
            "} else {",
            '    Write-Log "TechiAgent already installed -- skipping install step."',
            "}",
            "",
            "# -- Start service",
            "& $AgentPath start",
            "Start-Sleep -Seconds 3",
            "& $AgentPath status",
            "",
            '$svc = Get-Service -Name "TechiAgent" -ErrorAction Stop',
            'if ($svc.Status -ne "Running") {',
            '    Write-Log "ERROR: TechiAgent is $($svc.Status) -- expected Running."',
            "    exit 1",
            "}",
            "",
            'Write-Log "TechiAgent running successfully."',
            'Write-Log "Config : $ConfigPath"',
            'Write-Log "Logs   : $LogDir\\agent.log"',
            "exit 0",
        )

        script = "\n".join(L)
        command = "powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-installer.ps1"
        return command, script

    # ─── Windows GPO / Trusted Domain installer ───────────────────────────────

    def _gpo_windows_bootstrap(
        self,
        backend_url: str,
        enrollment_token: str,
        config_template: str,
        payload: EnrollmentBootstrapRequest,
    ) -> tuple[str, str]:
        package_url, sha256 = self._windows_package_info(backend_url)
        config_lines = self._config_ps_lines(config_template)
        rustdesk_migration_lines = self._rustdesk_force_migration_ps_lines(payload)

        safe_token = enrollment_token.replace("'", "''")

        L: list[str] = []

        def A(*lines: str) -> None:
            L.extend(lines)

        A(
            '$ErrorActionPreference = "Stop"',
            "# Techi Agent -- GPO / Trusted Domain deployment",
            "# Idempotent: safe to run at every PC startup via GPO.",
            "# No prompts, no Read-Host. Exits 0 on success, 1 on error.",
            "",
            '$InstallDir = "C:\\ProgramData\\TechiAgent"',
            "$LogDir     = Join-Path $InstallDir 'logs'",
            "$LogFile    = Join-Path $LogDir 'installer.log'",
            f"$AgentUrl   = '{package_url}'",
            "$AgentPath  = Join-Path $InstallDir 'techi-agent.exe'",
            "$ConfigPath = Join-Path $InstallDir 'agent.config.json'",
            "",
            "function Write-Log {",
            "    param([string]$Msg)",
            "    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
            '    $line = "$ts  $Msg"',
            "    Write-Host $line",
            "    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}",
            "}",
            "",
            "New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null",
            "New-Item -ItemType Directory -Force -Path $LogDir | Out-Null",
            'Write-Log "=== Techi Agent GPO Installer ==="',
            "",
            "# -- Download or verify binary",
            "if ($AgentUrl -like '<*>' -or [string]::IsNullOrWhiteSpace($AgentUrl)) {",
            "    if (-not (Test-Path $AgentPath)) {",
            '        Write-Log "ERROR: No download URL and no binary at $AgentPath"',
            "        exit 1",
            "    }",
            '    Write-Log "Using existing binary at $AgentPath -- checksum skipped."',
            "} else {",
            "    $NeedDownload = $true",
            "    if (Test-Path $AgentPath) {",
        )
        if sha256:
            A(
                "        $Cur = (Get-FileHash -Algorithm SHA256 -Path $AgentPath).Hash.ToLower()",
                f"        if ($Cur -eq '{sha256}') {{",
                "            $NeedDownload = $false",
                '            Write-Log "Binary checksum matches -- skipping download."',
                "        }",
            )
        else:
            A("        # No checksum configured -- will re-download each time")
        A(
            "    }",
            "    if ($NeedDownload) {",
            '        Write-Log "Downloading Techi Agent from $AgentUrl"',
            "        try {",
            "            Invoke-WebRequest -Uri $AgentUrl -OutFile $AgentPath -UseBasicParsing",
            "        } catch {",
            '            Write-Log "ERROR: Download failed: $_"',
            "            exit 1",
            "        }",
        )
        if sha256:
            A(
                "        $Got = (Get-FileHash -Algorithm SHA256 -Path $AgentPath).Hash.ToLower()",
                f"        if ($Got -ne '{sha256}') {{",
                "            Remove-Item -Force $AgentPath -ErrorAction SilentlyContinue",
                f"            Write-Log \"ERROR: SHA256 mismatch. Expected={sha256} Actual=$Got\"",
                "            exit 1",
                "        }",
                '        Write-Log "SHA256 verified: $Got"',
            )
        else:
            A('        Write-Log "WARNING: No SHA256 configured -- skipping integrity check."')
        A(
            '        Write-Log "Binary downloaded."',
            "    } else {",
            '        Write-Log "Binary up-to-date -- skipping download."',
            "    }",
            "}",
        )
        A(*rustdesk_migration_lines)
        A(
            "",
            "# -- Write/update config (UTF-8 without BOM) using ConvertTo-Json",
            'Write-Log "Writing config to $ConfigPath"',
        )
        A(*config_lines)
        A(
            'Write-Log "Config written."',
            "",
            "# -- Install service (idempotent)",
            '$svc = Get-Service -Name "TechiAgent" -ErrorAction SilentlyContinue',
            "if ($null -eq $svc) {",
            '    Write-Log "Installing TechiAgent service..."',
        )
        if enrollment_token:
            A(f"    & $AgentPath install -config $ConfigPath -enrollment-token '{safe_token}'")
        else:
            A("    & $AgentPath install -config $ConfigPath")
        A(
            '    Write-Log "Service installed."',
            "} else {",
            '    Write-Log "TechiAgent already installed -- skipping install."',
            "}",
            "",
            "# -- Ensure service is running",
            '$svc = Get-Service -Name "TechiAgent" -ErrorAction SilentlyContinue',
            "if ($null -ne $svc -and $svc.Status -ne 'Running') {",
            '    Write-Log "Starting TechiAgent service..."',
            "    & $AgentPath start",
            "    Start-Sleep -Seconds 3",
            "}",
            "",
            '$svc = Get-Service -Name "TechiAgent" -ErrorAction Stop',
            'if ($svc.Status -ne "Running") {',
            '    Write-Log "ERROR: TechiAgent is $($svc.Status) -- expected Running."',
            "    exit 1",
            "}",
            "",
            'Write-Log "TechiAgent running. Domain auto-enrollment occurs on next heartbeat."',
            'Write-Log "Config : $ConfigPath"',
            'Write-Log "Logs   : $LogDir\\agent.log"',
            "exit 0",
        )

        script = "\n".join(L)
        command = "powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-gpo-bootstrap.ps1"
        return command, script

    # ─── Helpers ──────────────────────────────────────────────────────────────

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
        # Bash here-doc is fine: 'JSON' terminator must be at column 0,
        # which it is since we join lines ourselves.
        lines = [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "",
            'INSTALL_DIR="${HOME}/.techi-agent"',
            f'AGENT_URL="https://downloads.example.invalid/techi-agent/{binary_name}/techi-agent"',
            'AGENT_PATH="${INSTALL_DIR}/techi-agent"',
            'CONFIG_PATH="${INSTALL_DIR}/config.json"',
            'HOSTNAME_VALUE="$(hostname)"',
            "",
            'mkdir -p "${INSTALL_DIR}"',
            'curl -fsSL "${AGENT_URL}" -o "${AGENT_PATH}"',
            'chmod +x "${AGENT_PATH}"',
            "",
            'cat > "${CONFIG_PATH}" <<\'JSON\'',
        ]
        # Embed config as-is — bash here-doc terminator must be at col 0
        lines.append(config_template)
        lines += [
            "JSON",
            'sed -i.bak "s/<HOSTNAME>/${HOSTNAME_VALUE}/g" "${CONFIG_PATH}"',
            'rm -f "${CONFIG_PATH}.bak"',
            "",
            f'"${{AGENT_PATH}}" -config "${{CONFIG_PATH}}" -enrollment-token "{enrollment_token}"',
        ]
        script = "\n".join(lines)
        command = "bash ./techi-bootstrap.sh"
        return command, script
