param(
    [Parameter(Mandatory=$true)][string]$ExePath
)

$ErrorActionPreference = 'Stop'

$serviceName = 'TECHI Remote Support'
$taskName = 'TECHI Remote Support Tray'
$logDir = Join-Path $env:ProgramData 'TECHI\logs'
$logPath = Join-Path $logDir 'remote-support-install.log'
$system32 = Join-Path $env:SystemRoot 'System32'
$scExe = Join-Path $system32 'sc.exe'
$schtasksExe = Join-Path $system32 'schtasks.exe'
$script:currentStep = 'initialize'

function Write-InstallLog([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "$stamp [remote-support-msi] $Message"
    [Console]::Out.WriteLine($line)
    try {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Add-Content -LiteralPath $logPath -Value $line -ErrorAction Stop
    } catch {
        [Console]::Error.WriteLine("$line; log_file_error=$($_.Exception.Message)")
    }
}

function Set-InstallStep([string]$Step) {
    $script:currentStep = $Step
    Write-InstallLog "step=$Step begin"
}

function Get-RSServiceStatus {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return 'missing' }
    return [string]$svc.Status
}

function Format-NativeOutput([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '<empty>' }
    return (($Value -replace '[\r\n]+', ' ') -replace '\s{2,}', ' ').Trim()
}

function Invoke-LoggedNative {
    param(
        [Parameter(Mandatory=$true)][string]$Step,
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0),
        [switch]$Fatal
    )

    $script:currentStep = $Step
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        & $FilePath @Arguments 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
        $stdout = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
        $stderr = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
        $stdoutText = Format-NativeOutput $stdout
        $stderrText = Format-NativeOutput $stderr
        Write-InstallLog "step=$Step exit_code=$exitCode stdout=$stdoutText stderr=$stderrText"

        if ($AllowedExitCodes -notcontains $exitCode) {
            $message = "step=$Step exit_code=$exitCode stdout=$stdoutText stderr=$stderrText"
            if ($Fatal) { throw $message }
            Write-InstallLog "warning $message"
        }
        return $exitCode
    } catch {
        if ($Fatal) { throw }
        Write-InstallLog "warning step=$Step launch_error=$($_.Exception.Message)"
        return -1
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Stop-OwnedRSProcesses {
    $script:currentStep = 'stop_owned_processes'
    try {
        $approved = @(
            [IO.Path]::GetFullPath($ExePath),
            [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($ExePath)) 'rustdesk.exe'))
        )
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
            if (!$process.ExecutablePath) { continue }
            try {
                $processPath = [IO.Path]::GetFullPath($process.ExecutablePath)
                if ($approved -contains $processPath) {
                    $null = Invoke-CimMethod -InputObject $process -MethodName Terminate -ErrorAction Stop
                    Write-InstallLog "step=stop_owned_processes terminated_pid=$($process.ProcessId) path=$processPath"
                }
            } catch {
                Write-InstallLog "warning step=stop_owned_processes pid=$($process.ProcessId) error=$($_.Exception.Message)"
            }
        }
    } catch {
        Write-InstallLog "warning step=stop_owned_processes query_error=$($_.Exception.Message)"
    }
}

function Wait-RSServiceRunning([int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $status = Get-RSServiceStatus
        Write-InstallLog "step=wait_service status=$status"
        if ($status -eq 'Running') { return $true }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Configure-TrayTask {
    $script:currentStep = 'configure_tray_task'
    try {
        $action = New-ScheduledTaskAction -Execute $ExePath -Argument '--tray'
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        $null = Invoke-LoggedNative -Step 'start_tray_task' -FilePath $schtasksExe -Arguments @('/run', '/tn', $taskName)
        Write-InstallLog "step=configure_tray_task result=registered"
    } catch {
        Write-InstallLog "warning step=configure_tray_task error=$($_.Exception.Message)"
    }
}

try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-InstallLog "begin identity=$identity exe=$ExePath"

    Set-InstallStep 'validate_runtime'
    $appSoPath = Join-Path ([IO.Path]::GetDirectoryName($ExePath)) 'data\app.so'
    foreach ($requiredFile in @($ExePath, $appSoPath)) {
        if (!(Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "required runtime file not found: $requiredFile"
        }
        if ((Get-Item -LiteralPath $requiredFile).Length -le 0) {
            throw "required runtime file is empty: $requiredFile"
        }
    }

    Stop-OwnedRSProcesses

    Set-InstallStep 'configure_service'
    $status = Get-RSServiceStatus
    Write-InstallLog "step=configure_service status_before=$status"
    if ($status -ne 'missing') {
        $null = Invoke-LoggedNative -Step 'stop_service' -FilePath $scExe -Arguments @('stop', $serviceName) -AllowedExitCodes @(0, 1062)
    }

    $binPath = '"' + $ExePath + '" --service'
    if ($status -eq 'missing') {
        $script:currentStep = 'create_service'
        New-Service -Name $serviceName -BinaryPathName $binPath -DisplayName $serviceName -StartupType Automatic -ErrorAction Stop | Out-Null
        Write-InstallLog "step=create_service result=created"
    } else {
        $script:currentStep = 'configure_service'
        $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
        $changeResult = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{
            DisplayName = $serviceName
            PathName = $binPath
            StartMode = 'Automatic'
        } -ErrorAction Stop
        if ($changeResult.ReturnValue -ne 0) {
            throw "Win32_Service.Change return_code=$($changeResult.ReturnValue)"
        }
        Write-InstallLog "step=configure_service result=updated"
    }

    $null = Invoke-LoggedNative -Step 'configure_service_recovery' -FilePath $scExe -Arguments @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/15000/restart/15000/restart/60000')
    $null = Invoke-LoggedNative -Step 'start_service' -FilePath $scExe -Arguments @('start', $serviceName) -AllowedExitCodes @(0, 1056) -Fatal

    Set-InstallStep 'wait_service'
    if (!(Wait-RSServiceRunning -TimeoutSeconds 30)) {
        $finalStatus = Get-RSServiceStatus
        throw "service did not reach Running within 30 seconds; status=$finalStatus"
    }

    Configure-TrayTask

    $final = Get-RSServiceStatus
    Write-InstallLog "success service_status=$final runtime_exe=true app_so=true"
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-InstallLog "fatal step=$script:currentStep error=$message"
    [Console]::Error.WriteLine("ConfigureRemoteSupportRuntime failed: step=$script:currentStep error=$message")
    exit 1
}
