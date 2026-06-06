import json
import re
from urllib.parse import urlsplit, urlunsplit
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
        "Lock screen stays enabled — remote access (TECHI Remote Support) works via Windows service. "
        "Sleep/hibernate makes the device unreachable; use Server profile or Wake-on-LAN to prevent this."
    )
    WINDOWS_AGENT_URL_PLACEHOLDER = "<TECHI_AGENT_WINDOWS_EXE_URL>"

    def __init__(self, db: Session):
        self.token_service = EnrollmentTokenService(db)

    # ─── Public entry point ────────────────────────────────────────────────────

    @staticmethod
    def normalize_backend_url(backend_url: str) -> str:
        """Return the public backend URL with an HTTPS scheme.

        Bootstrap scripts download privileged binaries and write persistent
        agent config, so generated URLs must not downgrade to HTTP even when
        the app is reached through a proxy that reports an http base_url.
        """
        raw = (backend_url or "").strip().rstrip("/")
        if not raw:
            return raw
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        scheme = "https"
        return urlunsplit((scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))

    def generate(self, payload: EnrollmentBootstrapRequest) -> EnrollmentBootstrapResponse:
        backend_url = self.normalize_backend_url(payload.backend_url)

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
            msi_url, _ = self._windows_msi_package_info(backend_url)
            token_name = getattr(token, "name", None) or "client"
            slug = self._safe_filename_slug(token_name)
            if msi_url:
                command, script = self._windows_msi_bootstrap(
                    backend_url, enrollment_token, token_name, payload
                )
                filename = f"TECHI-Bootstrap-{slug}.ps1"
            else:
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
        backend_url = self.normalize_backend_url(backend_url)
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
        password = (payload.rustdesk_default_password or "").strip()
        if not rendezvous or not key:
            return [
                "",
                "# -- TECHI Remote Support force migration skipped: missing TECHI server/key",
                'Write-Log "TECHI Remote Support force migration skipped: missing TECHI server/key"',
            ]

        safe_rendezvous = rendezvous.replace("'", "''")
        safe_relay = relay.replace("'", "''")
        safe_key = key.replace("'", "''")
        safe_password = password.replace("'", "''")
        return [
            "",
            "# -- Force TECHI Remote Support migration to TECHI self-hosted server",
            f"$TechiRendezvous = '{safe_rendezvous}'",
            f"$TechiRelay = '{safe_relay}'",
            f"$TechiKey = '{safe_key}'",
            f"$TechiPassword = '{safe_password}'",
            'Write-Log "Forcing TECHI Remote Support migration to TECHI infrastructure..."',
            "$TechiServices = @('TECHI Remote Support', 'RustDesk', 'rustdesk')",
            "foreach ($ServiceName in $TechiServices) {",
            "    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "    if ($null -ne $svc -and $svc.Status -ne 'Stopped') {",
            '        Write-Log "Stopping TECHI Remote Support service: $ServiceName"',
            "        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue",
            "    }",
            "}",
            "Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue | ForEach-Object {",
            '    Write-Log "Stopping TECHI Remote Support process: $($_.ProcessName) pid=$($_.Id)"',
            "    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue",
            "}",
            "Start-Sleep -Seconds 2",
            "function Test-PathSafe {",
            "    param([string]$Path)",
            "    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }",
            "    try {",
            "        return [bool](Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)",
            "    } catch {",
            '        Write-Log "WARNING: TECHI Remote Support path inaccessible, skipping: $Path Error=$_"',
            "        return $false",
            "    }",
            "}",
            "function Get-ChildItemSafe {",
            "    param([string]$Path, [string]$Filter = '*', [switch]$FileOnly)",
            "    if (-not (Test-PathSafe -Path $Path)) { return @() }",
            "    try {",
            "        if ($FileOnly) {",
            "            return @(Get-ChildItem -LiteralPath $Path -Filter $Filter -File -ErrorAction SilentlyContinue)",
            "        }",
            "        return @(Get-ChildItem -LiteralPath $Path -Filter $Filter -Force -ErrorAction SilentlyContinue)",
            "    } catch {",
            '        Write-Log "WARNING: TECHI Remote Support profile scan inaccessible, skipping: $Path Error=$_"',
            "        return @()",
            "    }",
            "}",
            "function New-DirectorySafe {",
            "    param([string]$Path)",
            "    try {",
            "        New-Item -ItemType Directory -Force -Path $Path -ErrorAction Stop | Out-Null",
            "        return $true",
            "    } catch {",
            '        Write-Log "WARNING: TECHI Remote Support directory inaccessible, skipping: $Path Error=$_"',
            "        return $false",
            "    }",
            "}",
            "function Write-TechiConfigSafe {",
            "    param([string]$Path, [string]$Content)",
            "    try {",
            "        $Parent = Split-Path -Parent $Path",
            "        if ($Parent -and -not (New-DirectorySafe -Path $Parent)) { return $false }",
            "        [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))",
            '        Write-Log "TECHI Remote Support config rewritten: $Path"',
            "        $Written = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue",
            "        if ($Written -and $Written.Contains($TechiRendezvous)) {",
            '            Write-Log "TECHI Remote Support TECHI config verified: $Path"',
            "            return $true",
            "        }",
            '        Write-Log "WARNING: TECHI Remote Support TECHI config verification failed; continuing bootstrap: $Path"',
            "        return $false",
            "    } catch {",
            '        Write-Log "WARNING: TECHI Remote Support config write inaccessible, skipping: $Path Error=$_"',
            "        return $false",
            "    }",
            "}",
            "$TechiRoots = @(",
            "    'C:\\ProgramData\\TECHI Remote Support',",
            "    'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\TECHI Remote Support'",
            ")",
            "if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {",
            "    $TechiRoots += (Join-Path $env:APPDATA 'TECHI Remote Support')",
            "}",
            "if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {",
            "    $TechiRoots += (Join-Path $env:LOCALAPPDATA 'TECHI Remote Support')",
            "}",
            "$TechiRoots = $TechiRoots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique",
            "foreach ($Root in $TechiRoots) {",
            "    if (Test-PathSafe -Path $Root) {",
            '        Write-Log "Old TECHI Remote Support config found: $Root"',
            "        foreach ($Name in @('TECHI Remote Support.toml', 'TECHI Remote Support2.toml')) {",
            "            $Path = Join-Path $Root $Name",
            "            if (Test-PathSafe -Path $Path) {",
            "                try {",
            "                    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue",
            '                    Write-Log "TECHI Remote Support config removed: $Path"',
            "                } catch {",
            '                    Write-Log "WARNING: TECHI Remote Support config remove failed; continuing: $Path Error=$_"',
            "                }",
            "            }",
            "        }",
            "        Get-ChildItemSafe -Path $Root -Filter '*.toml' -FileOnly | ForEach-Object {",
            "            try {",
            "                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue",
            '                Write-Log "TECHI Remote Support config removed: $($_.FullName)"',
            "            } catch {",
            '                Write-Log "WARNING: TECHI Remote Support config remove failed; continuing: $($_.FullName) Error=$_"',
            "            }",
            "        }",
            "        $ConfigDir = Join-Path $Root 'config'",
            "        if (Test-PathSafe -Path $ConfigDir) {",
            "            Get-ChildItemSafe -Path $ConfigDir | ForEach-Object {",
            "                try {",
            "                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue",
            '                    Write-Log "TECHI Remote Support config removed: $($_.FullName)"',
            "                } catch {",
            '                    Write-Log "WARNING: TECHI Remote Support config remove failed; continuing: $($_.FullName) Error=$_"',
            "                }",
            "            }",
            "        }",
            "    } else {",
            '        Write-Log "TECHI Remote Support config root not present or inaccessible: $Root"',
            "    }",
            "}",
            "$TechiToml = @(",
            "    \"rendezvous_server = '$TechiRendezvous'\",",
            "    'nat_type = 1',",
            "    'serial = 0',",
            "    '',",
            "    '[options]',",
            "    \"custom-rendezvous-server = '$TechiRendezvous'\",",
            "    \"relay-server = '$TechiRelay'\",",
            "    \"key = '$TechiKey'\"",
            ") -join \"`n\"",
            "foreach ($Root in $TechiRoots) {",
            "    $ConfigDir = Join-Path $Root 'config'",
            "    if (-not (New-DirectorySafe -Path $ConfigDir)) { continue }",
            "    foreach ($Path in @((Join-Path $Root 'TECHI Remote Support2.toml'), (Join-Path $ConfigDir 'TECHI Remote Support2.toml'))) {",
            "        [void](Write-TechiConfigSafe -Path $Path -Content $TechiToml)",
            "    }",
            "}",
            "function Get-TechiExecutable {",
            "    $Candidates = @(",
            "        'C:\\Program Files\\TECHI Remote Support\\rustdesk.exe',",
            "        'C:\\Program Files (x86)\\TECHI Remote Support\\rustdesk.exe'",
            "    )",
            "    foreach ($ServiceName in $TechiServices) {",
            "        $Service = Get-CimInstance Win32_Service -Filter \"Name='$ServiceName'\" -ErrorAction SilentlyContinue",
            "        if ($null -ne $Service -and -not [string]::IsNullOrWhiteSpace($Service.PathName)) {",
            "            $ImagePath = $Service.PathName.Trim()",
            "            if ($ImagePath -match '\"([^\"]*rustdesk\\.exe)\"') {",
            "                $Candidates += $Matches[1]",
            "            } elseif ($ImagePath -match '([A-Za-z]:\\\\.*?rustdesk\\.exe)') {",
            "                $Candidates += $Matches[1]",
            "            }",
            "        }",
            "    }",
            "    foreach ($Candidate in ($Candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {",
            "        if (Test-PathSafe -Path $Candidate) {",
            "            return $Candidate",
            "        }",
            "    }",
            "    return $null",
            "}",
            "if (-not [string]::IsNullOrWhiteSpace($TechiPassword)) {",
            "    $TechiExe = Get-TechiExecutable",
            "    if ($null -eq $TechiExe) {",
            '        Write-Log "WARNING: TECHI Remote Support password not set because rustdesk.exe was not found."',
            "    } else {",
            "        try {",
            '            Write-Log "Setting TECHI Remote Support unattended access password via CLI."',
            "            $PasswordProcess = Start-Process -FilePath $TechiExe -ArgumentList @('--password', $TechiPassword) -Wait -PassThru -WindowStyle Hidden",
            "            if ($PasswordProcess.ExitCode -eq 0) {",
            '                Write-Log "TECHI Remote Support unattended access password configured."',
            "            } else {",
            '                Write-Log "WARNING: TECHI Remote Support password CLI exited with code $($PasswordProcess.ExitCode); continuing bootstrap."',
            "            }",
            "        } catch {",
            '            Write-Log "WARNING: TECHI Remote Support password CLI failed; continuing bootstrap. Error=$_"',
            "        }",
            "    }",
            "} else {",
            '    Write-Log "TECHI Remote Support unattended access password skipped: no password configured."',
            "}",
            "foreach ($ServiceName in $TechiServices) {",
            "    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "    if ($null -ne $svc) {",
            '        Write-Log "Restarting TECHI Remote Support service: $ServiceName"',
            "        Start-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "        Start-Sleep -Seconds 3",
            "        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "        if ($null -ne $svc) {",
            '            Write-Log "TECHI Remote Support restarted: $ServiceName status=$($svc.Status)"',
            "        }",
            "    }",
            "}",
            'Write-Log "TECHI Remote Support forced migration complete."',
        ]

    def _agent_update_ps_lines(self) -> list[str]:
        return [
            "function Test-FileHashSafe {",
            "    param([string]$Path, [string]$ExpectedSha256)",
            "    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) { return $true }",
            "    if (-not (Test-Path -LiteralPath $Path -ErrorAction SilentlyContinue)) { return $false }",
            "    try {",
            "        $Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path -ErrorAction Stop).Hash.ToLower()",
            "        if ($Got -eq $ExpectedSha256.ToLower()) {",
            '            Write-Log "SHA256 verified: $Got"',
            "            return $true",
            "        }",
            '        Write-Log "ERROR: SHA256 mismatch. Expected=$ExpectedSha256 Actual=$Got"',
            "        return $false",
            "    } catch {",
            '        Write-Log "ERROR: SHA256 verification failed for $Path Error=$_"',
            "        return $false",
            "    }",
            "}",
            "",
            "function Wait-TechiAgentStopped {",
            "    param([int]$TimeoutSeconds = 45)",
            "    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)",
            "    do {",
            "        $svc = Get-Service -Name 'TechiAgent' -ErrorAction SilentlyContinue",
            "        $procs = @(Get-Process -Name 'techi-agent' -ErrorAction SilentlyContinue)",
            "        if (($null -eq $svc -or $svc.Status -eq 'Stopped') -and $procs.Count -eq 0) { return $true }",
            "        Start-Sleep -Milliseconds 500",
            "    } while ((Get-Date) -lt $Deadline)",
            "    return $false",
            "}",
            "",
            "function Stop-TechiAgentForUpdate {",
            "    $svc = Get-Service -Name 'TechiAgent' -ErrorAction SilentlyContinue",
            "    if ($null -eq $svc) {",
            '        Write-Log "service_stopped: TechiAgent service not installed."',
            "        return $false",
            "    }",
            "    if ($svc.Status -ne 'Stopped') {",
            '        Write-Log "update_started: stopping TechiAgent service. CurrentStatus=$($svc.Status)"',
            "        try { Stop-Service -Name 'TechiAgent' -Force -ErrorAction Stop } catch { Write-Log \"WARNING: Stop-Service failed; waiting/retrying replacement. Error=$_\" }",
            "    } else {",
            '        Write-Log "update_started: TechiAgent service already stopped."',
            "    }",
            "    if (Wait-TechiAgentStopped -TimeoutSeconds 45) {",
            '        Write-Log "service_stopped: TechiAgent stopped and process exited."',
            "    } else {",
            '        Write-Log "WARNING: TechiAgent did not fully stop before replace deadline; replacement will retry with backoff."',
            "    }",
            "    return $true",
            "}",
            "",
            "function Start-TechiAgentAfterUpdate {",
            "    param([bool]$ServiceExisted)",
            "    if (-not $ServiceExisted) { return }",
            "    try {",
            "        Start-Service -Name 'TechiAgent' -ErrorAction Stop",
            "        Start-Sleep -Seconds 3",
            "        $svc = Get-Service -Name 'TechiAgent' -ErrorAction Stop",
            "        if ($svc.Status -ne 'Running') { throw \"TechiAgent status is $($svc.Status)\" }",
            '        Write-Log "service_started: TechiAgent running after update."',
            "    } catch {",
            '        Write-Log "ERROR: service_started failed: $_"',
            "        throw",
            "    }",
            "}",
            "",
            "function Replace-FileWithRetry {",
            "    param([string]$Source, [string]$Destination)",
            "    $Delays = @(1, 2, 4, 8, 12)",
            "    for ($i = 0; $i -lt $Delays.Count; $i++) {",
            "        try {",
            "            Move-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop",
            "            return",
            "        } catch {",
            "            $Attempt = $i + 1",
            '            Write-Log "WARNING: binary replace attempt $Attempt failed: $_"',
            "            Start-Sleep -Seconds $Delays[$i]",
            "        }",
            "    }",
            "    throw \"Binary replace failed after $($Delays.Count) attempts: $Source -> $Destination\"",
            "}",
            "",
            "function Install-TechiAgentBinary {",
            "    param([string]$AgentUrl, [string]$AgentPath, [string]$NewPath, [string]$BackupPath, [string]$ExpectedSha256)",
            "    $NeedDownload = $true",
            "    if (Test-Path -LiteralPath $AgentPath -ErrorAction SilentlyContinue) {",
            "        if (Test-FileHashSafe -Path $AgentPath -ExpectedSha256 $ExpectedSha256) {",
            "            if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {",
            '                Write-Log "Binary checksum matches -- skipping download."',
            "                return",
            "            }",
            '            Write-Log "No SHA256 configured -- update will re-download and replace safely."',
            "        }",
            "    }",
            '    Write-Log "update_started: downloading Techi Agent from $AgentUrl to $NewPath"',
            "    Remove-Item -LiteralPath $NewPath -Force -ErrorAction SilentlyContinue",
            "    try {",
            "        Invoke-WebRequest -Uri $AgentUrl -OutFile $NewPath -UseBasicParsing -ErrorAction Stop",
            "    } catch {",
            '        Write-Log "ERROR: Download failed: $_"',
            "        throw",
            "    }",
            "    if (-not (Test-FileHashSafe -Path $NewPath -ExpectedSha256 $ExpectedSha256)) {",
            "        Remove-Item -LiteralPath $NewPath -Force -ErrorAction SilentlyContinue",
            "        throw 'Downloaded Techi Agent failed integrity validation.'",
            "    }",
            '    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) { Write-Log "WARNING: No SHA256 configured -- signature/checksum validation skipped." }',
            "    $ServiceExisted = Stop-TechiAgentForUpdate",
            "    $BackupCreated = $false",
            "    try {",
            "        Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue",
            "        if (Test-Path -LiteralPath $AgentPath -ErrorAction SilentlyContinue) {",
            "            Replace-FileWithRetry -Source $AgentPath -Destination $BackupPath",
            "            $BackupCreated = $true",
            "        }",
            "        Replace-FileWithRetry -Source $NewPath -Destination $AgentPath",
            '        Write-Log "binary_replaced: Techi Agent binary updated at $AgentPath"',
            "        Start-TechiAgentAfterUpdate -ServiceExisted $ServiceExisted",
            "    } catch {",
            '        Write-Log "rollback_triggered: update failed after service stop/replace. Error=$_"',
            "        Remove-Item -LiteralPath $AgentPath -Force -ErrorAction SilentlyContinue",
            "        if ($BackupCreated -and (Test-Path -LiteralPath $BackupPath -ErrorAction SilentlyContinue)) {",
            "            try { Replace-FileWithRetry -Source $BackupPath -Destination $AgentPath } catch { Write-Log \"ERROR: rollback restore failed: $_\" }",
            "        }",
            "        try { Start-TechiAgentAfterUpdate -ServiceExisted $ServiceExisted } catch { Write-Log \"ERROR: rollback service restart failed: $_\" }",
            "        throw",
            "    } finally {",
            "        Remove-Item -LiteralPath $NewPath -Force -ErrorAction SilentlyContinue",
            "    }",
            "}",
            "",
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
            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "",
            "# Techi Agent -- one-click installer (Token Enrollment)",
            "# Run as Administrator:",
            "#   powershell -ExecutionPolicy Bypass -NoProfile -File .\\techi-installer.ps1",
            "",
            '$InstallDir = "C:\\ProgramData\\TechiAgent"',
            "$LogDir     = Join-Path $InstallDir 'logs'",
            "$LogFile    = Join-Path $LogDir 'installer.log'",
            f"$AgentUrl   = '{package_url}'",
            f"$ExpectedSha256 = '{sha256}'",
            "$AgentPath  = Join-Path $InstallDir 'techi-agent.exe'",
            "$AgentNewPath = Join-Path $InstallDir 'techi-agent.new.exe'",
            "$AgentBackupPath = Join-Path $InstallDir 'techi-agent.previous.exe'",
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
        )
        A(*self._agent_update_ps_lines())
        A(
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
            "    Install-TechiAgentBinary -AgentUrl $AgentUrl -AgentPath $AgentPath -NewPath $AgentNewPath -BackupPath $AgentBackupPath -ExpectedSha256 $ExpectedSha256",
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
            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "# Techi Agent -- GPO / Trusted Domain deployment",
            "# Idempotent: safe to run at every PC startup via GPO.",
            "# No prompts, no Read-Host. Exits 0 on success, 1 on error.",
            "",
            '$InstallDir = "C:\\ProgramData\\TechiAgent"',
            "$LogDir     = Join-Path $InstallDir 'logs'",
            "$LogFile    = Join-Path $LogDir 'installer.log'",
            f"$AgentUrl   = '{package_url}'",
            f"$ExpectedSha256 = '{sha256}'",
            "$AgentPath  = Join-Path $InstallDir 'techi-agent.exe'",
            "$AgentNewPath = Join-Path $InstallDir 'techi-agent.new.exe'",
            "$AgentBackupPath = Join-Path $InstallDir 'techi-agent.previous.exe'",
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
        )
        A(*self._agent_update_ps_lines())
        A(
            "New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null",
            "New-Item -ItemType Directory -Force -Path $LogDir | Out-Null",
            'Write-Log "=== Techi Agent GPO Installer ==="',
            'Write-Log "Execution context: $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"',
            "",
            "# -- Trusted domain preflight. Backend re-validates during /agent/enroll.",
            "$ComputerSystem = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue",
            "if ($null -eq $ComputerSystem -or -not $ComputerSystem.PartOfDomain -or [string]::IsNullOrWhiteSpace($ComputerSystem.Domain)) {",
            '    Write-Log "Machine is not domain-joined; trusted-domain bootstrap skipped."',
            "    exit 0",
            "}",
            "$TrustedDomain = $ComputerSystem.Domain.Trim()",
            'Write-Log "Trusted-domain candidate detected: $TrustedDomain"',
            "",
            "# -- Download or verify binary",
            "if ($AgentUrl -like '<*>' -or [string]::IsNullOrWhiteSpace($AgentUrl)) {",
            "    if (-not (Test-Path $AgentPath)) {",
            '        Write-Log "ERROR: No download URL and no binary at $AgentPath"',
            "        exit 1",
            "    }",
            '    Write-Log "Using existing binary at $AgentPath -- checksum skipped."',
            "} else {",
            "    Install-TechiAgentBinary -AgentUrl $AgentUrl -AgentPath $AgentPath -NewPath $AgentNewPath -BackupPath $AgentBackupPath -ExpectedSha256 $ExpectedSha256",
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

    # ─── GPO Scheduled Task setup script (DC one-shot) ───────────────────────────

    @staticmethod
    def _gpo_scheduled_task_setup(backend_url: str, enrollment_token: str) -> str:
        safe_url = backend_url.rstrip("/")
        token_prefix = enrollment_token[:8] if len(enrollment_token) >= 8 else enrollment_token

        L: list[str] = []

        def A(*lines: str) -> None:
            L.extend(lines)

        A(
            "#Requires -RunAsAdministrator",
            '$ErrorActionPreference = "Stop"',
            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "",
            "# TECHI Agent - GPO Scheduled Task Deploy",
            "# Ekzekutoni si Administrator ne cdo Domain Controller.",
            "# Idempotent: krijon/perditeson dy GPO dhe instalon TECHI Agent cdo dite.",
            "",
            '$ScheduleTime = "15:00"',
            f'$TokenPrefix   = "{token_prefix}"',
            "",
            'Write-Host "=== TECHI Agent GPO Scheduled Task Deploy ===" -ForegroundColor Cyan',
            "",
            "# Hapi 1: Importimi i moduleve",
            'Write-Host "Hapi 1: Importimi i moduleve GroupPolicy dhe ActiveDirectory..." -ForegroundColor Yellow',
            "Import-Module GroupPolicy -ErrorAction Stop",
            "Import-Module ActiveDirectory -ErrorAction Stop",
            'Write-Host "   Module u ngarkuan me sukses." -ForegroundColor Green',
            "",
            "# Hapi 2: Zbulimi automatik i domainit",
            'Write-Host "Hapi 2: Zbulimi i domainit..." -ForegroundColor Yellow',
            "$Domain       = Get-ADDomain",
            "$DomainDN     = $Domain.DistinguishedName",
            "$DomainDNS    = $Domain.DNSRoot",
            '$NetlogonPath = "\\\\$DomainDNS\\NETLOGON"',
            '$SysvolBase   = "\\\\$DomainDNS\\SYSVOL\\$DomainDNS\\Policies"',
            'Write-Host "   Domain   : $DomainDNS" -ForegroundColor Green',
            'Write-Host "   DN       : $DomainDN" -ForegroundColor Green',
            'Write-Host "   NETLOGON : $NetlogonPath" -ForegroundColor Green',
            "",
            "# Hapi 3: GPO per perjashtimin nga Windows Defender",
            'Write-Host "Hapi 3: GPO \'TECHI Agent - Defender Exclusions\'..." -ForegroundColor Yellow',
            '$ExclGPOName = "TECHI Agent - Defender Exclusions"',
            "$ExclGPO     = Get-GPO -Name $ExclGPOName -ErrorAction SilentlyContinue",
            "if ($null -eq $ExclGPO) {",
            "    $ExclGPO = New-GPO -Name $ExclGPOName",
            '    Write-Host "   GPO u krijua." -ForegroundColor Green',
            "} else {",
            '    Write-Host "   GPO ekziston, perditesim..." -ForegroundColor Cyan',
            "}",
            "foreach ($XPath in @('C:\\ProgramData\\TechiAgent', 'C:\\ProgramData\\TechiAgent\\techi-agent.exe')) {",
            "    Set-GPRegistryValue -Name $ExclGPOName `",
            "        -Key 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Exclusions\\Paths' `",
            "        -ValueName $XPath -Type String -Value '0' | Out-Null",
            "}",
            "Set-GPRegistryValue -Name $ExclGPOName `",
            "    -Key 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Exclusions\\Processes' `",
            "    -ValueName 'techi-agent.exe' -Type String -Value '0' | Out-Null",
            'Write-Host "   Perjashtimi i shtegut dhe procesit u konfigurua." -ForegroundColor Green',
            "",
            "# Hapi 4: Shkrimi i techi-deploy.cmd ne NETLOGON (CMD, AMSI-i sigurte)",
            'Write-Host "Hapi 4: Shkrimi i techi-deploy.cmd ne NETLOGON..." -ForegroundColor Yellow',
            '$DeployScriptPath = Join-Path $NetlogonPath "techi-deploy.cmd"',
            "$DeployContent = @'",
            # ── techi-deploy.cmd content (PS single-quoted here-string; no PS expansion) ──
            "@echo off",
            "setlocal EnableExtensions",
            "",
            "set INSTALL_DIR=C:\\ProgramData\\TechiAgent",
            "set AGENT_EXE=%INSTALL_DIR%\\techi-agent.exe",
            "set CONFIG=%INSTALL_DIR%\\agent.config.json",
            f"set TOKEN={enrollment_token}",
            f"set BACKEND_URL={safe_url}",
            "set MSI_URL=%BACKEND_URL%/api/v1/agent-packages/platform/windows-amd64/download",
            "",
            ":: Case 1: I regjistruar dhe Running - kalo",
            'findstr /i "device_id" "%CONFIG%" >nul 2>&1',
            "if errorlevel 1 goto :check_running",
            'sc query TechiAgent | findstr /i "RUNNING" >nul 2>&1',
            "if errorlevel 1 goto :check_running",
            "exit /b 0",
            "",
            ":check_running",
            ":: Case 2: Running por jo i regjistruar - regjistrohu",
            'sc query TechiAgent | findstr /i "RUNNING" >nul 2>&1',
            "if errorlevel 1 goto :fresh_install",
            '"%AGENT_EXE%" -config "%CONFIG%" -enrollment-token "%TOKEN%" -once >nul 2>&1',
            "exit /b 0",
            "",
            ":fresh_install",
            ":: Case 3: I painstaluar - shkarko MSI dhe instalo",
            "set TMP_DIR=C:\\Windows\\Temp\\techi-gpo-%RANDOM%",
            'md "%TMP_DIR%" 2>nul',
            "set MSI_PATH=%TMP_DIR%\\techi-setup.msi",
            "",
            'curl.exe -L -f -s -o "%MSI_PATH%" "%MSI_URL%"',
            "if errorlevel 1 (",
            '    rd /s /q "%TMP_DIR%" 2>nul',
            "    exit /b 1",
            ")",
            "",
            'msiexec /i "%MSI_PATH%" TOKEN=%TOKEN% "BACKEND_URL=%BACKEND_URL%" /quiet /norestart',
            "timeout /t 10 /nobreak >nul",
            "",
            "net stop TechiAgent >nul 2>&1",
            '"%AGENT_EXE%" -config "%CONFIG%" -enrollment-token "%TOKEN%" -once >nul 2>&1',
            "net start TechiAgent >nul 2>&1",
            "",
            'rd /s /q "%TMP_DIR%" 2>nul',
            "exit /b 0",
            # ── end of techi-deploy.cmd content ──
            "'@",
            "[System.IO.File]::WriteAllText($DeployScriptPath, $DeployContent, [System.Text.UTF8Encoding]::new($false))",
            'Write-Host "   techi-deploy.cmd u shkrua ne: $DeployScriptPath" -ForegroundColor Green',
            "",
            "# Hapi 5: GPO per detyren e planifikuar",
            'Write-Host "Hapi 5: GPO \'TECHI Agent Deployment\' me detyre te planifikuar..." -ForegroundColor Yellow',
            '$DeployGPOName = "TECHI Agent Deployment"',
            "$DeployGPO    = Get-GPO -Name $DeployGPOName -ErrorAction SilentlyContinue",
            "if ($null -eq $DeployGPO) {",
            "    $DeployGPO = New-GPO -Name $DeployGPOName",
            '    Write-Host "   GPO u krijua." -ForegroundColor Green',
            "} else {",
            '    Write-Host "   GPO ekziston, perditesim..." -ForegroundColor Cyan',
            "}",
            '$GPOGuid     = $DeployGPO.Id.ToString("B").ToUpper()',
            "$GPOSysvol   = Join-Path $SysvolBase $GPOGuid",
            '$GPOPrefsDir = Join-Path $GPOSysvol "Machine\\Preferences\\ScheduledTasks"',
            "New-Item -ItemType Directory -Force -Path $GPOPrefsDir | Out-Null",
            '$TaskXmlPath = Join-Path $GPOPrefsDir "ScheduledTasks.xml"',
            "",
            "# Hapi 6: ScheduledTasks.xml - TaskV2, action=R, CalendarTrigger + BootTrigger",
            'Write-Host "Hapi 6: Konfigurimi i detyres (TaskV2, action=R, dy trigger)..." -ForegroundColor Yellow',
            '$TaskUID     = "{" + [System.Guid]::NewGuid().ToString().ToUpper() + "}"',
            '$ChangedDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
            '$NetlogonScr = "\\\\$DomainDNS\\NETLOGON\\techi-deploy.cmd"',
            '$StartBound  = "2000-01-01T$($ScheduleTime):00"',
            '$TaskXml = @"',
            '<?xml version="1.0" encoding="utf-8"?>',
            '<ScheduledTasks clsid="{CC63F200-7309-4ba0-B154-A0660CC16E20}">',
            '  <TaskV2 clsid="{D8896631-B747-47a7-84A6-C155337F3BC8}" name="TECHI Agent Deploy" image="0" changed="$ChangedDate" uid="$TaskUID" userContext="0" removePolicy="0">',
            '    <Properties action="R" name="TECHI Agent Deploy" runAs="NT AUTHORITY\\System" logonType="S4U">',
            '      <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
            "        <RegistrationInfo>",
            "          <Description>Deploy TECHI Agent - cdo dite ne oren $ScheduleTime dhe pas cdo restart</Description>",
            "        </RegistrationInfo>",
            "        <Principals>",
            '          <Principal id="Author">',
            "            <UserId>NT AUTHORITY\\System</UserId>",
            "            <LogonType>S4U</LogonType>",
            "            <RunLevel>HighestAvailable</RunLevel>",
            "          </Principal>",
            "        </Principals>",
            "        <Settings>",
            "          <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "          <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
            "          <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
            "          <AllowHardTerminate>true</AllowHardTerminate>",
            "          <StartWhenAvailable>true</StartWhenAvailable>",
            "          <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
            "          <Enabled>true</Enabled>",
            "          <Hidden>false</Hidden>",
            "          <RunOnlyIfIdle>false</RunOnlyIfIdle>",
            "          <WakeToRun>false</WakeToRun>",
            "          <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>",
            "          <Priority>7</Priority>",
            "        </Settings>",
            "        <Triggers>",
            "          <CalendarTrigger>",
            "            <StartBoundary>$StartBound</StartBoundary>",
            "            <Enabled>true</Enabled>",
            "            <ScheduleByDay>",
            "              <DaysInterval>1</DaysInterval>",
            "            </ScheduleByDay>",
            "          </CalendarTrigger>",
            "          <BootTrigger>",
            "            <Enabled>true</Enabled>",
            "            <Delay>PT5M</Delay>",
            "          </BootTrigger>",
            "        </Triggers>",
            '        <Actions Context="Author">',
            "          <Exec>",
            "            <Command>$NetlogonScr</Command>",
            "            <Arguments></Arguments>",
            "          </Exec>",
            "        </Actions>",
            "      </Task>",
            "    </Properties>",
            "  </TaskV2>",
            "</ScheduledTasks>",
            '"@',
            "[System.IO.File]::WriteAllText($TaskXmlPath, $TaskXml, [System.Text.UTF8Encoding]::new($false))",
            'Write-Host "   ScheduledTasks.xml u shkrua ne: $TaskXmlPath" -ForegroundColor Green',
            "",
            "# Hapi 7: gPCMachineExtensionNames dhe version ne AD",
            'Write-Host "Hapi 7: Perditesimi i gPCMachineExtensionNames dhe versionit ne AD..." -ForegroundColor Yellow',
            '$ExtNames    = "[{00000000-0000-0000-0000-000000000000}{CAB54552-DEEA-4691-817E-ED4A4D1AFC72}][{AADCED64-746C-4633-A97C-D61349046527}{CAB54552-DEEA-4691-817E-ED4A4D1AFC72}]"',
            '$GPODistName = "CN=$GPOGuid,CN=Policies,CN=System,$DomainDN"',
            "$GPOADObj    = Get-ADObject -Identity $GPODistName -Properties versionNumber",
            "$MachineVer  = (($GPOADObj.versionNumber -band 0xFFFF) + 1) -band 0xFFFF",
            "$UserVer     = ($GPOADObj.versionNumber -shr 16) -band 0xFFFF",
            "$NewVersion  = ($UserVer -shl 16) -bor $MachineVer",
            "Set-ADObject -Identity $GPODistName -Replace @{",
            "    gPCMachineExtensionNames = $ExtNames",
            "    versionNumber            = $NewVersion",
            "}",
            '$GptIniPath = Join-Path $GPOSysvol "GPT.INI"',
            '"[General]`nVersion=$NewVersion" | Set-Content -Path $GptIniPath -Encoding ASCII -Force',
            'Write-Host "   gPCMachineExtensionNames dhe versioni u perditesuan." -ForegroundColor Green',
            "",
            "# Hapi 8: Lidhja e GPO-ve me domainit",
            'Write-Host "Hapi 8: Lidhja e GPO-ve me domainit..." -ForegroundColor Yellow',
            "$ExistingLinks = (Get-GPInheritance -Target $DomainDN).GpoLinks",
            "if (-not ($ExistingLinks | Where-Object { $_.GpoId -eq $ExclGPO.Id })) {",
            "    New-GPLink -Name $ExclGPOName -Target $DomainDN -LinkEnabled Yes | Out-Null",
            '    Write-Host "   GPO \'$ExclGPOName\' u lidh me domainit." -ForegroundColor Green',
            "} else {",
            '    Write-Host "   GPO \'$ExclGPOName\' eshte i lidhur." -ForegroundColor Cyan',
            "}",
            "if (-not ($ExistingLinks | Where-Object { $_.GpoId -eq $DeployGPO.Id })) {",
            "    New-GPLink -Name $DeployGPOName -Target $DomainDN -LinkEnabled Yes | Out-Null",
            '    Write-Host "   GPO \'$DeployGPOName\' u lidh me domainit." -ForegroundColor Green',
            "} else {",
            '    Write-Host "   GPO \'$DeployGPOName\' eshte i lidhur." -ForegroundColor Cyan',
            "}",
            "",
            "# Hapi 9: gpupdate /force",
            'Write-Host "Hapi 9: Perditesimi i politikave te grupit (gpupdate /force)..." -ForegroundColor Yellow',
            "gpupdate /force | Out-Null",
            'Write-Host "   Politikat e grupit u perditesuan." -ForegroundColor Green',
            "",
            'Write-Host ""',
            'Write-Host "========================================================" -ForegroundColor Cyan',
            'Write-Host "  TECHI Agent GPO Scheduled Task Deploy - PERFUNDOI  " -ForegroundColor Cyan',
            'Write-Host "========================================================" -ForegroundColor Cyan',
            'Write-Host "  Domain    : $DomainDNS" -ForegroundColor White',
            f'Write-Host "  Token     : {token_prefix}..." -ForegroundColor White',
            'Write-Host "  Orari     : $ScheduleTime cdo dite + pas cdo restart (5 min)" -ForegroundColor White',
            'Write-Host "  NETLOGON  : $DeployScriptPath" -ForegroundColor White',
            'Write-Host "  GPO 1     : $ExclGPOName" -ForegroundColor White',
            'Write-Host "  GPO 2     : $DeployGPOName" -ForegroundColor White',
            'Write-Host "========================================================" -ForegroundColor Cyan',
            'Write-Host "  PC-te do instalojne TECHI Agent cdo dite ne oren" -ForegroundColor White',
            'Write-Host "  $ScheduleTime dhe 5 min pas restart. CMD, AMSI-i sigurte." -ForegroundColor White',
            'Write-Host "========================================================" -ForegroundColor Cyan',
        )

        return "\n".join(L)

    # ─── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _safe_filename_slug(name: str) -> str:
        slug = re.sub(r"[^\w\s-]", "", name.strip())
        slug = re.sub(r"[\s_]+", "-", slug)
        slug = slug.strip("-")[:40]
        return slug or "client"

    def _windows_msi_package_info(self, backend_url: str) -> tuple[str, str]:
        backend_url = self.normalize_backend_url(backend_url)
        svc = AgentPackageService()
        package = svc.latest_active("windows")
        if package is None:
            return "", ""
        url = f"{backend_url.rstrip('/')}{svc.latest_download_url('windows')}"
        return url, package.sha256 or ""

    def _windows_msi_bootstrap(
        self,
        backend_url: str,
        enrollment_token: str,
        token_name: str,
        payload: EnrollmentBootstrapRequest,
    ) -> tuple[str, str]:
        msi_url, sha256 = self._windows_msi_package_info(backend_url)
        safe_token = enrollment_token.replace("'", "''")
        safe_url = backend_url.replace("'", "''")
        safe_msi_url = msi_url.replace("'", "''")
        safe_sha256 = sha256.replace("'", "''")
        slug = self._safe_filename_slug(token_name)

        L: list[str] = []

        def A(*lines: str) -> None:
            L.extend(lines)

        A(
            '$ErrorActionPreference = "Stop"',
            "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
            "",
            f"# TECHI Endpoint Bootstrap: {token_name}",
            "# Run as Administrator:",
            f"#   powershell -ExecutionPolicy Bypass -NoProfile -File .\\TECHI-Bootstrap-{slug}.ps1",
            "",
            f"$BackendUrl    = '{safe_url}'",
            f"$MsiUrl        = '{safe_msi_url}'",
            f"$ExpectedSha256 = '{safe_sha256}'",
            f"$Token         = '{safe_token}'",
            "$MsiPath       = Join-Path $env:TEMP 'techi-endpoint-setup.msi'",
            "$LogFile       = 'C:\\Windows\\Temp\\techi-bootstrap.log'",
            "$MsiLog        = 'C:\\Windows\\Temp\\techi-bootstrap-install.log'",
            "",
            "function Write-Log {",
            "    param([string]$Msg)",
            "    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'",
            '    $line = "$ts  $Msg"',
            "    Write-Host $line",
            "    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}",
            "}",
            "",
            "# -- Admin elevation check",
            "$identity  = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
            "$principal = [System.Security.Principal.WindowsPrincipal]$identity",
            "if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {",
            '    Write-Log "ERROR: This script must be run as Administrator."',
            "    exit 1",
            "}",
            "",
            'Write-Log "=== TECHI Endpoint Bootstrap ==="',
            "",
            "# -- Download MSI",
            'Write-Log "Downloading TECHI Endpoint package from $MsiUrl"',
            "Remove-Item -LiteralPath $MsiPath -Force -ErrorAction SilentlyContinue",
            "try {",
            "    Invoke-WebRequest -Uri $MsiUrl -OutFile $MsiPath -UseBasicParsing -ErrorAction Stop",
            '    Write-Log "Download complete: $MsiPath"',
            "} catch {",
            '    Write-Log "ERROR: Download failed: $_"',
            "    exit 1",
            "}",
            "",
            "# -- Verify SHA256",
            "if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {",
            '    Write-Log "Verifying SHA256..."',
            "    try {",
            "        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $MsiPath -ErrorAction Stop).Hash.ToLower()",
            "        if ($actual -ne $ExpectedSha256.ToLower()) {",
            '            Write-Log "ERROR: SHA256 mismatch. Expected=$ExpectedSha256 Actual=$actual"',
            "            Remove-Item -LiteralPath $MsiPath -Force -ErrorAction SilentlyContinue",
            "            exit 1",
            "        }",
            '        Write-Log "SHA256 verified: $actual"',
            "    } catch {",
            '        Write-Log "ERROR: SHA256 check failed: $_"',
            "        Remove-Item -LiteralPath $MsiPath -Force -ErrorAction SilentlyContinue",
            "        exit 1",
            "    }",
            "} else {",
            '    Write-Log "WARNING: No SHA256 configured -- skipping integrity check."',
            "}",
            "",
            "# -- Silent MSI install",
            'Write-Log "Installing TECHI Endpoint (msiexec)..."',
            "$msiArgs = @(",
            "    '/i', $MsiPath,",
            "    ('TOKEN=' + $Token),",
            "    ('BACKEND_URL=' + $BackendUrl),",
            "    '/qn',",
            "    '/L*v', $MsiLog",
            ")",
            "try {",
            "    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -Wait -PassThru",
            "    if ($proc.ExitCode -ne 0) {",
            '        Write-Log "ERROR: msiexec exited with code $($proc.ExitCode). See: $MsiLog"',
            "        exit 1",
            "    }",
            '    Write-Log "Installation complete (exit 0)."',
            "} catch {",
            '    Write-Log "ERROR: msiexec launch failed: $_"',
            "    exit 1",
            "} finally {",
            "    Remove-Item -LiteralPath $MsiPath -Force -ErrorAction SilentlyContinue",
            "}",
            "",
            "# -- Wait for services to start",
            "Start-Sleep -Seconds 5",
            "",
            "# -- Verify services",
            '$RequiredServices = @("TechiAgent", "TECHI Remote Support")',
            "foreach ($ServiceName in $RequiredServices) {",
            "    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue",
            "    if ($null -eq $svc) {",
            '        Write-Log "WARNING: Service not found after install: $ServiceName"',
            "    } elseif ($svc.Status -ne 'Running') {",
            '        Write-Log "WARNING: $ServiceName is $($svc.Status) -- expected Running."',
            "    } else {",
            '        Write-Log "OK: $ServiceName is Running."',
            "    }",
            "}",
            "",
            '$agentSvc = Get-Service -Name "TechiAgent" -ErrorAction SilentlyContinue',
            "if ($null -eq $agentSvc -or $agentSvc.Status -ne 'Running') {",
            '    Write-Log "ERROR: TechiAgent is not running after install."',
            "    exit 1",
            "}",
            "",
            'Write-Log "TECHI Endpoint deployed successfully."',
            'Write-Log "Install log: $MsiLog"',
            "exit 0",
        )

        script = "\n".join(L)
        command = f"powershell -ExecutionPolicy Bypass -NoProfile -File .\\TECHI-Bootstrap-{slug}.ps1"
        return command, script

    def _windows_package_info(self, backend_url: str) -> tuple[str, str]:
        backend_url = self.normalize_backend_url(backend_url)
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
        backend_url = self.normalize_backend_url(backend_url)
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
