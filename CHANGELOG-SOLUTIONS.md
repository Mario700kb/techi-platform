# CHANGELOG-SOLUTIONS

Regjistër i ndryshimeve të konfirmuara me teste para deploy-it.

---

## 2026-06-24 — Race condition në /devices: device catalog rikthehet te "All" pas zgjedhjes së klientit

**Skedarë:**
- `frontend/src/pages/Devices.tsx`
- `frontend/src/api/devices.ts`
- `frontend/src/api/client.ts`

**Problem:** Te `/devices`, kur klikohej një klient/grup në Fleet tree, tabela e
device-ve riorientohej pas disa sekondash te "All" ose te një klient tjetër.
Konfirmuar live në network trace: requests për `client_id=7` dhe `client_id=3`
të mbivendosura, përgjigja që mbërrin e fundit fitonte pavarësisht cilës
selektim i përkiste — zero console errors (jo crash, race e pastër).

**Root cause:**
1. `loadTableData()` (te `Devices.tsx`) thërriste `getDevices(...)` pa
   `AbortController` — request-i i mëparshëm (p.sh. për `client_id=3`) vazhdonte
   në background edhe pasi përdoruesi kishte zgjedhur `client_id=7`, dhe çfarëdo
   që mbërrinte e fundit mbishkruante `tableDevices`.
2. `scheduleDevicesRefresh()` krijonte një `setTimeout` një-herësh (5s debounce
   pas event-eve WS "Live") që mbante closure stale mbi `refreshBoth` —
   nëse përdoruesi ndërronte selektimin brenda atyre 5s, timeout-i ekzekutohej
   sërish me `filters`/`client_id` e VJETËR (closure i kapur në momentin e
   planifikimit, jo në momentin e ekzekutimit).
3. Klikë të shpeshtë në fleet tree shumëzonin numrin e request-ve konkurrente.

**Zgjidhje (vetëm request lifecycle, pa prekur backend/layout/Command Center):**
- **AbortController**: `loadTableData()` anulon request-in paraardhës
  (`tableAbortRef`) para se të nisë një të ri; `getDevices()` (te `devices.ts`)
  pranon tani `signal?: AbortSignal` opsional dhe ia kalon `fetchJson`.
  `AbortError` trajtohet në heshtje (mos e trajto si gabim të rrjetit).
- **Fallback fix te `client.ts`**: `fetchJson` rihedh `AbortError`-in
  menjëherë te `catch`, në vend që të provojë base URL-in tjetër (loop-i
  ekzistues fallback mes disa base URLs do ta anashkalonte abort-in).
- **Selection guard (latest-selection-wins)**: `tableRequestKeyRef` ruan
  `cacheKey` e selektimit aktual (page+limit+search+quickFilter+filters,
  pra përfshin `client_id`/`smart_folder`); pas çdo `await getDevices(...)`,
  nëse `tableRequestKeyRef.current !== cacheKey` (selektimi ka ndryshuar
  ndërkohë), përgjigja hidhet poshtë pa shkruar state. I zbatuar gjithashtu
  te `finally` (mos e fik skeleton loading-un e selektimit të ri për shkak
  të një request-i të vjetër që po mbyllet).
- **Ref për polling "Live"**: `refreshBothRef` mban referencën më të fundit
  të `refreshBoth`; `scheduleDevicesRefresh`'s `setTimeout` thërret tani
  `refreshBothRef.current()` (lexim në kohën e ekzekutimit) në vend të
  `refreshBoth()` direkt (closure i kapur në kohën e planifikimit).
  `usePollingRefresh` (60s fallback) NUK u prek — ai hook rikrijon interval-in
  vetë kur identiteti i `refreshBoth` ndryshon, pra s'kishte bug stale-closure.
- **Debounce 200ms te Fleet tree**: `handleTreeSelect` jep feedback vizual
  menjëherë (`setSelectedTreeKey`), por debouncon (200ms, `treeSelectTimerRef`)
  pjesën që prek `setFilters`/URL/fetch, që klikë të shpeshtë të kolapsohen
  në një fetch të vetëm. Timer-i pastrohet te cleanup effect-i ekzistues
  (krahas `refreshTimerRef`/`drawerCloseTimerRef`/`searchTimerRef`).

