<#
  Installs, removes and upgrades the Endpoint MSI on a throwaway Windows
  runner and fails on anything a field install would trip over:
    1. fresh install: exit 0, agent service running, Remote Support stop
       actions logged, no custom action failing to launch (1721),
       no api-server in the Remote Support configuration;
    2. uninstall: exit 0, service gone;
    3. upgrade over the baseline (2.1.20) while a process named like Remote
       Support holds librustdesk.dll open: exit 0 (no 1603, no 3010), holder
       stopped by the MSI, new payload in place, agent configuration kept,
       api-server cleared;
    4. the agent itself removes an api-server that points at the platform.
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
$Props = @(
    'ENROLLMENT_TOKEN=ci-placeholder',
    'API_URL=http://127.0.0.1:9',
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
Check (@($tomls | Where-Object { $_.ApiServer -ne '' }).Count -eq 0) 'no Remote Support configuration names an api-server'

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
Check (@($upgraded | Where-Object { $_.ApiServer -ne '' }).Count -eq 0) 'the upgrade cleared api-server'

Write-Host '== 4. the agent itself clears an api-server pointing at the platform'
# self_update replaces only techi-agent.exe, so devices that still carry the
# setting are cleaned by the agent, not the MSI. Put it back, run one cycle.
foreach ($t in $upgraded) {
    $content = (Get-Content -LiteralPath $t.Path -Raw) -replace "(?m)^\s*api-server\s*=.*\r?\n?", ''
    $content = $content -replace '\[options\]\r?\n', "[options]`r`napi-server = 'http://127.0.0.1:9'`r`n"
    Set-Content -LiteralPath $t.Path -Value $content -NoNewline
}
Check (@(Get-ApiServers | Where-Object { $_.ApiServer -eq 'http://127.0.0.1:9' }).Count -eq $upgraded.Count) 'platform api-server planted in every Remote Support configuration'
$agentExe = Join-Path $env:ProgramData 'TechiAgent\techi-agent.exe'
$agentOut = Join-Path $LogDir 'agent-once.log'
Start-Process -FilePath $agentExe -ArgumentList '-once' -Wait -NoNewWindow -RedirectStandardError $agentOut -RedirectStandardOutput (Join-Path $LogDir 'agent-once.out') | Out-Null
$after = @(Get-ApiServers)
$after | ForEach-Object { Write-Host "  after agent  $($_.Path) api-server='$($_.ApiServer)'" }
Check (@($after | Where-Object { $_.ApiServer -ne '' }).Count -eq 0) 'one agent cycle removed every platform api-server'

Copy-Item $DeployLog $LogDir -ErrorAction SilentlyContinue
if ($failures.Count -gt 0) {
    Write-Host "`n$($failures.Count) check(s) failed:"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "`nall MSI lifecycle checks passed"
