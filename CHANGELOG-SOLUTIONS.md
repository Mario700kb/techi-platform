# CHANGELOG-SOLUTIONS

Regjistër i ndryshimeve të konfirmuara me teste para deploy-it.

---

## 2026-07-16 — Verify promoted Remote Support runtime before service/UI start

**Confirmed failure:** Device 11 completed staging and reached `start_ui`, but
the Session 1 launch failed because
`C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe` did not exist.

**Root cause:** `StagePayload` verified the extracted bundle, but
`PromoteFiles` considered the directory rename sufficient proof of promotion.
The full installed-manifest/runtime validation ran only in `ValidateFinal`,
after config restore, service startup, and UI launch. A missing promoted EXE or
Flutter runtime could therefore reach `start_ui`.

**Fix:** after the atomic rename, `PromoteFiles` now runs the existing exact
installed-manifest verifier before returning success. It requires the EXE,
`flutter_windows.dll`, `librustdesk.dll`, `data/icudtl.dat`, `data/app.so`, and
non-empty Flutter assets with the expected sizes and hashes. A verification
failure returns the promotion undo and exact underlying error; the orchestrator
rolls back and does not restore config, create/start the service, or launch UI.

**Regression coverage:** verifies rejection of a missing EXE,
`flutter_windows.dll`, or `data/app.so`, plus orchestration coverage proving a
failed promoted-runtime check preserves the root cause, rolls back, and blocks
all later recovery steps.

**Deployment:** source and CI candidate only. No GPO, NETLOGON, package
activation, or fleet rollout change.

---

## 2026-06-26 — Command Center: komanda "self_update" (backend + frontend)

**Qëllimi:** Të mund të dërgohet nga Command Center komanda `self_update`
që e bën agjentin v2.1.0 (i mbështetur te `agent/update.go`) të shkarkojë
dhe instalojë vetë versionin aktiv, pa operatorin ta shkruajë me dorë
URL-në/version-in/sha256-in.

### Backend
**Skedarë:** `backend/app/schemas/agent_command.py`,
`backend/app/schemas/remote_action.py`, `backend/app/services/agent_command_service.py`

1. `"self_update"` shtohet te `BULK_COMMAND_TYPES` dhe te
   `ADMIN_ONLY_COMMAND_TYPES` (kërkon admin/owner — si `reboot_pc`/`run_powershell`,
   pasi prek binarin e agjentit).
2. `ActionType.SELF_UPDATE` shtohet te enum-i (për konsistencë me
   sistemin e single-device actions), me label "Self Update Agent" dhe
   konflikt-grup me `RESTART_AGENT`/`IMMEDIATE_HEARTBEAT` (që të dy
   rinisin agjentin).
3. **`AgentCommandService._build_self_update_payload()`** (e re): kur
   `command_type == "self_update"`, payload-i i klientit injorohet
   plotësisht — backend merr paketën aktive nga `AgentPackageService
   .latest_active("windows-amd64")` dhe ndërton:
   `{"download_url": f"{PUBLIC_BACKEND_URL}{latest_download_url(...)}",
   "version": pkg.version, "sha256": pkg.sha256}`. Operatori nuk e shkruan
   kurrë me dorë. Nëse nuk ka paketë aktive → `ValueError` → HTTP 400.

**Validim:** 324 teste backend (1 dështim para-ekzistues i paalidhur,
`test_legacy_compat`, i konfirmuar edhe pa ndryshimet tona). `curl -X POST
/api/v1/commands/bulk` lokal me `command_type=self_update` → payload i
ruajtur në DB përputhet ekzakt me paketën aktive (2.1.0,
sha256 `cd7a6d3d...`).

**Deploy:** push → `git pull` + `docker compose build backend && up -d
backend` te `techi-server` (`/opt/techi/techi-platform`). Kontejneri healthy.

### Frontend
**Skedarë:** `frontend/src/api/agentCommands.ts`,
`frontend/src/components/AgentCommandsPanel.tsx`

1. `"self_update"` shtohet te `BulkCommandType`, `BULK_COMMAND_LABELS`
   ("Përditëso Agjentin"), `BULK_COMMAND_TYPES`, kategoria "Agent" te
   `BULK_COMMAND_CATEGORIES`, `BULK_COMMAND_DESCRIPTIONS`,
   `DESTRUCTIVE_BULK_COMMANDS` (hap modalin Faza B), dhe
   `ADMIN_ONLY_BULK_COMMANDS` (mirror i backend-it — komanda fshihet
   automatikisht te dropdown për jo-admin).
