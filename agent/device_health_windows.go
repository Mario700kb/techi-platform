//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

// windowsDeviceHealthScript prints ONE JSON object (see DeviceHealth).
// Windows PowerShell 5.1, no external modules, read-only. Every probe sits in
// its own try/catch: one that fails leaves its value null, it never fails the
// script. Non-ASCII characters are escaped as \uXXXX so the output survives
// the console code page of a service's PowerShell.
const windowsDeviceHealthScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# SMART failure prediction, by disk number: Win32_DiskDrive.Index is the
# physical disk number, and MSStorageDriver_FailurePredictStatus names the
# drive by its PNP device id (plus "_0").
$predicts = @{}
try {
  $pnpToIndex = @{}
  foreach ($drive in @(Get-CimInstance -ClassName Win32_DiskDrive)) {
    if ($drive.PNPDeviceID) { $pnpToIndex[([string]$drive.PNPDeviceID).ToUpperInvariant()] = [int]$drive.Index }
  }
  foreach ($status in @(Get-CimInstance -Namespace root/wmi -ClassName MSStorageDriver_FailurePredictStatus)) {
    $instance = ([string]$status.InstanceName).ToUpperInvariant() -replace '_\d+$', ''
    if ($pnpToIndex.ContainsKey($instance)) { $predicts[$pnpToIndex[$instance]] = [bool]$status.PredictFailure }
  }
} catch {}

# Physical disks with their reliability counters (Windows 8 / Server 2012
# and later); Win32_DiskDrive's status is the fallback.
$disks = New-Object System.Collections.Generic.List[object]
$read = $false
try {
  foreach ($pd in @(Get-PhysicalDisk)) {
    $disk = [ordered]@{
      name = ([string]$pd.FriendlyName).Trim(); media = [string]$pd.MediaType; bus = [string]$pd.BusType
      size_gb = $null; health = [string]$pd.HealthStatus; operational = @($pd.OperationalStatus | ForEach-Object { [string]$_ })
      predict_failure = $null; temperature_c = $null; wear_pct = $null; power_on_hours = $null; read_errors = $null; write_errors = $null
    }
    try { if ($pd.Size) { $disk.size_gb = [math]::Round([double]$pd.Size / 1GB, 1) } } catch {}
    try {
      $number = [int]$pd.DeviceId
      if ($predicts.ContainsKey($number)) { $disk.predict_failure = $predicts[$number] }
    } catch {}
    try {
      $rc = $pd | Get-StorageReliabilityCounter
      if ($rc) {
        if ($null -ne $rc.Temperature) { $disk.temperature_c = [int64]$rc.Temperature }
        if ($null -ne $rc.Wear) { $disk.wear_pct = [int64]$rc.Wear }
        if ($null -ne $rc.PowerOnHours) { $disk.power_on_hours = [int64]$rc.PowerOnHours }
        if ($null -ne $rc.ReadErrorsUncorrected) { $disk.read_errors = [int64]$rc.ReadErrorsUncorrected }
        if ($null -ne $rc.WriteErrorsUncorrected) { $disk.write_errors = [int64]$rc.WriteErrorsUncorrected }
      }
    } catch {}
    $disks.Add($disk)
    if ($disks.Count -ge 32) { break }
  }
  $read = $true
} catch {}
if (-not $read) {
  try {
    foreach ($drive in @(Get-CimInstance -ClassName Win32_DiskDrive)) {
      $status = [string]$drive.Status
      $health = 'unknown'
      if ($status -eq 'OK') { $health = 'healthy' } elseif ($status -eq 'Pred Fail') { $health = 'unhealthy' } elseif ($status) { $health = 'warning' }
      $disk = [ordered]@{ name = ([string]$drive.Model).Trim(); media = $null; bus = [string]$drive.InterfaceType; size_gb = $null; health = $health; operational = @($status); predict_failure = $null }
      try { if ($drive.Size) { $disk.size_gb = [math]::Round([double]$drive.Size / 1GB, 1) } } catch {}
      try { if ($predicts.ContainsKey([int]$drive.Index)) { $disk.predict_failure = $predicts[[int]$drive.Index] } } catch {}
      $disks.Add($disk)
      if ($disks.Count -ge 32) { break }
    }
  } catch {}
}

# A restart Windows is waiting for, and why.
$reasons = New-Object System.Collections.Generic.List[string]
try { if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') { $reasons.Add('cbs') } } catch {}
try { if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') { $reasons.Add('windows_update') } } catch {}
try {
  $pending = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations).PendingFileRenameOperations
  if ($pending) { $reasons.Add('file_rename') }
} catch {}
try {
  $active = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' -Name ComputerName).ComputerName
  $next = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName' -Name ComputerName).ComputerName
  if ($active -and $next -and $active -ne $next) { $reasons.Add('rename') }
} catch {}

# Critical System events of the last 25 hours, by id; the agent keeps only
# the providers it knows for each id. Critical, Error and Warning only: NTFS 98
# is also written at every mount as Information ("is healthy").
$events = New-Object System.Collections.Generic.List[object]
try {
  $filter = @{ LogName = 'System'; StartTime = (Get-Date).AddHours(-25); Level = @(1, 2, 3); Id = @(41, 1001, 6008, 18, 7, 11, 51, 153, 55, 98, 137, 7031, 7034) }
  foreach ($e in @(Get-WinEvent -FilterHashtable $filter -MaxEvents 200 -ErrorAction SilentlyContinue)) {
    $message = ''
    try { $message = [string]$e.Message } catch {}
    if ($message.Length -gt 300) { $message = $message.Substring(0, 300) }
    $events.Add([ordered]@{
      record_id = [int64]$e.RecordId; source = [string]$e.ProviderName; event_id = [int]$e.Id; win_level = [int]$e.Level
      at = $e.TimeCreated.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture); message = $message
    })
  }
} catch {}

$result = [ordered]@{
  collected_at   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  disks          = [object[]]$disks.ToArray()
  reboot_pending = ($reasons.Count -gt 0)
  reboot_reasons = [string[]]$reasons.ToArray()
  events         = [object[]]$events.ToArray()
}
$json = ConvertTo-Json -InputObject $result -Depth 5 -Compress
[regex]::Replace($json, '[^\u0000-\u007F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`

func deviceHealthCollector() func() *DeviceHealth { return collectWindowsDeviceHealth }

func collectWindowsDeviceHealth() *DeviceHealth {
	out, err := runDeviceHealthScript(deviceHealthTimeout)
	if err != nil {
		log.Printf("device health: %v", err)
		return nil
	}
	health, err := parseDeviceHealth(out, time.Now())
	if err != nil {
		log.Printf("device health: unreadable script output: %v", err)
		return nil
	}
	return health
}

func runDeviceHealthScript(timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, powershellPath(),
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", powershellEncoded(windowsDeviceHealthScript))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("script timed out after %s", timeout)
	}
	if err != nil && !bytes.Contains(stdout.Bytes(), []byte("{")) {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		return nil, fmt.Errorf("script failed: %v %s", err, msg)
	}
	return stdout.Bytes(), nil
}
