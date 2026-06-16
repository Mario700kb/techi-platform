@echo off
REM TECHI Agent v2.0 MSI Builder (Windows)
REM Kërkon: WiX Toolset v4  →  winget install WiXToolset.WiX
REM          Go 1.21+        →  https://go.dev/dl/

SET VERSION=2.0.0
SET OUTPUT=TECHI-Endpoint-Deployment-%VERSION%.msi
SET SRCDIR=%~dp0

echo [1/3] Building techi-agent.exe (Windows/amd64)...
pushd %~dp0..
SET GOOS=windows
SET GOARCH=amd64
go build -ldflags="-s -w" -o installer\techi-agent.exe .
if %ERRORLEVEL% neq 0 (
    echo ERROR: go build failed
    popd
    exit /b 1
)
popd

echo [2/3] Building MSI with WiX v4...
wix build installer.wxs -d SourceDir=%SRCDIR% -o %OUTPUT%
if %ERRORLEVEL% neq 0 (
    echo ERROR: wix build failed
    exit /b 1
)

echo [3/3] Done!
echo MSI: %SRCDIR%%OUTPUT%
echo SHA256:
certutil -hashfile %OUTPUT% SHA256

del /q techi-agent.exe 2>nul
