//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// performSelfUpdate downloads the new techi-agent.exe, verifies its SHA256,
// then hands the binary swap to a detached PowerShell helper.  The helper
// survives when SCM stops this service process during the replacement.
//
// The MSI is never touched here -- self_update ships only the agent binary.
// TECHI Remote Support is never affected.
func performSelfUpdate(update *AgentUpdate) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting binary update to v%s from %s", update.Version, update.URL)

	exePath := agentBinaryCachePath(update.Version)
	if err := downloadAgentBinary(update.URL, exePath); err != nil {
		log.Printf("[self_update] download failed: %v", err)
		return
	}

	if update.Checksum != "" {
		if !sha256Matches(exePath, strings.ToLower(update.Checksum)) {
			log.Printf("[self_update] checksum mismatch; aborting")
			_ = os.Remove(exePath)
			return
		}
		log.Printf("[self_update] checksum verified")
	}

	log.Printf("[self_update] scheduling detached binary swap for %s", exePath)
	if err := swapAgentBinary(exePath); err != nil {
		log.Printf("[self_update] schedule failed: %v", err)
		return
	}

	log.Printf("[self_update] v%s swap helper launched", update.Version)
}

// agentBinaryCachePath returns a stable temp path for the downloaded exe.
func agentBinaryCachePath(version string) string {
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	base := os.TempDir()
	if programData != "" {
		base = programData
	}
	dir := filepath.Join(base, "TechiAgent", "cache")
	_ = os.MkdirAll(dir, 0755)
	v := sanitizeCachePart(version)
	if v == "" {
		v = "latest"
	}
	return filepath.Join(dir, "techi-agent-"+v+".exe")
}