2. Modali i konfirmimit (`ConfirmModal`) për `self_update`: titull
   "Përditëso Agjentin", kuti paralajmërimi e kuqe ("Agjenti do të
   riniset gjatë instalimit. PC mund të dalë offline përkohësisht (~2
   minuta)."), kuti info "Version aktual → X.X.X" + "SHA256 → 8
   karaktere të para" (lazy-fetch nga `getAgentPackages()`, vetëm kur
   komanda është e zgjedhur), buton "Konfirmo përditësimin" (në vend
   të "Konfirmo dërgimin" gjenerik). Kutia e madhe "All devices" mbetet
   trajtimi ekzistues i përbashkët, automatikisht i vlefshëm.
3. `handleSend`, `sendBulkCommand`, `buildPayload` — **të paprekura**;
   `self_update` nuk ka fusha payload (backend e mbush vetë), `PayloadEditor`
   shfaq vetëm një `InfoNote` shpjeguese.
4. Timeout default 180s (si `reboot_pc`, pasi shkarkim+instalim+rinisje
   zgjat më shumë se komandat e thjeshta).

**Validim:** `tsc --noEmit` pa gabime. Playwright lokal (backend lokal
SQLite + paketë test 2.1.0): komanda shfaqet te dropdown te kategoria
"Agent", klikimi "Send" hap modalin me titull/paralajmërim/version/sha256
korrekte, "Konfirmo përditësimin" dërgon batch-in (DB konfirmon payload
ekzakt me `download_url`/`version`/`sha256`), veprimi shfaqet te Command
History.

**Kufizime respektuara:** `self_update` nuk prek TECHI Remote Support.exe
(payload-i prek vetëm agjentin); testuar fillimisht vetëm me
`device_ids` specifik, jo `target=all`; heartbeat/enrollment/komanda
ekzistuese të paprekura.

**Deploy:** push → `git pull` + `docker compose build frontend && up -d
frontend` te `techi-server`. Kontejneri healthy.

---

## 2026-06-26 — Devices: kolonë "Agent" me badge versioni + filtër i shpejtë

**Skedar:** `frontend/src/components/DevicesTable.tsx`

**Qëllimi:** Të shihet menjëherë versioni i agjentit për çdo PC te lista
`/devices`, pa hyrë në detajet e device-it.

**Ndryshime:**
1. Kolona "Agent" (mes "OS" dhe "Last Seen", ekzistonte pjesërisht) tani
   përdor saktësisht ngjyrat e specifikuara: badge jeshil `#22c55e/20`
   kur `device.agent_version` përputhet me `active_agent_version` nga
   fleet overview, badge portokalli `#f97316/20` kur është i ndryshëm/i
   vjetër, dhe badge gri (jo më tekst i thjeshtë) me "—" kur
   `agent_version` është null/bosh.
2. Dropdown i ri "Agent version" te rreshti i filtrave (krahas Status /
   Health / Lifecycle / Signals): "All versions" + çdo version distinkt
   i pranishëm te devices (p.sh. "2.1.0", "2.0.0") + "Unknown". Filtron
   `displayDevices` lokalisht (state i ri `agentVersionFilter`, brenda
   komponentit) — **nuk kryen fetch të ri** drejt backend-it.
3. Paneli "Device Groups" (`DeviceTree.tsx`) është thjesht pemë
   client/grup me numërues, jo lista e device-ve individuale — nuk ka
   rresht "emër device-i" ku të vendosej badge, kështu që ndryshimi
   mbetet vetëm te lista e plotë `/devices`, sipas rrugës alternative
   të kërkuar.
4. Logjika e heartbeat/enrollment/komandave nuk u prek.

**Validim (lokal, Playwright + backend lokal me SQLite):**
- Dropdown gjeneron saktë `["All versions","2.1.0","2.0.0","Unknown"]`
  nga 4 devices testues (1 me `2.1.0`, 1 me `2.0.0`, 2 me `agent_version`
  null).
- Badge-et e tabelës: jeshil për `2.1.0` (= active), portokalli për
  `2.0.0`, gri "—" për null — verifikuar me screenshot.