**`getDeviceTableDetails` (table-details) NUK u prek** — tashmë i mbrojtur
me `detailsRequestRef` (request id incremental).

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy — verifikim
manual te `/devices` (klikim i shpeshtë mes klientëve) mbetet për review.

---

## 2026-06-23 — Agent Path Consistency & HTTPS/WSS Fix

**Skedarë:**
- `agent/paths.go`
- `agent/agent.go`
- `agent/config.go`
- `agent/main.go`
- `agent/service_windows.go`
- `backend/app/services/enrollment_bootstrap_service.py`
- `backend/app/api/v1/endpoints/agent.py`
- `backend/app/api/v1/endpoints/agent_config.py`
- `backend/tests/test_agent_config.py`
- `backend/tests/test_enrollment_bootstrap_script.py`
- `backend/tests/test_agent_enroll_urls.py`
- `agent/config_test.go`

**Problem:** Deployment/GPO/MSI bootstrap shkruante ose kontrollonte config/log te
`C:\ProgramData\TechiAgent`, ndërsa `techi-agent.exe` në runtime lexonte
config nga `C:\ProgramData\TECHI`. Si rezultat, agent-i nisej me config bosh
ose default dhe heartbeat dështonte gjatë enrollment-it edhe pse install/service
ishin OK.

**Root cause:** Path-et e agent runtime dhe script-eve të deployment-it kishin
devijuar:
- Runtime: `C:\ProgramData\TECHI\agent.config.json`
- Deployment legacy: `C:\ProgramData\TechiAgent\agent.config.json`

Ky mismatch fshihte token-in real të enrollment-it nga runtime. Në të njëjtën
kohë, disa rrugë bootstrap/enrollment mund të gjeneronin URL me `http://` ose
`ws://` kur request-i kalonte përmes proxy/HTTP.

**Zgjidhje:**
- Standardizohet storage zyrtar i agent-it:
  - `C:\ProgramData\TECHI\agent.config.json`
  - `C:\ProgramData\TECHI\logs\agent.log`
- Shtohet migrim automatik në startup/install:
  - nga `C:\ProgramData\TechiAgent\agent.config.json`
  - te `C:\ProgramData\TECHI\agent.config.json`
  - krijohet `C:\ProgramData\TECHI\logs` nëse mungon
  - log-ohet migrimi pa ekspozuar secrets
- Bootstrap/GPO/rollout scripts shkruajnë te path-i zyrtar dhe mbajnë legacy
  fallback vetëm për migrim/compatibility.
- Heartbeat URL gjenerohet me HTTPS:
  - `https://api-rdp.techi.com.al/api/v1/agent/heartbeat`
- WebSocket URL gjenerohet me WSS:
  - `wss://api-rdp.techi.com.al/ws/devices?tenant_id=default`
- Runtime normalizon endpoint-et production:
  - `http://api-rdp.techi.com.al` → `https://api-rdp.techi.com.al`
  - `ws://api-rdp.techi.com.al` → `wss://api-rdp.techi.com.al`
- Startup diagnostics shtohen për:
  - resolved config path
  - resolved log path
  - backend URL
  - API URL
  - device ID
  - agent ID present/missing
  - enrollment token present/missing

**Validation:**
- Agent tests: `go test ./...`
- Backend targeted tests:
  - `backend/tests/test_agent_config.py`
  - `backend/tests/test_enrollment_bootstrap_script.py`
  - `backend/tests/test_agent_enroll_urls.py`
- Verifikuar që config template gjeneron HTTPS heartbeat URL dhe WSS websocket URL.
- Verifikuar migrimi automatik nga legacy path te path-i zyrtar.
- Verifikuar në production machine ku heartbeat dështonte më parë; heartbeat
  funksionoi pas migrimit të path-it.

---

## 2026-06-23 — gpo-deploy.ps1 download: Invoke-WebRequest → WebClient.DownloadFile

**Skedarë:**
- `backend/app/services/enrollment_token_service.py`
- `backend/tests/test_enrollment_token_workflow.py`

**Problem:** Komanda e gjeneruar nga UI për shkarkimin e `gpo-deploy.ps1` përdorte `Invoke-WebRequest` i cili dështon në Windows Server 2016 pa WMF 5.1 të plotë ose me proxy settings të caktuara.

