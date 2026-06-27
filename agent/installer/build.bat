@echo off
setlocal

REM TECHI Agent MSI Builder (Windows)
REM Requires: WiX Toolset v4, Go 1.21+, goversioninfo
REM Usage: build.bat [version]   -- nese mungon, lexon nga agent\VERSION

set SRCDIR=%~dp0
set PATH=C:\Program Files\Go\bin;%USERPROFILE%\.dotnet\tools;%USERPROFILE%\go\bin;%PATH%

set VERSION=%1
if "%VERSION%"=="" (
    for /f "usebackq delims=" %%v in ("%~dp0..\VERSION") do set VERSION=%%v
)
if "%VERSION%"=="" (
    echo ERROR: nuk u gjet version. Kaloje si argument ose vendose ne agent\VERSION.
    exit /b 1
)
set VERSION4=%VERSION%.0
set OUTPUT=TECHI-Endpoint-Deployment-%VERSION%.msi

echo [1/5] Generating resource.syso (versioninfo + manifest) v%VERSION%...
pushd "%~dp0.."
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$v='%VERSION%'; $v4='%VERSION4%'; $vi='versioninfo.json'; $m='techi-agent.manifest'; $json=Get-Content $vi -Raw | ConvertFrom-Json; $parts=$v.Split('.'); $json.FixedFileInfo.FileVersion.Major=[int]$parts[0]; $json.FixedFileInfo.FileVersion.Minor=[int]$parts[1]; $json.FixedFileInfo.FileVersion.Patch=[int]$parts[2]; $json.FixedFileInfo.FileVersion.Build=0; $json.FixedFileInfo.ProductVersion.Major=[int]$parts[0]; $json.FixedFileInfo.ProductVersion.Minor=[int]$parts[1]; $json.FixedFileInfo.ProductVersion.Patch=[int]$parts[2]; $json.FixedFileInfo.ProductVersion.Build=0; $json.StringFileInfo.FileVersion=$v4; $json.StringFileInfo.ProductVersion=$v4; $json | ConvertTo-Json -Depth 8 | Set-Content -Path $vi -Encoding ASCII; (Get-Content $m -Raw) -replace 'version=\"[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+\"', ('version=\"' + $v4 + '\"') -replace 'TECHI Platform Endpoint Agent [0-9]+\\.[0-9]+\\.[0-9]+', ('TECHI Platform Endpoint Agent ' + $v) | Set-Content -Path $m -Encoding ASCII"
if errorlevel 1 (
    echo ERROR: version metadata update failed
    popd
    exit /b 1
)
goversioninfo -o resource.syso versioninfo.json
if errorlevel 1 (
    echo ERROR: goversioninfo failed - install with: go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
    popd
    exit /b 1
)

echo [2/5] Building techi-agent.exe (Windows/amd64)...
set GOOS=windows
set GOARCH=amd64
go build -ldflags="-s -w -X main.AgentVersion=%VERSION%" -trimpath -o installer\techi-agent.exe .
if errorlevel 1 (
    echo ERROR: go build failed
    popd
    exit /b 1
)
del /q resource.syso 2>nul
popd

echo [3/5] Converting techi-icon.png to banner.bmp (498x55, icon simbolik pa tekst)...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Drawing; $src=[System.IO.Path]::GetFullPath('%~dp0..\TECHI-branding-assets\techi-icon.png'); $dst=[System.IO.Path]::GetFullPath('%~dp0banner.bmp'); $icon=[System.Drawing.Image]::FromFile($src); $banner=New-Object System.Drawing.Bitmap(498,55); $g=[System.Drawing.Graphics]::FromImage($banner); $g.Clear([System.Drawing.Color]::FromArgb(248,248,248)); $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $g.DrawImage($icon,233,12,32,32); $g.Dispose(); $icon.Dispose(); $banner.Save($dst,[System.Drawing.Imaging.ImageFormat]::Bmp); $banner.Dispose()"
if %ERRORLEVEL% neq 0 (
    echo ERROR: PNG to BMP conversion failed
    exit /b 1
)

echo [4/5] Building MSI with WiX v4...
pushd "%~dp0"
wix build installer.wxs -arch x64 -ext WixToolset.UI.wixext -d SourceDir=%SRCDIR% -d Version=%VERSION4% -o "%OUTPUT%"
REM Requires: wix extension add WixToolset.UI.wixext
if %ERRORLEVEL% neq 0 (
    popd
    echo ERROR: wix build failed
    exit /b 1
)
popd

echo [5/5] Done!
echo MSI: %SRCDIR%%OUTPUT%
echo SHA256:
certutil -hashfile "%OUTPUT%" SHA256

del /q techi-agent.exe 2>nul
del /q banner.bmp 2>nul
endlocal
