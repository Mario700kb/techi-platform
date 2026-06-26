//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// performSelfUpdate downloads the MSI at update.URL, verifies its SHA256 (if
// provided), then hands installation to a detached helper. The helper survives
// when SCM stops this service process during replacement.
func performSelfUpdate(update *AgentUpdate) {
	if update == nil || !update.Available || update.URL == "" {
		return
	}
	log.Printf("[self_update] starting update to v%s from %s", update.Version, update.URL)

	msiPath := agentMSICachePath(update.Version)
	if err := downloadAgentMSI(update.URL, msiPath); err != nil {
		log.Printf("[self_update] download failed: %v", err)
		return
	}

	if update.Checksum != "" {
		if !sha256Matches(msiPath, strings.ToLower(update.Checksum)) {
			log.Printf("[self_update] checksum mismatch; aborting")
			_ = os.Remove(msiPath)
			return
		}
		log.Printf("[self_update] checksum verified")
	}

	log.Printf("[self_update] scheduling detached install for %s", msiPath)
	if err := installAgentMSI(msiPath); err != nil {
		log.Printf("[self_update] schedule failed: %v", err)
		return
	}

	log.Printf("[self_update] v%s install helper launched", update.Version)
}

// agentMSICachePath returns a stable temp path for the agent MSI.
func agentMSICachePath(version string) string {
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
	return filepath.Join(dir, "techi-agent-"+v+".msi")
}

// downloadAgentMSI downloads url to dest with 3 attempts and exponential backoff.
func downloadAgentMSI(url, dest string) error {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if err := downloadFile(url, dest, 300); err == nil {
			return nil
		} else {
			lastErr = err
			if attempt < 3 {
				delay := time.Duration(attempt*30) * time.Second
				log.Printf("[self_update] download attempt %d failed: %v; retrying in %s", attempt, err, delay)
				time.Sleep(delay)
			}
		}
	}
	return fmt.Errorf("download failed after 3 attempts: %w", lastErr)
}

// installAgentMSI writes and launches a detached PowerShell helper. The helper
// does the risky work outside the current service process: stop service,
// reinstall MSI, verify service exists/runs, recreate it if needed, and log all
// results to deploy.log.
func installAgentMSI(msiPath string) error {
	if strings.TrimSpace(msiPath) == "" {
		return fmt.Errorf("empty MSI path")
	}
	if _, err := os.Stat(msiPath); err != nil {
		return fmt.Errorf("MSI not accessible: %w", err)
	}

	helperPath := filepath.Join(filepath.Dir(msiPath), "self-update-"+sanitizeCachePart(time.Now().UTC().Format("20060102T150405Z"))+".ps1")
	if err := os.WriteFile(helperPath, []byte(selfUpdateHelperScript()), 0600); err != nil {
		return fmt.Errorf("write helper: %w", err)
	}

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
		"-File", helperPath,
		"-MsiPath", msiPath,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start helper: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func selfUpdateHelperScript() string {
	return `param([Parameter(Mandatory=$true)][string]$MsiPath)

$ErrorActionPreference = 'Continue'

$deployLog = Join-Path $env:ProgramData 'TechiAgent\deploy.log'
$agentExe = Join-Path $env:ProgramData 'TechiAgent\techi-agent.exe'
$serviceName = 'TechiAgent'

function Write-DeployLog([string]$Message) {
    $dir = Split-Path -Parent $deployLog
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $deployLog -Value "$stamp [self_update] $Message"
}

function Run-Logged([string]$FilePath, [string[]]$Arguments) {
    Write-DeployLog ("run=" + $FilePath + " " + ($Arguments -join ' '))
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    Write-DeployLog ("result=" + $p.ExitCode + " command=" + $FilePath)
    return $p.ExitCode
}

function Get-AgentServiceStatus {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return 'missing' }
    return [string]$svc.Status
}

function Ensure-AgentService {
    $status = Get-AgentServiceStatus
    Write-DeployLog "service status after msiexec=$status"
    if ($status -eq 'missing') {
        Write-DeployLog "service missing; recreating"
        $binPathArg = 'binPath= "' + $agentExe + '"'
        Run-Logged 'sc.exe' @('create', $serviceName, $binPathArg, 'start= auto', 'DisplayName= TECHI Agent') | Out-Null
    }
    Run-Logged 'sc.exe' @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/60000/restart/60000/restart/300000') | Out-Null
    $status = Get-AgentServiceStatus
    if ($status -ne 'Running') {
        Write-DeployLog "starting service; current=$status"
        Run-Logged 'net.exe' @('start', $serviceName) | Out-Null
    }
    Start-Sleep -Seconds 5
    $status = Get-AgentServiceStatus
    Write-DeployLog "service final status=$status"
    if ($status -ne 'Running') {
        throw "service not running after self_update; status=$status"
    }
}

try {
    Write-DeployLog "begin msi=$MsiPath"
    if (!(Test-Path -LiteralPath $MsiPath)) {
        throw "MSI not found: $MsiPath"
    }

    $before = Get-AgentServiceStatus
    Write-DeployLog "service status before stop=$before"
    Run-Logged 'sc.exe' @('stop', $serviceName) | Out-Null
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Seconds 2
        $status = Get-AgentServiceStatus
        Write-DeployLog "service status wait=$status"
    } while ($status -eq 'Running' -and (Get-Date) -lt $deadline)

    $msiResult = Run-Logged 'msiexec.exe' @('/i', $MsiPath, '/quiet', '/norestart', 'REINSTALL=ALL', 'REINSTALLMODE=vomus')
    if ($msiResult -ne 0 -and $msiResult -ne 3010) {
        Write-DeployLog "msiexec failed; attempting service recovery"
        Ensure-AgentService
        throw "msiexec result=$msiResult"
    }

    Ensure-AgentService
    Remove-Item -LiteralPath $MsiPath -Force -ErrorAction SilentlyContinue
    Write-DeployLog "complete result=$msiResult"
    exit 0
} catch {
    Write-DeployLog ("failed error=" + $_.Exception.Message)
    try { Ensure-AgentService } catch { Write-DeployLog ("recovery failed error=" + $_.Exception.Message) }
    exit 1
}
`
}
