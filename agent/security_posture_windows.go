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

// windowsSecurityPostureScript prints ONE JSON object (see SecurityPosture).
// Windows PowerShell 5.1, no external modules. Every probe sits in its own
// try/catch: a probe that fails leaves its value null (or "unknown"), it
// never fails the script. Non-ASCII characters are escaped as \uXXXX so the
// output survives the console code page of a service's PowerShell.
const windowsSecurityPostureScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# Defender: Get-MpComputerStatus fails (or is missing) when Defender is
# removed or replaced; then it is not present and its fields stay null.
$defender = [ordered]@{ present = $false; antivirus_enabled = $null; realtime_enabled = $null; signature_age_days = $null }
try {
  $mp = Get-MpComputerStatus
  if ($mp) {
    $defender.present = $true
    try {
      $av = $null
      if ($null -ne $mp.AntivirusEnabled) { $av = [bool]$mp.AntivirusEnabled }
      if ($null -ne $mp.AMServiceEnabled -and -not [bool]$mp.AMServiceEnabled) { $av = $false }
      $defender.antivirus_enabled = $av
    } catch {}
    try { if ($null -ne $mp.RealTimeProtectionEnabled) { $defender.realtime_enabled = [bool]$mp.RealTimeProtectionEnabled } } catch {}
    try {
      $age = [int64]$mp.AntivirusSignatureAge
      if ($null -ne $mp.AntivirusSignatureAge -and $age -ge 0 -and $age -le 3650) { $defender.signature_age_days = [int]$age }
    } catch {}
  }
} catch {}

# Third-party antivirus registered with Security Center (workstations only:
# servers have no SecurityCenter2).
$thirdParty = New-Object System.Collections.Generic.List[string]
try {
  $productType = [int](Get-CimInstance -ClassName Win32_OperatingSystem).ProductType
  if ($productType -eq 1) {
    foreach ($product in @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct)) {
      $name = ([string]$product.displayName).Trim()
      if ($name -and $name -notmatch 'Defender' -and -not $thirdParty.Contains($name) -and $thirdParty.Count -lt 10) { $thirdParty.Add($name) }
    }
  }
} catch {}

# Firewall: the effective (ActiveStore, Group Policy included) state of each
# profile; the registry is the fallback when the NetSecurity module fails.
$firewall = [ordered]@{ domain = $null; private = $null; public = $null }
try {
  foreach ($fwProfile in @(Get-NetFirewallProfile -PolicyStore ActiveStore)) {
    $key = ([string]$fwProfile.Name).ToLowerInvariant()
    $state = [string]$fwProfile.Enabled
    if ($firewall.Contains($key)) {
      if ($state -eq 'True') { $firewall[$key] = $true } elseif ($state -eq 'False') { $firewall[$key] = $false }
    }
  }
} catch {}
$fwKeys = [ordered]@{ domain = 'DomainProfile'; private = 'StandardProfile'; public = 'PublicProfile' }
foreach ($key in @('domain', 'private', 'public')) {
  if ($null -eq $firewall[$key]) {
    try {
      $value = (Get-ItemProperty -Path ('HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\' + $fwKeys[$key]) -Name EnableFirewall).EnableFirewall
      if ($null -ne $value) { $firewall[$key] = ([int]$value -ne 0) }
    } catch {}
  }
}

# BitLocker on the system drive. The namespace is missing on Home editions
# and where the feature is not installed: protection stays "unknown".
$drive = [string]$env:SystemDrive
if (-not $drive) { $drive = 'C:' }
$bitlocker = [ordered]@{ system_drive = $drive; protection = 'unknown'; encryption_percent = $null }
try {
  $volume = @(Get-CimInstance -Namespace root/CIMV2/Security/MicrosoftVolumeEncryption -ClassName Win32_EncryptableVolume -Filter ("DriveLetter='" + $drive + "'")) | Select-Object -First 1
  if ($volume) {
    try {
      $protection = [int]$volume.ProtectionStatus
      if ($protection -eq 1) { $bitlocker.protection = 'on' } elseif ($protection -eq 0) { $bitlocker.protection = 'off' }
    } catch {}
    try {
      $conversion = Invoke-CimMethod -InputObject $volume -MethodName GetConversionStatus
      if ($conversion -and [int]$conversion.ReturnValue -eq 0 -and $null -ne $conversion.EncryptionPercentage) {
        $bitlocker.encryption_percent = [double]$conversion.EncryptionPercentage
      }
    } catch {}
  }
} catch {}

# UAC (Admin Approval Mode).
$uac = $null
try {
  $value = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA).EnableLUA
  if ($null -ne $value) { $uac = ([int]$value -ne 0) }
} catch {}

# Secure Boot: Confirm-SecureBootUEFI throws on BIOS / unsupported machines.
$secureBoot = $null
try {
  $state = Confirm-SecureBootUEFI
  if ($null -ne $state) { $secureBoot = [bool]$state }
} catch {}

# Local Administrators by its well-known SID (the group name is localised).
# Get-LocalGroupMember fails on groups with orphaned or Azure AD SIDs; the
# WinNT provider is the fallback.
$admins = New-Object System.Collections.Generic.List[string]
$adminsRead = $false
try {
  foreach ($member in @(Get-LocalGroupMember -SID 'S-1-5-32-544')) {
    $name = ([string]$member.Name).Trim()
    if ($name -and -not $admins.Contains($name) -and $admins.Count -lt 50) { $admins.Add($name) }
  }
  $adminsRead = $true
} catch {}
if (-not $adminsRead) {
  $admins.Clear()
  try {
    $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $groupName = $sid.Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
    $group = [ADSI]('WinNT://./' + $groupName + ',group')
    foreach ($member in @($group.psbase.Invoke('Members'))) {
      try {
        $path = [string]$member.GetType().InvokeMember('ADsPath', 'GetProperty', $null, $member, $null)
        $parts = @(($path -replace '^WinNT://', '') -split '/' | Where-Object { $_ })
        if ($parts.Count -ge 2) { $name = $parts[-2] + '\' + $parts[-1] } elseif ($parts.Count -eq 1) { $name = $parts[0] } else { $name = '' }
        if ($name -and -not $admins.Contains($name) -and $admins.Count -lt 50) { $admins.Add($name) }
      } catch {}
    }
  } catch {}
}

$result = [ordered]@{
  collected_at   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  defender       = $defender
  third_party_av = [string[]]$thirdParty.ToArray()
  firewall       = $firewall
  bitlocker      = $bitlocker
  uac_enabled    = $uac
  secure_boot    = $secureBoot
  local_admins   = [string[]]$admins.ToArray()
}
$json = ConvertTo-Json -InputObject $result -Depth 4 -Compress
[regex]::Replace($json, '[^\u0000-\u007F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
`

func securityPostureCollector() func() *SecurityPosture { return collectWindowsSecurityPosture }

func collectWindowsSecurityPosture() *SecurityPosture {
	out, err := runSecurityPostureScript(securityPostureTimeout)
	if err != nil {
		log.Printf("security posture: %v", err)
		return nil
	}
	posture, err := parseSecurityPosture(out, time.Now())
	if err != nil {
		log.Printf("security posture: unreadable script output: %v", err)
		return nil
	}
	return posture
}

// runSecurityPostureScript runs the script and returns its stdout; stderr is
// kept apart so a stray warning never lands in the JSON.
func runSecurityPostureScript(timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, powershellPath(),
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", powershellEncoded(windowsSecurityPostureScript))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// A child still holding the output pipe must not hold the inventory pass.
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
