param(
    [Parameter(Mandatory=$true)][string]$ExePath
)

$ErrorActionPreference = 'Continue'

$serviceName = 'TECHI Remote Support'
$taskName = 'TECHI Remote Support Tray'
$logDir = Join-Path $env:ProgramData 'TECHI\logs'
$logPath = Join-Path $logDir 'remote-support-install.log'
$system32 = Join-Path $env:SystemRoot 'System32'
$scExe = Join-Path $system32 'sc.exe'
$schtasksExe = Join-Path $system32 'schtasks.exe'
$taskkillExe = Join-Path $system32 'taskkill.exe'

function Write-InstallLog([string]$Message) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logPath -Value "$stamp [remote-support-msi] $Message"
}

function Get-RSServiceStatus {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return 'missing' }
    return [string]$svc.Status
}

try {
    Write-InstallLog "begin exe=$ExePath"
    if (!(Test-Path -LiteralPath $ExePath)) {
        throw "remote support exe not found: $ExePath"
    }

    Start-Process -FilePath $taskkillExe -ArgumentList @('/F','/IM','TECHI Remote Support.exe') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
    Start-Process -FilePath $taskkillExe -ArgumentList @('/F','/IM','rustdesk.exe') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue

    $status = Get-RSServiceStatus
    Write-InstallLog "service status before=$status"
    if ($status -ne 'missing') {
        Start-Process -FilePath $scExe -ArgumentList @('stop', $serviceName) -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Start-Process -FilePath $scExe -ArgumentList @('delete', $serviceName) -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    $binPath = '"' + $ExePath + '" --service'
    Start-Process -FilePath $scExe -ArgumentList @('create', $serviceName, ('binPath= ' + $binPath), 'start= auto', 'DisplayName= TECHI Remote Support') -WindowStyle Hidden -Wait
    Start-Process -FilePath $scExe -ArgumentList @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/15000/restart/15000/restart/60000') -WindowStyle Hidden -Wait
    Start-Process -FilePath $scExe -ArgumentList @('start', $serviceName) -WindowStyle Hidden -Wait

    $action = New-ScheduledTaskAction -Execute $ExePath -Argument '--tray'
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    & $schtasksExe /run /tn $taskName | Out-Null

    $final = Get-RSServiceStatus
    Write-InstallLog "service final=$final task=registered"
    if ($final -ne 'Running') {
        throw "service not running after install; status=$final"
    }
    exit 0
} catch {
    Write-InstallLog ("error: " + $_.Exception.Message)
    exit 1
}
