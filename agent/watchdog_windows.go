//go:build windows

package main

import (
	"log"
	"os/exec"
	"strings"
	"sync"
)

var agentWatchdogOnce sync.Once

func ensureAgentServiceWatchdog() {
	agentWatchdogOnce.Do(func() {
		if err := installAgentServiceWatchdog(); err != nil {
			log.Printf("[watchdog] install/update skipped: %v", err)
			return
		}
		log.Printf("[watchdog] TECHI Agent Watchdog scheduled task installed/updated")
	})
}

func installAgentServiceWatchdog() error {
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
		"-Command", agentWatchdogInstallScript(),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return wrapCommandError(err, strings.TrimSpace(string(out)))
	}
	return nil
}

func wrapCommandError(err error, output string) error {
	if output == "" {
		return err
	}
	return &commandOutputError{err: err, output: output}
}

type commandOutputError struct {
	err    error
	output string
}

func (e *commandOutputError) Error() string {
	return e.err.Error() + ": " + e.output
}

func agentWatchdogInstallScript() string {
	return `$ErrorActionPreference = 'Stop'
$taskName = 'TECHI Agent Watchdog'
$agentDir = Join-Path $env:ProgramData 'TechiAgent'
$agentExe = Join-Path $agentDir 'techi-agent.exe'
$deployLog = Join-Path $agentDir 'deploy.log'

New-Item -ItemType Directory -Path $agentDir -Force | Out-Null

$watchdog = @'
$ErrorActionPreference = 'Continue'
$agentDir = Join-Path $env:ProgramData 'TechiAgent'
$agentExe = Join-Path $agentDir 'techi-agent.exe'
$deployLog = Join-Path $agentDir 'deploy.log'
$svcName = 'TechiAgent'

function Write-WatchdogLog([string]$Message) {
    try {
        New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $deployLog -Value "$stamp [watchdog] $Message"
    } catch {}
}

try {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        if (Test-Path -LiteralPath $agentExe) {
            $binPathArg = 'binPath= "' + $agentExe + '"'
            Start-Process -FilePath 'sc.exe' -ArgumentList @('create', $svcName, $binPathArg, 'start= auto', 'DisplayName= TECHI Agent', 'obj= LocalSystem') -Wait -WindowStyle Hidden
            Write-WatchdogLog "service missing; recreated"
            $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        } else {
            Write-WatchdogLog "service missing and exe missing; cannot recover"
            exit 0
        }
    }

    Start-Process -FilePath 'sc.exe' -ArgumentList @('failure', $svcName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') -Wait -WindowStyle Hidden

    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') {
        Start-Process -FilePath 'net.exe' -ArgumentList @('start', $svcName) -Wait -WindowStyle Hidden
        Start-Sleep -Seconds 5
        $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        Write-WatchdogLog ("start attempted; final=" + $(if ($svc) { $svc.Status } else { 'missing' }))
    }
} catch {
    Write-WatchdogLog ("error: " + $_.Exception.Message)
}
'@

$watchdogPath = Join-Path $agentDir 'techi-agent-watchdog.ps1'
[System.IO.File]::WriteAllText($watchdogPath, $watchdog, [System.Text.UTF8Encoding]::new($false))

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdogPath + '"')
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$repeatTrigger.Repetition.Interval = 'PT5M'
$repeatTrigger.Repetition.Duration = 'P3650D'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($bootTrigger, $repeatTrigger) -Principal $principal -Settings $settings -Force | Out-Null
`
}