**Zgjidhje:** Zëvendëso në `safe_gpo_deploy_command()`:
```
Para:  Invoke-WebRequest -Uri "{url}" -OutFile $f -UseBasicParsing
Pas:   (New-Object Net.WebClient).DownloadFile("{url}", $f)
```
`Net.WebClient.DownloadFile` funksionon në .NET 3.5+ (Windows Server 2008+) dhe nuk varet nga cmdlet-et e PowerShell.

**Teste:** 5 passed (1 assertion e re: `DownloadFile in gpo_deploy_command` + `Invoke-WebRequest not in gpo_deploy_command`).

---

## 2026-06-23 — Uninstall eksplicit i v1.0.4 (TECHI Endpoint Deployment) para install v2.0.0

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Root cause i konfirmuar:** PC-të me v1.0.4 kishin `UpgradeCode` identik me v2.0.0 (`{E6AD0A88-5F26-5665-9B1F-70B8C5EE8363}`) por MSI nuk mund ta uninstalonte v1.0.4 automatikisht gjatë upgrade kur shërbimi ishte running + file locked. Rezultati: `msiexec REINSTALL=ALL` kthente 1603.

**Zgjidhja — tre shtresa në `:do_install`, para `set PRODUCT_INSTALLED=`:**

**1. Fshi service para uninstall** (eliminon file-lock dhe service-conflict):
```bat
sc.exe stop TechiAgent 2>nul
sc.exe delete TechiAgent 2>nul
timeout /t 3 /nobreak >nul
```

**2. Uninstall registry-based** (dinamik — gjen çdo paketë "TECHI Endpoint Deployment"):
```bat
for /f "tokens=*" %%i in ('reg query ... "TECHI Endpoint Deployment" ...') do (
    for /f "tokens=2 delims={}" %%j in ('... findstr /i "HKEY"') do (
        msiexec /x "{%%j}" /quiet /norestart 2>nul
    )
)
```

**3. Uninstall direkt me ProductCode** (failsafe — ProductCode-et e njohura të v1.0.4):
```bat
msiexec /x "{134568B7-BCB0-4341-933B-C24DA78DEF6E}" /quiet /norestart 2>nul
msiexec /x "{110919C6-83C4-444F-821F-61F755FE5081}" /quiet /norestart 2>nul
timeout /t 10 /nobreak >nul
```

Pas këtij blloku, `set PRODUCT_INSTALLED=` kërkon "TECHI Agent" (v2.0.0) — nëse u uninstalua, do ta instalojë si fresh. Nëse UpgradeCode u gjet ende, bën REINSTALL=ALL.

**Teste:** 32 passed (2 teste të reja: `test_deploy_cmd_deletes_service_before_uninstall`, `test_deploy_cmd_uninstalls_old_v104_before_install`).

---

## 2026-06-23 — :manual_replace_lan krijon Windows Service nëse mungon (v1.0.4 skip-install bug)

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`

**Problem:** Disa PC me v1.0.4 kishin kaluar nëpër upgrade të mëparshëm ku `ServiceInstall` u skip-ua — skedari `techi-agent.exe` ekzistonte por Windows Service `TechiAgent` nuk ekzistonte fare. Rrjedhimisht `:manual_replace_lan` kopjonte executable-in me `copy /y` dhe pastaj `net start TechiAgent` dështonte me "service not found".

**Zgjidhje:** Shtohen 4 rreshta pas `copy /y`, para `net start`:
```bat
sc query TechiAgent >nul 2>&1
if errorlevel 1 (
    sc.exe create TechiAgent binPath= "%AGENT_EXE%" start= auto DisplayName= "TECHI Agent"
    sc.exe description TechiAgent "TECHI Solutions endpoint monitoring and management service"
    sc.exe failure TechiAgent reset= 60 actions= restart/60000/restart/60000/restart/300000
)
```
`sc query` kthen errorlevel 1 nëse service nuk ekziston → krijimi bëhet vetëm kur nevojitet (idempotent).

**Teste:** 30 passed (1 test i ri: `test_deploy_cmd_manual_replace_lan_creates_service_if_missing`).

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
