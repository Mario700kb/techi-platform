param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$LogDirectory
)

$ErrorActionPreference = 'Stop'

$serviceName = 'TECHI Remote Support'
$installRoot = Join-Path $env:ProgramFiles 'TECHI Remote Support'
$msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

function Get-MsiProperty([string]$Name) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember(
        'OpenDatabase',
        'InvokeMethod',
        $null,
        $installer,
        @($resolvedMsi, 0)
    )
    $view = $database.OpenView("SELECT Value FROM Property WHERE Property='$Name'")
    $null = $view.Execute()
    $record = $view.Fetch()
    if ($null -eq $record) { throw "MSI property not found: $Name" }
    return $record.StringData(1)
}

function Invoke-Msi {
    param(
        [Parameter(Mandatory=$true)][string]$CaseName,
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )

    $logPath = Join-Path $LogDirectory "$CaseName.log"
    $fullArguments = @($Arguments + @('/qn', '/norestart', '/L*v', ('"' + $logPath + '"')))
    $process = Start-Process -FilePath $msiexec -ArgumentList $fullArguments -Wait -PassThru
    if ($AllowedExitCodes -notcontains $process.ExitCode) {
        throw "$CaseName MSI exit code $($process.ExitCode); log=$logPath"
    }
    Write-Host "$CaseName MSI exit code $($process.ExitCode)"
    return $logPath
}

function Wait-ServiceState([string]$Expected, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        $actual = if ($null -eq $service) { 'missing' } else { [string]$service.Status }
        if ($actual -eq $Expected) { return }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "service state did not become $Expected; actual=$actual"
}

function Assert-InstalledRuntime {
    $requiredFiles = @(
        'TECHI Remote Support.exe',
        'flutter_windows.dll',
        'librustdesk.dll',
        'data\app.so',
        'data\icudtl.dat'
    )
    foreach ($relativePath in $requiredFiles) {
        $path = Join-Path $installRoot $relativePath
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "installed runtime file missing: $path"
        }
        if ((Get-Item -LiteralPath $path).Length -le 0) {
            throw "installed runtime file empty: $path"
        }
    }
    Wait-ServiceState -Expected 'Running' -TimeoutSeconds 30
}

function Assert-SystemHelperLog([string]$LogPath) {
    $log = Get-Content -LiteralPath $LogPath -Raw
    if ($log -notmatch 'WixQuietExec') {
        throw "WixQuietExec output missing from MSI log: $LogPath"
    }
    if ($log -notmatch '(?i)remote-support-msi.*identity=NT AUTHORITY\\SYSTEM') {
        throw "SYSTEM helper identity missing from MSI log: $LogPath"
    }
    if ($log -notmatch 'remote-support-msi.*success service_status=Running runtime_exe=true app_so=true') {
        throw "helper success details missing from MSI log: $LogPath"
    }
}

$productCode = Get-MsiProperty 'ProductCode'

# Establish a clean machine state. An absent product is expected on a fresh runner.
$null = Invoke-Msi -CaseName 'initial-uninstall' -Arguments @('/x', $productCode) -AllowedExitCodes @(0, 1605)
Wait-ServiceState -Expected 'missing' -TimeoutSeconds 30
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue

$cleanLog = Invoke-Msi -CaseName 'clean-install' -Arguments @('/i', ('"' + $resolvedMsi + '"'))
Assert-InstalledRuntime
Assert-SystemHelperLog $cleanLog

# Repair the same package after deleting a required runtime file.
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
Wait-ServiceState -Expected 'Stopped' -TimeoutSeconds 30
Remove-Item -LiteralPath (Join-Path $installRoot 'data\app.so') -Force
$damagedLog = Invoke-Msi -CaseName 'damaged-reinstall' -Arguments @(
    '/i',
    ('"' + $resolvedMsi + '"'),
    'REINSTALL=ALL',
    'REINSTALLMODE=amus'
)
Assert-InstalledRuntime
Assert-SystemHelperLog $damagedLog

$null = Invoke-Msi -CaseName 'uninstall' -Arguments @('/x', $productCode)
Wait-ServiceState -Expected 'missing' -TimeoutSeconds 30
if (Test-Path -LiteralPath (Join-Path $installRoot 'TECHI Remote Support.exe')) {
    throw 'Remote Support executable remained after uninstall'
}

$reinstallLog = Invoke-Msi -CaseName 'uninstall-reinstall' -Arguments @('/i', ('"' + $resolvedMsi + '"'))
Assert-InstalledRuntime
Assert-SystemHelperLog $reinstallLog
Write-Host 'Remote Support MSI clean, damaged, and uninstall/reinstall validation passed'