- Ndërrimi i filtrit nuk gjeneron asnjë XHR/fetch të ri (Network tab —
  0 requests të reja për secilin ndryshim filtri).
- `npx tsc --noEmit` pa gabime.

**Deploy:** frontend-only, pas konfirmimit të userit.

---

## 2026-06-26 — techi-deploy.cmd: fix bug kritik — service fshihej para verifikimit të MSI

**Skedar:** `backend/app/services/enrollment_bootstrap_service.py`
(gjeneron `techi-deploy.cmd` te NETLOGON brenda PowerShell here-string-it).

**Bug i konfirmuar live:** te `:do_install` (rrugë e përbashkët për instalim
të freskët **dhe** për `:do_reinstall_lan`), `sc.exe delete TechiAgent`
ekzekutohej **para** se script-i të verifikonte nëse `%NETLOGON_MSI%`
ekziston në të vërtetë. Nëse MSI-ja mungonte nga NETLOGON (version i
fshirë/i papërditësuar), `msiexec` dështonte, rruga e fallback-ut
(`:manual_replace_lan`) dështonte gjithashtu (MSI nuk ekziston për ta
ekstraktuar), dhe `:install_failed` thërriste `net start TechiAgent` mbi
një service që **tashmë ishte fshirë** — PC mbetej përgjithmonë pa
TechiAgent të instaluar, edhe pse versioni i mëparshëm po punonte.

**Fix:**
1. Shtohet kontroll `if not exist "%NETLOGON_MSI%"` **para** rreshtit
   `sc.exe stop TechiAgent` te `:do_install` — nëse MSI mungon, loget
   `result=msi-not-found-abort` dhe kërcen te `:ensure_service_running`
   pa prekur service-in ekzistues.
2. Label i ri `:ensure_service_running` (para `:install_done`) — rikrijon
   service-in TechiAgent (`sc.exe create` + `description` + `failure`
   restart policy, si te `:manual_replace_lan`) **vetëm nëse** nuk
   ekziston më, pastaj `net start`. Kjo garanton që asnjë rrugë e re
   dështimi nuk e lë PC-në pa service, qoftë instalim i freskët apo
   reinstall.

**Validim:** `pytest backend/tests/test_enrollment_bootstrap_script.py
backend/tests/test_enrollment_token_workflow.py` — **101 + 5 = 106 teste
PASS** (asnjë test ekzistues prekur, vetëm shtim rreshtash në script).

**Deploy:** direkt në `stable/phase-2-heartbeat` pas testeve.

---

## 2026-06-24 — Command Center /agent-config: Faza B — gate konfirmimi para dërgimit

**Skedarë:**
- `frontend/src/api/agentCommands.ts`
- `frontend/src/components/AgentCommandsPanel.tsx`

**Qëllimi:** Shtresë sigurie UI para se Command Center të dërgojë komanda që
ekzekutohen si SYSTEM te ~605 PC. **`handleSend`, `sendBulkCommand`,
`buildPayload`, `startPolling`, `getBatchProgress`, çdo endpoint dhe çdo
komandë mbetën plotësisht të paprekura** — modal-i ndërhyn vetëm mes klikut
"Send" dhe thirrjes ekzistuese `handleSend()`.

**Ndryshime:**
1. **Lista e komandave "të rrezikshme" u zgjerua** (`DESTRUCTIVE_BULK_COMMANDS`,
   vetëm klasifikim UI — vendos kur hapet `ConfirmModal`, jo logjikë dërgimi):
   historical note: `set_remote_password` was added here but is now retired; `restart_rustdesk` and `change_heartbeat_interval` remain
   pranë 4 ekzistuesve (`restart_device`, `restart_agent`, `reboot_pc`,
   `run_powershell`) → 7 gjithsej. `ping`, `collect_inventory`, `sync_rustdesk`,
   `register_protocol` dërgohen direkt, pa modal, si më parë.
2. **Numër pajisjesh real PARA dërgimit** — `deviceCount` te `AgentCommandsPanel.tsx`
   nuk vjen më nga `activeBatch?.total` (që ishte `null` në dërgimin e parë,
   para çdo batch-i), por nga `fleetOverview` (AppDataContext, **zero fetch i
   ri**): `stats.total` për "All devices", `agents_outdated` për "Devices
   needing agent update", `tree_counts.by_client[clientId]` për "By client",
   numërim i ID-ve të parsuara për "Specific device IDs". "By group" mbetet
   `null` (s'ka count të para-llogaritur client-side pa endpoint të ri — jashtë
   scope).
