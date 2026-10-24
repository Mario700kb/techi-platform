<#
  Installs, removes and upgrades the Endpoint MSI on a throwaway Windows
  runner and fails on anything a field install would trip over:
    1. fresh install: exit 0, agent service running, Remote Support stop
       actions logged, no custom action failing to launch (1721),
       every Remote Support configuration names the platform as api-server;
    2. uninstall: exit 0, service gone;
    3. upgrade over the baseline (2.1.20) while a process named like Remote
       Support holds librustdesk.dll open: exit 0 (no 1603, no 3010), holder
       stopped by the MSI, new payload in place, agent configuration kept,
       api-server still the platform;
    4. the agent sets the platform api-server where none is set, and keeps
       one someone else chose;
    5. the watchdog task runs its own copy of the agent and puts back a
       techi-agent.exe that disappeared (antivirus);
    6. a self-update swap that cannot reach the platform keeps the new exe,
       keeps the backup and leaves the service running;
    7. after an uninstall the watchdog removes its task and brings nothing
       back;
    8. upgrade over the baseline while another process holds a handle to the
       TechiAgent service (marked for deletion): exit 0, service running.
  The agent and Remote Support are pointed at 127.0.0.1 so nothing reaches
  production. Runs under Windows PowerShell 5.1 (Add-Type -OutputType needs it).
#>
param(
    [Parameter(Mandatory)] [string]$NewMsi,
    [Parameter(Mandatory)] [string]$BaselineMsi,
    [Parameter(Mandatory)] [string]$ExpectedVersion,
    [Parameter(Mandatory)] [string]$PayloadDir,
    [Parameter(Mandatory)] [string]$LogDir
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$RsDir = Join-Path $env:ProgramFiles 'TECHI Remote Support'
$DeployLog = Join-Path $env:ProgramData 'TechiAgent\deploy.log'
$AgentConfig = Join-Path $env:ProgramData 'TechiAgent\agent.config.json'
$PlatformApi = 'http://127.0.0.1:9'
$Props = @(
    'ENROLLMENT_TOKEN=ci-placeholder',
    "API_URL=$PlatformApi",
    'REMOTE_SERVER=127.0.0.1',
    'REMOTE_RELAY=127.0.0.1'
)
$TomlDirs = @(
    (Join-Path $env:ProgramData 'TECHI Remote Support\config'),
    (Join-Path $env:WINDIR 'System32\config\systemprofile\AppData\Roaming\TECHI Remote Support\config'),
    (Join-Path $env:WINDIR 'ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support\config')
) + @(Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'AppData\Roaming\TECHI Remote Support\config' })

$failures = New-Object System.Collections.Generic.List[string]
function Check([bool]$ok, [string]$what) {
    if ($ok) { Write-Host "  ok    $what" } else { Write-Host "  FAIL  $what"; $failures.Add($what) }
}

