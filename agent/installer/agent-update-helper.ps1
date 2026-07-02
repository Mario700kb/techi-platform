param(
    [Parameter(Mandatory=$true)][string]$NewExePath,
    [string]$TargetVersion = "",
    [string]$ApiUrl = "https://api-rdp.techi.com.al",
    [string]$EnrollmentToken = ""
)

$ErrorActionPreference = 'Stop'

$agentDir = Join-Path $env:ProgramData 'TechiAgent'
$dataDir = Join-Path $env:ProgramData 'TECHI'
$agentExe = Join-Path $agentDir 'techi-agent.exe'
$agentOld = Join-Path $agentDir 'techi-agent-old.exe'
$deployLog = Join-Path $agentDir 'deploy.log'
$configPath = Join-Path $dataDir 'agent.config.json'
$serviceName = 'TechiAgent'

function Write-DeployLog([string]$Message) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $deployLog -Value "$stamp [agent-update-bridge] $Message"
}

function Get-AgentServiceStatus {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return 'missing' }
    return [string]$svc.Status
}

function Ensure-AgentConfig {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    if (Test-Path -LiteralPath $configPath) {
        Write-DeployLog "config preserved path=$configPath"
        return
    }
    if ([string]::IsNullOrWhiteSpace($EnrollmentToken)) {
        Write-DeployLog "config missing and no enrollment token supplied; leaving enrollment to existing agent/bootstrap"
        return
    }
    $cfg = [ordered]@{
        api_url = $ApiUrl
        enrollment_token = $EnrollmentToken
        timeout_seconds = 30
        heartbeat_interval_seconds = 60
        retries = 3
        retry_delay_seconds = 10
        collect_processes = $true
        collect_software = $true
        collect_services = $true
    }
    $json = $cfg | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))
    Write-DeployLog "config created path=$configPath"
}

function Stop-AgentService {
    $before = Get-AgentServiceStatus
    Write-DeployLog "service status before stop=$before"
    if ($before -ne 'missing' -and $before -ne 'Stopped') {
        Start-Process -FilePath 'sc.exe' -ArgumentList @('stop', $serviceName) -WindowStyle Hidden -Wait
    }
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Seconds 2
        $status = Get-AgentServiceStatus
        Write-DeployLog "service status wait=$status"
    } while ($status -notin @('Stopped', 'missing') -and (Get-Date) -lt $deadline)
    Stop-Process -Name 'techi-agent' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

function Ensure-AgentService {
    $status = Get-AgentServiceStatus
    if ($status -eq 'missing') {
        $binPathArg = 'binPath= "' + $agentExe + '"'
        Start-Process -FilePath 'sc.exe' -ArgumentList @('create', $serviceName, $binPathArg, 'start= auto', 'DisplayName= TECHI Agent', 'obj= LocalSystem') -WindowStyle Hidden -Wait
        Start-Process -FilePath 'sc.exe' -ArgumentList @('description', $serviceName, 'TECHI Solutions endpoint monitoring and management service') -WindowStyle Hidden -Wait
        Write-DeployLog "service recreated"
    }
    Start-Process -FilePath 'sc.exe' -ArgumentList @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') -WindowStyle Hidden -Wait
    $status = Get-AgentServiceStatus
    if ($status -ne 'Running') {
        Start-Process -FilePath 'net.exe' -ArgumentList @('start', $serviceName) -WindowStyle Hidden -Wait
    }
    Start-Sleep -Seconds 8
    $final = Get-AgentServiceStatus
    Write-DeployLog "service final status=$final"
    if ($final -ne 'Running') {
        throw "service not running after update; status=$final"
    }
}

function Restore-Backup {
    if (Test-Path -LiteralPath $agentOld) {
        Copy-Item -LiteralPath $agentOld -Destination $agentExe -Force
        Write-DeployLog "rollback restored backup"
    }
}

try {
    Write-DeployLog "begin target_version=$TargetVersion new=$NewExePath"
    if (!(Test-Path -LiteralPath $NewExePath)) {
        throw "new exe not found: $NewExePath"
    }
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    Ensure-AgentConfig

    $newHash = (Get-FileHash -LiteralPath $NewExePath -Algorithm SHA256).Hash.ToLower()
    Write-DeployLog "new exe sha256=$newHash"

    Stop-AgentService

    if (Test-Path -LiteralPath $agentExe) {
        Copy-Item -LiteralPath $agentExe -Destination $agentOld -Force
        Write-DeployLog "backup written path=$agentOld"
    }
    Copy-Item -LiteralPath $NewExePath -Destination $agentExe -Force
    $installedHash = (Get-FileHash -LiteralPath $agentExe -Algorithm SHA256).Hash.ToLower()
    Write-DeployLog "installed exe sha256=$installedHash"

    Ensure-AgentService
    Write-DeployLog "success target_version=$TargetVersion"
    exit 0
} catch {
    Write-DeployLog ("error: " + $_.Exception.Message)
    try {
        Stop-Process -Name 'techi-agent' -Force -ErrorAction SilentlyContinue
        Restore-Backup
        Ensure-AgentService
    } catch {
        Write-DeployLog ("rollback error: " + $_.Exception.Message)
    }
    exit 1
}
