param(
    [string]$Version = "1.4.6",
    [string]$MsiPath = "",
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($MsiPath)) {
    $MsiPath = Join-Path $ScriptDir "TECHI-Remote-Support-$Version.msi"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $ScriptDir "TECHI-Remote-Support-$Version.exe"
}

if (-not (Test-Path -LiteralPath $MsiPath)) {
    throw "Remote Support MSI not found: $MsiPath"
}

$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
if (-not (Test-Path -LiteralPath $iexpress)) {
    throw "IExpress is required to build the standalone EXE and was not found at $iexpress"
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("techi-rs-exe-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $msiItem = Get-Item -LiteralPath $MsiPath
    $sourceDir = $msiItem.Directory.FullName
    $target = [IO.Path]::GetFullPath($OutputPath)
    $sed = Join-Path $work "remote-support.sed"
    $msiName = $msiItem.Name
    $sedText = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$target
FriendlyName=TECHI Remote Support
AppLaunched=msiexec.exe /i "$msiName"
PostInstallCmd=<None>
AdminQuietInstCmd=msiexec.exe /i "$msiName" /qn /norestart
UserQuietInstCmd=msiexec.exe /i "$msiName" /qn /norestart
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=$sourceDir
[SourceFiles0]
%FILE0%=
[Strings]
FILE0="$msiName"
"@
    Set-Content -LiteralPath $sed -Value $sedText -Encoding ASCII
    & $iexpress /N /Q $sed
    if ($LASTEXITCODE -ne 0) {
        throw "IExpress failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $target)) {
        throw "IExpress did not produce $target"
    }
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $target)" | Set-Content -LiteralPath "$target.sha256" -Encoding utf8NoBOM
    Write-Host "EXE: $target"
    Write-Host "SHA256: $hash"
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