function Invoke-Msi([string[]]$MsiArgs, [string]$Name) {
    $log = Join-Path $LogDir "$Name.log"
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList ($MsiArgs + @('/qn', '/norestart', '/l*v', "`"$log`""))
    Write-Host "msiexec $Name exit=$($p.ExitCode)"
    return @{ Code = $p.ExitCode; Log = $log }
}

function Get-DeployLogLines {
    if (Test-Path $DeployLog) { return @(Get-Content $DeployLog) } else { return @() }
}

function Wait-ServiceRunning([string]$Name, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Get-InstalledVersion {
    $keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    $entry = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'TECHI Agent' } | Select-Object -First 1
    if ($entry) { return [string]$entry.DisplayVersion } else { return '' }
}

function Get-ApiServers {
    $found = @()
    foreach ($dir in $TomlDirs) {
        $file = Join-Path $dir 'TECHI Remote Support2.toml'
        if (-not (Test-Path $file)) { continue }
        $value = ''
        foreach ($line in Get-Content $file) {
            if ($line -match "^\s*api-server\s*=\s*['""]?([^'""]*)['""]?\s*$") { $value = $Matches[1] }
        }
        $found += [pscustomobject]@{ Path = $file; ApiServer = $value }
    }
    return $found
}

function Check-InstallLog([string]$Log) {
    $text = Get-Content $Log -Raw
    Check (-not ($text -match 'Error 1721')) "no custom action failed to launch (1721) in $(Split-Path $Log -Leaf)"
    Check ($text -match 'Doing action: BackupAgentConfigBeforeLegacyRemove') 'BackupAgentConfigBeforeLegacyRemove was sequenced'
}

function Check-RemoteSupportStopped([string[]]$Before, [string[]]$Actions) {
    $new = @(Get-DeployLogLines | Select-Object -Skip $Before.Count)
    foreach ($action in $Actions) {
        Check (@($new | Where-Object { $_ -like "* ${action}: start*" }).Count -gt 0) "$action ran (start logged)"
        Check (@($new | Where-Object { $_ -like "* ${action}: exit=0*" }).Count -gt 0) "$action finished (exit=0 logged)"
    }
}

function Remove-RemoteSupportConfig {
    foreach ($dir in $TomlDirs) {
        Remove-Item -LiteralPath (Join-Path $dir 'TECHI Remote Support2.toml') -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '== 1. fresh install'
$before = Get-DeployLogLines
$r = Invoke-Msi (@('/i', "`"$NewMsi`"") + $Props) 'fresh-install'
Check ($r.Code -eq 0) "fresh install exits 0 (got $($r.Code))"
Check-InstallLog $r.Log
Check-RemoteSupportStopped $before @('KillTechiRSBeforeInstall')
Check (Wait-ServiceRunning 'TechiAgent' 90) 'TechiAgent service running'
Check ((Get-InstalledVersion) -eq $ExpectedVersion) "installed version is $ExpectedVersion (got '$(Get-InstalledVersion)')"
$tomls = @(Get-ApiServers)
$tomls | ForEach-Object { Write-Host "  toml  $($_.Path) api-server='$($_.ApiServer)'" }
Check ($tomls.Count -gt 0) 'Remote Support configuration was written'
Check (@($tomls | Where-Object { $_.ApiServer -ne $PlatformApi }).Count -eq 0) 'every Remote Support configuration names the platform as api-server'

Write-Host '== 2. uninstall'
$r = Invoke-Msi @('/x', "`"$NewMsi`"") 'uninstall'
Check ($r.Code -eq 0) "uninstall exits 0 (got $($r.Code))"
Check ($null -eq (Get-Service -Name 'TechiAgent' -ErrorAction SilentlyContinue)) 'TechiAgent service removed'
Check ((Get-InstalledVersion) -eq '') 'product no longer registered'
Remove-RemoteSupportConfig

Write-Host '== 3. upgrade over the baseline with Remote Support files held open'
$r = Invoke-Msi (@('/i', "`"$BaselineMsi`"") + $Props) 'baseline-install'
if ($r.Code -ne 0) { throw "baseline install failed with $($r.Code); see $($r.Log)" }
Wait-ServiceRunning 'TechiAgent' 90 | Out-Null
Get-ApiServers | ForEach-Object { Write-Host "  baseline toml  $($_.Path) api-server='$($_.ApiServer)'" }

$holderDir = Join-Path $RsDir 'ci-holder'
New-Item -ItemType Directory -Force -Path $holderDir | Out-Null
$holderExe = Join-Path $holderDir 'TECHI Remote Support.exe'
Add-Type -OutputType ConsoleApplication -OutputAssembly $holderExe -TypeDefinition @'
using System.IO;
using System.Threading;
public static class Holder {
    public static void Main(string[] args) {
        using (new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.Read)) {
            Thread.Sleep(Timeout.Infinite);
        }
    }
}
'@
$locked = Join-Path $RsDir 'librustdesk.dll'
$holder = Start-Process -FilePath $holderExe -ArgumentList "`"$locked`"" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$isLocked = $false
try { [IO.File]::Open($locked, 'Open', 'ReadWrite', 'None').Dispose() } catch { $isLocked = $true }
if (-not $isLocked) { throw 'holder did not lock librustdesk.dll; the upgrade check would prove nothing' }
Write-Host "  holder pid=$($holder.Id) holds $locked"

$before = Get-DeployLogLines
$r = Invoke-Msi (@('/i', "`"$NewMsi`"") + $Props) 'upgrade'
Check ($r.Code -eq 0) "upgrade exits 0, no 1603 and no reboot-deferred files (got $($r.Code))"
Check-InstallLog $r.Log
Check-RemoteSupportStopped $before @('StopTechiRSBeforeUpgrade', 'KillTechiRSBeforeInstall')
Check ($null -eq (Get-Process -Id $holder.Id -ErrorAction SilentlyContinue)) 'the MSI stopped the process holding Remote Support files'
Check (Wait-ServiceRunning 'TechiAgent' 90) 'TechiAgent service running after upgrade'
Check ((Get-InstalledVersion) -eq $ExpectedVersion) "upgraded version is $ExpectedVersion (got '$(Get-InstalledVersion)')"
$want = (Get-FileHash (Join-Path $PayloadDir 'librustdesk.dll')).Hash
$got = if (Test-Path $locked) { (Get-FileHash $locked).Hash } else { 'missing' }
Check ($got -eq $want) 'librustdesk.dll is the packaged one after upgrade'
Check (Test-Path $AgentConfig) 'agent configuration kept across the upgrade'
$upgraded = @(Get-ApiServers)
$upgraded | ForEach-Object { Write-Host "  upgraded toml  $($_.Path) api-server='$($_.ApiServer)'" }
Check (@($upgraded | Where-Object { $_.ApiServer -ne $PlatformApi }).Count -eq 0) 'the upgrade kept the platform as api-server'

Write-Host '== 4. the agent sets a missing api-server and keeps one someone chose'
# self_update replaces only techi-agent.exe, so a device whose configuration
# lost the setting gets it back from the agent, not the MSI. Remove it from
# every file but one, which names another server; run one cycle.
$foreign = 'https://rustdesk-pro.example.com'
for ($i = 0; $i -lt $upgraded.Count; $i++) {
    $t = $upgraded[$i]
    $content = (Get-Content -LiteralPath $t.Path -Raw) -replace "(?m)^\s*api-server\s*=.*\r?\n?", ''
    if ($i -eq 0) {
        $content = $content -replace '\[options\]\r?\n', "[options]`r`napi-server = '$foreign'`r`n"
    }
    Set-Content -LiteralPath $t.Path -Value $content -NoNewline
}
$planted = @(Get-ApiServers)
Check (@($planted | Where-Object { $_.ApiServer -eq '' }).Count -eq ($upgraded.Count - 1)) 'api-server removed from every Remote Support configuration but one'
$agentExe = Join-Path $env:ProgramData 'TechiAgent\techi-agent.exe'
$agentOut = Join-Path $LogDir 'agent-once.log'
Start-Process -FilePath $agentExe -ArgumentList '-once' -Wait -NoNewWindow -RedirectStandardError $agentOut -RedirectStandardOutput (Join-Path $LogDir 'agent-once.out') | Out-Null
$after = @(Get-ApiServers)
$after | ForEach-Object { Write-Host "  after agent  $($_.Path) api-server='$($_.ApiServer)'" }
Check (@($after | Where-Object { $_.Path -ne $upgraded[0].Path -and $_.ApiServer -ne $PlatformApi }).Count -eq 0) 'one agent cycle set the platform api-server where it was missing'
Check (@($after | Where-Object { $_.Path -eq $upgraded[0].Path -and $_.ApiServer -eq $foreign }).Count -eq 1) 'an api-server someone else chose was kept'

function Wait-Path([string]$Path, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $Path) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Get-WatchdogTaskXml {
    # Under 'Stop', Windows PowerShell 5.1 turns a native command's stderr into
    # a terminating error even when redirected; a missing task is expected here.
    $ErrorActionPreference = 'Continue'
    $xml = & schtasks.exe /Query /TN 'TECHI Agent Watchdog' /XML 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ($xml -join "`n")
}

$agentDir = Join-Path $env:ProgramData 'TechiAgent'
$watchdogExe = Join-Path $agentDir 'techi-agent-watchdog.exe'
$backupExe = Join-Path $agentDir 'techi-agent-old.exe'

Write-Host '== 5. the watchdog puts back a missing techi-agent.exe'
Check (Wait-Path $watchdogExe 90) 'the agent wrote its watchdog copy'
Check ((Get-WatchdogTaskXml) -match 'techi-agent-watchdog\.exe') 'the watchdog task runs the watchdog copy'
Stop-Service -Name 'TechiAgent' -Force
Start-Sleep -Seconds 3
Remove-Item -LiteralPath $agentExe -Force
Check (-not (Test-Path $agentExe)) 'techi-agent.exe removed (as antivirus would)'
$before = Get-DeployLogLines
& schtasks.exe /Run /TN 'TECHI Agent Watchdog' | Out-Null
Check (Wait-Path $agentExe 90) 'the watchdog restored techi-agent.exe'
Check (Wait-ServiceRunning 'TechiAgent' 90) 'TechiAgent service running after the restore'
$new = @(Get-DeployLogLines | Select-Object -Skip $before.Count)
Check (@($new | Where-Object { $_ -like '*agent exe missing; restoring from*' }).Count -gt 0) 'the restore was logged'

Write-Host '== 6. self-update swap without a platform keeps the new exe and the backup'
$cacheDir = Join-Path $agentDir 'cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$newExe = Join-Path $cacheDir 'techi-agent-ci.exe'
Copy-Item -LiteralPath $agentExe -Destination $newExe -Force
Remove-Item -LiteralPath $backupExe -Force -ErrorAction SilentlyContinue
$before = Get-DeployLogLines
$swap = Start-Process -FilePath $newExe -ArgumentList @('swap-binary', '-swap-target', "`"$agentExe`"", '-swap-confirm-window', '45s') -Wait -PassThru -NoNewWindow
Check ($swap.ExitCode -eq 0) "swap exits 0 (got $($swap.ExitCode))"
$new = @(Get-DeployLogLines | Select-Object -Skip $before.Count)
$new | ForEach-Object { Write-Host "  deploy  $_" }
Check (@($new | Where-Object { $_ -like '*not confirmed within*keeping the new version and the backup*' }).Count -gt 0) 'an unreachable platform keeps the swap, never rolls it back'
Check (@($new | Where-Object { $_ -like '*rollback*' }).Count -eq 0) 'no rollback'
Check (Test-Path $backupExe) 'the previous exe is kept as techi-agent-old.exe'
Check (-not (Test-Path (Join-Path $agentDir 'swap.inprogress'))) 'the swap marker is cleared'
Check (Wait-ServiceRunning 'TechiAgent' 30) 'TechiAgent service running after the swap'

Write-Host '== 7. after an uninstall the watchdog brings nothing back'
$r = Invoke-Msi @('/x', "`"$NewMsi`"") 'uninstall-2'
Check ($r.Code -eq 0) "uninstall exits 0 (got $($r.Code))"
if (Test-Path $watchdogExe) {
    $before = Get-DeployLogLines
    Start-Process -FilePath $watchdogExe -ArgumentList 'watchdog-check' -Wait -NoNewWindow | Out-Null
    $new = @(Get-DeployLogLines | Select-Object -Skip $before.Count)
    Check (@($new | Where-Object { $_ -like '*agent uninstalled; removing the watchdog task*' }).Count -gt 0) 'the watchdog saw the uninstall'
} else {
    Write-Host '  note  no watchdog copy left after uninstall'
}
Check ($null -eq (Get-Service -Name 'TechiAgent' -ErrorAction SilentlyContinue)) 'TechiAgent service not recreated'
Check (-not (Test-Path $agentExe)) 'techi-agent.exe not brought back'
Check ((Get-WatchdogTaskXml) -eq '') 'the watchdog task is gone'
Check (-not (Test-Path $backupExe)) 'the swap backup is gone'
Remove-RemoteSupportConfig

Write-Host '== 8. upgrade over the baseline while a TechiAgent service handle is held'
$r = Invoke-Msi (@('/i', "`"$BaselineMsi`"") + $Props) 'baseline-install-2'
if ($r.Code -ne 0) { throw "baseline install failed with $($r.Code); see $($r.Log)" }
Wait-ServiceRunning 'TechiAgent' 90 | Out-Null
$svcHolderExe = Join-Path $env:RUNNER_TEMP 'svc-holder.exe'
Add-Type -OutputType ConsoleApplication -OutputAssembly $svcHolderExe -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class SvcHolder {
    [DllImport("advapi32.dll", SetLastError = true)] static extern IntPtr OpenSCManager(string machine, string db, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] static extern IntPtr OpenService(IntPtr scm, string name, uint access);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr h);
    public static int Main(string[] args) {
        IntPtr scm = OpenSCManager(null, null, 0x0001);
        if (scm == IntPtr.Zero) return 2;
        IntPtr svc = OpenService(scm, args[0], 0x0004);
        if (svc == IntPtr.Zero) return 3;
        Thread.Sleep(int.Parse(args[1]) * 1000);
        CloseServiceHandle(svc);
        CloseServiceHandle(scm);
        return 0;
    }
}
'@
$svcHolder = Start-Process -FilePath $svcHolderExe -ArgumentList @('TechiAgent', '30') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
if ($svcHolder.HasExited) { throw "service handle holder exited early with $($svcHolder.ExitCode)" }
Write-Host "  holder pid=$($svcHolder.Id) holds a TechiAgent service handle for 30 s"
$before = Get-DeployLogLines
$r = Invoke-Msi (@('/i', "`"$NewMsi`"") + $Props) 'upgrade-held-service'
Check ($r.Code -eq 0) "upgrade with a held service handle exits 0, no 1920/1603 (got $($r.Code))"
Check (Wait-ServiceRunning 'TechiAgent' 90) 'TechiAgent service running after the upgrade'
Check ((Get-InstalledVersion) -eq $ExpectedVersion) "upgraded version is $ExpectedVersion (got '$(Get-InstalledVersion)')"
$new = @(Get-DeployLogLines | Select-Object -Skip $before.Count)
$waited = @($new | Where-Object { $_ -like '*service marked for deletion*' }).Count
Check ($waited -gt 0) 'EnsureServiceCreated met the pending delete and waited it out (the scenario reproduced the field 1603)'
Stop-Process -Id $svcHolder.Id -Force -ErrorAction SilentlyContinue

Copy-Item $DeployLog $LogDir -ErrorAction SilentlyContinue
if ($failures.Count -gt 0) {
    Write-Host "`n$($failures.Count) check(s) failed:"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "`nall MSI lifecycle checks passed"
# The workflow ends with `exit $LASTEXITCODE`; a native command that was meant
# to fail (schtasks /Query for a removed task) must not decide the result.
exit 0
