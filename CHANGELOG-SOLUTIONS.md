# CHANGELOG-SOLUTIONS

Regjistër i ndryshimeve të konfirmuara me teste para deploy-it.

---

## 2026-06-23 — manual_replace_lan fallback në :do_install kur msiexec REINSTALL kthen 1603

**Skedarë:**
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/tests/test_enrollment_bootstrap_script.py`

**Problem:** `techi-deploy.cmd` (arkitektura LAN) dështonte me `exit /b 1` kur `msiexec /i REINSTALL=ALL` kthente error 1603 (file lock gjatë upgrade — shërbimi aktiv mban `techi-agent.exe` të bllokuar). Nuk kishte asnjë fallback.

**Zgjidhje:** Shtohet `:manual_replace_lan` fallback pas REINSTALL=ALL:
1. Msiexec REINSTALL=ALL dështon → `goto :manual_replace_lan`
2. `:manual_replace_lan`: ekstrakton MSI nga NETLOGON me `msiexec /a /qn TARGETDIR=%EXTRACT_DIR%`
3. Ndalon shërbimin + `taskkill`, kopjon `CommApp\TechiAgent\techi-agent.exe` me `copy /y`
4. Rinis shërbimin, log `result=0-manual`
5. Nëse copy dështon → `:install_failed` → `result=1603`, `exit /b 1`

**Ndryshim CMD strukturor:** Hiqet `if/else` me kllapa (për shkak të `%ERRORLEVEL%` expansion bug-it të CMD brenda kllaPave). Struktura e re me goto:
```bat
if defined PRODUCT_INSTALLED goto :do_reinstall_lan
msiexec ... ENROLLMENT_TOKEN...
set MSI_EXIT=%ERRORLEVEL%
if not "%MSI_EXIT%"=="0" goto :install_failed
goto :install_done

:do_reinstall_lan
msiexec ... REINSTALL=ALL...
set MSI_EXIT=%ERRORLEVEL%
if not "%MSI_EXIT%"=="0" goto :manual_replace_lan

:install_done → :done
:manual_replace_lan → :done ose :install_failed
:install_failed → exit /b 1
:done → exit /b 0
```

**Teste:** 29 passed (6 teste të reja).

---

## 2026-06-23 — Eliminim i false positive-ve AV (Kaspersky/Symantec) në GPO deploy

**Skedarë:**
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/tests/test_enrollment_bootstrap_script.py`
- `backend/app/services/device_heartbeat_service.py`

**Problem:** `techi-deploy.cmd` e gjeneruar nga `gpo-deploy.ps1` dhe e shkruar në SYSVOL/NETLOGON
detektohej si `HEUR:Trojan-Downloader.PowerShell.Agent.gen` nga Kaspersky (dhe Symantec/Cybereason).
Shkaku rrënjësor: CMD-ja kishte "dropper pattern" klasik — shkarkon MSI nga interneti
(`curl.exe`/`Net.WebClient`/`Invoke-WebRequest`) me token plaintext, pastaj ekzekuton `msiexec`.
Kaspersky e karantinonte menjëherë pas shkrimit në SYSVOL.

**Zgjidhje:** MSI pozicionohet në `\\domain\NETLOGON\` nga `gpo-deploy.ps1` (admin, 1 herë në DC).
PC-të instalojnë vetëm nga LAN — zero download nga interneti, zero pattern dropper, zero detektim AV.

Dy ndryshime kryesore:

**1. Hapi 4b i ri në `gpo-deploy.ps1`** (`_gpo_scheduled_task_setup`):
- Shkarkon MSI aktiv nga API → `\\domain\NETLOGON\TECHI-Agent-X.Y.Z.msi` (3 retries, TLS 1.2)
- Shkruan `\\domain\NETLOGON\techi-version.txt` me versionin aktiv
- Fshin MSI-të e vjetra nga NETLOGON (pastrim automatik)
- Shfaq SHA256 të MSI-t të shkarkuar
- `Test-Path` verifikime pas çdo shkrimie kritike (mësim nga "bug Adpascucci")

**2. `techi-deploy.cmd` i ri — vetëm LAN:**
```bat
:: Lexo version aktiv nga NETLOGON (LAN -- jo internet)
for /f "tokens=*" %%i in ('type "%NETLOGON_VERSION%" 2^>nul') do set ACTIVE_VERSION=%%i

:do_install
  reg query "HKLM\...\Uninstall" ... | findstr "TECHI Agent" → PRODUCT_INSTALLED
  if defined PRODUCT_INSTALLED → REINSTALL=ALL REINSTALLMODE=vomus
  else                         → ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL%
  logs: deploy.log (timestamp + result + version)

:already_uptodate
  sc query TechiAgent | findstr "RUNNING" >nul 2>&1
  if errorlevel 1 → net start TechiAgent

:fresh_install  (fallback nëse NETLOGON_VERSION nuk lexohet)
  instalo MSI me ENROLLMENT_TOKEN
```

**Rregullime shtesë:**
- `reg query ... 2^>nul` (jo `2^>/dev/null` — `/dev/null` nuk ekziston në CMD Windows)
- `sc query ... >nul 2>&1` (i njëjti korrigjim)
- Testim i label ordering me `re.search(r"^:label", script, re.MULTILINE)` — `.index()` gjente `goto :label` para labelit aktual
- `from __future__ import annotations` në `device_heartbeat_service.py` — fix pre-ekzistues për Python 3.9 (`str | None` syntax)

**Rezultati:**
```
23 passed, 3 warnings in 0.99s
```

**Arsye:** Pattern-i dropper (download+exec) është firma e malware-it sipas heuristikës AV.
LAN-only eliminon firmën dhe do të gjitha benefitet e security-t të AD (nuk ka token në CMD).

---

## 2026-06-21 — Simplifiko path-detection për :manual_replace në techi-deploy.cmd

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Problem:** Seksioni `:manual_replace` përdorte `if/else if` chain me 4 path-e alternative
për të gjetur `techi-agent.exe` pas `msiexec /a` (administrative install/extract):

```bat
set EXTRACTED_AGENT=
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\PFiles64\TECHI Agent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommonAppData\TechiAgent\techi-agent.exe"
) else if exist "%EXTRACT_DIR%\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\TechiAgent\techi-agent.exe"
)
```

**Zgjidhje:** Konfirmuar me 3×3 teste në makina të ndryshme Windows se path-i i vetëm i qëndrueshëm
është `CommApp\TechiAgent\techi-agent.exe`, i dokumentuar gjithashtu në `installer.wxs` si i garantuar
nga MSI packaging. U hoqën 3 `else if` të tjerë; u standardizua inicializimi i variablit me kuota.

```bat
set "EXTRACTED_AGENT="
if exist "%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe" (
    set "EXTRACTED_AGENT=%EXTRACT_DIR%\CommApp\TechiAgent\techi-agent.exe"
)
```

**Arsye:** Heqja e path-eve alternative eliminon ambiguitetin, zvogëlon sipërfaqen e gabimeve,
dhe e bën kodin konsistent me strukturën e garantuar nga MSI-ja.