3. **Theksim vizual "All devices" + komandë e rrezikshme** — `ConfirmModal`
   merr prop të ri `target`; kur `target === "all"`, bordura bëhet e kuqe
   (2px) dhe shfaqet banner i dedikuar me numrin e madh + "Kjo do dërgohet te
   të gjitha pajisjet".
4. **Script preview për `run_powershell`** — `ConfirmModal` merr prop të ri
   `scriptPreview` (= `payload["script"]`), shfaqur read-only në `<pre>`
   scroll-ueshëm brenda modal-it, përpara konfirmimit.
5. **Butona të riemërtuar**: "Send command" → **"Konfirmo dërgimin"**,
   "Cancel" → **"Anulo"**.
6. **Mbyllje universale me Escape** — `ConfirmModal` tani ka `window`
   keydown-listener (si `OutputModal` i Faza A.1), në vend të vetëm
   `onKeyDown` te input-i i step 2 (që s'funksiononte në step 1 ose pa focus).

**Bug-fix sigurie i zbuluar gjatë punës (jashtë kërkesës fillestare, por brenda
frymës "Faza B"):** te konfirmimi 2-hapësh i `reboot_pc`, nëse `deviceCount`
ishte `null` (numër i panjohur), fusha "shkruaj numrin" me input bosh **e
kalonte automatikisht kontrollin** (`"" === ""`). Tani `canConfirm` kërkon
domosdoshmërisht një numër real (`expectedText !== ""`) përpara se input-i i
përdoruesit të mund të përputhet.

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy ende —
verifikim manual te `/agent-config` (provo `reboot_pc`/`run_powershell` me
target "All devices" dhe me një klient specifik) mbetet për review.

---

## 2026-06-24 — Command Center /agent-config: Faza A.1 — progress bar live + full output modal

**Skedar:** `frontend/src/components/AgentCommandsPanel.tsx` (vetëm frontend, asnjë ndryshim backend/agjent).

**Qëllimi:** Vizualizim mbi të dhëna që tashmë vinin nga API (diagnoza e
konfirmoi: `/commands/{batch_id}/progress` poll-ohet çdo 3s dhe rikthen
`completed/failed/total/percent` live; `action.output`/`error` përmbajnë
PowerShell stdout/stderr të plotë, vetëm UI i fshihte pas tooltip 160px).
**`getBatchProgress`, `startPolling`, `POLL_INTERVAL`, `sendBulkCommand`, dhe
çdo endpoint/komandë mbetën plotësisht të paprekura.**

**Ndryshime:**
1. **Progress bar me tekst live** — nën `<ProgressBar>`, shtohet rresht i ri
   `"X/Y completed · Z failed · W timeout"` (krahas `percent%`), llogaritur
   direkt nga fushat ekzistuese të `activeBatch` (`completed/failed/timeout/total`),
   përditësohet automatikisht me çdo poll 3s ekzistues.
2. **Status final i diferencuar** kur `finished===true` — `batchOverallStatus()`
   (helper ekzistues, përdorur tashmë te tabela e History) u **gjeneralizua në
   tip** (`{finished, failed, timeout}` në vend të `BatchSummary` specifik) që
   të ripërdoret edhe për `activeBatch` (`BatchProgressResponse`) — sjellja për
   History mbetet identike. "Batch complete" tani bëhet "Batch complete" (gjelbër)
   / "Batch failed (n)" (kuq) / "Batch timeout (n)" (gri), në vend të një teksti
   të vetëm gjithmonë gjelbër.
3. **Modal "view full output"** (`OutputModal`, i ri, pranë `ConfirmModal`) —
   te per-device list, output/error i shkurtuar (160px) tani është buton me
   ikonë `Eye`; klikimi hap modal me `<pre>` monospace + scroll, stdout dhe
   stderr ndarë qartë (jo më i prerë te 160px/tooltip). Mbyllet me X, klik
   jashtë, **ose Escape** (`keydown` listener, hequr në cleanup).

**Validim:** `npx tsc --noEmit` kalon pa gabime. Pa build/deploy ende —
verifikim manual te `/agent-config` (dërgo `run_powershell`, p.sh. `ipconfig`,
kontrollo progress bar live + modal output) mbetet për review.

---

## 2026-06-24 — Command Center /agent-config: Ridizajn Faza A (strukturë + grupim, pa logjikë)

**Skedarë:**
- `frontend/src/api/agentCommands.ts`
- `frontend/src/components/AgentCommandsPanel.tsx`
- `frontend/src/pages/AgentConfig.tsx`
- `backend/app/schemas/agent_command.py`
- `backend/app/services/agent_command_service.py`

**Qëllimi:** Ridizajn vizual i Command Center te `/agent-config` (Faza A) —
grupim i komandave, përshkrime, Command History i dukshëm by-default, layout
2-kolonësh. **Logjika e dërgimit të komandave (endpoint, payload, target,
konfirmimet ekzistuese) mbeti plotësisht e paprekur.**

**Ndryshime:**
1. **Grupim vizual i 11 komandave** (`BULK_COMMAND_CATEGORIES` te `agentCommands.ts`)
   në 4 kategori, render-uar si `<optgroup>` te `<select>` ekzistues (vlerat/
   `value=` identike me ato ekzistuese):
   - Diagnostikë: `ping`, `collect_inventory`
   - Agent: `restart_agent`, `change_heartbeat_interval`, `run_powershell`
   - Pajisje: `reboot_pc`, `restart_device`
   - RustDesk / Remote: `sync_rustdesk`, `restart_rustdesk`, `register_protocol` (`set_remote_password` retired)
2. **Përshkrim 1-rresht për çdo komandë** (`BULK_COMMAND_DESCRIPTIONS`,
   anglisht për tani) — shfaqet nën select-in e Command-it, sipas komandës
   aktualisht të zgjedhur.
3. **Command History i dukshëm by-default** — hiqet accordion-i i mbyllur
   (`historyOpen`, `ChevronDown`/`ChevronUp`); ngarkohet automatikisht në mount
   (i njëjti `getCommandHistory(20)` ekzistues, vetëm thirrur më herët, pa
   polling të ri). Riorganizohet si tabelë: Time, Command, Target, Status, By.
   - Kolona "Status" vjen nga `batchOverallStatus()` — derivim UI i ri, vetëm
     nga fushat ekzistuese `finished/failed/timeout` (Running / Completed /
     Failed (n) / Timeout (n)), pa logjikë biznesi të re.
   - Kolona "By" vjen nga `created_by_name` (shih ndryshimin backend poshtë).
4. **Layout 2-kolonësh** (`grid xl:grid-cols-2`): majtas Send Command + Active
   Batch (e pandryshuar), djathtas Command History (tabela e re).
5. **Gjerësia e faqes** (`AgentConfig.tsx`): containeri kryesor `max-w-2xl` →
   `max-w-6xl`; Header/Agent notice/Heartbeat Policy/Rollout Scripts u
   mbështjellën në një `<div className="mx-auto max-w-2xl">` të brendshëm —
   **përmbajtja e tyre mbetet 100% e pandryshuar**, vetëm Command Center
   përdor gjerësinë e re.

**Backend (minimal, read-only, vetëm history — jo endpoint-i i dërgimit):**
- `backend/app/schemas/agent_command.py`: shtohet `created_by_name: Optional[str]`
  te `BatchSummary`.
- `backend/app/services/agent_command_service.py`: te `get_history()`, bashkon
  `operators` për `batch.created_by` (FK ekzistuese në `agent_command_batches`,
  s'ishte e ekspozuar më parë) → `display_name or username`. **`create_bulk()`
  (endpoint-i `/api/v1/commands/bulk`, dërgimi real i komandave) NUK u prek.**

**Jashtë scope (qëllimisht, Faza B):** asnjë konfirmim i ri për komanda të
rrezikshme, asnjë ndryshim te Heartbeat Policy/Rollout Scripts, asnjë ndryshim
te endpoint/payload/target i dërgimit.

**Validim:** `npx tsc --noEmit` kalon pa gabime; `python3 -m py_compile`
(ast parse) OK për 2 skedarët backend. Pa build/deploy ende në këtë hap —
verifikim manual te `/agent-config` mbetet për review.

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