// downloadAgentBinary downloads url to dest with 3 attempts and exponential backoff.
func downloadAgentBinary(url, dest string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFile(url, dest, 120); err == nil {
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(attempt*15) * time.Second
				log.Printf("[self_update] download attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}
	return fmt.Errorf("download failed after 3 attempts: %w", lastErr)
}

// swapAgentBinary writes a PowerShell helper and runs it through a one-shot
// Scheduled Task as SYSTEM.  Starting a plain child powershell.exe from the
// agent is not enough: when the helper stops TechiAgent, Windows can terminate
// child processes that still belong to the service's process/job tree.
// Task Scheduler gives the swap an independent parent before the service stops:
//   - stop service
//   - backup old exe → techi-agent-old.exe
//   - move new exe → techi-agent.exe
//   - start service
//   - rollback on failure (restore backup)
func swapAgentBinary(newExePath string) error {
	if strings.TrimSpace(newExePath) == "" {
		return fmt.Errorf("empty exe path")
	}
	if _, err := os.Stat(newExePath); err != nil {
		return fmt.Errorf("new exe not accessible: %w", err)
	}

	helperPath := filepath.Join(filepath.Dir(newExePath),
		"binary-swap-"+sanitizeCachePart(time.Now().UTC().Format("20060102T150405Z"))+".ps1")
	if err := os.WriteFile(helperPath, []byte(binarySwapHelperScript()), 0600); err != nil {
		return fmt.Errorf("write helper: %w", err)
	}

	launcherPath := filepath.Join(filepath.Dir(newExePath),
		"binary-swap-launch-"+sanitizeCachePart(time.Now().UTC().Format("20060102T150405Z"))+".ps1")
	taskName := "TECHI-Agent-SelfUpdate-" + sanitizeCachePart(time.Now().UTC().Format("20060102T150405Z"))
	if err := os.WriteFile(launcherPath, []byte(binarySwapTaskLauncherScript(helperPath, newExePath, taskName)), 0600); err != nil {
		return fmt.Errorf("write task launcher: %w", err)
	}

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
		"-File", launcherPath,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("start scheduled task helper: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func binarySwapTaskLauncherScript(helperPath, newExePath, taskName string) string {
	return fmt.Sprintf(`$ErrorActionPreference = 'Stop'
$taskName = '%s'
$helperPath = '%s'
$newExePath = '%s'
$deployLog = Join-Path $env:ProgramData 'TechiAgent\deploy.log'

function Write-DeployLog([string]$Message) {
    $dir = Split-Path -Parent $deployLog
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $deployLog -Value "$stamp [self_update] $Message"
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $helperPath + '" -NewExePath "' + $newExePath + '" -TaskName "' + $taskName + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-DeployLog "scheduled task launched task=$taskName helper=$helperPath new=$newExePath"
`, psSingleQuoted(taskName), psSingleQuoted(helperPath), psSingleQuoted(newExePath))
}

func psSingleQuoted(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func binarySwapHelperScript() string {
	return `param(
    [Parameter(Mandatory=$true)][string]$NewExePath,
    [string]$TaskName = ''
)

$ErrorActionPreference = 'Continue'

$deployLog   = Join-Path $env:ProgramData 'TechiAgent\deploy.log'
$agentDir    = Join-Path $env:ProgramData 'TechiAgent'
$agentExe    = Join-Path $agentDir 'techi-agent.exe'
$agentOldExe = Join-Path $agentDir 'techi-agent-old.exe'
$serviceName = 'TechiAgent'

function Write-DeployLog([string]$Message) {
    $dir = Split-Path -Parent $deployLog
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $deployLog -Value "$stamp [self_update] $Message"
}

function Get-AgentServiceStatus {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return 'missing' }
    return [string]$svc.Status
}

function Ensure-AgentService {
    $status = Get-AgentServiceStatus
    Write-DeployLog "service status after swap=$status"
    if ($status -eq 'missing') {
        Write-DeployLog "service missing; recreating"
        $binPathArg = 'binPath= "' + $agentExe + '"'
        Start-Process -FilePath 'sc.exe' -ArgumentList @('create', $serviceName, $binPathArg, 'start= auto', 'DisplayName= TECHI Agent') -Wait -WindowStyle Hidden
    }
    Start-Process -FilePath 'sc.exe' -ArgumentList @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') -Wait -WindowStyle Hidden
    $status = Get-AgentServiceStatus
    if ($status -ne 'Running') {
        Write-DeployLog "starting service; current=$status"
        Start-Process -FilePath 'net.exe' -ArgumentList @('start', $serviceName) -Wait -WindowStyle Hidden
    }
    Start-Sleep -Seconds 5
    $status = Get-AgentServiceStatus
    Write-DeployLog "service final status=$status"
    if ($status -ne 'Running') {
        throw "service not running after binary swap; status=$status"
    }
}

function Rollback {
    Write-DeployLog "rollback: restoring $agentOldExe -> $agentExe"
    try {
        if (Test-Path $agentOldExe) {
            Move-Item -Path $agentOldExe -Destination $agentExe -Force
            Write-DeployLog "rollback: backup restored"
        } else {
            Write-DeployLog "rollback: no backup found"
        }
        Start-Process -FilePath 'net.exe' -ArgumentList @('start', $serviceName) -Wait -WindowStyle Hidden
        $status = Get-AgentServiceStatus
        Write-DeployLog "rollback: service status=$status"
    } catch {
        Write-DeployLog ("rollback error: " + $_.Exception.Message)
    }
}

try {
    Write-DeployLog "begin binary_swap new=$NewExePath"

    if (!(Test-Path -LiteralPath $NewExePath)) {
        throw "new exe not found: $NewExePath"
    }

    # 1. Stop the service (this terminates the agent process — the helper
    #    is detached and survives). We wait for BOTH Running AND StopPending
    #    to clear before touching the exe file, otherwise Move-Item fails with
    #    "file in use" while the process is still exiting, which triggers an
    #    unwanted rollback and leaves the old binary in place.
    $before = Get-AgentServiceStatus
    Write-DeployLog "service status before stop=$before"
    Start-Process -FilePath 'sc.exe' -ArgumentList @('stop', $serviceName) -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(45)
    do {
        Start-Sleep -Seconds 2
        $status = Get-AgentServiceStatus
        Write-DeployLog "service status wait=$status"
    } while ($status -notin @('Stopped', 'missing') -and (Get-Date) -lt $deadline)

    # Belt-and-suspenders: kill any lingering techi-agent process so the
    # exe file is guaranteed unlocked before we attempt the rename.
    Stop-Process -Name 'techi-agent' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-DeployLog "service fully stopped; proceeding with swap"

    # 2. Backup old exe.
    if (Test-Path $agentOldExe) {
        Remove-Item $agentOldExe -Force
        Write-DeployLog "removed old backup"
    }
    Move-Item -Path $agentExe -Destination $agentOldExe -Force
    Write-DeployLog "backup: $agentExe -> $agentOldExe"

    # 3. Move new exe into place.
    Move-Item -Path $NewExePath -Destination $agentExe -Force
    Write-DeployLog "installed: $NewExePath -> $agentExe"

    # 4. Start service and verify.
    Ensure-AgentService

    # 5. Clean up backup on success.
    Remove-Item $agentOldExe -Force -ErrorAction SilentlyContinue
    if ($TaskName -ne '') {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-DeployLog "complete: binary swap succeeded"
    exit 0

} catch {
    Write-DeployLog ("failed: " + $_.Exception.Message)
    Rollback
    if ($TaskName -ne '') {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    exit 1
}
`
}
