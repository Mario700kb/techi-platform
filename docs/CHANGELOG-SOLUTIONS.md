# TECHI Platform Changes and Solutions

> **IMPORTANT**
> Ky dokument përmban vetëm HISTORINË e projektit.
> Për gjendjen aktuale lexoni vetëm: [docs/PROJECT_STATE.md](PROJECT_STATE.md).
> Mos vendosni gjendjen aktuale këtu.

**This file is the project's HISTORY — and only the history.** Every bug,
incident, deploy, optimization, migration, technical decision, hotfix,
analysis, root cause, and workaround is recorded here, newest first. The
CURRENT state of the project lives exclusively in
[PROJECT_STATE.md](PROJECT_STATE.md) — never describe current state here, and
never record history there.

**Entry format for new entries** (use the sections that apply):

```markdown
## [YYYY-MM-DD] <title>
### Problemi     — what was wrong / what was needed
### Analiza      — what was investigated, with evidence
### Shkaku       — root cause
### Zgjidhja     — the decision/fix taken
### Ndryshimet   — files/config/infra changed
### Rezultati    — verified outcome
### Mësimet      — lessons / gotchas for the future
```

Older entries predate this template; they remain valid as written.

## [2026-07-08] Hardening: Deployment Contract Verification (contract tests + preflight + smoke)

### Problemi

Pas regresionit të katalogut (shërbimi forward-oi një param që repository s'e
kishte), duhej një mekanizëm permanent që kap mismatch-et service↔repository
PARA deploy-it, dhe një smoke pas deploy-it.

### Zgjidhja

- **Contract tests** (`tests/test_service_repository_contracts.py`): dy shtresa —
  (1) signature contract (DB-free): kwargs që shërbimi forward-on ⊆ params që
  repository pranon (kap ekzaktësisht regresionin `category`); (2) end-to-end:
  çdo shërbim publik instancohet dhe metoda read ekzekutohet deri në SQL.
  Mbulon DeviceService, DeviceOverviewService, VaultService,
  EnrollmentTokenService, TerminalService, ConnectService, AgentPackageService,
  RemoteActionService. Plus `test_device_service_filter_contract.py`.
- **`scripts/preflight.sh`** (gate para push/deploy): contract tests (zero
  tolerancë) + suita e plotë flags OFF & ON (pa dështime të reja mbi baseline
  4) + tsc + frontend build + agent go build/test. Del non-zero në çdo dështim.
  Detekton edhe collection errors dhe "collected no tests" (një version i parë
  kishte false-pass kur pytest gabonte importin — u rregullua me `cd backend` +
  numërim passed/failed/errors).
- **`scripts/smoke.sh`** (pas deploy-it): `/health`, `/api/v1/devices/`,
  `/platform/features`, `/auth/me`, `/devices/overview`, `/enrollment-tokens`,
  `/agent-packages`. 500 kudo = deployment FAILED.
- Milestone permanent "Deployment Contract Verification" te IMPLEMENTATION-
  ROADMAP.md; hapi 0 i Deploy Process te PROJECT_STATE.

### Rezultati

`preflight.sh`: **13 contract passed** + suita 457 passed + 4 të njohura (flags
OFF & ON) + tsc + build + agent — **PASSED**. Provuar që gate-i punon: kapi një
flakiness izolimi (overview cache modul-nivel) gjatë ndërtimit dhe u rregullua.
`smoke.sh` kundër prodhimit: 7/7 endpoints OK (health 200, të tjerat 401, zero
500). Të dy skriptet dalin non-zero në dështim → ndalojnë deploy-in/e shënojnë
FAILED.

### Mësimet

Testet duhet të ekzekutojnë kontratën publike (shërbimin), jo vetëm repository-n.
Një gate deploy-i që parse-on output pytest duhet të kontrollojë passed>0 +
errors==0 + failed≤baseline (përndryshe një import error jep false-pass).

## [2026-07-08] INCIDENT: Device Catalog 500 — commit i paplotë hoqi `category` nga repository

### Problemi

Device Catalog nuk ngarkohej: "Unable to load devices / Failed to fetch". Çdo
`GET /api/v1/devices/` kthente 500. Release blocker — path-i SACRED i katalogut
Windows i prishur pa kushte (pavarësisht flags).

### Analiza (frontend → API → endpoint → service → repository → SQL)

Logu i backend-it dha shkakun ekzakt:
```
File "/app/app/services/device_service.py", line 68, in get_devices
    devices = self.repository.get_multi(
TypeError: DeviceRepository.get_multi() got an unexpected keyword argument 'category'
```
`git status`: `device_repository.py` i modifikuar por **i pa-commit-uar** (5
referenca `category` në working tree, 0 në HEAD). `device_service.py` (që i
kalon `category=category`) ishte commit-uar dhe deployuar; `device_repository.py`
(që e pranon) JO. "Failed to fetch" në browser = 500-i pa header-at e duhur në
rrugën e gabimit.

### Shkaku

Commit-i **`c042724`** ("feat: tree Network/Storage/Hypervisor folders +
ConnectMenu", Phase 7 M3-M4) përfshiu `device_service.py` (forward i `category`)
por harroi `git add backend/app/repositories/device_repository.py`. Testet
lokale kaluan sepse working tree e kishte fix-in; prodhimi mori vetëm gjysmën.

### Zgjidhja

Commit i ndryshimit të tashmë-shkruar te repository (`_apply_category_filter` +
parametri `category` te `get_multi`/`count`) — pa ndryshim sjelljeje, vetëm
plotëson kontratën service→repository. Fajl: `device_repository.py` (+22),
`tests/test_device_service_filter_contract.py` (i ri).

### Rezultati

Deploy prod tip `2dae09a` (vetëm backend). health 200; `/api/v1/devices/` → 401
(auth), JO 500; 0 `get_multi` TypeErrors; 0 gabime reale. Validim end-to-end
kundër DB-së reale në kontejner: `DeviceService.get_devices(limit=20)` → 20
rreshta, total 723 pajisje, windows 723, network 0. **Katalogu i rikthyer.**

### Testet e regresionit

`test_device_service_filter_contract.py` ekzekuton **shërbimin** (jo repository-n
drejtpërdrejt) me të gjithë `filter_kwargs` e endpoint-it (incl. platform+
category) — **verifikuar që DËSHTON kundër repository-t të deployuar (të prishur)
me TypeError-in ekzakt të prodhimit** (via git stash), dhe kalon me fix-in. Ky
lloc mismatch (shërbimi forward-on një kwarg që repository s'e ka) tani kapet.

### Mësimet

`git add` selektiv për ndryshime multi-file është i rrezikshëm — një commit që
prek service+repository duhet t'i përfshijë të dyja. Testet duhet të ekzekutojnë
**shërbimin** (kontrata publike), jo vetëm repository-n, që mismatch-et
service→repository të kapen para deploy-it. Deploy-i i backend-it duhet të bëjë
një smoke të `/devices/` me auth (jo vetëm `/health`).

## [2026-07-08] Platform Expansion Phase 7 — MikroTik Proxy Adapter + Connect Framework (DARK)

### Problemi

Të provohet se Platform Expansion mbështet platformat pa-agent me të njëjtën
arkitekturë: Linux = platforma e parë native, MikroTik = e para proxy-managed.
Të ndërtohet **Connect Framework** gjenerik (metadata capability-driven), pa
launchers, pa RouterOS API/SSH/credentials (ato janë faza tjetër). Flag OFF =
identik.

### Zgjidhja (deploy prod tip `7df3cba`, të gjitha flags OFF)

- **Connect Framework** (`platform_core/connect.py`): metadata e strukturuar
  `ConnectMethod` (id, label, surface desktop/browser, capability, priority,
  scheme) per platformë; `methods_for(device)` = metoda native (capability
  None) + gjenerike ku pajisja raporton capability-n. **SSH/Web Terminal
  varen nga capability `terminal`** → SSH gjenerik, jo Linux-only; Winbox/
  WebFig/DSM/QTS/vSphere janë thjesht metoda native, jo feature speciale.
  `GET /devices/{id}/connect-methods` (gated CORE→404) ndërton dropdown-in
  dinamikisht. Frontend `ConnectMenu` — dropdown 100% nga metadata; launcher-at
  vijnë fazën tjetër (klikimi shfaq metadata, jo veprim fiktiv). 10 teste.
- **MikroTik proxy adapter** (`platform_adapters/mikrotik.py`, `is_proxy=True`)
  i regjistruar — provon kontratën adapter platform-neutrale (pa RouterOS API).
- **Auto-classification**: `_tree_category_case` klasifikon platformat pa-agent
  me platform-class FIRST (network/storage/hypervisors); platformat agent mbajnë
  logjikën referencë servers/clientpc. Filtër i ri aditiv `category`
  (network/storage/hypervisors). Tree: foldera Network/Storage/Hypervisors +
  nën-foldera platforme, shfaqen vetëm kur kanë pajisje → flag-off tree identik.
  Vendosje automatike (MikroTik→Network→MikroTik), zero lëvizje manuale.

### Rezultati

Suita backend **444 passed + 4 të njohura, flag OFF DHE ON**; agent 4 targetet;
tsc + build clean. Deploy: health 200, frontend 200, connect-methods 401 pa
auth (404 me auth+flag off), FEATURE_MIKROTIK+CORE False, adapter i ngarkuar,
0 gabime reale, 131 hb/min. Sjellja e prodhimit e paprekur.

### Objektivi arkitekturor — arritur

Shtimi i një platforme të re tani kërkon VETËM: (1) Platform Adapter, (2)
Capability Mapping, (3) Platform Icon, (4) Connect Methods (rreshta te
`connect.py` + `_platform_class_case`). PA ndryshim te Device Tree/Catalog/
Drawer/Command Center/Navigation. Synology/QNAP/VMware/Proxmox/Hyper-V tashmë
kanë connect-methods të deklaruara + klasifikim; u mbetet vetëm adapter-i.

### Boundary — çfarë NUK u implementua (faza tjetër)

Winbox/WebFig launcher, RouterOS API, SSH, credential management, terminal
integration. Phase 7 ndërtoi vetëm framework-un ku këto plug-in pa ridizajn.

## [2026-07-08] Platform Expansion Phase 5 — Web Terminal (implementim DARK, pa NPM, pa flag)

### Problemi

Të ndërtohet i gjithë Web Terminal-i pas `FEATURE_TERMINAL` (OFF), pa prekur
NPM, pa ekspozuar rrugë publike, pa canary. Arkitekturë platform-independent:
Linux i pari, platformat e ardhshme ripërdorin të njëjtën. Flow: Browser →
Backend → Agent WS → PTY → Shell.

### Zgjidhja (5 milestone, prod tip `991ae07`, FEATURE_TERMINAL OFF)

- **M1 backend model+service**: `TerminalSession` (tabelë e izoluar) +
  `TerminalService` (create→attach→active→close/expire) me dy tickets një-
  përdorimshe të hash-uara (operator+agent, side-specific, TTL 60s), idle/max
  caps, `recording_path` i përgatitur por i papërdorur. 6 teste.
- **M2 backend endpoint+relay**: `POST /devices/{id}/terminal/sessions` (admin+,
  gated → 404; kontrollon capability `terminal`; krijon sesion; radhit
  `open_terminal` remote action; audit; kthen operator WS path + ticket).
  `TerminalRelay` in-memory çift operator↔agent; rrugët WS `/ws/terminal/{id}`
  + `/ws/agent/terminal/{id}` (accept+close 4003 kur flag off). 4 teste.
- **M3 agent (Linux)**: dispatch `open_terminal` → `handleOpenTerminal` dial WS
  (gorilla/websocket) + PTY (creack/pty) bash/sh, relay binar + resize + cap 60
  min. Goroutine e izoluar — s'prek heartbeat/enrollment/inventory/update/
  RustDesk. Deps importohen vetëm në files linux → Windows/darwin të paprekur.
  Windows/other stub. 4 targetet ndërtohen.
- **M4 frontend**: `DeviceTerminal` (xterm.js + fit, lazy) — session→operator WS
  →relay+resize. Tab "Terminal" te Drawer VETËM kur FEATURE_TERMINAL on DHE
  pajisja raporton capability `terminal`. xterm në chunk të veçantë (293KB, jo
  në main path). Windows s'ka terminal cap → tab s'shfaqet → drawer identik.

### Siguria

Sesione: authenticated (JWT admin+), authorized (device scope), audited,
time-limited (TTL 60s ticket, cap 60 min, idle 15 min), tickets një-përdorimshe
side-specific të hash-uara, zero sekret në browser. E ndarë nga Remote Support
(RustDesk). E gatshme për integrim me Vault (SSH-mode i ardhshëm).

### Rezultati

Suita backend **434 passed + 4 të njohura, flag OFF DHE ON**; agent 4 targetet +
go test green; tsc + build clean (xterm code-split). SQL `terminal_sessions`
aplikuar schema-first. Deploy: health 200, frontend 200, terminal endpoint 401
pa auth (i mbrojtur; 404 me auth + flag off), **FEATURE_TERMINAL False**, 0
gabime reale, 142 hb/min. Sjellja e prodhimit e paprekur.

### STOP — mbeten VETËM (Manual Approval)

(1) shtimi i rrugës WS në NPM (`/ws/terminal/*`, `/ws/agent/terminal/*`),
(2) ndezja e `FEATURE_TERMINAL` për canary. Të dyja presin aprovimin eksplicit
të owner-it — NUK u prekën.

### Mësimet

Sinjali "hap terminal" ripërdor rrugën ekzistuese `pending_actions` (pa lidhje
persistente të re per-pajisje) → latencë deri në një heartbeat (250s) për të
nisur; e pranueshme dark, por para canary-t vlen një sinjal më i shpejtë ose
interval më i ulët për pajisjet me terminal aktiv. Relay-i in-memory është
per-worker — nëse terminali ndizet në shkallë të gjerë, ky komponent lëviz
out-of-process (audit R5), pa ndryshuar protokollin.

## [2026-07-07] Platform Expansion Phase 3 (pjesa 2, PËRFUNDIM) — tree auto-classification + Command Center engine

### Problemi

Të përfundohet Faza 3: (1) Device Tree me sub-foldera platforme me **klasifikim
automatik** (asnjë vendosje manuale), (2) Command Center i vetëm me **engine
automatik** (Windows→PowerShell, Linux→Bash). Flag OFF = identik.

### Zgjidhja (deploy prod tip `dfd601b`)

**Tree auto-classification (3e):**
- Backend: `_platform_class_case()` — klasifikim i centralizuar platforme (NULL⇒
  windows, audit §8) + `count_by_client_category_platform()` — agregim i veçantë
  i lehtë GROUP BY, që **NUK prek** path-in e nxehtë 2-query të overview-t.
  `DeviceTreeCounts.by_client_category_platform` llogaritet **vetëm kur
  FEATURE_LINUX on** → overview mbetet 2 query në prodhimin e sotëm (testi ende
  `==2`, i fiksuar në flag-off).
- Frontend: DeviceTree rendon sub-foldera platforme (PlatformIcon) nën Servers/
  Client PC kur `showPlatformFolders`; Devices mapon `client-N-servers-linux` →
  filtër device_type+platform. Klasifikim automatik nga OS/device_type — asnjë
  lëvizje manuale. Flag off ⇒ tree identik (backend kthen {}).

**Command Center engine (3c):**
- Agent: dispatch case i ri `run_command` + `handleRunCommand` (Linux real:
  bash/sh/busybox/python3 via runLinuxCommand; Windows/other stub — Windows
  përdor run_powershell, s'merr kurrë run_command). Ndërton të 4 targetet.
- Backend: `run_command` në BULK_COMMAND_TYPES + ADMIN_ONLY; payload
  {command,engine} kalon si pending action (pa ndryshim shërbimi).
- Frontend: command type `run_command` + PayloadEditor (engine select + script),
  i dukshëm **vetëm kur FEATURE_LINUX on** → Command Center flag-off identik.

### Rezultati

Suita backend **424 passed + 4 të njohura, flag off DHE on** (testet e
invariantit 2-query të overview-t fiksuar në flag-off). Agent: 4 targetet
ndërtohen, go test green. tsc + build clean. Deploy: health 200, frontend 200,
0 gabime reale; heartbeats ~98/min (400 pajisje aktive @ 250s — konsistente),
FEATURE_LINUX False verifikuar. **Faza 3 e plotë.**

### Shtimi i një platforme të ardhshme kërkon tani vetëm

(1) një degë te `_platform_class_case`, (2) një adapter backend + capability
mapping, (3) një etiketë + hyrje te `PlatformIcon`. Asnjë ridizajn UI.

### Mësimet

Invariantet e performancës (overview 2-query) shprehen si garanci flag-OFF:
puna e re shtesë gate-ohet nga flag-u, dhe testet fiksohen në flag-off që të
dokumentojnë prodhimin e sotëm pa u prishur nga env-i.

## [2026-07-07] Platform Expansion Phase 3 (pjesa 1) — UI Linux native (flag-gated)

### Problemi

Të bëhet Linux "native" në Desktop UI ekzistuese, pa ridizajn, pa faqe të reja,
me flag OFF = UI identik me sot. Çdo komponent duhet të mbështesë platformat e
ardhshme pa ridizajn.

### Zgjidhja (deploy prod tip `5212753`, të gjitha pas FEATURE_LINUX OFF)

- **PlatformIcon** (`components/PlatformIcon.tsx`): burim i vetëm ikonash
  (Windows/Linux/MikroTik/generic, SVG inline). Në katalog para emrit, vetëm kur
  FEATURE_LINUX on; flag off → markup origjinal verbatim.
- **Packages**: toggle Windows|Linux (vetëm flag on) → `LinuxPackagesPanel`
  (upload/list/activate/delete `agent_binary` per arch: amd64/arm64/armhf).
  Windows scope i paprekur. Backend enum + arch të reja; të ardhmet = config.
- **Enrollment**: opsioni Linux gjeneron one-liner-in real
  `curl … /api/v1/install/linux?token=… | sudo bash` (flag on); flag off → script
  legacy.
- **Device Drawer**: Overview shton Kernel, Architecture dhe rreshtin
  Capabilities (chips) — të dhëna reale nga agjenti, vetëm flag on + kur pajisja
  raporton; Windows kurrë s'raporton → drawer Windows identik. Backend Device
  schema kthen `capabilities`.
- **Platform filter** (themel): devices list/count + repository marrin filtër
  opsional `platform` (`_apply_platform_filter`); "windows" përfshin edhe
  rreshtat legacy me platform NULL (audit §8). Aditiv/inert kur i pasetuar.

### Rezultati

Suita backend 422 passed + 4 të njohura (flag off **dhe** on); tsc + build
clean. Deploy: health 200, frontend 200, `/api/v1/devices?platform=linux` → 401
(auth, filtri i lidhur), 186 hb/min, 0 gabime reale. Flags OFF → UI identik.

### Mbetet për Fazën 3 (pjesa 2)

(1) **Device Tree platform sub-folders** — kërkon zgjerim të agregimit
`get_overview_inputs` (GROUP BY + platform) në një path të nxehtë + trajtim
key-i te Devices.tsx; u shty për të mos rrezikuar navigimin SACRED Windows pa
verifikim vizual. Themeli (filtri platform) është gati.
(2) **Command Center platform-aware execution** — kërkon një action type të ri
`run_command` (engine bash/sh/python) end-to-end agent+backend+frontend.

### Mësimet

Tree merr `tableDevices` (faqja aktuale, jo flota) → numëratorët e sub-folderave
duhen nga backend, jo client-side. Çdo sipërfaqe e re UI u ndërtua flag-gated me
degë të veçantë "windows" të pandryshuar.

## [2026-07-07] Platform Expansion Phase 2 — Linux Agent MVP (flag-gated, Windows bit-identik në sjellje)

### Problemi

Agjenti i parë native jo-Windows: enroll → heartbeat → inventory → actions →
self-update → systemd, me të njëjtën kontratë si Windows, pa prekur sjelljen
Windows. Autorizuar pas shpalljes zyrtare të owner-it që rollout-i 2.1.5 është
i mbyllur.

### Analiza / Zgjidhja (7 milestone, commits të vegjël)

Ndarja ekzistuese build-tag (`_windows.go`/`_other.go`) u formalizua në një
kontratë PAL të dokumentuar (`agent/pal.go`: `Platform` me `Capabilities()` +
`ExtraInventory()`). Windows-i implementon kontratën me kthime bosh → payload-i
i heartbeat-it byte-identik (të gjitha fushat e reja `omitempty`); Linux-i
raporton realisht. Për të shmangur simbole të dyfishta, `_other.go`-t përkatëse
u ritag-uan `!windows && !linux` (darwin mbetet fallback) dhe u shtuan
`*_linux.go`.

- **M1**: `pal.go` + `platform_{windows,linux,other}.go`.
- **M2**: 7 fusha aditive (`fqdn, kernel_version, architecture, mac_address,
  timezone, last_boot_at, capabilities`) në Inventory + HeartbeatPayload,
  populuar nga `currentPlatform()`. Test `pal_test.go` provon që payload-i
  jo-Linux nuk përmban asnjë nga fushat e reja.
- **M3**: `collectOSInfo` real në Linux nga `/etc/os-release` + kernel (uname).
- **M4**: actions Linux (restart_agent/restart_device/reboot via systemd;
  RustDesk/PowerShell → "not supported on Linux").
- **M5**: service management systemd (install shkruan unit + enable --now;
  uninstall/start/stop/status) + self-update (download → SHA256 → atomic
  rename me `.old` për rollback → `systemctl restart`).
- **M6**: backend `GET /api/v1/install/linux?token=` (bash one-liner, 404 kur
  FEATURE_LINUX OFF) + `linux-arm64` te AgentPackagePlatform.

### Windows protection — provë

Baseline i binarit Windows u kap PARA punës. Byte-identik i binarit është i
pamundur kur shtohet kod i përbashkët (pal.go kompilohet edhe në Windows),
prandaj garancia është **sjellje bit-identike**: (1) test që provon payload-i
jo-Linux s'ka fushat e reja; (2) suita Go e gjelbër; (3) **agjenti Windows NUK
u rindërtua/rideploy-ua — flota mbetet në 2.1.5**. Të katër targetet ndërtohen
(linux amd64/arm64, windows, darwin).

### Smoke test (server Ubuntu)

Binari `linux/amd64` (ELF statik ~9.5MB) u ekzekutua me `--once`: mblodhi
inventory + RustDesk discovery (`not_installed` — saktë në Linux) dhe dështoi
me elegancë te enrollment pa token. Kodi Linux u ushtrua pa gabime.

### Deploy + validim

Backend prod tip `59a781b` (backend-only rebuild). health 200;
`/api/v1/install/linux` → **404** (FEATURE_LINUX OFF, verifikuar); 206
heartbeats/min (~750 pajisje @ 250s — normale); 0 gabime reale në logje.
FEATURE_LINUX mbetet OFF — Linux është dark. Binarët Linux nuk u ngarkuan si
paketa (kërkon ndezjen e flag-ut për canary — Manual Approval).

### Certifikim

Linux → **Experimental** (Appendix C): kod i implementuar, dark, pa pajisje
prodhimi. Internal kërkon UI-n e Fazës 3 + një host të brendshëm.

### Mësimet

Ritag-imi build-tag (`!windows && !linux`) është mënyra e pastër të shtosh një
platformë të tretë pa prekur dy të parat: kompajlleri garanton izolim, jo
disiplina. Çdo funksion i hequr nga `_other.go` duhet ripërkufizuar për Linux.

## [2026-07-07] Vault Operational Safety — backup + recovery i çelësit master (hardening, pa ndryshim sjelljeje)

### Problemi

Çelësi master i Credential Vault (`vault_master.key`, në volume `backend_data`)
nuk ishte në backup — humbja e tij = çdo sekret vault i parikuperueshëm.
Boshllëk i regjistruar te deploy-i i Fazës 4; duhej mbyllur PARA se
`FEATURE_VAULT` të ndizej ndonjëherë. Kjo NUK është feature platforme; është
hardening operacional. Zero ndryshim sjelljeje, asnjë flag i ndezur.

### Zgjidhja

`scripts/techi-backup.sh` (i versionuar tani në repo, i deploy-uar në
`/root/techi-backup.sh`) shton një hap: resolve i mountpoint-it të volume-it
`techi-platform_backend_data` (dinamik — që një recreation i compose të mos
çojë te path i vjetër), tar i `vault_master.key` me `chmod 600`, dhe një file
integriteti `vault-key-<date>.sha256`. Hyn në retention-in ekzistues 14-ditor.
Nëse çelësi mungon (vault i painicializuar) → warning, jo error.

### Procedura e restaurimit (dokumentuar te PROJECT_STATE › Disaster Recovery)

Extract `vault-key-<date>.tar.gz` → verifiko `sha256sum` kundër `.sha256` →
vendos te `data/vault_master.key` (`0400`) në volume → restart backend.

### Rezultati (verifikim end-to-end, 2026-07-07)

Backup u ekzekutua: çelësi u ruajt, sha `e7bcd67f…710b`. Verifikim integriteti:
sha e restauruar = e regjistruar = live. **Verifikim rikuperimi**: një sekret i
enkriptuar me çelësin LIVE u dekriptua saktë duke ngarkuar çelësin nga kopja e
RESTAURUAR e backup-it (`recovery-canary-42`) — pra artefakti i backup-it është
i vlefshëm dhe funksional për recovery. Temp files u pastruan. Prodhimi i
paprekur; asnjë flag i ndryshuar.

### Mësimet

Ky është i vetmi komponent DR me restore të provuar realisht (postgres/NPM/
offsite mbeten të pa-provuara — boshllëqe para-ekzistuese). Sekretet e reja
persistente kërkojnë hyrje në backup + provë recovery që në deploy-in e parë.

## [2026-07-07] Platform Expansion Phase 4 — Enterprise Credential Vault (flag-gated)

### Problemi

Vault enterprise për sekrete (password/ssh_key/api_token/snmp/winbox/cert),
me scope Global→Client→Group→Device, i ndarë PLOTËSISHT nga sistemi i
RS-password (secret_cipher), pa u prekur asgjë me flags OFF. (Fazat 2–3 u
anashkaluan për momentin: Faza 2 e bllokuar nga rollout-i 2.1.5; fazat
zhvillohen në mënyrë të pavarur.)

### Analiza / Zgjidhja

Envelope AES-256-GCM në `core/vault_cipher.py`: master key file jashtë
repo/DB (`data/vault_master.key`, `0400`, në volume `backend_data`) → DEK
per-credential → payload; rotation me re-wrap (payload i paprekur). E ndarë
nga `secret_cipher` (keystream i RS-password — i ngrirë). Tabela të reja
`vault_credentials` + `vault_credential_usage` (append-only audit). Service
me integritet scope-i (scope_type ↔ target id), reveal me arsye + audit,
rotim. API `/vault` me role gates (list operator+, mutim admin+) dhe **404
kur FEATURE_VAULT është OFF** (i padukshëm, jo "i çaktivizuar"). Endpoint i ri
read-only `/platform/features` për frontend-in. UI: faqe `CredentialVault.tsx`
+ hook `usePlatformFeatures` (default all-off) + rrugë + zë Sidebar-i, të
gjitha të gated nga FEATURE_VAULT.

**SQL i aplikuar në prodhim para deploy-it** (dy tabela + indekse; shih
commit). Rollback: `FEATURE_VAULT=false` (default, i menjëhershëm) + `git
revert`; DROP TABLE vault_* vetëm me aprovim.

Varësi e re: `cryptography==42.0.8` (vjen me docker build).

### Rezultati

Deploy 2026-07-07 (backend+frontend, prod tip `9a119a7`): health 200, të dy
kontejnerët healthy, `/api/v1/vault` → **404** me flag OFF, `/platform/features`
→ 401 pa auth (i mbrojtur), cipher round-trip OK në kontejner, çelësi master
`0400` në `/app/data` (volume `techi-platform_backend_data`), 380 heartbeats/
2min. Suita 2×: flags OFF dhe FEATURE_PLATFORM_CORE+FEATURE_VAULT ON → 414
passed + 4 të njohura; tsc pastër; frontend build OK.

### ⚠️ Veprim i detyrueshëm PARA se FEATURE_VAULT të ndizet në prodhim

Çelësi master `vault_master.key` **nuk është ende në backup**. Skripti
`techi-backup.sh` merr postgres + RustDesk keys + config tar, JO volume-in
`backend_data`. Humbja e këtij çelësi = çdo sekret vault i parikuperueshëm
(si RustDesk keys). Përpara ndezjes së flag-ut (që kërkon aprovim owner-i —
kusht Manual Approval): (1) shto `vault_master.key` te config tar-i i
backup-it; (2) rishiko rotation. Deri atëherë vault është i zbrazët dhe OFF,
pa rrezik real.

### Mësimet

Sekretet e reja persistente kërkojnë hyrje në DR/backup që në ditën e parë —
u regjistrua si gate para ndezjes së flag-ut, jo si borxh i heshtur.

## [2026-07-07] Platform Expansion Phase 1 — Platform Core Integration (dark wiring + kolona DB)

### Problemi

Faza 1 e roadmap-it: themeli i Fazës 0 duhej bërë i përdorshëm pa ndryshuar
sjelljen — kolona aditive në `devices`, nxjerrja e Windows adapter-it dhe
parsing i capabilities në side effects, të gjitha nën `FEATURE_PLATFORM_CORE`.

### Analiza

Seam-i i klasifikimit: `DeviceHeartbeatService.classify_device_type` (statike,
Windows-specifike) — logjika u zhvendos FJALË PËR FJALË te
`platform_adapters/windows.py::classify_windows_device_type`; metoda statike
tani delegon aty (API publike + testet ekzistuese të paprekura). Dispatch
flag-gated në `process_heartbeat_core`: flag OFF → rruga legacy identike;
flag ON → `get_adapter(payload.platform)`. Kujdes i veçantë te tre
`payload.model_dump(...)` (update / create / reuse) — `capabilities`
përjashtohet që të mos rrjedhë raw në DeviceCreate/DeviceUpdate; normalizohet
vetëm në `_run_side_effects._process_capabilities` (jashtë fast path).
Fallback i sigurt: platformë e panjohur ose pa adapter → Windows adapter
(sjellja legacy), me log.

### Shkaku

n/a — fazë e planifikuar e roadmap-it.

### Zgjidhja

Kod: `app/services/platform_adapters/{__init__,base,windows,linux,registry}.py`;
`device_heartbeat_service.py` (delegim + dispatch + `_process_capabilities` +
3 përjashtime dump); `models/device.py` +7 kolona nullable; skemat
DeviceBase/DeviceUpdate +6 fusha, `AgentHeartbeatPayload` +7 fusha opsionale;
`schema_compat_service.DEVICE_COLUMNS` +7 (SQLite dev). Teste:
`test_platform_adapters.py` (13 teste: golden corpus me pritshmëri të
ngurtësuara para-ekstraktimit, ekuivalenca adapter↔legacy, fallbacks,
filtrimi per-platform i capabilities, side-effect flag on/off);
`test_platform_core.py` — invarianti i errësirës u zëvendësua me kufi wiring
(vetëm 3 module të aprovuara importojnë platform_core) dhe testet e flags u
bënë imune ndaj env override (lexojnë defaults të klasës Settings).

**SQL i aplikuar në prodhim PARA deploy-it** (schema-first, hapi 4):

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fqdn VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS kernel_version VARCHAR(120);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS architecture VARCHAR(40);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_boot_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS capabilities JSONB;
```

Rollback SQL (VETËM me aprovim të owner-it — rregulli i drop-eve):

```sql
ALTER TABLE devices DROP COLUMN IF EXISTS fqdn, DROP COLUMN IF EXISTS kernel_version,
  DROP COLUMN IF EXISTS architecture, DROP COLUMN IF EXISTS mac_address,
  DROP COLUMN IF EXISTS timezone, DROP COLUMN IF EXISTS last_boot_at,
  DROP COLUMN IF EXISTS capabilities;
```

Rollback sjelljeje: `FEATURE_PLATFORM_CORE=false` (default) — i menjëhershëm.

### Ndryshimet

Shih listën e file-ve më lart; zero ndryshime frontend; zero endpoints të reja.

### Rezultati

Suita e plotë **2×**: me flag OFF → 403 passed + 4 dështimet e njohura;
me `FEATURE_PLATFORM_CORE=true` → identike (403 + 4) — dispatch-i i adapter-it
nuk ndryshon asnjë klasifikim (golden corpus 10 rastesh e provon fushë më
fushë). Deploy + validimi i prodhimit: shih rreshtat e roadmap-it (Phase 1).

### Mësimet

Tre vendet e `model_dump` (update/create/reuse) janë kontrata e heshtur e
heartbeat-it me skemat Device* — çdo fushë e re e payload-it duhet ose të
ekzistojë në DeviceUpdate/DeviceCreate, ose të përjashtohet shprehimisht në
të tre vendet, përndryshe heartbeat 500 fleet-wide.

## [2026-07-07] Deploy: Platform Expansion Phase 0 (Platform Core Foundation) + gotcha e emrit të compose project

### Problemi

Deploy i Fazës 0 (flags + Platform Registry + Capability Registry — kod dark,
flags OFF) në prodhim, sipas standing approval të owner-it për workflow-in e
plotë të fazave.

### Analiza

Para deploy-it u verifikua me evidencë: live dir `/root` (docker label),
prod në `9644634`, working tree i pastër. Gjatë deploy-it u zbulua një
**gotcha kritike**: `cd /root && docker compose build backend && up -d backend`
krijoi projekt të ri compose të quajtur **`root`** (nga emri i direktorisë) —
kontejnerë `root-backend-1`/`root-postgres-1` paralelë me projektin real
`techi-platform`. `root-postgres-1` dështoi në nisje (porta 5432 e zënë nga
postgres-i real) — prodhimi mbeti i paprekur, por procesi i dokumentuar i
deploy-it ishte i paplotë: kërkon **`-p techi-platform`** (ose
`COMPOSE_PROJECT_NAME=techi-platform`), sepse emri i projektit nuk del nga
compose file, po nga direktoria.

### Shkaku

Compose project name i pa-fiksuar në `/root/.env` ose në compose file;
deploy-et e mëparshme duket se e kanë dhënë manualisht.

### Zgjidhja

Pastrim i menjëhershëm (`docker rm root-backend-1 root-postgres-1`,
`docker network rm root_default`, heqja e imazhit `root-backend`) dhe rideploy
me `docker compose -p techi-platform build backend && … up -d backend`.
Hapi 5 i Deploy Process në PROJECT_STATE.md u përditësua me `-p techi-platform`.

### Ndryshimet

Prodhimi: `9644634` → `c60ff62` (3 commits: `d19f5d9` docs aprovimi/design-lock,
`f1975ed` Phase 0 platform_core, `c60ff62` roadmap). Vetëm imazhi backend u
rindërtua; frontend/postgres të paprekur. Zero SQL (Faza 0 s'ka ndryshime skeme).

### Rezultati

`/health` 200; `techi-platform-backend-1` healthy; operatorët u rilidhën në
`/ws/devices`; **740 heartbeats në 5 min** (~750 pajisje @ 250 s — normale);
verifikuar në kontejner: të 7 flags OFF, `feature_enabled('FEATURE_LINUX')` =
False, 8 platforma në registry. Sjellja e prodhimit bit-identike (kod dark i
pa-importuar nga asnjë modul ekzistues — invariant i testuar).

### Mësimet

(1) **Gjithmonë `docker compose -p techi-platform` në `/root`** — pa të,
compose krijon projekt paralel "root" dhe tenton postgres të dytë në 5432.
Vlen ta fiksojmë me `COMPOSE_PROJECT_NAME=techi-platform` në `/root/.env`
(kërkon vendim të owner-it — prek edhe backup/restore docs). (2) Filtri i
heartbeat access-log (deploy 2026-07-06) do të thotë që rrjedha e heartbeat-eve
verifikohet me DB (`device_heartbeats.created_at`), jo me logje.

## [2026-07-07] Vendim: Platform Expansion — arkitektura APROVOHET dhe DESIGN LOCKED

### Problemi

TECHI Platform (LIVE, ~750 pajisje Windows) duhet të zgjerohet në multi-platform
(Linux i pari; më pas MikroTik, Synology, QNAP, VMware, Hyper-V, Proxmox) pa
prishur asgjë nga sistemi aktual dhe pa krijuar produkt paralel.

### Analiza

Auditi u krye në 4 raunde iterative (2026-07-06 → 2026-07-07) nën mbikëqyrjen e
owner-it: (1) draft "Linux Support" + mockups; (2) mockups të rindërtuara mbi
design language-in real të frontend-it; (3) draft "V3" i zgjeruar; (4) pas
urdhrit të owner-it "dokumentacioni para kodit", u lexuan të plota
PROJECT_STATE.md, CHANGELOG-SOLUTIONS.md, MOBILE-DESIGN-SPEC.md dhe u raportuan
8 konflikte draft-vs-dokumentacion (kryesorët: agjentët NUK kanë kanal
WebSocket — komandat udhëtojnë vetëm si `pending_actions` në heartbeat; policy
globale 250 s; asnjë punë në `agent/` gjatë rollout-it 2.1.5; kufiri me Zabbix).
Gjetje pozitive: `Device.platform`, selektori Platform në Enrollment Bootstrap,
`linux-amd64` te Packages dhe stubs `_other.go` të agjentit ekzistojnë tashmë.

### Shkaku

n/a — vendim arkitekturor, jo incident.

### Zgjidhja

**Arkitektura u APROVUA dhe u shpall DESIGN LOCKED nga owner-i (2026-07-07).**
Dokumenti bazë: `docs/reference/PLATFORM-EXPANSION-AUDIT.md` (riemërtuar nga
`LINUX-AGENT-DESIGN-SPEC.md`). Vendimet kryesore të ngrira:

- **No Rewrite policy**: asnjë ridizajn i platformës/UI/backend; vetëm zgjerim
  aditiv i komponentëve ekzistues; Windows mbetet reference implementation.
- **Feature Flags policy**: gjithçka e re pas flags (FEATURE_PLATFORM_CORE,
  FEATURE_LINUX, FEATURE_VAULT, FEATURE_TERMINAL, …), default OFF;
  **flag OFF = sjellje BIT-IDENTIKE me prodhimin e sotëm**.
- **Platform Expansion nis** me roadmap fazor (audit §12), një fazë në një kohë,
  me STOP + aprovim manual të owner-it mes fazave; çdo fazë mbyllet vetëm me
  Definition of Done (Appendix A) + Regression Matrix (Appendix B) +
  Platform Certification (Appendix C).
- **Linux shtyhet** derisa rollout-i i Windows Agent 2.1.5 të shpallet
  zyrtarisht i përfunduar (standing order — asnjë prekje e `agent/`).
- Dy porta me aprovim të veçantë të owner-it: rruga WS në NPM (Faza Terminal)
  dhe data e nisjes së punës në `agent/`.

### Ndryshimet

`docs/reference/LINUX-AGENT-DESIGN-SPEC.md` → riemërtuar
`docs/reference/PLATFORM-EXPANSION-AUDIT.md` (+ banner ARCHITECTURE STATUS:
DESIGN LOCKED); hyrje të reja në PROJECT_STATE.md (seksioni PLATFORM EXPANSION);
kjo hyrje. Zero ndryshime kodi/prodhimi në këtë vendim.

### Rezultati

Baseline zyrtar i ngrirë; implementimi nis me Fazën 0 (Platform Core Foundation
— dark, pa ndryshim sjelljeje), e cila raportohet më vete pas përfundimit.

### Mësimet

Dokumentacioni ka përparësi mbi kodin — auditi kodi-i-parë prodhoi 8 supozime
të gabuara që u kapën vetëm nga leximi i plotë i PROJECT_STATE/CHANGELOG.
Çdo iniciativë e re duhet të fillojë me leximin e dy dokumenteve kanonike.

## [2026-07-06] JetBrains Mono self-hosted — hiqet varësia nga Google Fonts CDN

### Problemi

Owner-i vërejti te DevTools Issues (prodhim, desktop) një "Page Error:
failed to load a stylesheet" për `fonts.googleapis.com/css2?family=
JetBrains+Mono...` (`index.html:17`).

### Analiza

URL-ja e font-it ishte valide (curl → 200 OK; Chromium i pastër kundër
prodhimit → stylesheet 200, zero kërkesa të dështuara). Dështimi ndodhte
vetëm në browser-in e owner-it sepse ka AdBlock të instaluar — shumë
filter-lista privatësie bllokojnë Google Fonts. Pasoja: monospace i
sistemit në vend të JetBrains Mono për çdo operator me ad-blocker (pjesa
më e madhe e teknikëve). Dy issues të tjera në panel u analizuan si
jo-probleme: "bounce tracking 486643457" = heuristikë e Chrome mbi
protokollet custom `techiremotesupport://` / `rustdesk://` të butonit
Connect (ID-ja interpretohet si hostname — s'ka tracking real, s'ka
veprim); "16 form fields without id/name" = rekomandim autofill-i i
Chrome-it (kategoria Improvements), jo error.

### Shkaku

Varësi e vetme runtime nga një CDN palë e tretë (Google Fonts) për
JetBrains Mono — të bllokueshme nga çdo ad-blocker, GDPR-gri, dhe jashtë
mbulimit të service worker-it offline.

### Zgjidhja

Self-hosting: shkarkuar saktësisht të njëjtat woff2 latin-subset që
shërbente Google (një file variabël wght 400–800 për upright — konfirmuar
me fontTools `fvar` axis — dhe një statik 400 italic; latin U+0000-00FF
mbulon edhe ë/ç shqip), vendosur te `frontend/public/fonts/`; `@font-face`
në krye të `index.css` me të njëjtat `unicode-range`/`font-display: swap`;
hequr 3 rreshtat e Google Fonts (2 preconnect + stylesheet) nga
`index.html`; CSP në `nginx.conf` u SHTRËNGUA — `fonts.googleapis.com`
hequr nga `style-src`, `fonts.gstatic.com` hequr nga `font-src` (tani
`font-src 'self' data:`).

### Ndryshimet

`frontend/public/fonts/jetbrains-mono-latin.woff2` (i ri, 31KB),
`frontend/public/fonts/jetbrains-mono-latin-italic.woff2` (i ri, 22KB),
`frontend/src/index.css` (@font-face), `frontend/index.html` (hequr 3
rreshta), `frontend/nginx.conf` (CSP më e ngushtë). Zero ndryshim
backend/API/komponentësh.

### Rezultati

Verifikuar Playwright kundër build-it të prodhimit (`vite preview`):
`document.fonts.check` true për 400/700/italic; vetëm 2 kërkesa fonts,
të dyja nga origjina vetjake; zero kërkesa te `fonts.googleapis.com`/
`fonts.gstatic.com`; zero referenca Google në `dist/`. Font-et bien nën
rregullin ekzistues nginx `\.woff2$` (1 vit immutable — korrekte këtu:
nëse përditësohen, riemërtohen) dhe cache-ohen edhe nga runtime cache i
service worker-it (mbulim offline).

### Mësimet

Për një konsolë të brendshme MSP, çdo asset kritik UI duhet të vijë nga
`'self'` — CDN-të e palëve të treta dështojnë në mënyra të padukshme
(ad-blockers, DNS filtering në rrjetet e klientëve) pikërisht për
audiencën që e përdor më shumë (teknikë me ad-blocker). Bonus: heqja e
një origjine nga CSP është përmirësim sigurie në vetvete.

## [2026-07-06] "Add to Home Screen" në iOS shfaqte logo-n e vjetër — file i vjetëruar + cache 1-vjeçar

### Problemi

Owner-i raportoi se ikona e "Save to Home Screen" në iOS mbetej ajo e
VJETËR edhe pas ndryshimit të logo-s, dhe që fshirja+rishtimi i
shkurtores nga home screen nuk ndihmonte fare — e njëjta gjë përsëritej.

### Analiza

`git log` zbuloi që `frontend/public/apple-touch-icon.png` (referuar te
`<link rel="apple-touch-icon">` në `index.html`, mekanizmi kryesor që iOS
Safari përdor për "Add to Home Screen") s'ishte prekur që nga commit
`aec945e` (shumë i vjetër) — ndërsa `manifest.json`'s `/icons/*.png` u
rregulluan më vonë te commit `bf32ef8` ("fix: PWA icons from real
Logo.png"). Krahasimi vizual (Read tool mbi të dy PNG-të) e konfirmoi:
`icon-512.png` tregonte logo-n e saktë aktuale (sfond i errët, "techi"
wordmark, gradient rozë→portokalli), `apple-touch-icon.png` tregonte një
version krejt tjetër, të vjetër, të prerë keq (flakë portokalli e
sheshtë). iOS injoron kryesisht manifest.json për home-screen icon dhe
mbështetet te `apple-touch-icon` link tag-u — kështu që rregullimi i
`bf32ef8` kurrë s'e prekte atë që iOS-i faktikisht shfaq. Gjetje e dytë,
më e rëndësishme afatgjatë: `nginx.conf`'s rregulli gjenerik
`location ~* \.(js|css|png|...)$` i cakonte `apple-touch-icon.png` dhe
`favicon.svg`/`favicon.png` me `Cache-Control: public, max-age=31536000,
immutable` (1 VIT) — ndryshe nga `/icons/` që kishte tashmë rregull të
veçantë me `max-age=86400`. Kjo shpjegon pse "remove+add" nuk ndihmoi:
edhe nëse skedari të ndryshohej, header-i "immutable" 1-vjeçar i thoshte
çdo cache (browser, sistemi iOS) të mos e rikontrollonte fare për një vit.

### Shkaku

Dy shkaqe të pavarura, të dyja duhej të rregulloheshin: (1) vetë skedari
`apple-touch-icon.png` s'u rigjenerua kurrë kur logo-ja u ndryshua/u
rregullua për manifest-in; (2) `nginx.conf` s'kishte një rregull të
veçantë për ikonat rrënjë (root-level) siç kishte për `/icons/`, kështu që
ato binin nën rregullin gjenerik immutable-1-vit të menduar për bundle-t e
hash-uara të Vite-it (që VËRTET s'ndryshojnë kurrë nën të njëjtin emër,
ndryshe nga këto ikona).

### Zgjidhja

(1) Rigjeneruar `apple-touch-icon.png` (180×180, `sips`) nga i njëjti
burim si `icon-512.png` (logo-ja aktuale korrekte); bump `?v=4→5` te
`index.html` për cache-bust të menjëhershëm anë-browser. (2) Shtuar një
`location` e re e veçantë në `nginx.conf` (`favicon.svg`, `favicon.png`,
`apple-touch-icon.png`) me të njëjtën politikë ditore (`max-age=86400`,
JO immutable) si `/icons/` — vendosur PARA rregullit gjenerik `\.png$` në
skedar, që nginx (rregulla regex zgjidhen sipas radhës së parë-që-
përputhet) ta zgjedhë këtë në vend të asaj immutable.

### Ndryshimet

`frontend/public/apple-touch-icon.png` (rigjeneruar), `frontend/index.html`
(cache-bust bump), `frontend/nginx.conf` (location e re). Zero ndryshim
backend/API, zero ndryshim komponentësh React — thjesht asete + config
serveri statik.

### Rezultati

Verifikuar lokalisht (`npm run build`): `dist/apple-touch-icon.png` e re,
`dist/index.html` përmban `?v=5`. Nginx.conf u rishikua rresht-për-rresht
për radhën e location-eve (rregullat regex `~*` zgjidhen sipas radhës së
parë-që-përputhet në skedar, jo sipas specifikimit — rregulli i ri është
para atij gjenerik). Verifikimi live pas deploy: header-at `Cache-Control`
mbi `https://rdp.techi.com.al/apple-touch-icon.png` duhet të tregojnë
`max-age=86400` (jo `31536000, immutable`).

### Mësimet

Kur një "fix" i mëparshëm (`bf32ef8`, rregullimi i ikonave PWA) prek
VETËM `manifest.json`'s icons array, kontrollo GJITHMONË nëse ka file të
tjerë referuar drejtpërdrejt nga `index.html` (`apple-touch-icon`,
`favicon`) që mbeten jashtë — iOS Safari në veçanti u jep përparësi këtyre
mbi manifest-in. Dhe: një header `Cache-Control: immutable` i gabuar mbi
një asset JO të hash-uar (që ndryshon me të njëjtin emër file-i) e bën
çdo "fix" të ardhshëm të padukshëm për muaj/vite, pavarësisht sa herë
rifreskon ose fshin+rishton — duhet verifikuar që politika e cache-ut
përputhet me natyrën reale të file-it (i hash-uar+immutable, apo i
riemërtueshëm+revalidate).

## [2026-07-06] Mobile UI 2.0 — 4 raunde rregullimesh pas deploy-it

### Problemi

Pas deploy-it të Mobile UI 2.0 (shih entry-n më poshtë), owner-i rishikoi
prodhimin live dhe raportoi katër probleme në katër raunde të veçanta:
Raundi 1 — Software te Device Details fetch-ohej automatikisht sapo hapej
accordion-i (rrezik ngarkese DB të panevojshme) dhe seksioni Performance i
mungonte sparkline-i i mockup-it dhe dukej me "të dhëna jo reale". Raundi 2
— Uptime/Latency në Device Details mobile "s'janë reale" krahasuar me web.
Raundi 3 — Fleet Tree mobile i mungon opsioni "No Client" (i pranishëm në
Desktop), dhe Alerts mobile s'ka kategori filtri "Disk"/"Storage" për
alertet e diskut. Raundi 4 — screenshot nga prodhimi tregoi që kur
shtypej brenda fushës "Search devices…", e gjithë faqja zoom-ohej dhe
kërkonte zoom-out manual.

### Analiza

Raundi 1: `DeviceInventoryService.get_inventory()` në backend u lexua
drejtpërdrejt — është një lookup i lehtë me një rresht, jo një query e
rëndë; problemi real ishte payload-i JSON (software/services/processes të
plota), jo kostoja e DB-së, dhe fakti që mobile hapet më rastësisht se
desktop. Raundi 2: krahasimi me `DeviceDrawer.tsx` tregoi se e dhëna
(`uptime_seconds`, `heartbeat_latency_ms` nga `useDeviceTelemetry`) ishte
identike me desktop-un — divergjenca ishte thjesht formatimi
(`formatUptime()` mungonte në mobile, ndante vetëm në orë totale). Raundi
3: `DeviceTree.tsx` (Desktop) konfirmoi konventën `client_id = -1` +
`treeCounts.unassigned` për "No Client"; `AlertsMobile.tsx` konfirmoi se
`low_disk` ekzistonte tashmë plotësisht në `AlertKind`/`KIND_LABEL`/
`KindIcon` por mungonte thjesht nga `FilterId`/`FILTER_PILLS`. Raundi 4:
sjellje e njohur e iOS Safari-t — çdo `<input>`/`<select>`/`<textarea>` i
fokusuar me `font-size` të llogaritur nën 16px shkakton auto-zoom të
viewport-it; disa fusha teksti të Mobile UI 2.0 (Devices search
`text-[13px]`, Remote Support search `text-[13px]`, notes te Device
Details `text-[12.5px]`) përdorin madhësi nën 16px për densitet.

### Shkaku

Raundi 1: mungesë gate-i eksplicit për një fetch të shtrenjtë në payload.
Raundi 2: divergjencë formatimi e prezantuar gjatë implementimit fillestar
të Phase 4 (mobile s'e riprodhoi `formatUptime()` e Desktop-it). Raundi 3:
dy feature paritetesh Desktop→Mobile të harruara gjatë Phase 3/5 fillestare
(elementë additivë, jo bug logjike). Raundi 4: asnjë nga input-et e reja të
Mobile UI 2.0 s'u projektua me kufizimin "≥16px" të iOS Safari-t në mendje
gjatë fazave 1–7 — densiteti vizual u prioritizua pa e ditur këtë sjellje
specifike browser-i.

### Zgjidhja

Raundi 1 (commit `44770fd`): `Software` kërkon tap eksplicit ("Load
software list") para se të thërrasë `getDeviceInventory`; shtuar
`Sparkline.tsx` (SVG, real) i ushqyer nga `getDeviceTelemetryHistory`.
Raundi 2 (commit `7161f73`): `formatUptime()` në `DeviceDetailsMobile.tsx`
bërë identike me `DeviceDrawer.tsx`; hequr heuristika e gabuar "0ms =
e pamatur" — Latency tani përdor saktësisht të njëjtin kontroll `!== null`
si Desktop. Raundi 3 (commit `c1b5f9f`): shtuar buton "No Client" te
`FilterSheet.tsx` (menjëherë pas "All clients", ikonë `Box`, ripërdor
`client_id = -1` ekzistues, `unassignedCount` nga
`fleetOverview.tree_counts.unassigned`); shtuar `low_disk`/"Disk" te
`FilterId`/`FILTER_PILLS` në `AlertsMobile.tsx` (aditiv i pastër,
`applyFilter`'s fallback tashmë e mbulonte). Raundi 4: një rregull CSS
global te `index.css` — `@media (max-width: 767px) { input:focus,
select:focus, textarea:focus { font-size: 16px !important; } }` — forcon
16px vetëm gjatë fokusit dhe vetëm nën të njëjtin breakpoint `md:768px`
që përdor pjesa tjetër e Mobile UI 2.0, në vend të ndryshimit të çdo
input-i individualisht.

### Ndryshimet

Raundi 1: `frontend/src/pages/DeviceDetailsMobile.tsx`,
`frontend/src/components/mobile/Sparkline.tsx` (i ri). Raundi 2:
`frontend/src/pages/DeviceDetailsMobile.tsx`. Raundi 3:
`frontend/src/components/FilterSheet.tsx`,
`frontend/src/components/DevicesTable.tsx`, `frontend/src/pages/Devices.tsx`,
`frontend/src/pages/AlertsMobile.tsx`. Raundi 4: `frontend/src/index.css`.
Të katër raundet: vetëm frontend, zero ndryshim backend/API, zero prekje
Desktop (verifikuar me smoke test Playwright kundër komponentëve desktop
përkatës, dhe në rastin e Raundit 4 nga vetë kufiri i media query-t).
`docs/reference/MOBILE-DESIGN-SPEC.md` përditësuar me Implementation Notes
#8–#12 dhe rreshta Progress Log pas secilit raund.

### Rezultati

Të katër raundet u verifikuan me Playwright (mock data + build prodhimi
`vite preview`) para push+deploy, dhe me verifikim live kundër
https://rdp.techi.com.al pas deploy-it. 0 gabime console në çdo rast.
Raundi 4 u verifikua përmes mekanizmit shkaktar (`getComputedStyle` para/
gjatë/pas fokusit: 13px→16px→13px) — vetë zoom-i i Safari-t s'riprodhohet
me Chromium headless. Deploy: `docker compose -p techi-platform build
frontend && ... up -d frontend` (frontend-only, pa prekur backend/
postgres).

### Mësimet

"E dhëna është 'jo reale'" nga një owner që krahason Mobile me Desktop
shpesh do të thotë **divergjencë formatimi/veçorie**, jo të dhëna false —
krahasimi drejtpërdrejt me komponentin ekuivalent të Desktop-it (para se
të supozohet një bug backend-i) e zgjidhi çdo raund më shpejt dhe me
ndryshim më të vogël se sa do të kishte kërkuar një "rregullim" i ri
spekulativ. Raundi 4 shton: një bug UX specifik për iOS Safari (font-size
<16px → auto-zoom) është më i lirë për t'u eliminuar me një rregull CSS
global i kufizuar me media query sesa duke kaluar çdo input individualisht
— zvogëlon rrezikun e harresës për input-e të ardhshme.

## [2026-07-06] Mobile UI 2.0 — implementim i plotë (7 faza) + deploy në prodhim

### Problemi

Audit vizual (Playwright, live prod, 2026-07-05) zbuloi Mobile-in e TECHI si
"companion view" jo enterprise-ready: BUG 1 (search i Devices nuk
rifreskohej — cache-key mungues), BUG 2 (pa refresh), BUG 3 (ikona Android e
RustDesk e pandryshuar), plus B2 (offline = ekran i bardhë), B9 (401 pa
mesazh), Device Details si drawer jo faqe, Alerts si listë e sheshtë me
"Device #93", sidebar mobile i papërdorshëm, etj. Owner-i aprovoi mockup-in
(artifact `af146cd9`) dhe kërkoi implementim të plotë "design-locked" në 7
faza, secila e commit-uar veçmas, pastaj push + deploy.

### Zgjidhja

Kontrata e dizajnit: `docs/reference/MOBILE-DESIGN-SPEC.md` (Vision →
Implementation Notes, wireframe për çdo ekran, design tokens). Implementim
sipas fazave:

1. **Shell/Nav/Theme** — BottomNav 4-tab (More zëvendëson sidebar-in
   mobile), MobileTopBar+FreshnessPill, MobileSheet/Snackbar/primitives,
   tokens dark+light.
2. **Dashboard** — theme-aware, Recent Activity e re, "Stale" si rresht
   normal.
3. **Devices** — DeviceMobileCard v2 (emri dominues), empty-search fix
   (B1), FilterSheet v2 (Apply/Reset), infinite scroll.
4. **Device Details** — faqe e re `/devices/:id` (jo drawer): header,
   VitalsStrip live, 6 accordion sections, StickyActionBar. Ripërdor
   drejtpërdrejt hooks/API ekzistuese (`useDeviceTelemetry`,
   `useDeviceAlerts`, `useDeviceActivity`, `getDeviceInventory`, etj.) —
   zero logjikë e duplikuar; drawer desktop i paprekur.
5. **Alerts** — grupim sipas pajisjes (emra realë via `getDevice()`),
   dismiss me UNDO real (resolveAlert i shtyrë 5s).
6. **Remote Support mobile + Settings i plotë** — grupim Issues/Online/Not
   installed brenda `RemoteSupport.tsx` ekzistues; Settings me System
   theme, Default screen, Diagnostics.
7. **Offline/A11y/Responsive** — `sw.js` me precache shell + runtime cache
   (zgjidh B2); OfflineBanner; session-expired message (zgjidh B9);
   `:focus-visible` global; landscape-compact BottomNav.

### Bugs reale të zbuluara dhe rregulluara gjatë verifikimit (jo gjetje mockup-i)

- **`MobileSheet`**: `history.back()` në mbyllje programatike anullonte
  navigim tjetër që ndodhte njëkohësisht (p.sh. `setSearchParams` i
  FilterSheet Apply) — hequr.
- **`Devices.tsx`**: `setSearchParams` i thirrur >1 herë brenda të njëjtit
  handler sinkron e anullonte njëri-tjetrin (react-router-dom resolon
  "updater" kundër snapshot-it të render-it aktual, jo një gjendje
  gjithmonë e freskët) — kaluar në functional-updater form + FilterSheet's
  Apply e riorganizoi rendin (onQuickFilterChange i fundit).
- **`AlertsMobile`**: `<button>` i ngulitur brenda `<button>` (header
  grupi + "Dismiss all") shkaktonte `validateDOMNesting` + crash të plotë
  të faqes kur klikohej në pikën qendrore — ndarë në elementë vëllazëror.
- **`Login.tsx`**: leximi+fshirja e flag-ut session-expired brenda një
  `useState` lazy-initializer ishte i papastër (side-effect); React
  StrictMode e thërret dy herë në dev, thirrja e dytë e gjente flag-un
  tashmë të fshirë → mesazhi s'shfaqej kurrë — zgjidhur me `useEffect` +
  `useRef` guard.

### Deploy (2026-07-06, https://rdp.techi.com.al)

Push i 9 commits në `origin/stable/phase-2-heartbeat`: 7 fazat mobile
(`27f1687`…`a8a35ea`) + 2 commits ekzistues të papushuara pa lidhje me
mobile-in (`49fce27` storage optimization, `1fe93de` docs) — bashkimi u
konfirmua shprehimisht nga owner-i pas një pyetjeje të drejtpërdrejtë mbi
scope-in (dega është lineare, s'mund të ndaheshin pa krijuar degë të re).

Në server (`/root`, projekt Docker Compose `techi-platform`): `git pull
--ff-only` → `docker compose build backend` → indeksi
`ix_device_heartbeats_created_at` (nga `49fce27`) ekzistonte tashmë në
Postgres (aplikuar me dorë më parë) → `alembic stamp b2c3d4e5f8a9` (via
imazhin e ri, `docker compose run --rm backend`) → `docker compose up -d
backend` → `docker compose build frontend` → `docker compose up -d
frontend`.

**E papritur**: `docker compose run --rm backend` shkaktoi rikrijim
automatik të kontejnerit `postgres` — Compose zbuloi që
`docker-compose.yml` (nga `49fce27`) kishte shtuar cap-in e logging-ut për
shërbimin postgres dhe e rikrijoi vetë për ta aplikuar, edhe pse komanda
kërkonte vetëm `backend`. Postgres u rishëndosh brenda ~30s; heartbeats
vazhduan (204-a në logje menjëherë pas); backend `/health` 200 gjatë
gjithë kohës. Efekt anësor pozitiv: log-cap i postgres tani aktiv, pa u
dashur një "dritare e qetë" e veçantë.

### Rezultati

Të tre kontejnerët "healthy". Verifikuar me Playwright kundër site-it real
(login manual nga owner-i): Dashboard (720 pajisje, 86% online, "Live"),
Devices, Device Details (`/devices/714`, vitals reale CPU 71%/RAM 76%/Disk
41%), Alerts (grupim real "Recepsion-hr · Gffa"), More, Settings — 0
gabime 4xx/5xx në sweep të pastër të 6 rrugëve kryesore.

### Mësimet

- `docker compose run --rm <svc>` respekton `depends_on` dhe rikrijon
  varësi (si `postgres`) nëse config-u i tyre në compose file ka ndryshuar
  që nga hera e fundit e krijimit — edhe kur kërkohet vetëm një shërbim
  tjetër. Të pritet gjatë çdo deploy që përfshin ndryshime docker-compose.yml
  për shërbime "silent" (postgres), jo vetëm ato eksplicitisht të prekura.
- React StrictMode dev-only double-invoke i lazy state initializers /
  effects zbulon efekte anësore të papastra (si mutacione
  localStorage/sessionStorage) që në prodhim (single-invoke) do të kishin
  kaluar pa u vënë re — trajtoji si gabime reale, jo zhurmë e StrictMode.
- `setSearchParams` (react-router-dom) i thirrur disa herë sinkron brenda
  të njëjtit handler NUK kompozohet si `useState`'s functional updater;
  çdo flow i ri që kombinon disa ndryshime filtri/URL në një veprim duhet
  ose një thirrje e vetme, ose kujdes eksplicit për renditjen.

## [2026-07-05] Shkrirja e historisë së munguar 19–26 qershor nga root CHANGELOG

### Problemi

Changelog-u kanonik s'kishte asnjë hyrje midis 2026-06-19 dhe 2026-06-26; ajo
javë (Command Center Fazat A/B, komanda self_update, fix-e kritike të
techi-deploy.cmd, eliminimi i false-positive AV) jetonte vetëm në
`CHANGELOG-SOLUTIONS.md` të root-it — më parë i vlerësuar gabimisht si dublikatë.

### Zgjidhja

14 hyrjet u shkrinë verbatim në pozicionin kronologjik (pas 2026-06-27, para
2026-06-18), me shënues proveniençe HTML në vend. Verifikim: krahasim
byte-për-byte i bllokut, 0 dublime titujsh, rend datash i plotë. Root-i tani
është 100% i mbuluar nga ky dokument dhe propozohet për arkivim (vetëm me
miratimin e Marios).

## [2026-07-04] Vendim: standardi i dokumentacionit me dy dokumente

### Problemi

Documentation was scattered across 20+ files of different eras
(`ai-context/*` frozen at Phase 3 / SQLite / no-auth, stale READMEs, two files
named CHANGELOG-SOLUTIONS.md, plans already implemented). A new AI session had
no reliable single source of truth, and production facts (deploy dir, real
retention, real heartbeat interval) existed only in chat history.

### Zgjidhja

Owner decision (permanent standard): exactly TWO canonical documents —
`docs/PROJECT_STATE.md` (current state only, verified facts flagged) and
`docs/CHANGELOG-SOLUTIONS.md` (history only, this file). Every meaningful
change updates PROJECT_STATE immediately; every incident/decision lands here
immediately; nothing critical may exist only in AI conversations. All other
docs demoted to historical/technical reference.

### Ndryshimet

- `docs/PROJECT_STATE.md` rewritten to the agreed structure (state-only, with
  (verified)/(needs verification) markers, AI Instructions, Things Never To
  Change).
- This header rewritten to define the history-only role + entry template.
- No documents deleted; archive proposals listed in the reorg report to the
  owner (root `CHANGELOG-SOLUTIONS.md`, `ai-context/current-phase|
  completed-phases|next-steps|runtime.md`, `AGENT-UPDATE-PLAN.md`, stale
  READMEs → proposed `docs/archive/`).

### Rezultati

A new AI session needs only PROJECT_STATE.md + this changelog to work safely
on the project.

## [2026-07-04] Storage: retention, log rotation, cache pruning (safe batch)

### Why

Server disk at ~98%. Audit found unbounded growth in: DB tables without
retention (audit_logs, resolved alerts, terminal remote_actions incl. full
PowerShell output, status history, command batches, enrollment audit), the
postgres container log (no docker cap), agent-side `agent.log`/`deploy.log`
(append-only, never rotated), and `%ProgramData%\TechiAgent\cache` (old RS
MSIs ~25 MB + old self-update exes ~10 MB per version, never deleted).
Heartbeat redesign is NOT part of this batch — see
`docs/architecture/heartbeat-storage-redesign.md` (proposal, needs approval).

### What changed (behavior-preserving)

- `app/tasks/cleanup.py` + `app/main.py`: nightly 03:00 UTC job now also
  cleans resolved alerts (90 d), terminal remote actions (90 d), empty
  command batches (90 d), status history (60 d), audit logs (180 d),
  enrollment audit (180 d). Open alerts and non-terminal actions untouched.
  Each task is isolated — one failure no longer stops the rest.
- Alembic `b2c3d4e5f8a9`: index on `device_heartbeats.created_at` (nightly
  cleanup was full-scanning the biggest table).
- `logging_config.py`: uvicorn access lines for `/api/v1/agent/heartbeat` and
  `/health` are dropped (per-device-per-minute noise that churned rotation).
- `docker-compose.yml`: postgres service now has the same json-file 10m×5 cap
  as backend/frontend (was unbounded).
- Agent-side changes (log rotation 5 MB for `agent.log` / 1 MB for
  `deploy.log`, startup pruning of stale cache files) are **NOT in this
  batch**: they live on branch `pending-agent-2.1.6`, marked *Pending Agent
  2.1.6*. Nothing on the current branch requires an agent build or touches
  the heartbeat contract — the 2.1.5 fleet (700-device rollout) is fully
  compatible as-is.

### Deploy notes (Postgres — remember the schema gotcha)

The index must exist in prod. Either run the alembic revision or, to avoid
blocking live heartbeat INSERTs on a large table, apply by hand:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_device_heartbeats_created_at
    ON device_heartbeats (created_at);
```

Recreate the postgres container for the logging cap to take effect
(`docker compose up -d postgres`) — note this restarts the DB, do it in a
quiet window. Pre-existing condition, unchanged by this batch: alembic has
two heads (`a1b2c3d4e5f7`, `e6f7a8b9c0d1`); the new revision extends the
first.

### Verify

- Backend: 368 tests pass (the 4 failures in
  `test_enrollment_audit_diagnostics.py` are pre-existing on a clean tree).
- Agent: `go vet` clean, `GOOS=windows` build OK, `go test ./...` pass.
- Next morning after deploy: `grep Cleanup /app/logs/techi.log` shows the six
  new tasks; `docker logs techi-postgres --tail 1` capped.

## [2026-07-04] Security: Per-Device Remote Support Password (Phase 1, backend)

### Why

The TECHI Remote Support password was a single fleet-wide value (`Durres.12`),
written in plaintext into the RustDesk TOMLs and re-applied every heartbeat.
One compromised/curious user reading a TOML exposed remote access to the
ENTIRE fleet. The enrollment token was also plaintext in
`\\DOMAIN\NETLOGON\techi-deploy.cmd` (world-readable by domain users).

### Phase 1 (backend, deployed)

- Each device gets a unique, server-generated RS password, stored encrypted
  at rest (`app/core/secret_cipher.py`, XOR+HMAC keyed off SECRET_KEY;
  `remote_support_password_ciphertext` column).
- `RemoteSupportPasswordService`: get_or_create / set_custom / regenerate.
- Heartbeat response now returns `remote_support_password`; a >= 2.1.5 agent
  will apply it to RustDesk (Phase 2).
- `/connect-url` uses the per-device password, with a **transition-safe
  fallback** to the legacy shared password for agents < 2.1.5 (so remote
  access does not break during rollout; the fallback retires itself).
- New audited endpoints: `GET/POST /remote-support/devices/{id}/password`,
  `POST .../password/regenerate`.

### GOTCHA (caused a brief heartbeat outage during deploy)

`schema_compat_service.ensure_sqlite_dev_schema` only adds columns on
**SQLite (dev)**. Production Postgres needs the columns added by hand — the
heartbeat 500'd fleet-wide until:

```sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_ciphertext TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_updated_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS remote_support_password_source VARCHAR(16);
```

Any new model column that the heartbeat/enrollment fast-path reads MUST be
ALTER-ed into Postgres before/with the deploy.

### Phase 2 (agent 2.1.5) + Phase 3 (frontend) — done, in commit 0335ec7

- Agent 2.1.5: the heartbeat response `remote_support_password` is adopted
  into `cfg.RustDeskDefaultPassword`, persisted to config, and applied to
  RustDesk immediately (`applyRemoteSupportPassword`). The management loop
  now re-applies the server's per-device value, not the old global.
- Also in 2.1.5: `bootstrap-config -rustdesk-password` (fresh installs write
  the RS password), and `watchdog-check` starts the TECHI Remote Support
  service if stopped (remote access survives agent-down).
- Frontend: RemoteSupport page password modal (reveal / copy / regenerate /
  set-custom), deployed.

**Rollout dependency:** devices only APPLY the per-device password once on
2.1.5. Until a device is on 2.1.5, connect-url returns the legacy shared
password for it (version-gated fallback), so remote access keeps working.
Standalone 2.1.5 exe: `/private/tmp/techi-agent-2.1.5.exe` SHA256
`cdc413f191faab7046c04451a7ff6f83300449e03f067377bda96a3ef52e29a3`
(CI builds the MSIs). Keep the agent_binary SHA aligned to the MSI's exe.

### Still open

- NETLOGON `techi-deploy.cmd` token: restrict ACL to Domain Computers.
- Optionally stop the install writing the transient Durres.12 bootstrap value
  (server overrides it on first heartbeat anyway).

## [2026-07-04] INCIDENT: v2.1.3 Agent Won't Launch — Broken Manifest XML Declaration (SxS)

### Root cause

The physical test PC failed every 2.1.3 install with msiexec 1603. After
ruling out (via the verbose MSI log) leftover MSI registration, and after
confirming Windows Defender real-time was genuinely OFF and it still failed,
the decisive test was an administrative extract (`msiexec /a`) of the exe
plus a direct run:

`The application has failed to start because its side-by-side configuration
is incorrect.` (SxS, error 14001)

Both the combined-MSI exe and the agent-binary exe failed identically — the
binary would not launch at all, as a service (1920) or as an MSI custom
action (1721).

The cause was in `agent/techi-agent.manifest`:

`<?xml version="2.1.3.0" encoding="UTF-8" standalone="yes"?>`

The 2.1.3 version-bump used a sloppy inline regex
(`version="[0-9.]+"` with `count=1`) that replaced the FIRST `version="..."`
in the file — the **XML declaration**, which must always be `version="1.0"`.
An invalid XML declaration makes the whole manifest unparseable, so Windows
cannot build the activation context and refuses to start the process. 2.1.2
was fine because its build used a 4-part-only regex that never matched the
2-part `version="1.0"`. Once the declaration was poisoned to `2.1.3.0`
(4-part), even the "safe" CI regex kept re-stamping it 4-part, so every
2.1.3 artifact shipped broken.

### Fix

- `techi-agent.manifest` restored: `<?xml version="1.0"...?>`,
  assemblyIdentity `version="2.1.4.0"`.
- All three manifest-stamping regexes (`build.sh`, `build-agent-update.sh`,
  CI `build-agent-msi.yml`) anchored to the indented assemblyIdentity line
  `(?m)^(\s+version=")...` so they can NEVER touch the XML declaration again.
- Version bumped to **2.1.4** to retire the poisoned 2.1.3 artifacts.

### Verification

- `agent/techi-agent.manifest` parses as valid XML; declaration is
  `version="1.0"`, assemblyIdentity is `2.1.4.0`.
- Built exe embeds `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  (confirmed via strings). Local standalone build:
  `/private/tmp/techi-agent-2.1.4.exe`
  SHA256 `8657e4d59072162851f3a1ccae2525ed0fac036c0bc8c6039d2088a82e6b1f82`.
- `go build ./...` (darwin + windows) clean.

### Lesson

Never regex the manifest with a pattern that can match the XML declaration.
Defender/AV was a red herring here — the exe never ran on ANY machine.

## [2026-07-03] v2.1.3: Package-Type Split (agent_update_msi) + Script-Free Combined MSI

### Root cause

Two remaining structural gaps after v2.1.2:

1. One "active MSI" slot served two conflicting purposes: the public
   `/agent-packages/platform/windows-amd64/download` feeds BOTH the
   GPO/NETLOGON bootstrap (needs the combined MSI with Remote Support) AND
   legacy self_update payloads (need the agent-only bridge MSI). Activating
   the bridge broke bootstrap; activating the combined re-exposed RS to
   MajorUpgrade during routine agent updates.
2. The combined bootstrap MSI still ran ~12 PowerShell custom actions
   (config, service ensure, recovery, icacls, tray task, shortcuts, kill RS,
   cleanup). AV/AMSI-strict clients (Symantec, CybeeAI) block all of them,
   leaving fresh GPO installs half-configured.

### Fix

**Backend/UI — new package type `agent_update_msi`:**
- `AgentFileType` gains `agent_update_msi` (bridge). `msi` keeps meaning the
  combined bootstrap package; `set_active` scopes per platform+file_type, so
  combined and bridge can be active simultaneously.
- New public endpoint `GET /api/v1/agent-packages/agent-update-msi/download`.
- Legacy self_update payloads now require an active `agent_update_msi`
  matching the active agent binary version and point at the new endpoint;
  `/platform/{platform}/download` (bootstrap) is untouched and again always
  serves the combined MSI.
- Agent Packages UI gains a third tab "Update MSI (Bridge)".

**Combined MSI (installer.wxs) — script-free:**
- `WriteAgentConfig` → `techi-agent.exe bootstrap-config ...` (native Go,
  bootstrap_windows.go); public-desktop shortcut is now a declarative WiX
  component (`PublicDesktopShortcut`).
- `EnsureServiceCreated` → `techi-agent.exe watchdog-check`.
- `CreateRustDeskTrayTask` → `techi-agent.exe rs-tray-task` (task definition
  shipped as Task Scheduler XML via `schtasks /Create /XML` — keeps group SID
  S-1-5-32-545 and ExecutionTimeLimit PT0S which the schtasks CLI cannot express).
- `SetServiceRecovery` → direct `sc.exe failure ...`; `LockdownTechiDataDir`
  → direct `icacls.exe`; `KillTechiRS*`, `RemoveRustDeskTrayArtifacts`,
  `CleanupProgramData` → `cmd.exe /d /c` chains. No PowerShell anywhere in
  the normal install path.
- Intentionally still PowerShell (documented in the wxs): the four
  v1.0.4-legacy config backup/restore/registry-cleanup actions — they run
  before the new exe exists and only matter when upgrading from 1.0.4.

### Version

`agent/VERSION` bumped to 2.1.3 (binary gains bootstrap-config/rs-tray-task).
Standalone exe for upload: `/private/tmp/techi-agent-2.1.3-native-bootstrap.exe`
SHA256 `94a0bda42c929d2521b450f7edffd65dba04cc7fc36c1cf8a3faf2e55033874e`.
CI builds the three 2.1.3 MSIs on push.

### Checks

- `cd agent && go build ./...` (darwin + windows), `go test ./...` -> clean.
- `cd backend && python3 -m pytest` -> 363 passed (4 pre-existing
  enrollment-audit failures, unrelated).
- `cd frontend && npx tsc --noEmit && npm run build` -> clean.
- installer.wxs parses as XML; `powershell.exe` appears only in the four
  documented v1.0.4-legacy actions.

## [2026-07-03] INCIDENT: Server 90-99% CPU From 09:00 — Legacy Heartbeat Bridge + 60s Global Interval

### Root cause

Two compounding factors, both unrelated to the previous night's
self_update-classification deploy:

1. The v1 heartbeat endpoint gained a `background_tasks` parameter, but
   `legacy_compat.py` still called it as `agent_heartbeat(payload, db)`.
   Every legacy `/api/heartbeat` request raised, was answered with a bodyless
   204, and old agents treated it as failure and retried in a tight loop
   (~34 req/s). The flood began at exactly 09:00 local when the legacy-fleet
   client offices (zoomtrip, vasdream, Travel, Reservation-*, Remote-*)
   powered on — overnight traffic on that route was zero. This was the
   long-failing `test_current_v1_heartbeat_route_is_unchanged`.
2. The global agent heartbeat policy had been left at 60 seconds for the
   whole fleet (~600 online devices ≈ 10 heavy heartbeats/s on a 2 vCPU/2 GB
   host).

Additionally, leftover pre-2.1 agent services on those client machines
fire-and-forget POST `/api/heartbeat` with tiny timeouts; each request died
with a full ClientDisconnect traceback (~2 300/min of log spam).

### Fix

- `legacy_compat.py` now calls the v1 handler with a real `BackgroundTasks`
  and runs the side effects inline; known legacy devices again receive the
  JSON body old agents expect (commit `60576a7`).
- `_read_limited_body` swallows `ClientDisconnect` quietly (commit `107528c`).
- Global heartbeat policy raised 60 → 180 seconds (`/app/data/agent_policy.json`).
- `test_legacy_compat.py` updated to the core+background endpoint shape and
  extended with a regression test that a known legacy device gets a JSON body.

### Result

Backend CPU fell from pegged 90-99% to normal levels within minutes; v1
heartbeats settled at ~150/min; zero tracebacks. The ~2 200/min legacy churn
from leftover old services continues (cheap, bodyless) — the durable cleanup
is uninstalling the leftover legacy agent services on those fleets.

## [2026-07-03] v2.1.2: Script-Free Self-Update and Watchdog (AV/AMSI-Proof)

### Root cause

Devices in the GFFA and INDUSTRIALE domains run an AV policy that blocks
every PowerShell script the agent launches (AMSI:
"This script contains malicious content and has been blocked by your
antivirus software" — reproduced with a read-only diagnostic script on
device 112). Everything in the update chain depended on PowerShell:

- the 2.1.0 legacy agent runs `self-update-*.ps1` before msiexec;
- the 2.1.1 binary-swap agent writes `binary-swap-*.ps1` + a PS task launcher;
- the watchdog is a `.ps1` registered through PowerShell cmdlets;
- the Agent Update Bridge MSI custom action runs `agent-update-helper.ps1`.

On those domains self_update failed silently and expired as "timeout"
(devices 16 `PDC`/GFFA, 112 `PM-SRV`/GFFA, 451 `PDC`/INDUSTRIALE), while the
same payloads worked in seconds elsewhere (device 5 `PDC`/AGROBLEND0: 25 s).

### Fix (agent v2.1.2)

The swap and watchdog are now native Go code inside techi-agent.exe; the only
external process used is Microsoft-signed `schtasks.exe`. No `.ps1` files are
written or executed anywhere in the update chain:

- `agent/swap_windows.go` (new): `techi-agent.exe swap-binary` — stop
  TechiAgent via the SCM API, wait for full stop, kill lingering agent
  processes (gopsutil), backup, copy itself over the target, recreate the
  service if missing, reapply recovery actions, start, verify Running,
  rollback to backup on failure. Logs to deploy.log. Also
  `techi-agent.exe watchdog-check` — the watchdog body in Go.
- `agent/update.go`: self_update registers a one-shot SYSTEM task via
  schtasks.exe running the downloaded exe with `swap-binary`; both PS1
  template functions are deleted.
- `agent/watchdog_windows.go`: registers "TECHI Agent Watchdog" via
  `schtasks /SC MINUTE /MO 5` running `techi-agent.exe watchdog-check`;
  removes the stale `techi-agent-watchdog.ps1`.
- `agent/installer/agent-update.wxs`: the bridge custom action now runs
  `[BRIDGEFOLDER]techi-agent.exe swap-binary -swap-target ... -swap-api-url
  ... -swap-enrollment-token ...` directly; `agent-update-helper.ps1` is
  deleted from the package and repo. Config-preservation semantics are kept
  in Go (`ensureFreshAgentConfig`): existing configs are never touched, a
  minimal config is created only when none exists and a token was supplied.

Still PowerShell-dependent (out of scope, features rather than update path):
`run_powershell` action itself, `restart_agent` helper, patch-status
telemetry. These remain blocked on AMSI-strict domains.

### Version

`agent/VERSION` bumped to 2.1.2 (versioninfo.json + manifest updated).
Backend legacy classification (`BINARY_SELF_UPDATE_MIN_VERSION = 2.1.1`)
already routes 2.1.1 devices to the EXE payload, so the 2.1.1 fleet can be
updated to 2.1.2 from the UI. GitHub Actions builds the 2.1.2 MSIs on push.

### Rollout

1. Upload `/private/tmp/techi-agent-2.1.2-native-swap.exe` as
   `file_type=agent_binary`, windows-amd64, version `2.1.2`, activate. SHA256:
   `253e0c56c4540305f7b86fd15a5e37880598ef88827d67d98c97a6965365e8de`
2. Upload/activate the CI-built `TECHI-Agent-Update-2.1.2.msi` as
   `file_type=msi` (legacy 2.1.0 devices refuse UI updates until the MSI
   version matches the active binary).
3. Pilot on one AMSI-strict device (16/112/451 via GPO or manual msiexec of
   the 2.1.2 bridge MSI — their *current* agents still use PS, so the first
   hop cannot come from UI self_update on those domains).
4. After the first hop, UI self_update works everywhere, including
   AMSI-strict domains.

### Checks

- `cd agent && go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -> clean (vet warnings in inventory_windows.go pre-exist).
- `cd backend && python3 -m pytest` -> 359 passed; the 5 failures pre-exist
  (enrollment audit diagnostics + legacy compat, unrelated).
- Final exe strings confirm `2.1.2`, `swap-binary`, `watchdog-check`,
  `schtasks.exe`; no `binary-swap-*.ps1` templates remain.

## [2026-07-03] Fix: Legacy self_update Classification Must Use Version, Not Missing SHA

### Root cause

UI self_update to devices 603 (`PDC`), 604 (`FileSharing-SRV`), 714 (`AC-SRV`)
timed out. All three run 2.1.1 fleet builds deployed via bootstrap v2 that
predate the SHA-reporting rebuild: they use the binary-swap self_update flow
but never send `agent_sha256`.

`_requires_legacy_msi_self_update` treated "no agent_sha256" as "legacy
msiexec agent" and shipped them the Agent Update Bridge MSI payload
(`sha256` = MSI hash). The binary-swap agent downloaded the MSI, the checksum
matched, and it tried to install the MSI bytes as `techi-agent.exe`. The
service could not start, rollback restored the old exe, no failure was ever
reported, and the action expired at 900s as "timeout".

Fleet impact at the time of the fix: 115 online devices were in the same trap
(2.1.1 without SHA); only 6 devices reported SHA and got the correct payload.

### Fix

`agent_command_service.py`: legacy now means `agent_version < 2.1.1`
(`BINARY_SELF_UPDATE_MIN_VERSION`). Devices reporting `agent_sha256` are
always binary-swap; devices with missing/unparseable versions still fall back
to the MSI flow. 2.1.1+ agents get the EXE payload even without a reported
SHA — completion is still verified by heartbeat SHA because the new binary
reports it after the swap.

### Operations note

The 115 affected devices run the pre-scheduled-task swap helper (child
PowerShell). The payload is now correct for them, but their internal swap is
the unreliable one — retest on 714/603/604 first and roll out in waves ≤50.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 11 passed (new regression test: 2.1.1 without SHA gets binary payload).
- Full backend suite: 358 passed; 5 failures pre-exist without the change
  (enrollment audit diagnostics + legacy compat, unrelated).
- Deployed commit `620ea31` to production: backend rebuilt, `/health` ok,
  heartbeats flowing (~496/min), new constant present in the container.

## [2026-07-02] Fix: Platform Package Download Must Serve MSI, Not Agent Binary

### Root cause

After split packaging, production can have two active Windows packages at the
same time:

- `file_type=msi` for legacy MSI self-update/GPO;
- `file_type=agent_binary` for clean binary-only self-update.

The public `/agent-packages/platform/windows-amd64/download` endpoint used
`latest_active(platform)` without a file type. Once the active EXE was newer
than the MSI, this endpoint returned `techi-agent.exe` even though legacy agents
use it as an MSI URL.

### Fix

The platform download endpoint now explicitly selects
`latest_active(platform, file_type="msi")`.

`/agent-packages/agent-binary/download` remains the EXE endpoint.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_package_public_download.py tests/test_agent_command_service.py -q`
  -> 18 passed.
- `python3 -m compileall backend/app/api/v1/endpoints/agent_packages.py`
  -> clean.

## [2026-07-02] Packaging: Split Agent Update Bridge and Remote Support MSI

### Root cause

The existing production MSI is a combined endpoint package: it contains both
`techi-agent.exe` and the TECHI Remote Support runtime. That is correct for
full bootstrap, but it is risky for routine agent upgrades because a normal
MSI major upgrade can uninstall/reinstall remote support files while operators
still depend on remote access to recover devices.

Legacy agents also still expect an MSI payload for `self_update`; sending them
the new binary-only EXE causes `msiexec` failures.

### Fix

The combined MSI is kept as fallback/full-bootstrap. Two new split packages
were added:

- `agent/installer/agent-update.wxs`
  - builds `TECHI-Agent-Update-<version>.msi`;
  - carries only `techi-agent.exe` and `agent-update-helper.ps1`;
  - does not use the combined MSI `UpgradeCode`;
  - does not run `MajorUpgrade`;
  - does not ship or stop TECHI Remote Support;
  - stops only `TechiAgent`, writes a backup, copies the new exe, recreates the
    service if missing, sets service recovery, starts it, and rolls back on
    failure.
- `agent/installer/remote-support.wxs`
  - builds `TECHI-Remote-Support-1.4.6.msi`;
  - carries only the TECHI Remote Support runtime, protocol handler, service,
    tray scheduled task, and RS config;
  - contains no enrollment token flow and no agent config writes.

GitHub Actions now builds three artifacts on Windows:

- combined full-bootstrap MSI;
- agent update bridge MSI;
- remote support MSI.

### Rollout Rule

For the existing fleet, use the Agent Update Bridge MSI first. Do not replace
the combined MSI in every GPO until device #5 and a small pilot confirm:

1. `TechiAgent` updates to `2.1.1`;
2. heartbeat reports the expected agent SHA;
3. `TECHI Remote Support` still connects;
4. `agent.config.json` keeps the same device identity.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_update_bridge_installer.py tests/test_remote_support_installer.py tests/test_agent_command_service.py -q`
  -> 21 passed.
- macOS local WiX still cannot be used as the final MSI build authority for
  this repo; Windows GitHub Actions is the expected MSI build path.

## [2026-07-02] Fix: Legacy Agent self_update Must Not Receive EXE as MSI

### Root cause

Device #5 (`PDC`) was online and receiving actions, but remained on
`agent_version=2.1.0` with empty `agent_sha256`. The local deploy log showed
the old agent self-update path:

`msiexec.exe /i C:\ProgramData\TechiAgent\cache\techi-agent-2.1.1.msi`

followed by:

`result=1620 command=msiexec.exe`

MSI exit code `1620` means Windows Installer could not open the package as a
valid MSI. The backend was sending the new binary-only EXE endpoint, while the
legacy `2.1.0` agent saved the download as `.msi` and ran `msiexec`.

NETLOGON was also still advertising `active_version=2.1.0`, so the scheduled
GPO run correctly logged `result=uptodate` and never moved the machine to the
clean `2.1.1` build.

### Fix

`AgentCommandService` now builds `self_update` payloads per device:

- clean agents that report `agent_sha256` receive the binary-only EXE payload;
- legacy agents without `agent_sha256` must receive an active MSI package for
  the same target version;
- if a matching active MSI is missing, the backend rejects the UI command with
  a clear error instead of sending an EXE to an agent that will run `msiexec`
  and fail;
- legacy MSI payloads include `target_sha256`, so completion is still verified
  by the installed `techi-agent.exe` hash from heartbeat, not by the MSI hash.

### Operations Note

Production currently has active MSI `2.1.0` and active agent binary `2.1.1`.
That means legacy agents like device #5 cannot be safely updated from the UI
until a matching `2.1.1` MSI is uploaded/activated or NETLOGON/GPO is updated
once with the clean `2.1.1` installer.

### Checks

- `python3 -m compileall backend/app/services/agent_command_service.py backend/app/services/remote_action_service.py`
  -> clean.
- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 10 passed.

## [2026-07-02] Cleanup: Ignore RustDesk Repair Counters Older Than 24h

### Root cause

Resetting historical `rustdesk_repair_count` in the database is not enough by
itself. Older agents still have the cumulative repair counter in local config
and can resend it on the next heartbeat, causing old counts to reappear in the
UI.

### Fix

`DeviceHeartbeatService` now drops stale repair counters from heartbeat device
updates when `rustdesk_last_repair_at` is missing or older than 24 hours:

- `rustdesk_repair_count` is set to `0`;
- `rustdesk_last_repair_at` is set to `NULL`.

Recent repair counters inside the last 24 hours are preserved, so active repair
loops remain visible.

### Operations

Before deploying this backend filter, production historical repair counters
older than 24 hours were backed up to:

`device_repair_count_reset_20260702`

and reset for 314 devices.

### Checks

- `python3 -m compileall backend/app/services/device_heartbeat_service.py`
  -> clean.
- `cd backend && python3 -m pytest tests/test_rustdesk_repair_event_throttle.py tests/test_rustdesk_heartbeat_sync.py -q`
  -> 8 passed.

## [2026-07-02] Fix: self_update Batch Completion Must Wait for Heartbeat SHA

### Root cause

On device #5 (`PDC`), the agent reported `self_update` as completed, but the
next heartbeat still showed `agent_version=2.1.0` and empty `agent_sha256`.
This is the old false-positive behavior: older agents report that the
background swap was initiated, not that the new binary is actually running.

### Fix

Backend `RemoteActionService.complete()` now treats `self_update` specially:

- agent callback "complete" moves the action to `running` with
  `Self-update initiated; awaiting heartbeat verification` unless the device
  already reports the target version/SHA;
- `DeviceHeartbeatService` verifies running `self_update` actions after each
  heartbeat and marks them completed only when `agent_sha256` matches the
  active package payload;
- bulk `self_update` timeout is raised to at least 900 seconds so server
  swaps, restarts, and heartbeat verification have enough time.

### Checks

- `cd backend && python3 -m pytest tests/test_agent_command_service.py -q`
  -> 7 passed.
- `python3 -m compileall backend/app/services/remote_action_service.py backend/app/services/device_heartbeat_service.py backend/app/services/agent_command_service.py`
  -> clean.

## [2026-07-02] Fix: Watchdog Task Creation on Clean 2.1.1 Build

### Root cause

Device #11 successfully updated to the clean `2.1.1` binary and reported the
expected SHA256, but `Get-ScheduledTask -TaskName "TECHI Agent Watchdog"`
returned not found after service restart. The installed binary was correct;
the issue was in the watchdog registration script. It set repetition fields by
mutating `$repeatTrigger.Repetition.Interval` / `.Duration`, which is not
reliable across Windows PowerShell/ScheduledTasks implementations.

The agent service log path is:

`C:\ProgramData\TechiAgent\logs\agent.log`

not:

`C:\ProgramData\TechiAgent\agent.log`

### Fix

`agent/watchdog_windows.go` now creates the repeat trigger using the supported
parameters directly:

```powershell
New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
```

It also writes watchdog install success/failure to:

`C:\ProgramData\TechiAgent\deploy.log`

with `[watchdog-install]`, so failures are visible even when operators do not
know the agent log location.

### Final replacement binary

Upload this as `file_type=agent_binary`, platform `windows-amd64`, version
`2.1.1`, then activate it:

`/private/tmp/techi-agent-2.1.1-watchdog-fix.exe`

SHA256:

`264516f15e2fe26fccb334bb017845f4ecee7a4cb4b9711e9e3f437a3a216600`

### Checks

- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- Final binary strings confirm `2.1.1`, `TECHI Agent Watchdog`,
  `watchdog-install`, and `-RepetitionInterval`.

## [2026-07-02] Hardening: Same-Version Agent Rebuilds Verified by SHA256

### Root cause

Keeping the public agent version at `2.1.1` is correct, but version-only
comparison is not enough when we rebuild the same version to fix self-update,
watchdog, or deployment behavior. A device can report `2.1.1` while still
running an older `2.1.1` binary if the previous self-update did not complete.

Another old path was confusing the UI: some backend checks read the active
`windows-amd64` package without filtering `file_type="agent_binary"`, so they
could compare the fleet against the MSI package instead of the active
standalone agent binary.

### Fix

- The agent now sends `agent_sha256` during enrollment and every heartbeat.
- `devices.agent_sha256` stores the last reported hash.
- Fleet overview exposes both `active_agent_version` and
  `active_agent_sha256`.
- "Needs Agent Update" uses version plus SHA256 when the active package is an
  `agent_binary`.
- `/api/v1/agent-packages/active-version` now prefers the active
  `agent_binary` over the MSI package.
- Command Center target `outdated_agents` is now a real backend target for
  `self_update`; it queues only devices whose version or binary hash differs
  from the active agent binary.

### Final 2.1.1 binary for upload

Upload this as `file_type=agent_binary`, platform `windows-amd64`, version
`2.1.1`, then activate it:

`/private/tmp/techi-agent-2.1.1-clean.exe`

SHA256:

`f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`

### Checks

- `cd backend && python3 -m pytest tests/test_agent_package_public_download.py tests/test_device_scope.py tests/test_agent_command_service.py tests/test_remote_support_connect_url.py tests/test_enrollment_bootstrap_script.py -q`
  -> 144 passed.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- `cd frontend && npm run build`
  -> clean.
- Final binary strings confirm `2.1.1`, `TECHI-Agent-SelfUpdate`, and
  `TECHI Agent Watchdog`.

## [2026-07-02] Hardening: TechiAgent Watchdog Scheduled Task

### Root cause

Windows Service recovery actions restart `TechiAgent` after process failure,
but they do not reliably cover every operational case we hit during recovery:
manual stop, a service left stopped after an interrupted script, or a missing
service entry while `techi-agent.exe` still exists. Also, if `TechiAgent` is
already stopped, the agent process cannot execute code to start itself.

### Fix

`agent/watchdog_windows.go` adds a separate Task Scheduler watchdog:
- On agent startup, `ensureAgentServiceWatchdog()` registers/refreshes
  `TECHI Agent Watchdog` as `SYSTEM`.
- The task runs at Windows startup and then every 5 minutes.
- It checks `TechiAgent`; if stopped, it starts it.
- If the service entry is missing but
  `C:\ProgramData\TechiAgent\techi-agent.exe` exists, it recreates the service
  and starts it.
- It reapplies SCM failure actions
  `restart/60000/restart/60000/restart/300000`.
- It logs to `C:\ProgramData\TechiAgent\deploy.log` with `[watchdog]`.

Non-Windows builds use a no-op implementation.

### Checks

- Final same-version binary for upload:
  superseded by `/private/tmp/techi-agent-2.1.1-clean.exe`, SHA256
  `f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache GOOS=windows GOARCH=amd64 go build ./...`
  -> clean.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...`
  -> clean.

## [2026-07-02] Fix: Remote Support Connect Must Not Depend on Agent Heartbeat

### Root cause

During recovery, some machines had no TechiAgent heartbeat, so the platform
marked the device as offline and `/api/v1/remote-support/devices/{id}/connect-url`
returned `422 "Device is OFFLINE — cannot initiate remote session"`.

That block was too strict. TECHI Remote Support runs as a separate Windows
service and can still be reachable through its RustDesk/TECHI Remote ID even
when the monitoring agent is stopped, stuck in update, or missing heartbeat.
In this incident, blocking connect removed the exact fallback path operators
needed to inspect/recover the machine.

### Fix

`backend/app/api/v1/endpoints/remote_support.py`:
- `connect-url` still rejects devices with no valid TECHI Remote ID.
- It no longer rejects only because computed remote support status is
  `offline` from stale `device.last_seen`.
- Audit logs now include the computed `remote_support_status`, so operators can
  see whether the connection was attempted while heartbeat was stale.

`frontend/src/pages/RemoteSupport.tsx`:
- The Connect button is enabled whenever a TECHI Remote ID exists.
- If status is offline, tooltip now says "Agent heartbeat offline — try remote
  session" instead of disabling the action.

### Checks

- `cd backend && python3 -m pytest tests/test_remote_support_connect_url.py -q`
  -> 5 passed.
- `cd frontend && npm run build` -> clean.

## [2026-07-02] Fix: self_update Must Use Scheduled Task, Not Child PowerShell

### Root cause

Device 590 (`Server002`) accepted `self_update` for v2.1.1 and the action
completed with payload SHA256 `3f0917e245...`, but later heartbeats still
reported agent version `2.1.0`. The active uploaded binary was verified by
SHA256 and contained version string `2.1.1`, so the problem was not the UI
payload or the uploaded package.

The remaining unsafe part was `agent/update.go`: it launched the binary-swap
PowerShell helper as a child process of `TechiAgent` with
`CREATE_NEW_PROCESS_GROUP`. That is not a hard detach from the service's
process/job tree. When the helper stops `TechiAgent`, Windows can still
terminate that child helper before the swap finishes. This is the same class
of failure as the earlier v1 PowerShell rollout incident.

### Fix

`agent/update.go` now writes a small launcher PS1 that registers a one-shot
Scheduled Task named `TECHI-Agent-SelfUpdate-*` as `SYSTEM`, starts it, and
returns. The task runs the real binary-swap helper independently of the agent
process, then unregisters itself on success or failure. The swap still does
download verification before scheduling, stop -> backup -> replace -> start,
and rollback on failure.

Operator decision: keep the public agent version at `2.1.1` and rebuild/re-upload
the `agent_binary` package with the same version string but a new SHA256, rather
than creating `2.1.2`. Superseded by the final clean build above:
`/private/tmp/techi-agent-2.1.1-clean.exe`, SHA256
`f0eaddc9d4957df02faf9f082fba0b5ab557609d319e55595b2288e084a6b4f5`.

### Related GPO recovery hardening

`techi-deploy.cmd` generation now calls `:recover_missing_agent_binary` before
the `VERSION_STATE=equal` / `:already_uptodate` gate. If registry says the MSI
version is current but `C:\ProgramData\TechiAgent\techi-agent.exe` is missing,
the script restores one of the known incident backup names
(`techi-agent-new.exe`, `techi-agent-old.exe`, `techi-agent.new.exe`,
`techi-agent.previous.exe`) and starts the service. If no backup exists, it
forces `VERSION_STATE=missing` so the scheduled GPO run reinstalls from the
NETLOGON MSI instead of falsely treating the machine as up to date.

### Checks

- Active prod agent binary download SHA256 verified:
  `3f0917e245103dd9de0b4497c1f35e9d93e26f9827338de0415ea89dd0196de4`.
- Device 590 action history confirmed `self_update` completed but heartbeat
  stayed `2.1.0`, proving command completion alone was not sufficient evidence
  of swap completion.
- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -> 107 passed.
- `cd agent && GOOS=windows GOARCH=amd64 go build ./...` -> clean.
- Fixed same-version binary built with
  `AgentVersion=2.1.1`; strings confirm `TECHI-Agent-SelfUpdate-*` and `2.1.1`.
- `cd agent && GOCACHE=/private/tmp/techi-go-cache go test ./...` -> clean.

## [2026-07-02] INCIDENT: Fleet Bootstrap v1 Killed 253 Devices — Root Cause, Fix, Recovery

### Root cause

Gjatë përpjekjes për të instaluar binaryni e ri (v2.1.1) me `run_powershell`
te gjithë fleet-i (~624 devices), skripti i parë (v1) dërgoi `sc.exe stop
TechiAgent` nga brenda i njëjti PowerShell proces që kishte lançuar vetë
agjenti. Kur agjenti ndalet, Windows mund të kill-ojë child process-in
(PowerShell-in) si pjesë e i njëjtit job object. Ky kill ndodhte MES dy
`Move-Item` operacioneve (rename old → backup, rename new → current):
- `techi-agent.exe` u fshi (mov-uar te `techi-agent-old.exe`)
- `techi-agent-new.exe` nuk arriti të vendoset në vend
- Rollback-u nuk funksionoi (procesi ishte vrarë)
- Shërbimi nuk mund të rifillonte (exe mungonte)
- 175 device kaluan offline ndërmjet 13:39–13:42 (peak: 80 @ 13:40, 73 @ 13:41)

Problemi dytë: binari origjinal i vjetër (v2.1.0, SHA256 `5ee07dff...`,
instaluar nga MSI me 26 qershor) kishte kodin e vjetër të `update.go` me
`msiexec /i` dhe jo binary-swap. Ai shkruante helperin PS1 (`self-update-*.ps1`)
por PS1-i thirrte `msiexec` mbi një `.exe` — komanda dështonte pa log
(deploy.log mungonte). Kjo shpjegon pse `self_update` komanda tregonte
"Completed" por asgjë nuk ndodhte.

Gjithashtu: loop-i i pritjes pas `sc stop` dilte kur statusi bëhej
`StopPending` (jo `Stopped`) — procesi ishte akoma gjallë dhe mbante
lock-un mbi exe-n. `Move-Item` dështonte, catch block bënte rollback.

### Çfarë u fiksua

**`agent/update.go` commit `bcf0c24`:**
- Loop ndryshoi nga `while status != 'Running'` në
  `while status not in ('Stopped','missing')` — pret plotësisht
- `Stop-Process -Name techi-agent -Force` + 3 sekonda pas loop-it
- Kontroll eksplicit i file lock para rename-it

**Bootstrap manual njëherësh për DESKTOP-IM4V3G4 (device 11):**
Skript manual (jo nëpërmjet agjentit) i dërguar direkt; stop → kontroll
lock → swap → start. SHA256 `3f0917e245...` konfirmuar. v2.1.1 online.

**Bootstrap v2 (Scheduled Task) për fleet-in:**
Skript i ri me dy faza: (1) shkarkon binary-n dhe regjistron Scheduled Task
SYSTEM — pastaj del menjëherë pa pritur. (2) Task-u (SYSTEM, i pavarur)
kryen stop→swap→start. Kështu kill-i i agjentit nuk prek swap-in.
Rezultat: 186/440 completed ✅ (127 failed + 127 timeout = download overload
— 440 device njëkohësisht nga i njëjti backend endpoint i vogël).

### Gjendja pas incidentit (DB query 14:10)

```
online   : 430  (192 = v2.1.1 ✅,  236 = v2.1.0 akoma)
offline  : 286  (207 nga v2.1.0 batch v1,  6 v2.1.1 temp gjatë swap)
Datat e incidentit: 13:39–13:42 peak; 24 offline në 30 min e fundit
                    (scheduled tasks nga batch v2 duke bërë swap temp)
```

Të gjithë 430 online kanë `rustdesk_id` valid — RS funksionon.

### Recovery për device-t offline

**Script recovery (qasje fizike / RDP / mjet tjetër):**
```powershell
$d='C:\ProgramData\TechiAgent'
$exe="$d\techi-agent.exe"; $old="$d\techi-agent-old.exe"; $new="$d\techi-agent-new.exe"
if(-not(Test-Path $exe)){
    if(Test-Path $new){Move-Item $new $exe -Force}
    elseif(Test-Path $old){Move-Item $old $exe -Force}
}
net.exe start TechiAgent
```

**GPO Startup Script `techi-recovery.ps1`:**
Të shtuar te Metropol domain GPO → Computer Configuration → Scripts →
Startup: kontrollon nëse exe ekziston, e rivendos nga `*-new.exe` ose
`*-old.exe`, riniset shërbimi. Ekzekutohet automatikisht në reboot.

**Nëse asnjë exe nuk ekziston:**
```
msiexec /i \\METROPOLGROUP.LOCAL\NETLOGON\TECHI-Agent-2.1.0.msi /quiet
```

### Mësimet

- Kurrë mos ndalo shërbimin nga brenda child process-it të tij (run_powershell
  ekzekutohet si child i TechiAgent). Gjithmonë detach (Scheduled Task SYSTEM)
  para `sc stop`.
- Batch i madh njëkohësisht (440 download × 7MB) overload-on backend-in.
  Dërgo në grupe ≤50, prit 2 min mes grupeve.
- Testoji skriptet e reja te 1–2 device para dërgimit te gjithë fleet-i.

## [2026-07-02] Deploy stable/phase-2-heartbeat → prodhim (rdp.techi.com.al)

### Commits të deployu

- `e5d11f3` feat: binary-only self_update + Agent Binary tab
- `8a08665` fix: TOML read-only pas repair (rustdesk_repair_count)
- `1df0d46` fix: enrollment_token self-heal për device-t e bllokuara
- `137ecfb` fix: restore Windows Service TECHI Remote Support

### Hapat e deploy-it

```
git pull origin stable/phase-2-heartbeat   # 12 skedarë të re
docker compose build backend               # Python:3.12-slim, kodi i ri i ngarkuar
docker compose up -d backend               # Recreated → healthy
docker compose build frontend              # Node:20-alpine + npm run build (19s)
docker compose up -d frontend              # Recreated → healthy
```

### Health checks

- `curl http://127.0.0.1:8000/health` → `{"status":"ok","environment":"production"}`
- `docker compose ps` → të tre containers healthy (postgres, backend, frontend)
- `python3 -c "from app.schemas.agent_package import AgentFileType"` → OK
- `GET /api/v1/agent-packages/agent-binary/download` → HTTP 404 (endpoint aktiv, paketë e ngarkimit pritet)

### Hapi tjetër

Ngarko `techi-agent.exe` v2.1.1 te UI → Agent Packages → **Agent Binary tab** → Activate.
Dërgo `self_update` nga Command Center → device 11 → verifiko RS.exe SHA256 i pandryshuar.

## [2026-07-02] Binary-Only self_update: techi-agent.exe Swapped Without Touching TECHI Remote Support

### Arkitektura e re

Dy kategori të ndara paketash:
- **MSI** (`file_type=msi`): GPO, fresh install, PC të reja.
  Përmban techi-agent.exe + TECHI Remote Support bashkë.
- **Agent Binary** (`file_type=agent_binary`): vetëm techi-agent.exe.
  Përdoret nga komanda `self_update` përmes UI.
  TECHI Remote Support nuk preket kurrë.

### Ndryshimet

**Backend** (`agent_package_service.py`, `agent_package.py`,
`agent_packages.py`, `agent_command_service.py`):
- Shtohet `AgentFileType` enum (`msi` | `agent_binary`) te skema.
  Nuk nevojitet Alembic — hapësira e paketave është file-based (JSON
  manifest), jo tabelë DB.
- `upload()` pranon `file_type` (default `msi`); manifest-i ruan vlerën
  në çdo hyrje të re; hyrjet ekzistuese pa `file_type` lexohen si `msi`.
- `latest_active(platform, *, file_type=None)` mund të filtrojë sipas
  llojit; `set_active()` çaktivizon vetëm paketat e së njëjtës
  `platform + file_type` (kështu aktivizimi i MSI nuk çaktivizon
  binary-n dhe anasjelltas).
- Endpoint i ri `GET /api/v1/agent-packages/agent-binary/download` —
  kthen binary-n aktiv `agent_binary / windows-amd64`, publik (pa token).
  Vendoset para `/{package_id}/download` në router kështu FastAPI nuk
  e trajton `agent-binary` si një package_id.
- `_build_self_update_payload()` tani merr paketën `agent_binary` aktive
  dhe ndërton URL-në drejt endpointit të ri.

**Frontend** (`agentPackages.ts`, `AgentPackages.tsx`,
`AgentCommandsPanel.tsx`):
- `AgentPackage` interface fiton `file_type: AgentFileType`.
- `uploadAgentPackage()` dërgon `file_type` si form field.
- `AgentPackages.tsx` ka tani dy tab: **MSI Packages** dhe
  **Agent Binary** — secilit i shfaqen vetëm paketat e llojit të vet;
  upload-i ndryshon `accept` dhe dërgon `file_type` automatikisht.
- Modal i `self_update` te `AgentCommandsPanel` tani tregon paketën
  `agent_binary` aktive (jo MSI-n) dhe teksti i paralajmërimit
  është ndryshuar: "~30 sekonda" (jo "~2 minuta"),
  "TECHI Remote Support nuk preket".

**Agent Go** (`update.go`):
- `performSelfUpdate()` tani shkarkon `.exe` (jo `.msi`) dhe lançon
  një helper PowerShell të shkëputur (`binary-swap-*.ps1`) që bën:
  stop service → backup old exe → move new exe → start service →
  rollback automatik nëse start dështon. MSI (`msiexec`) nuk thirret
  kurrë gjatë self_update. TECHI Remote Support.exe nuk preket.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` — clean.
- `pytest` — 229 passed (4 gabime pre-ekzistuese DB, jo lidhur me
  ndryshimet tona).
- `tsc --noEmit` — pa gabime TypeScript.
- Deploy: backend `docker compose build backend && up -d backend`;
  frontend `npm run build` + sync; agent binary: shpërndarje vetëm
  e binarit Go (nuk kërkon MSI rebuild).

## [2026-07-02] RustDesk Periodically Wiped custom-rendezvous-server, Accumulating 40 000+ Repairs on Servers

### Root cause

The agent correctly repaired the managed `[options]` keys in
`TECHI Remote Support.toml` (custom-rendezvous-server, relay-server,
key) but left the file writable after every repair. When the
"TECHI Remote Support" Windows Service restarted (e.g., via the SCM
failure-recovery policy the agent itself sets -- 15 s/15 s/60 s),
RustDesk overwrote its own config, wiping those keys. The 30-minute
cooldown meant a repair every ~33 minutes; on long-running servers
this accumulated rustdesk_repair_count in the tens of thousands.

### Fix

`agent/rustdesk_readonly.go` (new, no build tag -- `os.Chmod` is
cross-platform):
- `setTomlReadOnly(path)` -- `os.Chmod(path, 0444)`, maps to
  `FILE_ATTRIBUTE_READONLY` on Windows. Logged on error, never
  propagated.
- `removeTomlReadOnly(path)` -- `os.Chmod(path, 0644)`, clears it.

`agent/rustdesk_manage.go`:
- `writeRustDeskConfig`: for each existing repaired file, calls
  `removeTomlReadOnly` immediately before `os.WriteFile` and
  `setTomlReadOnly` immediately after. Fresh file initialisation
  intentionally does NOT set read-only -- RustDesk must be able to
  write its own identity fields (id, enc_id, key_pair) on first run;
  the next heartbeat cycle patches and protects the file then.
- `setRustDeskPassword`: same remove-write-set pattern so UI password
  updates are not blocked by the read-only bit.

### Checks

`agent/rustdesk_readonly_test.go` (new):
- Patch + setReadOnly + simulate RustDesk overwrite -- write blocked,
  content unchanged.
- setReadOnly + removeReadOnly + write -- write succeeds.
- Two consecutive remove-patch-setReadOnly cycles -- file correct and
  read-only after both rounds.
- helpers on non-existent path -- no panic, only logs.
- `go test ./...` clean. No MSI rebuild needed -- binary-only fix.

## [2026-07-01] Device Aliases and Domain-to-Client Mapping

### Root cause

Some devices enrolled with generic Windows hostnames such as
`DESKTOP-...`, and some customer domains were very short, for example
`X`. The fleet tree used the automatically created client/domain name,
so operators could not safely present the real customer name without
risking future enrollments being assigned back to the old short domain
client.

The new Domain Mapping panel also showed existing trusted-domain
fallback rows with no explicit client mapping. Those rows appeared as
`Fallback by domain name`, which made the panel look like it contained
real mappings that operators had not configured.

### Fix

- Added editable device display names as UI aliases without renaming the
  Windows hostname or changing enrollment identity.
- Added trusted-domain-to-client mapping so a reported domain such as
  `x` can be mapped to the real client, for example `X-PlanStudio`.
- Kept fallback trusted domains working server-side, but hid fallback
  rows from the Domain Mapping panel unless they have a real `client_id`.
- Updated the Domain Mapping helper text and placeholder to use the
  exact domain value shown on devices, for example `x`, instead of
  suggesting `x.local` by default.

### Checks

- Added backend coverage for mapped trusted domains assigning new and
  existing devices to the configured client.
- Ran focused backend tests for trusted-domain mapping and Windows
  device classification.
- Ran the frontend production build.
- Deployed the mapping flow and the follow-up UI cleanup to production.
- Verified production containers are healthy and the frontend returns
  `200 OK`.

## [2026-06-30] Command Center Bulk Password Should Target Online Devices

### Root cause

Manual per-device `set_remote_password` worked, but several bulk
Command Center runs looked stuck as `running`. Production DB showed the
manual device-targeted batches completed, while older `all`/`client`
batches had `total=0` actions and therefore could never satisfy the
old `finished = total > 0 and done == total` check. Bulk password also
used a 30-second UI default timeout even though commands are delivered
on the next heartbeat, commonly every 60 seconds.

### Fix

Added an `online` bulk target. Operators can now send password rotation
to online devices only, avoiding offline devices that cannot pick up
the command until later. `set_remote_password` bulk timeout is now
raised to 300 seconds server-side even if an older UI sends a lower
value, and the UI default is also 300 seconds. Empty historical batches
now report `finished=true` with 100% progress instead of appearing to
run forever.
Batch creation is also atomic now: the backend no longer commits the
batch row before its per-device actions are added, so a transient error
cannot leave a new zero-target batch behind.
The confirm modal now submits as a real form, shows send errors inside
the modal, and refreshes Command History immediately after a batch is
created.
Large online batches now flush each `RemoteAction` through SQLAlchemy's
single-row insert path inside the same transaction. This avoids a
Postgres enum cast failure where the ORM's multi-row insert bound
`remote_actions.status` as `VARCHAR` instead of the `actionstatus` enum.

### Checks

- Added `backend/tests/test_agent_command_service.py` for online-only
  targeting, password timeout normalization, empty-batch progress, and
  normal completed-batch progress.
- Added coverage that an empty online target creates no batch/actions.
- Ran the new backend test file and frontend production build.
- Verified the frontend production build emits a new JS asset after the
  modal/history refresh fix.
- Verified from production logs that the bulk failure was a Postgres
  `actionstatus` enum mismatch during multi-row insert.

## [2026-06-28] GPO Token Repair Must Write Canonical Config Without UTF-8 BOM

### Root cause

On RHGDC1, the scheduled task upgraded the agent to 2.1.0, repaired
`agent.config.json` with the GPO enrollment token, and started the
service. A manual `techi-agent.exe -once` still failed immediately with:

`config migration failed: invalid character 'ï' looking for beginning of value`

The repair step wrote JSON using Windows PowerShell `Set-Content
-Encoding UTF8`, which on Windows PowerShell 5 emits a UTF-8 BOM. The
agent's Go JSON parser then rejected the canonical config before it
could enroll or send heartbeat.

### Fix

`techi-deploy.cmd` now writes repaired canonical config with
`System.IO.File.WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`
so the file is UTF-8 without BOM. The repair also rewrites any
unenrolled config that already has a token, which lets existing BOM
configs self-heal on the next scheduled task run without reinstalling.
After a repair-triggered service restart, the script now waits briefly
before validation so `deploy.log` does not record a false `result=failed`
while the service is still transitioning.

### Checks

- Updated bootstrap script tests to reject the old PowerShell
  `Set-Content -Encoding UTF8` writer and require the no-BOM
  `UTF8Encoding` writer.
- Added a check that repair-triggered restarts wait before final
  validation.

## [2026-06-28] GPO Equal-Version Devices Could Stay Unenrolled Without a Token

### Root cause

After the GPO Scheduled Task fixes, a Metropol test machine showed the
new task running and `techi-deploy.cmd` logging `result=uptodate`
because registry version was already 2.1.0 and `TechiAgent` was
running. The device still never appeared online because the agent log
repeated:

`enrollment_token is required when trusted domain auto-enrollment is
disabled or domain is not trusted`

This is a distinct equal-version stuck state: since the package was
already 2.1.0, GPO did not run `msiexec /i` again, so the MSI did not
rewrite the legacy config with `ENROLLMENT_TOKEN=...`. The running
agent had a canonical config with no `device_id`/`agent_id` and no
`enrollment_token`; it kept retrying enrollment without credentials.

### Fix

`techi-deploy.cmd` generation now calls `:repair_unenrolled_config`
before taking the `VERSION_STATE=equal` / `:already_uptodate` branch.
The repair is narrowly scoped: if canonical config exists (or can be
copied from legacy), has no `device_id`, no `agent_id`, and no
`enrollment_token`, it injects the current GPO token into canonical
config and restarts `TechiAgent` so the already-running process reloads
the token immediately. Already-enrolled devices or devices that already
hold a token are left untouched.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  the repair runs before `:already_uptodate`, patches only missing
  `enrollment_token`, logs `enrollment_token_repaired`, and restarts
  `TechiAgent` when it acts.

## [2026-06-28] GPO UI Script Now Removes the Legacy `TECHI Agent Startup` GPO

### Root cause

Domains that had already run older deployment scripts could still have
the separate `TECHI Agent Startup` GPO linked and active. The current
deployment model uses only two GPOs (`TECHI Agent - Defender
Exclusions` and `TECHI Agent Deployment`) and relies on the scheduled
task's own boot trigger for startup execution. Because the new script
only updated the two current GPOs, it left the old startup-script GPO
behind, creating a parallel deployment path and noisy/ambiguous client
diagnostics.

### Fix

`backend/app/services/enrollment_bootstrap_service.py`: the generated
UI GPO script now checks for `TECHI Agent Startup` immediately after
domain discovery. If present, it disables the GPO and deletes it with
`Remove-GPO`; if absent, it continues normally. Cleanup failures are
logged as warnings and do not block creating/updating the two current
GPOs.

Follow-up from real DC run: `Set-GPO` is not a valid GroupPolicy
cmdlet, so the cleanup warninged and continued. The cleanup now uses
real cmdlets: it enumerates domain/OU links with `Get-GPInheritance`,
disables matching links with `Set-GPLink -LinkEnabled No`, then deletes
the legacy object with `Remove-GPO`.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  legacy GPO cleanup and to keep guarding against reintroducing
  `Machine\Scripts\Startup` / `scripts.ini` startup-script plumbing.

## [2026-06-28] GPO Scheduled Task Was Applied but Not Created on Windows Server 2016

### Root cause

Metropol ALPHADB showed `TECHI Agent Deployment` as an applied computer
GPO, and Group Policy logged successful Scheduled Tasks Extension
processing, but `schtasks /query /tn "TECHI Agent Deploy"` returned
"file not found". NETLOGON was reachable, the current MSI and
`techi-deploy.cmd` were present, and a manual
`cmd /c "\\metropolgroup.local\NETLOGON\techi-deploy.cmd"` installed
2.1.0 successfully and brought the device online. Extracting the inner
Task Scheduler XML from `ScheduledTasks.xml` and registering it manually
failed on ALPHADB with `LogonType:ServiceAccount`; a direct `schtasks
/create /ru SYSTEM ...` worked. The GPP wrapper was fine, but the inner
Task Scheduler XML used `NT AUTHORITY\System` plus
`<LogonType>ServiceAccount</LogonType>`, which Server 2016 rejected.

The same run also exposed a false negative in `techi-deploy.cmd`:
`for /f "tokens=3"` over `sc query` captured the numeric state `4`,
not the text `RUNNING`, so deploy logged `result=failed` even though
MSI exit code was 0, registry version was 2.1.0, the service was
actually running, and heartbeats were arriving.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`: generated
  GPP ScheduledTasks XML now keeps the outer GPP `runAs`/`logonType`
  wrapper, but the inner Task Scheduler principal uses the locale-safe
  SYSTEM SID (`S-1-5-18`) and omits the inner
  `<LogonType>ServiceAccount</LogonType>`. This matches the manual DC
  patch that immediately made ALPHADB create `TECHI Agent Deploy` with
  boot + 09:00/13:00/21:00 triggers.
- `techi-deploy.cmd` generation now normalizes `sc query` state `4` to
  `RUNNING` before success validation/logging, preventing false
  `result=failed` entries after successful installs.

### Checks

- Updated `backend/tests/test_enrollment_bootstrap_script.py` to assert
  `S-1-5-18`, absence of the inner `LogonType`, and service-state
  normalization.

## [2026-06-28] Devices Stuck Without a device_id Stayed Stuck Forever, Even After a Fresh, Valid Enrollment Token Was Written

### Root cause

Testing the restored Remote Support service (see entry below) on NODE02
surfaced a second, independent bug: after a clean MSI upgrade with the
correct, healthy "Metropol" enrollment token passed via
`ENROLLMENT_TOKEN=`, the device still failed every heartbeat with
"enrollment_token is required" and never got a `device_id`. The
deploy log showed `service_before=not-installed` before this run,
meaning NODE02's prior install was already in a broken state with no
TechiAgent service registered at all -- so it had likely never
completed a single successful enrollment.

There are two `agent.config.json` locations: the MSI's
`WriteAgentConfig` custom action always writes to the "legacy" path
(`C:\ProgramData\TECHI\agent.config.json`), but the agent binary itself
only ever reads `C:\ProgramData\TechiAgent\agent.config.json` (the
"canonical" path, `agent/paths.go`). A one-time bridge
(`migrateConfigIfNeeded`) is supposed to copy legacy into canonical,
but it only ran the copy if the canonical file was completely absent.
For a device whose canonical file already existed in a broken,
never-enrolled state (no `device_id`, no token -- from any earlier
crashed or interrupted install), the bridge saw "file exists" and did
nothing, forever -- even though every later MSI run kept writing a
perfectly valid, fresh token into the legacy file right next to it.
This is the same failure NODE04 hit earlier in this engagement, fixed
there with a one-time manual edit; NODE02 showed it is not a one-off
but a fleet-wide class of bug for any device that ends up in this
specific broken state.

### Fix

`agent/paths.go`: added `refreshEnrollmentTokenIfNeeded`, called from
`migrateConfigIfNeeded` whenever the canonical config already exists.
It only acts when the canonical file has no `device_id` and no
`enrollment_token` of its own, and the legacy file has a usable token
-- in which case it patches just the `enrollment_token` field into the
canonical file, leaving everything else (including a device that is
already enrolled, or already holds its own token) completely
untouched. This lets a stuck, never-enrolled device self-heal on its
next service start/heartbeat cycle, without needing the kind of
manual one-time fix NODE04 needed.

### Checks

- Added `agent/paths_test.go` covering: legacy-to-canonical copy when
  canonical is absent (pre-existing behavior), an enrolled device
  (`device_id` set) is never touched, a stuck unenrolled device gets
  its token refreshed from legacy, a stuck device that already has its
  own token is left alone, and a no-op when the legacy file is also
  missing.
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- all clean.
- Manual one-time recovery script provided for NODE02 in the meantime
  (writes the live "Metropol" token directly into the canonical file
  and restarts the service), mirroring the earlier NODE04 fix --
  this code change prevents needing that manual step on future
  devices that hit the same stuck state.

## [2026-06-28] Restored the Windows Service for TECHI Remote Support: --tray Alone Has No Daemon to Accept Connections

### Root cause

After fixing the GPO/NETLOGON and enrollment issues, NODE04 came back
online correctly (heartbeat, version 2.1.0) but "connect" from the
platform still failed, and `sc query`/`Get-Service` showed no
"TECHI Remote Support" service at all -- only the Scheduled-Task-
launched tray process. Earlier in this engagement, the Windows Service
for Remote Support was deliberately dropped in favor of a Scheduled
Task running `--tray`, on the theory that a SYSTEM-context service
(Session 0) can't do interactive screen capture. That theory was
wrong: RustDesk's own source (`src/platform/windows.rs`,
`get_create_service`/`install_service`) creates exactly this kind of
service to run its real connection daemon, and `--tray` (`core_main.rs`,
`tray.rs`) is documented in RustDesk's own comments as only showing an
icon -- "the tray icon is only shown when the service is running." A
tray-only install looks installed/running in monitoring but has no
daemon listening for incoming connections at all, so every connect
attempt fails. This was flagged as an open question earlier in this
engagement and deliberately deferred; revisited now that the
password/enrollment issues are resolved and this is the one remaining
blocker.

### Fix

Restored the service as the real daemon, keeping the Scheduled Task
+ `--tray` as a cosmetic companion icon (matches RustDesk's own
`install_service()`, which creates the SCM service AND drops a
`--tray` shortcut for the logged-on user -- the same hybrid, just via
a Scheduled Task instead of a Startup-folder shortcut):

- `agent/rustdesk_manage.go`: restored `ensureRustDeskService` /
  `setRustDeskServiceRecovery` (creates/starts the SCM service if
  missing or stopped, with an auto-restart failure policy) and added
  `stopRustDeskServiceFn` / `startRustDeskServiceFn` for action
  handlers. `ensureRustDesk`'s heartbeat loop now ensures both the
  service (primary) and the tray (cosmetic) every cycle. Kept the
  TOML-based `setRustDeskPassword` from the earlier fix -- it works
  the same regardless of service vs. tray.
- `agent/actions_windows.go`: `restart_rustdesk`, `reinstall_rustdesk`,
  `reopen_rustdesk`, `repair_config_rustdesk`, `set_remote_password`,
  and `deploy_remote_support`'s Phase 6 all now stop/start the service
  as the primary action, with the tray restarted alongside it
  (non-fatal if the tray step fails).
- `agent/installer/installer.wxs`: restored the
  `ServiceControl Id="StopTechiRemoteSupport"` (stop-on-uninstall)
  that was removed earlier -- the service itself is still created at
  runtime by the agent (`sc create`), not declaratively by the MSI,
  matching how it has always worked. Updated the comments that
  asserted the now-corrected "no service, Session 0" rationale on
  `REMOTESUPPORTFOLDER`, `KillTechiRSBeforeInstall`,
  `RemoveRustDeskTrayArtifacts`, and `CreateRustDeskTrayTask`.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean.
- `wix build` against the modified `installer.wxs` (with fake
  `-d SourceDir`) produces the exact same `WIX0200`/`WIX0389` errors,
  same count, as the unmodified file on this macOS/mono host -- a
  known pre-existing host limitation, not a regression. A Python
  regex scan confirms zero literal `--` sequences inside any XML
  comment (the recurring WIX0104-class bug from earlier in this
  engagement).
- Not yet verified on a real machine with the new MSI -- pending CI
  build and a fresh test on NODE04.

## [2026-06-28] techi-deploy.cmd's :read_registry Was Silently Broken on Every Run, Forcing Unnecessary Reinstalls Fleet-Wide

### Root cause

The real explanation for "650 devices offline" on metropolgroup.local,
found by reproducing on NODE04 with a clean, non-wrapped invocation
(`& $DeployScript` directly from PowerShell, no `cmd.exe /c` involved
at all): `techi-deploy.cmd`'s `:read_registry` label printed "The
syntax of the command is incorrect." -- twice, matching its two call
sites -- on every single run, regardless of how the script was
invoked. Its one-liner nested three layers of quoting (batch
`for /f ... in ('...')` + a PowerShell `-Command` string + a regex
inside that), and that combination was malformed. Because the `for /f`
command itself failed to even parse, it produced no output to
capture, so `REG_VERSION`/`REG_PRODUCT_CODE`/`VERSION_STATE` always
kept their pre-set defaults (`missing`) -- even on machines where
TECHI Agent was correctly installed. `techi-deploy.cmd` then always
took the `:do_install` branch and ran `msiexec /i ... ENROLLMENT_TOKEN=...`
on every scheduled run (09:00/13:00/21:00), on every domain machine,
regardless of whether anything actually needed installing.

This single bug explains both incidents from today: the original mass
offline report (forced reinstalls fleet-wide since whenever this
`:read_registry` version was deployed) and the NODE04/DC device_id
loss after manually triggering `techi-deploy.cmd` for diagnosis --
both are the same forced-reinstall path firing when it never should
have. (An earlier theory blaming an expired "Internal gpo bootstrap"
token was wrong and retracted: the actual embedded token, "Metropol",
is healthy -- active, no expiry, 187/400 uses.)

### Fix

Replaced the single-line `-Command` with a `-EncodedCommand` (base64
UTF-16LE) invocation -- the same pattern already used safely elsewhere
in `installer.wxs` -- eliminating all nested-quoting risk entirely
(the encoded blob is pure base64, no characters that batch or
PowerShell could misinterpret). The script now writes its output to a
temp file (`%TEMP%\techi-read-registry.out`) instead of being captured
via `for /f in ('command')`, and batch reads that file directly.
`enrollment_bootstrap_service.py` keeps the literal PowerShell source
in a comment above the encoded constant (`_READ_REGISTRY_ENCODED_COMMAND`)
so it stays human-reviewable and regeneratable.

### Checks

- Generated the actual `techi-deploy.cmd` content locally via
  `EnrollmentBootstrapService._gpo_scheduled_task_setup` and confirmed
  the embedded command line decodes (base64 + UTF-16LE) back to the
  intended PowerShell source byte-for-byte; full line length 3198
  chars, well under cmd.exe's 8191 limit.
- `pytest tests/test_enrollment_bootstrap_script.py -q` -- 105 passed
  (two tests that asserted on the old inline PowerShell text now
  decode `_READ_REGISTRY_ENCODED_COMMAND` and assert against that).
  `pytest tests/ -k "bootstrap or enrollment"` -- 119 passed.
- Not yet re-verified on a real domain machine (this fix isn't on
  NETLOGON yet -- `techi-deploy.cmd` only gets rewritten when the GPO
  admin re-fetches `/api/v1/bootstrap/gpo-deploy.ps1?token=...`;
  pending explicit go-ahead before pushing that to metropolgroup.local
  again given today's history).

## [2026-06-28] GPO/NETLOGON Domain Deployment Was Silently Serving a Stale MSI (metropolgroup.local)

### Root cause

Urgent report: devices on the "metropolgroup.local" domain hadn't come
online via the scheduled GPO deployment, and a server that did enroll
via GPO had the wrong Remote Support password. Both traced to the same
cause: `_gpo_scheduled_task_setup`'s "Hapi 4b" only re-downloads the MSI
into `\\<domain>\NETLOGON\TECHI-Agent-<version>.msi` when the version
*string* differs from `techi-version.txt`, or the file is missing.
Since `ProductVersion` intentionally stayed at 2.1.0 through every fix
from the last two days (per standing instruction not to bump it), the
NETLOGON copy was never refreshed even though the GPO admin re-ran the
setup script today (confirmed: GPO objects and `techi-deploy.cmd` were
freshly rewritten at 00:41 today, but `Get-FileHash` on the NETLOGON
MSI showed `cd7a6d3d...`, last written 2026-06-26 17:49 -- two days
before today's password/Scheduled-Task fixes -- while the backend's
currently published MSI hashes to `a58e6702...`). Every domain machine
running off NETLOGON was therefore stuck on a build from before all of
today's fixes, regardless of how many times the platform itself was
redeployed.

### Fix

No code change -- this was an operational/process gap, not a bug in
this session's commits. Diagnosed via a read-only PowerShell script
(domain info, `techi-version.txt` + NETLOGON MSI hash/timestamp,
hash of the currently published backend MSI for comparison, GPO object
status) run directly on the domain's DC, then resolved by downloading
the current backend MSI and overwriting the NETLOGON copy + version
file directly (without touching GPO objects or `techi-deploy.cmd`).

### Checks

- Diagnostic script confirmed the hash mismatch (`cd7a6d3d...` vs.
  `a58e6702...`) conclusively before taking any action.
- After the refresh: `Get-FileHash` on
  `\\metropolgroup.local\NETLOGON\TECHI-Agent-2.1.0.msi` matches the
  backend's published hash exactly. The next scheduled GPO run
  (09:00/13:00/21:00) will install the current build on affected
  machines.
- Follow-up implemented same day (user approved): `_gpo_scheduled_task_setup`'s
  Hapi 4b now always downloads the current backend MSI to a temp path,
  hashes it, and only overwrites the NETLOGON copy when the hash
  differs from what's already there -- the version string is still
  used for the filename/cleanup, but no longer gates whether a refresh
  happens. This trap cannot recur regardless of whether ProductVersion
  changes. `pytest tests/test_enrollment_bootstrap_script.py -q` --
  105 passed (two tests updated for the new hash-compare flow).

## [2026-06-28] Password Write Found Nothing to Patch: the Identity File Gets Deleted, Then Never Waited For

### Root cause

Fourth real-machine test of the just-deployed TOML-write fix: zero log
lines from the password step at all -- not even the "skipped: no
password configured" fallback. The bootstrap script's own earlier
cleanup loop (`$TechiRoots` / `Get-ChildItemSafe -Path $ConfigDir |
... Remove-Item -Recurse`) deletes every file under each root's
`config\` directory, including the suffix-less identity TOML that
holds `password`/`salt`/`id`. Nothing in this script recreates that
file -- only RustDesk itself does, once it actually runs. The new
password-write block ran *before* the Scheduled Task was even
triggered, so every candidate path was missing, `Test-PathSafe`
returned false for all of them, and the function silently returned
`$false` with no logging at all -- exactly the silence observed.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`: moved the
  Scheduled Task start (now with a 6s wait, was 2s) to *before* the
  password-write block, since RustDesk needs to actually run once to
  recreate the identity file the cleanup loop just deleted. The
  password loop now retries once more after a 5s wait if nothing was
  found the first time, and logs explicitly either way ("identity TOML
  not found yet -- waiting... retrying" / a final WARNING if still not
  found after both attempts) instead of failing in total silence.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (ordering assertion flipped back, two new assertions
  for the retry/visibility logging).
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean (no Go changes this entry, re-verified
  anyway since the agent shares `rustDeskConfigDirs()`/file-patch
  logic conceptually).
- Generated the real script locally via
  `EnrollmentBootstrapService._rustdesk_force_migration_ps_lines` with
  a dummy payload to confirm the literal generated PowerShell matches
  what's described above, rather than trusting the Python source alone.
- Not yet verified on a real machine for this specific reorder -- this
  directly follows from the previous entry's real-machine test result.

## [2026-06-28] Set the Remote Support Password by Writing the Identity TOML Directly, Not via --password CLI

### Root cause

Third real-machine test: the Scheduled Task now registers and runs (the
GroupId/logging fix worked), but the password still didn't take effect.
Re-reading the actual RustDesk source (vendored locally) settled this
properly instead of guessing further:

- `--tray` (`core_main.rs`) only ever calls `tray::start_tray()` -- a thin
  UI client. The actual daemon only starts via `--service` (SCM) or
  `--server`. `tray.rs` even says outright: "The tray icon is only shown
  when the service is running." So today's earlier architecture change
  (dropping the Windows Service in favor of Scheduled-Task-launched
  `--tray`) left no daemon for the `--password` CLI to talk to over IPC
  at all -- explaining why it kept failing regardless of timing fixes.
  (Whether to bring the Service back is a separate, bigger decision the
  user wants to defer; not done in this entry.)
- Separately, and independent of the service question:
  `hbb_common/src/config.rs` shows `Config` (id/enc_id/password/salt/
  key_pair) loads from the **suffix-less** file
  (`Config::load_::<Config>("")`), while `Config2` (rendezvous_server/
  nat_type/serial/options) loads from the **"2"-suffixed** file
  (`Config::load_::<Config2>("2")`). Critically,
  `migrate_permanent_password_to_hashed_storage` runs on every config
  load/store: if `password` is plaintext (not already a recognized
  hashed/encrypted format), it computes the proper hash using `salt` and
  rewrites it -- meaning a plaintext password written directly into the
  TOML file gets picked up and hashed correctly the next time RustDesk
  loads or saves that file, with **no daemon and no IPC required**.

### Fix

- `agent/rustdesk_toml.go`: added `applyTOMLTopLevelPatch(content, key,
  value)` -- patches a single top-level `key = 'value'` pair that lives
  before any `[section]`, preserving everything else (including any
  `[options]` section). Inserts before the first section if the key is
  missing.
- `agent/rustdesk_manage.go`: `setRustDeskPassword` rewritten to use this
  to patch `password` into the suffix-less identity TOML across all of
  `rustDeskConfigDirs()`'s candidate locations, instead of shelling out to
  `<exe> --password <value>`.
- `backend/app/services/enrollment_bootstrap_service.py`: removed
  `Get-TechiExecutable` and the CLI-based password block entirely (no
  longer needed); added `Set-TechiPermanentPasswordSafe`, the PowerShell
  equivalent in-place patch, run against `TECHI Remote Support.toml`
  (not the "2" file) under every `$TechiRoots` candidate.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean. Added 4 new tests for
  `applyTOMLTopLevelPatch` (update existing key, no-op when unchanged,
  insert before first section, ignore a same-named key inside a
  `[section]`).
- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (CLI-based password assertions replaced with the new
  TOML-write ones); `pytest tests/ -k "bootstrap or enrollment"` -- 119
  passed.
- Not yet verified on a real machine for this specific change.
- Flagged but explicitly deferred per user request: `rustdesk_manage.go`'s
  config-repair (`managedRustDeskOptions`/`writeRustDeskConfig`) writes
  `rendezvous_server`/`[options]` into the suffix-less file too, but per
  the source mapping above those fields belong in the **"2"-suffixed**
  file (`Config2`) -- the agent's own repair pass may have been
  inert/no-op against a file RustDesk's `Config` struct doesn't define
  those fields on. The backend bootstrap script already targets the
  correct "2" file for those fields. Worth a dedicated look in a future
  session; out of scope here.

## [2026-06-27] Scheduled Task Silently Failed to Register; Password CLI Needs the Daemon Already Running

### Root cause

Second real-machine test (after the previous entry's fixes) showed the
orphaned service was correctly removed, the password CLI now found the
right executable, and logged "configured" -- but the password still
didn't take effect, and the log showed:
`WARNING: TECHI Remote Support Tray Scheduled Task not found`. Two
separate bugs, the first causing the second:

1. `CreateRustDeskTrayTask` (installer.wxs) used
   `New-ScheduledTaskPrincipal -GroupId 'BUILTIN\Users'`. This is the
   same class of bug already learned the hard way with `icacls` earlier
   in this session: friendly group names aren't reliable across
   locales/contexts, and the failure was completely invisible because
   the CustomAction has `Return="ignore"` and had no logging of its own.
2. Checking the actual RustDesk source (`src/core_main.rs` /
   `src/ipc.rs`, vendored locally) confirms `--password` connects to the
   *already-running* daemon over IPC (`set_permanent_password_with_ack_async`,
   1s timeout) and applies it there -- it does **not** write the config
   file directly. Critically, `core_main.rs`'s `--password` branch only
   `println!`s on failure; it never sets a non-zero process exit code.
   So when no daemon is running (exactly the situation here, since the
   Scheduled Task never got created), the CLI still exits 0 and our
   wrapper logs "configured" even though nothing happened. The bootstrap
   script's existing order (set password, *then* restart) was backwards
   for this reason regardless of bug #1.

### Fix

- `agent/installer/installer.wxs`: `CreateRustDeskTrayTask` rewritten as
  an `-EncodedCommand` (was a raw `-Command` one-liner) so it can
  properly try/catch and log every step to
  `C:\ProgramData\TECHI\logs\deploy.log` instead of failing in total
  silence. `-GroupId 'BUILTIN\Users'` replaced with the locale-safe SID
  `S-1-5-32-545` (the "Users" group). Also switched from the
  `[REMOTESUPPORTFOLDER]` WiX token to `$env:ProgramFiles` inside the
  script, since a property substitution into the middle of a base64
  blob wouldn't have worked anyway.
- `backend/app/services/enrollment_bootstrap_service.py`: swapped the
  order in `_rustdesk_force_migration_ps_lines` -- start the Scheduled
  Task first (4s wait for the daemon to come up), *then* attempt
  `--password`. Updated the log line to note the exit-0-on-failure
  caveat so it doesn't read as a false-positive guarantee again.
- `agent/rustdesk_manage.go`: `ensureRustDesk` now sleeps 4s before
  `setRustDeskPassword` specifically when `ensureRustDeskTrayRunning`
  just triggered a fresh start in the same call (not on every
  heartbeat) -- same IPC-needs-the-daemon-up reasoning, scoped to the
  one situation where it actually matters.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (re-ordering assertions flipped/renamed).
- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`,
  `go test ./...` -- clean.
- Decoded the new `-EncodedCommand` base64 back to UTF-16LE text and
  diffed it against the intended script to confirm it matches exactly.
- `installer.wxs` re-verified well-formed, no `--`-in-comment regressions.
- Not yet verified on a real machine -- this is a same-day follow-up to
  a test that's still in progress.

## [2026-06-27] Bootstrap Script Still Assumed a Remote Support Windows Service After It Was Removed

### Root cause

Real-machine test of the "Safe one-time/manual command" bootstrap (and the
shared GPO bootstrap path -- both call the same
`_rustdesk_force_migration_ps_lines` generator in
`enrollment_bootstrap_service.py`) surfaced two bugs left over from
dropping the Remote Support Windows Service earlier today:

- `Get-TechiExecutable`'s candidate paths only listed `rustdesk.exe`,
  never the actual shipped binary name `TECHI Remote Support.exe` --
  log showed `WARNING: TECHI Remote Support password not set because
  rustdesk.exe was not found.` every time, on every device.
- The script still did `Stop-Service` / `Start-Service` against a
  `TECHI Remote Support` service name. On the test device this found
  an orphaned service left over from an earlier build *this session*
  (before the Program Files + Scheduled Task fix) and happily
  restarted it -- putting Remote Support right back into the broken
  Session 0 state the rest of today's work was meant to eliminate.

### Fix

- `backend/app/services/enrollment_bootstrap_service.py`:
  `Get-TechiExecutable`'s candidates now include
  `TECHI Remote Support.exe` (Program Files, both archs) ahead of the
  legacy `rustdesk.exe` names. The service stop-loop now deletes
  (`sc.exe delete`) any matched service instead of just stopping it --
  there's no legitimate reason for one to exist anymore. The final
  "restart" step no longer does `Start-Service`; it instead does
  `Get-ScheduledTask`/`Start-ScheduledTask` against the
  `TECHI Remote Support Tray` task installer.wxs creates.
- `agent/installer/installer.wxs`: `KillTechiRSBeforeInstall` (runs
  before `InstallFiles` on every install/upgrade, see the entry below)
  now also runs `sc.exe delete "TECHI Remote Support"`. This closes the
  same gap at the MSI level so it's covered regardless of which outer
  deployment path triggered msiexec (raw `msiexec /i`, GPO
  `techi-deploy.cmd`, or either bootstrap script) -- `RemoveRustDeskTrayArtifacts`
  only runs on a full uninstall, never on a normal upgrade, so without
  this the orphaned service would otherwise survive upgrades indefinitely.

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py -q`
  -- 105 passed (2 assertions updated for the new Scheduled-Task-based
  restart wording, 1 new test added for the orphaned-service deletion).
- `installer.wxs` re-verified well-formed, no `--`-in-comment regressions.
- Real-machine result that surfaced this: manual install of this MSI
  over an existing 2.1.0, then 2.0.0, then 2.1.0 again all completed
  without the device going offline (the InstallFiles fix from the entry
  below appears to be working) -- only the bootstrap script's own
  service-restart/password-exe-name bugs remained, both fixed here.

## [2026-06-27] Devices Going Offline During 2.0.0 -> 2.1.0 Upgrade: Kill Remote Support Before InstallFiles, Not Just Before Uninstall

### Root cause

User reported many devices going offline specifically because the
2.0.0 -> 2.1.0 upgrade fails to complete (fails to remove 2.0.0 / install
2.1.0). The 2.0.0 MSI (inspected directly via `msiinfo`) does not bundle
Remote Support at all -- on the real fleet, Remote Support was installed
separately via `TECHI-Remote-Support.iss` (Inno Setup), running as
`rustdesk.exe` in `C:\Program Files\TECHI Remote Support\`, always
running as a persistent tray app once a user has logged on.

2.1.0's `installer.wxs` bundles Remote Support in the *same* MSI
transaction as the agent, writing files (`librustdesk.dll`,
`flutter_windows.dll`, `data\*`) into that same Program Files directory.
`KillTechiRS` (which terminates the Remote Support process) was only
scheduled `Before="RemoveFiles" Condition="REMOVE~=\"ALL\""` -- i.e. only
during a *full uninstall*, never during a normal install/upgrade. Since
Remote Support is essentially always running on a real device, MSI's
`InstallFiles` standard action would try to overwrite DLLs that Windows
has locked open in the running `rustdesk.exe` process, causing the file
write to fail. A failure during `InstallFiles` can roll back the *entire*
MSI transaction -- including the agent's own file/service upgrade in the
same package -- which plausibly explains devices stuck mid-upgrade,
neither cleanly on 2.0.0 nor 2.1.0, and consequently offline. `KillTechiRS`
also only killed the branded `TECHI Remote Support.exe` name, never the
legacy `rustdesk.exe` name the existing Inno-installed fleet actually
runs under.

### Fix

`agent/installer/installer.wxs`:
- `KillTechiRS`'s `taskkill` now targets both `TECHI Remote Support.exe`
  and the legacy `rustdesk.exe` process name.
- Added `KillTechiRSBeforeInstall` (same kill logic, separate CustomAction
  Id since the same Id can't be scheduled twice), scheduled
  `Before="InstallFiles" Condition="NOT REMOVE"`. This runs on every
  fresh install (no-op, nothing running yet) and every upgrade (kills
  any already-running Remote Support -- whether from the Inno installer
  or a previous MSI build -- before the new files are written), removing
  the file-lock collision that could break the whole upgrade transaction.

### Checks

- XML re-verified well-formed, no `--`-inside-comment regressions.
- Not yet verified on a real machine / MSI build, intentionally (per
  explicit instruction not to trigger a build yet). Devices already
  stuck in a failed/offline state from a *past* upgrade attempt will
  need the fixed MSI redeployed (e.g. on next GPO retry cycle); this fix
  prevents the failure going forward, it does not retroactively repair
  an already-broken local install state.

## [2026-06-27] Remote Support "Not ready": Drop the SCM Service, Go Back to Program Files + Logon Scheduled Task

### Root cause

Earlier this session, "TECHI Remote Support" was moved from Program Files
to ProgramData, and a Windows Service (`sc create ... --service`) was added
so the agent could "ensure" it stays running. Both changes were wrong,
discovered by comparing against `TECHI-Remote-Support.iss` (the real,
proven Inno Setup installer used historically, found locally alongside the
actual RustDesk fork source) and `enrollment_bootstrap_service.py`'s own
exe-path candidates (`C:\Program Files\TECHI Remote Support\rustdesk.exe`):

- The proven installer puts the exe in **Program Files**, not ProgramData.
  Moving it to ProgramData (to match the agent's own, apparently
  outdated, assumption) went the wrong direction.
- The proven installer never creates a Windows Service for Remote Support
  at all. It only installs files and optionally adds a Startup-folder
  shortcut that launches `rustdesk.exe --tray` at user logon -- an
  interactive, per-session launch. A Service we added instead runs as
  SYSTEM in **Session 0**, which cannot do interactive screen capture,
  which is exactly why the app showed "Not ready. Please check your
  connection" even with heartbeats arriving fine, and why behavior
  differed between the tray icon and a Desktop-launched instance.

### Fix

- `agent/installer/installer.wxs`: `REMOTESUPPORTFOLDER` moved back under
  `ProgramFiles6432Folder` (was `CommonAppDataFolder`/ProgramData).
  `TECHI_RS_EXE` search path updated to match. Removed the
  `ServiceControl` for "TECHI Remote Support" (no service exists anymore).
  Added `CreateRustDeskTrayTask`: registers a Scheduled Task ("At Logon",
  runs as the interactive user via `BUILTIN\Users` principal,
  `ExecutionTimeLimit` 0 so it isn't killed after 72h) that launches
  `TECHI Remote Support.exe --tray`, then immediately does `schtasks /run`
  against it once so a manual/interactive install opens Remote Support
  right away (matching old behavior) instead of waiting for the next
  logon -- an "At Logon" trigger never fires for a session that's already
  active. On an unattended `/quiet` GPO install with nobody logged on,
  this `/run` is a harmless no-op; the task still fires normally at the
  next real logon. Renamed `DeleteTechiRSService` to
  `RemoveRustDeskTrayArtifacts`: unregisters the Scheduled Task on
  uninstall, and still runs the old `sc delete` as a no-op safety net for
  any device that already has the now-removed service registered from a
  build during this session.
- `agent/rustdesk_manage.go`: removed `ensureRustDeskService` /
  `setRustDeskServiceRecovery` and the `rustdeskServiceName` SCM
  machinery entirely. Added `isRustDeskProcessRunning` (tasklist-based),
  `ensureRustDeskTrayRunning` (nudges via `schtasks /run` against the
  installer's task if not running), and `stopRustDeskTray` /
  `startRustDeskTray` helpers used by the remote actions. Path constants
  changed back to Program Files.
- `agent/rustdesk.go`: `discoverRustDeskWindows`'s path candidate list
  reordered so Program Files is checked first; ProgramData/LOCALAPPDATA
  remain fallbacks for the brief window devices may have picked up the
  wrong location.
- `agent/actions_windows.go`: `handleRestartRustDesk`,
  `handleReinstallRustDesk`, `handleReopenRustDesk`,
  `handleRepairConfigRustDesk`, `handleSetRemotePassword`, and
  `handleDeployRemoteSupport`'s service-ensure phase all switched from
  `sc stop`/`sc start`/`ensureRustDeskService` to
  `stopRustDeskTray`/`startRustDeskTray`/`ensureRustDeskTrayRunning`.
  Protocol-handler registry value paths reverted to Program Files.

### Checks

- `go build ./...`, `GOOS=windows GOARCH=amd64 go build ./...`, `go vet
  ./...` (native and Windows cross-compile) -- clean.
- `go test ./...` -- all existing tests pass unchanged.
- `installer.wxs` checked for the recurring `--`-inside-XML-comment bug
  (none found) and confirmed well-formed via `xml.dom.minidom`. A local
  `wix build` was attempted for schema validation but `wix.exe` only
  partially works on macOS (`WIX0000: only supports Windows`); confirmed
  via the *same* error appearing against the unmodified original file
  that this is a pre-existing host limitation, not a regression --
  real validation still requires the Windows CI build (not run yet, per
  explicit instruction, pending more items to batch).
- Not yet verified on a real machine / MSI build, intentionally.

## [2026-06-27] New Managed RustDesk Options Were Blocked by the 30-Minute Repair Cooldown

### Root cause

The previous entry added `enable-remote-config-modification = 'Y'` to
`managedRustDeskOptions`, but the user reported it had no effect after
upgrading and retesting. `ensureRustDesk`'s config-repair cooldown
(`cfg.RustDeskLastRepairAt`, 30 minutes) is persisted in
`agent.config.json` and survives MSI upgrades by design (so device_id and
other identity data aren't disturbed). Since this device had been
repaired/upgraded repeatedly within the same hour during testing, the
timestamp was always recent, so the cooldown silently skipped
`writeRustDeskConfig` every time -- the new agent code was correct and
deployed, but never actually got to run on this device. This is a real
bug, not just a testing artifact: it means *any* future change to
`managedRustDeskOptions` would take up to 30 minutes to reach
already-enrolled devices, fleet-wide, even in production.

### Fix

- `agent/rustdesk_toml.go`: added `rustDeskOptionsSchemaVersion` constant
  (bump whenever the managed-keys set changes).
- `agent/config.go`: added `Config.RustDeskOptionsSchemaVer` (persisted).
- `agent/rustdesk_manage.go`: `ensureRustDesk` now bypasses the cooldown
  once whenever `cfg.RustDeskOptionsSchemaVer != rustDeskOptionsSchemaVersion`
  (i.e. right after an agent upgrade that changed the managed-keys set),
  then persists the new schema version once the repair succeeds.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Immediate workaround for retesting on the affected device without
  waiting for this fix to ship: edit
  `C:\ProgramData\TECHI\agent.config.json`, clear
  `rustdesk_last_repair_at` to `""`, restart the `TechiAgent` service.

## [2026-06-27] Always Enable "Remote Configuration Modification" Permission

### Root cause

In the Remote Support permissions panel, "Enable remote configuration
modification" was the one permission left unchecked by default, requiring
someone physically at each PC to turn it on before an operator could adjust
that device's Remote Support settings remotely. This is a standard
RustDesk `[options]` key (`enable-remote-config-modification`), the same
mechanism already used for `custom-rendezvous-server`/`relay-server`/`key`.

Separately, the user asked about adding clipboard copy-paste / drag-and-drop
file transfer (today only the manual "file transfer" menu works). That is
not a config toggle -- it doesn't appear at all in this build's permissions
list (13 known permissions, ending at remote-config-modification), so it's
not compiled into this vendored RustDesk fork. It can't be enabled via
config; it would need a newer build of the binary itself.

### Fix

- `agent/rustdesk_toml.go`: `managedRustDeskOptions` now always includes
  `enable-remote-config-modification = 'Y'`, repaired the same way as the
  other managed keys (30-min cooldown, see `ensureRustDesk`).

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
  (updated 3 existing fixtures in `rustdesk_toml_test.go` that asserted
  "no repair needed" / "no change" without the new key)
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)

## [2026-06-27] Auto-Restart "TECHI Remote Support" Service on Failure (Tray "Exit" Can Kill It)

### Root cause

Once Remote Support could actually start (previous entry), the user found
that clicking "Exit" on its system-tray icon can stop the underlying SCM
service too, not just close a window -- and once that happens, heartbeats
for that device stop until something restarts it. For a platform that
monitors many PCs/servers unattended, an end-user/operator being able to
accidentally kill monitoring from the tray is a real operational risk, not
just a cosmetic one.

`ensureRustDeskService` (called every heartbeat) already restarts the
service if it's stopped, but that only happens on the *next* heartbeat tick
(up to `HeartbeatSeconds` later, default ~60s) -- there was no faster,
SCM-level recovery the way `TechiAgent`'s own service already has via the
installer's `SetServiceRecovery` custom action.

### Fix

- `agent/rustdesk_manage.go`: added `setRustDeskServiceRecovery()`, which
  runs `sc failure "TECHI Remote Support" reset= 86400 actions=
  restart/15000/restart/15000/restart/60000` every time
  `ensureRustDeskService` confirms the service exists (already running, just
  started, or just created) -- so SCM itself restarts the service within
  15-60s of any exit, regardless of cause, well before the next heartbeat's
  own check would catch it. Idempotent, safe to re-apply every call.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Still open: confirm with the user whether heartbeats resumed on their own
  after the previous ~60s self-heal window, or stayed down indefinitely --
  determines whether this SCM-level fix alone is sufficient or whether a
  second issue (e.g. the whole machine losing connectivity, not just
  Remote Support) is also in play.

## [2026-06-27] Remote Support Wouldn't Open: app.so Silently Excluded by .gitignore's `*.so` Rule

### Root cause

TECHI Remote Support exited immediately on every launch attempt (no window,
no Task Manager entry lasting more than an instant), confirmed via a direct
launch capturing stderr:

```
[ERROR:flutter/shell/platform/windows/flutter_project_bundle.cc(66)] Can't load AOT data from C:\ProgramData\TECHI Remote Support\data\app.so; no such file.
[ERROR:flutter/shell/platform/windows/flutter_windows_engine.cc(253)] Unable to start engine without AOT data.
Failed to create view controller.
```

TECHI Remote Support is a Flutter Windows app; `data\app.so` is the
AOT-compiled Dart bytecode the Flutter engine needs to start at all --
without it the engine can't initialize and the process exits before showing
anything. `data\app.so` (13 MB) existed on disk in
`agent/installer/TECHI-Remote-Support/data/` (copied from the user's
`agent.rar`) but was never actually committed to git: `.gitignore`'s
generic `*.so` rule (meant for Python C-extension shared objects, line 7)
silently matched and excluded it too, since gitignore patterns aren't
path-scoped by default. Every CI-built MSI since this repo adopted the real
`installer.wxs` shipped Remote Support's DLLs and Flutter assets but not
its actual application code -- explaining why the icon "does nothing": the
engine fails before any window is created.

Found via a PowerShell diagnostic script run on the affected machine that
killed any running instance, relaunched the exe directly with
`-RedirectStandardError`, and captured the message above.

### Fix

- `.gitignore`: added `!agent/installer/TECHI-Remote-Support/data/app.so`
  exception to the `*.so` rule (same pattern already used for
  `!agent/techi-agent.manifest` against the `*.manifest` rule).
- `git add -f` the file so it's actually tracked going forward.

### Checks

- `comm -23 <(find agent/installer/TECHI-Remote-Support -type f | sort) <(git ls-files agent/installer/TECHI-Remote-Support | sort)`
  -- confirmed `app.so` was the *only* file on disk missing from git tracking
  under that whole vendored directory.
- Expect the next CI artifact to grow from ~22 MB to ~30+ MB (the MSI
  previously shipped without this 13 MB file at all).

## [2026-06-27] Hide Remaining Console-EXE CustomActions, Embed BuildCommit for Test Traceability

### Root cause

After a from-scratch IObit-driven uninstall/reinstall, the user still saw
console windows flash during manual install. The previous `-WindowStyle
Hidden` pass (commit `20844ae`) only covered the seven `powershell.exe`
`CustomAction`s. Four others launch bare console executables directly --
`SetServiceRecovery` (`sc.exe failure ...`), `LockdownTechiDataDir`
(`icacls.exe ...`), `KillTechiRS` (`taskkill.exe ...`), and
`DeleteTechiRSService` (`sc.exe delete ...`) -- none of which accept a
`-WindowStyle` flag themselves, so they were never covered. `KillTechiRS`/
`DeleteTechiRSService` also run during the *old* product's uninstall step
of every MajorUpgrade transaction, i.e. during what looks to the user like
"installing the new version."

Separately, since `ProductVersion` intentionally stays `2.1.0` across every
iteration (per explicit instruction, to avoid version churn), there was no
way to tell from the installed machine which exact commit's MSI was
actually running -- repeated back-and-forth was needed each time to confirm
"which build did you test."

### Fix

- `agent/installer/installer.wxs`: wrapped the four bare console-EXE
  `CustomAction`s in `powershell.exe -WindowStyle Hidden ... Start-Process
  -WindowStyle Hidden -NoNewWindow -Wait`, consistent with the other seven.
- Added a `BuildCommit` WiX variable (`-d BuildCommit=<git short sha>`,
  defaults to `dev`/`local` when unset) written to
  `HKLM\SOFTWARE\TECHI\Agent\BuildCommit` alongside the existing `DataDir`
  value -- `reg query HKLM\SOFTWARE\TECHI\Agent /v BuildCommit` on the test
  machine now tells us exactly which commit is installed.
- `.github/workflows/build-agent-msi.yml`: passes `-d BuildCommit=$(git sha
  short)` to `wix build`.
- `agent/installer/build.sh` / `build.bat`: same, using local `git rev-parse
  --short HEAD` (suffixed `-dirty` in build.sh if the tree has uncommitted
  changes).

### Checks

- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML)
- `bash -n agent/installer/build.sh` (syntax check)
- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-agent-msi.yml'))"`
- `grep -c "WindowStyle Hidden" agent/installer/installer.wxs` → 11 (7
  powershell.exe CAs + 4 newly-wrapped console-EXE CAs)

## [2026-06-27] Stop Spawning a Remote Support Process Every Heartbeat (Process Pile-up, Won't Open, Reconnect Loop)

### Root cause

After moving Remote Support to ProgramData, the user reported, on real
hardware: clicking the Remote Support icon does nothing at all (no process
ever appears in Task Manager, from either the Desktop shortcut or the exe in
`C:\ProgramData\TECHI Remote Support\`), several duplicate "TECHI Remote
Support" processes visibly running all the time (nested under "TECHI Platform
Endpoint Agent" in Task Manager), and connecting via our platform UI drops
and reconnects every 5-10 seconds. The user confirmed this is unrelated to
Defender/AppLocker and started with the first GitHub-CI-built MSI — i.e. it
traces back to this repo's agent code, not the installer or AV.

`rustdesk.go`'s `discoverRustDeskWindows` (called every heartbeat, default
every ~60s, from both the main loop and the on-demand `sync_remote_support`
action handler) unconditionally spawned a *second* instance of the exe twice
per call: `--version` (2s timeout) and `--get-id` (5s timeout), to refresh
telemetry. Remote Support is single-instance-locked, so a probe spawn either
exits almost immediately (forwarded to the existing instance) or, if it
doesn't, was only killed via `cmd.Process.Kill()` -- which kills just that
one PID, not any child process the exe itself spawned. Probing on every
heartbeat, indefinitely, is exactly what produced the pile of duplicate
processes the user saw in Task Manager: every ~60s added another spawn that
either left an orphaned child behind or briefly held the single-instance
lock, so the user's manual double-click attempts were silently forwarded to
one of these short-lived orphans (which has no UI to show, being headless)
instead of opening a window. The lock contention and repeated spawn/kill
cycles are also a plausible explanation for the periodic disconnects: each
new probe competes with whatever instance currently owns an active remote
session.

### Fix

- `agent/rustdesk.go`: added `cachedRustDeskVersion`/`shouldProbeRustDeskID`/
  `recordRustDeskIDProbe`, throttling both probes to once per
  `cliProbeInterval` (30 min) once a usable ID/version is already known,
  instead of every heartbeat. The ID probe still runs immediately if we
  don't have a usable ID yet (first-run bootstrap).
- Added `killProcessTree` (`taskkill /F /T /PID`) and use it instead of
  `cmd.Process.Kill()` on both probes' timeout paths, so a non-exiting probe
  can't leave orphaned children behind even in the rare case the throttle
  above still lets one through.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass)
- Manual cleanup still required once on already-affected machines: kill all
  existing `TECHI Remote Support.exe` processes (`taskkill /F /IM "TECHI
  Remote Support.exe"`), then retest opening Remote Support after updating
  to this agent build -- this fix prevents future pile-up, it doesn't clear
  processes that already accumulated under the old code.

## [2026-06-27] Remaining Program Files Reference, Visible PowerShell Windows During Install

### Root cause

After the ProgramData move (previous entry), the user still saw a `TECHI
Remote Support` folder under both `Program Files` and `ProgramData`, and
PowerShell console windows flashing during the token-based manual install.
Two separate issues:

1. `WriteAgentConfig`'s `CustomAction` (the one that also writes
   `agent.config.json`) created the Public Desktop shortcut with
   `TargetPath`/`WorkingDirectory` hardcoded to
   `C:\Program Files\TECHI Remote Support\...` — missed in the previous pass
   because it's a string inside a PowerShell snippet, not a WiX directory
   reference. This alone doesn't *create* the Program Files folder (a
   shortcut's target isn't validated at save time), but the `Program Files`
   folder the user saw is most likely a leftover from testing this repo's
   *earlier, incorrect* installer.wxs (before the real one was adopted),
   whose RustDesk binary ran from Program Files and left its own
   untracked runtime files (logs/identity/cache) there — those aren't part
   of any MSI component, so `RemoveExistingProducts` during the MajorUpgrade
   never removes them. One-time manual cleanup of that stale folder is
   needed on machines that were used for earlier testing; new/clean installs
   won't recreate it now that nothing in installer.wxs references it.
2. None of the seven `powershell.exe`-launching `CustomAction`s
   (`WriteAgentConfig`, `EnsureServiceCreated`, `BackupAgentConfigBeforeLegacyRemove`,
   `CleanupLegacyEndpointInstallerRegistry`, `RestoreAgentConfigAfterLegacyRemove`,
   `RestoreAgentConfigFromLegacyBackup`, `CleanupProgramData`) passed
   `-WindowStyle Hidden`, so each one could flash a console window even
   though the action itself runs silently in the background during `/qn`.

### Fix

- `agent/installer/installer.wxs`: `WriteAgentConfig`'s shortcut now points
  at `C:\ProgramData\TECHI Remote Support\TECHI Remote Support.exe`.
- Added `-WindowStyle Hidden` to all seven `powershell.exe` `ExeCommand`
  invocations.

### Checks

- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML after edits)
- `grep -c "WindowStyle Hidden" agent/installer/installer.wxs` → 7 (one per
  powershell.exe CustomAction)
- `grep "Program Files" agent/installer/installer.wxs` → only the explanatory
  comment remains, no executable reference

## [2026-06-27] Move TECHI Remote Support Install Path from Program Files to ProgramData

### Root cause

The real `installer.wxs` brought in from the field (previous entry below)
installed TECHI Remote Support under `ProgramFiles6432Folder` (`C:\Program
Files\TECHI Remote Support\`). After building and testing this MSI manually
on a Windows box (token-based enrollment), the new agent version showed up
correctly, but TECHI Remote Support would not open and the remote session
dropped every few seconds. The user found the existing/legacy install on that
same machine had TECHI Remote Support under `C:\ProgramData\TECHI Remote
Support\` instead — matching the rest of the live fleet — and the agent's own
Go code (`rustdesk_manage.go`, `rustdesk.go`, `actions_windows.go`) already
hardcoded `C:\Program Files\TECHI Remote Support\...` as the *primary* path
for service registration, password config, and protocol-handler registration,
while `backend/app/services/enrollment_bootstrap_service.py`'s legacy-migration
PowerShell already assumes `C:\ProgramData\TECHI Remote Support` is where the
existing fleet has it installed. So the new MSI created a second, disconnected
copy of TECHI Remote Support in a different folder than the one the agent
self-healing logic and the rest of the fleet actually use — explaining both
symptoms (wrong/orphaned binary won't launch correctly; agent's periodic
service/config healing fights with whichever copy is actually running).

### Fix

- `agent/installer/installer.wxs`: moved `REMOTESUPPORTFOLDER` from its own
  `ProgramFiles6432Folder` `StandardDirectory` to a `Directory` under the same
  `CommonAppDataFolder` `StandardDirectory` as `INSTALLFOLDER`/`TECHIDATADIR`
  (i.e. `C:\ProgramData\TECHI Remote Support\`). Updated `TECHI_RS_EXE`'s
  `DirectorySearch` path and the `techiremotesupport://` protocol handler's
  registry value to match (the Start Menu shortcut already referenced the
  `REMOTESUPPORTFOLDER` property, so it updates automatically).
- `agent/rustdesk_manage.go`: `rustdeskDefaultInstallPath` and
  `rustdeskLegacyExePath` now point at `C:\ProgramData\TECHI Remote
  Support\...` instead of `C:\Program Files\...`.
- `agent/actions_windows.go`: the two protocol-handler-writing PowerShell
  snippets (`ensureRustDeskProtocolHandler`, `handleRegisterTechiProtocol`)
  now write the `C:\ProgramData\...` path.
- `agent/rustdesk.go`: `discoverRustDeskWindows`'s candidate path list now
  checks `ProgramData` first, keeping `Program Files`/`LOCALAPPDATA` as
  fallbacks for any machine that ended up with a Program-Files copy during
  this transition.
- `agent/installer/build.sh` / `build.bat`: corrected stale "WiX v4" comments
  to "WiX v7" (matches the CI fix below) and documented the
  `wix eula accept wix7` step needed once per machine.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1` (pass)
- `cd agent && GOOS=windows GOARCH=amd64 go build .` (cross-compile pass,
  exercises the `//go:build windows` files: `rustdesk_manage.go`,
  `actions_windows.go`)
- Confirmed `backend/app/services/enrollment_bootstrap_service.py`'s legacy
  migration script already targets `C:\ProgramData\TECHI Remote Support` —
  this change makes the new MSI consistent with that existing assumption
  instead of contradicting it.
- `python3 -c "import xml.dom.minidom as m; m.parse('agent/installer/installer.wxs')"`
  (well-formed XML after edits)

## [2026-06-27] Adopt Real Combined installer.wxs (Agent + Remote Support), Revert Explicit Uninstall

### Root cause

The previous entry (below) diagnosed an `UpgradeCode` mismatch by comparing the
live-deployed `2.0.0` MSI against this repo's `agent/installer/installer.wxs`
— but that comparison was against the **wrong** file. The actual source for
the live MSI lived only on a local Windows machine (never committed): a much
more complete WiX project with UI dialogs (enrollment token prompt), legacy
v1.0.4 migration, `agent.config.json`/`device_id` backup-and-restore across
upgrades, and `UpgradeCode=E6AD0A88-5F26-5665-9B1F-70B8C5EE8363` — which
*does* match production. That real installer was already locally built and
tested through three elevated scenarios (fresh→upgrade, same-version
reinstall, no-token GPO-style upgrade), all passing with `device_id`
preserved, using a **plain** `msiexec /i` (no explicit uninstall).

Given that, the explicit-uninstall logic added in the previous two entries
(`self_update`'s manual `msiexec /x` before `/i`, and `techi-deploy.cmd`'s
`:do_upgrade` uninstall-then-install) is actively harmful with the real
installer: a standalone `msiexec /x` does not set `UPGRADINGPRODUCTCODE`,
so `installer.wxs`'s `CustomAction CleanupProgramData` (condition
`REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE`) fires and deletes
`C:\ProgramData\TECHI\agent.config.json` — wiping `device_id` and causing the
device to re-enroll as a new device on every upgrade.

### Fix

- Brought the real `installer.wxs`, `EpCustomActDll.dll`, `banner.bmp`,
  `TECHI-branding-assets/`, `TECHI-Remote-Support/` (prebuilt RustDesk/Flutter
  bundle), `versioninfo.json`, and `techi-agent.manifest` into the repo under
  `agent/` — this is the single source of truth going forward, replacing the
  simplified agent-only installer this session had been building.
- Parameterized `installer.wxs`'s `Version` via `$(var.Version)` (same
  pattern as before), sourced from `agent/VERSION`.
- `agent/update.go` self_update reverted to a **plain** `msiexec /i
  $MsiPath /quiet /norestart` — no explicit `/x`. Removed the now-unused
  `Get-InstalledTechiAgentProductCode` helper.
- `techi-deploy.cmd` (`enrollment_bootstrap_service.py`) collapsed
  `:do_install`/`:do_upgrade` into a single `:do_install` path: any
  non-`equal` registry version state runs the same `msiexec /i` (relying on
  `MajorUpgrade` + `AllowSameVersionUpgrades`), with no `msiexec /x` and no
  `:wait_registry_removed`. Registry read is kept for logging/diagnostics
  only.
- `agent/installer/build.sh` and `build.bat` rewritten to mirror the real
  build process: patch `versioninfo.json`/`techi-agent.manifest` from
  `agent/VERSION`, generate `resource.syso` via `goversioninfo`, `go build
  -ldflags -X main.AgentVersion=... -trimpath`, then `wix build -arch x64
  -ext WixToolset.UI.wixext -d Version=<version>.0`.
- `.github/workflows/build-agent-msi.yml` updated to match (swapped
  `WixToolset.Util.wixext` for `WixToolset.UI.wixext`, added `-arch x64`,
  added the `goversioninfo`/manifest-patch steps).
- `.gitignore`: added `agent/installer/*.wixpdb`, `agent/installer/.wix/`,
  `agent/installer/*.log`, `agent/resource.syso`.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- `cd backend && python3 -m pytest tests/` (326 passed; 1 pre-existing
  unrelated failure in `test_legacy_compat.py`)
- Locally verified (on macOS, cross-compile only — `wix build` itself
  requires Windows): version-metadata patch script is idempotent,
  `goversioninfo` + `go build -ldflags -X main.AgentVersion=...
  -trimpath` succeed and produce a valid `techi-agent.exe`.
- User's own local elevated test logs (`elevated-test-output.log`,
  `elevated-notoken-upgrade-output.log`) already validated the real
  `installer.wxs` end-to-end against the live `2.0.0` lineage before this
  integration.
- CI (`build-agent-msi.yml`) run for this change actually built the MSI
  end-to-end on `windows-latest` (artifact `TECHI-Endpoint-Deployment-2.1.0`,
  ~22 MB) after fixing three real CI-only issues found via failed runs:
  1. WiX tool version was pinned to `4.0.5`; the real `installer.wxs` needs
     WiX v7 (`WixToolset.UI.wixext` API surface). Pinned both the `wix`
     dotnet tool and `WixToolset.UI.wixext` to `7.0.0`.
  2. WiX v7 refuses to run (`WIX7015`) until the Open Source Maintenance Fee
     EULA is accepted — added `wix eula accept wix7` right after install
     (see https://docs.firegiant.com/wix/osmf/).
  3. The parameterized-`Version` comment block added to `installer.wxs`'s
     header contained two literal `--` sequences, which is invalid inside an
     XML comment (`WIX0104`). Reworded to avoid `--`.

## [2026-06-27] Self-Update — Stop Relying on MajorUpgrade, Mirror techi-deploy.cmd's Explicit Uninstall

### Root cause

Live verification on a test PC showed double-clicking the freshly built
`TECHI-Endpoint-Deployment-2.1.0.msi` (confirmed via `msiinfo`/WindowsInstaller
COM to correctly embed `ProductVersion=2.1.0`) had no effect on a machine
already at `2.0.0`. Inspecting the actually-deployed production `2.0.0` MSI
(pulled from `agent_packages` on `techi-server`) revealed it is a **different,
much larger build** (~27 MB vs ~7 MB) that bundles `TECHI Agent` together with
`TECHI Remote Support` (RustDesk/Flutter runtime — `librustdesk.dll`,
`flutter_windows.dll`, `app.so`) and uses
`UpgradeCode={E6AD0A88-5F26-5665-9B1F-70B8C5EE8363}`, `Manufacturer=TECHI
Solutions SH.P.K.` — neither matches `agent/installer/installer.wxs`
(`UpgradeCode={A1B2C3D4-E5F6-7890-ABCD-EF1234567890}`, `Manufacturer=TECHI`).
That MSI was never built from this repo's installer source. Because
`MajorUpgrade` keys off `UpgradeCode`, Windows Installer treats the two as
fully unrelated products — no version bump can ever make `MajorUpgrade` fire
against the currently-installed bundle. The previous fix (see entry below)
made `self_update`'s `msiexec /i` rely on `MajorUpgrade` alone, which cannot
work against this specific installed base.

### Fix

`agent/update.go`'s self-update helper no longer assumes `MajorUpgrade` will
fire. It now mirrors the registry-driven approach already used by
`techi-deploy.cmd`: looks up `DisplayName = TECHI Agent` under both native and
WOW6432Node uninstall hives, extracts the real installed `ProductCode` from
`UninstallString`, and runs `msiexec /x <ProductCode>` before `msiexec /i
$MsiPath` — regardless of whether the installed product's `UpgradeCode`
matches. This works for the current mismatched-UpgradeCode bundle and for any
future build, without depending on MSI version/UpgradeCode bookkeeping being
correct.

### Checks

- `cd agent && go build ./... && go vet ./... && go test ./... -count=1`
- Manually confirmed via `msiinfo export` against both the new `2.1.0` MSI and
  the live `2.0.0` MSI pulled from `agent_packages` on `techi-server`.

## [2026-06-27] MSI/GPO Deploy — Version Parameterization, Self-Update Parity, Redundant Boot GPO, Third Daily Trigger

### Root cause

- `agent/installer/installer.wxs` hardcoded `Version="2.0.0"`; neither
  `agent/installer/build.sh` nor `.github/workflows/build-agent-msi.yml` ever
  bumped it or passed `-d Version=`. Every MSI built from these scripts
  embedded ProductVersion `2.0.0` regardless of the release label. On machines
  already at `2.0.0`, Windows Installer's `MajorUpgrade` (which only removes
  strictly *older* versions under the same UpgradeCode) saw an equal version
  and refused the install with `ERROR_PRODUCT_VERSION (1638)`. Device
  telemetry confirmed exactly this split: 480 devices stuck at `2.0.0`, 148
  fresh-install devices (no prior version to conflict with) correctly on
  `2.1.0`, 48 with no agent at all.
- `agent/update.go`'s `self_update` helper ran
  `msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus`, which targets
  repair-reinstall of the *same* ProductCode and never triggers
  `RemoveExistingProducts` — same 1638 failure mode as above, making
  "update agent" from Command Center unsafe for real version upgrades.
- GPO scheduled-task deploy created two independent "run techi-deploy.cmd on
  boot" mechanisms: a `<BootTrigger>` inside the Scheduled Task XML, and a
  separate "TECHI Agent Startup" GPO (classic Group Policy startup script).
  Both fired on every boot — redundant, and a source of double-execution
  races during an actual upgrade.

### Fix

- `installer.wxs`: `Version` is now `$(var.Version)`, supplied via a
  build-time `-d Version=` parameter (falls back to `0.0.0` if omitted).
- New single source of truth `agent/VERSION` (currently `2.1.0`) feeds both
  the MSI `Version` and `-ldflags -X main.AgentVersion=` for the compiled
  binary, wired into `agent/installer/build.sh` and
  `.github/workflows/build-agent-msi.yml`.
- `update.go` self_update dropped `REINSTALL=ALL REINSTALLMODE=vomus`.
  **Correction (see entry above, same day):** relying on `MajorUpgrade` alone
  turned out to be insufficient against the live-deployed `2.0.0` bundle
  (different `UpgradeCode`) — self_update now does an explicit registry-driven
  uninstall before install, not a bare `/i`.
- Removed the redundant "TECHI Agent Startup" GPO and its
  `scripts.ini`/Startup-Scripts plumbing from `_gpo_scheduled_task_setup`;
  boot-time execution is now covered solely by the Scheduled Task's
  `<BootTrigger>`. Renumbered remaining setup steps.
- Added a third daily `<CalendarTrigger>` at `09:00` (alongside the existing
  `13:00`/`21:00`).

### Checks

- `cd backend && python3 -m pytest tests/test_enrollment_bootstrap_script.py` (106 passed)
- `cd backend && python3 -m pytest tests/` (328 passed; 1 pre-existing unrelated
  failure in `test_legacy_compat.py`, confirmed present before this change via
  `git stash`)
- `cd agent && go build ./... && go vet ./... && go test ./...`
- `GOOS=windows GOARCH=amd64 go build -ldflags="-X main.AgentVersion=2.1.1" ...`
  to confirm ldflags wiring compiles

## [2026-06-27] GPO Deploy — Registry-Driven MSI Upgrade When ProductCode Changes

### Root cause

`techi-deploy.cmd` treated `msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus`
with exit code `0` as a successful upgrade. On Windows clients with TECHI Agent
2.0.0.0 installed under ProductCode
`{0460426B-FC27-41E3-9EAC-1272F9941D30}`, installing MSI 2.1.0.0 with a
different ProductCode did not update the registry product entry. The service
could remain running while `HKLM\...\Uninstall` still reported version 2.0.0.0.

### Fix

`techi-deploy.cmd` now treats MSI registry as the source of truth:

- reads `DisplayName = TECHI Agent` from both native and WOW6432Node uninstall
  registry hives;
- extracts `DisplayVersion` and ProductCode from `UninstallString`;
- if registry is missing, runs fresh install;
- if registry version equals `ACTIVE_VERSION`, skips install and only ensures
  `TechiAgent` is running;
- if registry version is older, stops `TechiAgent`, uninstalls the discovered
  ProductCode with `msiexec /x`, waits until the registry entry is removed,
  then installs the new NETLOGON MSI;
- no longer uses `REINSTALL=ALL` / `REINSTALLMODE=vomus`;
- considers deploy successful only when registry version matches
  `ACTIVE_VERSION` and service state is `RUNNING`.

### Checks

- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_enrollment_bootstrap_script.py backend/tests/test_agent_config.py`
- `cd agent && env GOCACHE=/private/tmp/techi-go-build-cache go test ./...`

## [2026-06-27] Windows Agent Bootstrap/GPO — Standardize TechiAgent ProgramData Path

### Root cause

Windows MSI 2.1.0 installs and runs `TechiAgent` from
`C:\ProgramData\TechiAgent\techi-agent.exe`, but some bootstrap paths still used
`C:\ProgramData\TECHI` as the primary agent/config/log location. This could make
one-step bootstrap logs reference the wrong binary and could make generated GPO
startup/scheduled deploy flows miss the real agent path.

### Fix

- One-step/token bootstrap and trusted-domain bootstrap now use
  `C:\ProgramData\TechiAgent` as the primary install/config/log root.
- `C:\ProgramData\TECHI` remains only as legacy config fallback/migration.
- Bootstrap scripts resolve `TechiAgent` executable from `Win32_Service.PathName`
  when the service already exists, then fall back to
  `C:\ProgramData\TechiAgent\techi-agent.exe`.
- Bootstrap scripts verify `Test-Path $AgentPath` before `install`, `start`, or
  `status`, logging a clear error instead of falling into `CommandNotFoundException`.
- GPO `ScheduledTasks.xml` now uses SYSTEM/ServiceAccount, highest privileges,
  `cmd.exe /c "\\domain\NETLOGON\techi-deploy.cmd"`, a boot trigger, and daily
  13:00/21:00 triggers.
- Agent runtime defaults now read/write config and logs under
  `C:\ProgramData\TechiAgent`; `C:\ProgramData\TECHI` is legacy fallback.

### Checks

- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_enrollment_bootstrap_script.py`
- `env PYTHONPATH=backend python3 -m pytest backend/tests/test_agent_config.py`
- `cd agent && env GOCACHE=/private/tmp/techi-go-build-cache go test ./...`

<!-- Entries from here through 2026-06-21 were merged on 2026-07-05 from the
     former root-level CHANGELOG-SOLUTIONS.md (Albanian-format originals,
     preserved verbatim). They fill the 2026-06-19..26 gap. -->

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
   shtohen `set_remote_password`, `restart_rustdesk`, `change_heartbeat_interval`
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
   - RustDesk / Remote: `sync_rustdesk`, `restart_rustdesk`, `set_remote_password`, `register_protocol`
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

## [2026-06-18] MSI Deploy — Force TLS 1.2 for Windows Server 2016 (.NET WebClient)

### Root cause

Windows Server 2016 (dhe versione më të vjetra) nuk aktivizojnë automatikisht
TLS 1.2 për `.NET WebClient` në CMD/PowerShell context. Rezultati:
`"Could not create SSL/TLS secure channel"` kur `DownloadFile`, `DownloadString`
ose `Invoke-WebRequest` tenton të lidhej me HTTPS endpoints.

### Fix

**1. TLS force block** — shtohet pas Defender exclusions dhe para çdo download:
```cmd
:: Force TLS 1.2 per .NET WebClient (Windows Server 2016)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ...
    Set-ItemProperty 'HKLM:\SOFTWARE\Microsoft\.NETFramework\v4.0.30319'
    -Name SchUseStrongCrypto -Value 1 ..." >nul 2>&1
```
Vendos `SchUseStrongCrypto=1` në dy regjistrat (64-bit dhe 32-bit WoW64).

**2. TLS prefix në çdo PowerShell fallback command:**
- `DownloadString` (active-version check)
- `DownloadFile` (MSI download, `:do_upgrade` dhe `:fresh_install`)
- `Invoke-WebRequest` (MSI download, `:do_upgrade` dhe `:fresh_install`)

Secili tani fillon me:
`[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;`

### Checks

- `test_deploy_cmd_forces_tls12_after_exclusions_before_downloads`: verifikon
  praninë e TLS block, rendin (pas exclusions, para Case 0) dhe `SchUseStrongCrypto`/`Wow6432Node`.
- `test_deploy_cmd_active_version_fallback_has_tls12`: TLS prefix në `DownloadString`.
- `test_deploy_cmd_msi_download_has_powershell_fallback`: TLS prefix në
  `DownloadFile` dhe `Invoke-WebRequest` për të dy seksionet.

## [2026-06-18] MSI Deploy — curl.exe Fallback for Windows Server 2016 and Older

### Root cause

`techi-deploy.cmd` i gjeneruar përdorte `curl.exe` si i vetmi mjet download.
`curl.exe` nuk ekziston si built-in në Windows Server 2016 dhe versione
më të vjetra (u shtua si built-in vetëm në Windows 10 1803+). Rezultati:
silent fail pa download MSI dhe pa feedback.

### Fix

Tre check-e të reja, të gjitha brenda `techi-deploy.cmd` të gjeneruar:

**1. Active-version check — `where` guard + PowerShell fallback:**
```cmd
set ACTIVE_VERSION=
where curl.exe >nul 2>&1
if not errorlevel 1 (
    for /f ... curl.exe -s -f "%ACTIVE_VERSION_URL%" ...
)
if not defined ACTIVE_VERSION (
    for /f ... powershell.exe ... DownloadString("%ACTIVE_VERSION_URL%") ...
)
```

**2. MSI download (`:do_upgrade` dhe `:fresh_install`) — tre-shtresa fallback:**
```cmd
set DOWNLOAD_OK=0
where curl.exe >nul 2>&1
if not errorlevel 1 ( curl.exe ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" ( Net.WebClient.DownloadFile ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" ( Invoke-WebRequest ... && set DOWNLOAD_OK=1 )
if "%DOWNLOAD_OK%"=="0" goto :cleanup_fail
```

Rendi: `curl.exe` (nëse ekziston) → `Net.WebClient` → `Invoke-WebRequest`.

### Checks

- `test_deploy_cmd_active_version_has_powershell_fallback`: verifikon `where` guard
  dhe `DownloadString` fallback për version check.
- `test_deploy_cmd_msi_download_has_powershell_fallback`: verifikon tri shtresat
  e download (`curl`, `DownloadFile`, `Invoke-WebRequest`) dhe `DOWNLOAD_OK` guard
  në të dy seksionet `:do_upgrade` dhe `:fresh_install`.

## [2026-06-18] MSI Deploy — Fresh PC Fix: EXIT 1603 in do_upgrade on Uninstalled Product

### Root cause

`:do_upgrade` përdorte `REINSTALL=ALL REINSTALLMODE=vomus` në çdo rast, duke
përfshirë PC-të e reja ku produkti nuk ishte instaluar fare. Windows MSI kthen
`EXIT 1603` kur `REINSTALL=ALL` zbatohet mbi një produkt të painstaluar.

### Fix

Para `msiexec`, `:do_upgrade` tani:

1. Kontrollon regjistrin `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
   me `reg query /s /f "TECHI Agent" /d` për të zbuluar nëse produkti ekziston.
2. Nëse `PRODUCT_INSTALLED` është i definuar → upgrade path me
   `REINSTALL=ALL REINSTALLMODE=vomus` (sjellja e mëparshme).
3. Nëse `PRODUCT_INSTALLED` nuk është i definuar → fresh install path me
   `ENROLLMENT_TOKEN=%TOKEN% API_URL=%BACKEND_URL%` (e njëjta si `:fresh_install`).

### Checks

- Test strukturor `test_deploy_cmd_do_upgrade_detects_product_installed` verifikon:
  - `set PRODUCT_INSTALLED=` dhe `reg query ... findstr` janë brenda `:do_upgrade`
  - `if defined PRODUCT_INSTALLED (` bloku ekziston
  - Të dy path-et (REINSTALL dhe ENROLLMENT_TOKEN) janë brenda `:do_upgrade`

## [2026-06-18] MSI Deploy — Use ENROLLMENT_TOKEN and API_URL Properties

### Root cause

Bootstrap scripts kalonin MSI properties `TOKEN` dhe `BACKEND_URL`, ndërsa
installer-i pret `ENROLLMENT_TOKEN` dhe `API_URL`. Fresh install mund të
dështonte me `AbortNoToken` / MSI error `1603`.

### Fix

Të tre MSI install paths tani përdorin:

- `ENROLLMENT_TOKEN=<token>`
- `API_URL=<backend-url>`

Kjo përfshin token bootstrap PowerShell, GPO bootstrap PowerShell dhe
`techi-deploy.cmd` fresh install. Upgrade path nuk kalon token.

### Checks

- Teste strukturore për property names në të tre generatorët.
- Test që MSI invocation i vjetër `TOKEN=%TOKEN%` nuk gjenerohet më.

## [2026-06-18] GPO Deploy — Prioritize CommApp Agent Path

MSI administrative extract vendos agentin real te:
`CommApp\TechiAgent\techi-agent.exe`.

Manual fallback në `techi-deploy.cmd` tani kontrollon këtë path si zgjedhjen e
parë, përpara fallback-eve `PFiles64`, `CommonAppData` dhe `TechiAgent`.
Testi strukturor verifikon praninë dhe prioritetin e `CommApp`.

## [2026-06-18] GPO Deploy — Select Agent EXE from Known MSI Paths

### Root cause

Manual MSI fallback përdorte `for /R` për të kërkuar `techi-agent.exe`.
Kur MSI extract përmbante kopje të tjera brenda TECHI Remote Support
`flutter_assets`, variabla `EXTRACTED_AGENT` merrte rezultatin e fundit dhe
mund të kopjonte executable-in e gabuar.

### Fix

Kërkimi recursive u hoq. `techi-deploy.cmd` zgjedh vetëm path-et e njohura,
në këtë rend:

1. `CommApp\TechiAgent\techi-agent.exe`
2. `PFiles64\TECHI Agent\techi-agent.exe`
3. `CommonAppData\TechiAgent\techi-agent.exe`
4. `TechiAgent\techi-agent.exe`

Nëse asnjë nuk ekziston, manual fallback dështon pa kopjuar një binary të
pasaktë.

### Checks

- Test që `for /R` nuk gjenerohet më.
- Test për të tre path-et specifike dhe rendin e tyre.

## [2026-06-18] GPO Deploy — Defender Exclusions Before Agent Deployment

### Fix

- `gpo-deploy.ps1` shton menjëherë në Domain Controller exclusions lokale për:
  - `C:\ProgramData\TechiAgent`;
  - `C:\Windows\Temp\TechiDeploy`;
  - procesin `techi-agent.exe`.
- GPO `TECHI Agent - Defender Exclusions` vendos registry policy për të dy
  paths dhe procesin, dhe lidhet në domain root në mënyrë idempotente.
- `techi-deploy.cmd` ekzekuton `Add-MpPreference` për të njëjtat exclusions
  përpara version check, download dhe `msiexec`.
- Backend cleanup scheduler nuk nis më cleanup të madh menjëherë në çdo
  container restart; pret dritaren e planifikuar në `03:00 UTC`. Kjo shmang
  request starvation kur pajisjet reconnect-ojnë pas deploy-it.

### Checks

- Test që exclusions lokale në DC vendosen para import/deploy steps.
- Test që GPO registry përmban Paths dhe Processes dhe është linked në domain.
- Test që CMD exclusion command vjen para Case 0 dhe para MSI download.
- Post-deploy health kontrollohet pa startup cleanup concorrente.

## [2026-06-18] GPO Deploy — Verify Installed EXE After MSI Upgrade

### Root cause

`msiexec /i ... REINSTALL=ALL REINSTALLMODE=vomus` mund të kthente exit code
`0`, por të linte versionin e vjetër të
`C:\ProgramData\TechiAgent\techi-agent.exe`. MSI e përmbante executable-in e
ri, sepse administrative extract + manual copy funksiononte.

### Fix

- `:do_upgrade` tani ekzekuton `taskkill /f /im techi-agent.exe` pasi ndalon
  service-in dhe para `msiexec`.
- Pas një MSI exit `0`, script-i lexon përsëri versionin real nga
  `%AGENT_EXE% --version`.
- Nëse versioni mungon ose nuk përputhet me `ACTIVE_VERSION`, rrjedha kalon te
  `:manual_replace`.
- Manual fallback:
  - ekstrakton MSI-n me `msiexec /a`;
  - gjen `techi-agent.exe`;
  - ndalon service-in dhe vret çdo proces të mbetur;
  - kopjon executable-in e ri mbi `%AGENT_EXE%`;
  - rinis `TechiAgent`.

### Checks

- Test strukturor për `taskkill` para MSI.
- Test strukturor për version verification pas MSI exit `0`.
- Test strukturor që stop/taskkill ndodhin para manual copy.

## [2026-06-17] GPO Deploy — Robust Outdated-Agent Upgrade Path

### Root cause

Pas shtimit të version check në `techi-deploy.cmd`, dy raste mbetën të
rrezikshme:

- Nëse versioni lokal nuk lexohej nga `--version` ose `agent.config.json`,
  `CURRENT_VERSION` mbetej bosh dhe krahasimi CMD nuk e detyronte upgrade-in
  në mënyrë të besueshme.
- Upgrade MSI mbi një instalim ekzistues mund të dështonte me `1603` kur
  `TechiAgent` ishte ende `RUNNING`.

### Fix

- `CURRENT_VERSION` bosh trajtohet si `0.0.0`, kështu çdo paketë aktive më e
  re shkakton upgrade.
- `:do_upgrade` ndalon `TechiAgent` para `msiexec`.
- Upgrade MSI përdor:
  `REINSTALL=ALL REINSTALLMODE=vomus /quiet /norestart`.
- Pas upgrade-it, script-i tenton `net start TechiAgent`.
- Nëse `msiexec` dështon, script-i bën fallback manual:
  - ekstrakton MSI-n me `/a`;
  - gjen `techi-agent.exe` në extract dir;
  - kopjon executable-in mbi path-in ekzistues;
  - rinis service-in.

### Checks

- Test strukturor për fallback `CURRENT_VERSION=0.0.0`.
- Test strukturor për stop/start service dhe `REINSTALLMODE=vomus`.
- Test strukturor për fallback manual `msiexec /a` + copy të `techi-agent.exe`.

## [2026-06-17] GPO Deploy — Agent MSI Upgrade When Installed Agent Is Outdated

### Root cause

`techi-deploy.cmd` dilte me `exit /b 0` kur `agent.config.json` kishte
`device_id` dhe `TechiAgent` ishte `RUNNING`. Kjo e bënte GPO deployment
idempotent, por bllokonte upgrade-in e agjentëve ekzistues p.sh. nga `1.0.4`
në paketën aktive `2.0.0`.

### Fix

- Shtuar endpoint publik plain-text:
  `GET /api/v1/agent-packages/active-version`.
- Endpoint-i kthen versionin aktiv të paketës `windows-amd64`, p.sh. `2.0.0`,
  me `Cache-Control: no-store`.
- `techi-deploy.cmd` i gjeneruar nga `gpo-deploy.ps1` tani ka **Case 0** para
  idempotency exit:
  - lexon versionin aktual nga `techi-agent.exe --version`;
  - fallback: lexon `agent_version` nga config nëse ekziston;
  - merr versionin aktiv nga serveri;
  - nëse versionet ndryshojnë, shkarkon MSI dhe bën upgrade silent.
- Fresh install kalon `ENROLLMENT_TOKEN=%TOKEN%` dhe `API_URL=%BACKEND_URL%`;
  upgrade ruan konfigurimin ekzistues dhe nuk e ri-enroll-on pajisjen.

### Checks

- Test për `active-version` plain-text success/404.
- Test strukturor që `Case 0` shfaqet para `Case 1` në script-in e GPO deploy.
- Test strukturor që ekzistojnë të dy path-et: upgrade MSI pa token dhe fresh
  install MSI me token.

## [2026-06-17] Agent Version UI — Kolona, Filter, Dashboard, Command Center

### Çfarë u shtua

**Backend:**
- `DeviceBase` schema merr `agent_version: Optional[str] = None` — ekspozohet
  automatikisht nga `/api/v1/devices/` response.
- `DeviceFleetOverview` merr dy fusha të reja: `agents_outdated: int` dhe
  `active_agent_version: Optional[str]`.
- `DeviceOverviewService._compute_overview()` llogarit `agents_outdated` duke
  krahasuar `device.agent_version` me versionin aktiv nga `AgentPackageService
  .latest_active("windows-amd64")`.

**Frontend — DevicesTable:**
- Tip `QuickFilter` dhe array `QUICK_FILTERS` marrin `"needs_agent_update"`.
- Props të reja: `activePackageVersion` dhe `agentsOutdated`.
- Fleet Health Panel zgjerohet nga 6 → 7 karta; karta "Agent Update" (vjollcë)
  filtroi sipas `needs_agent_update`.
- Kolona "Agent" (desktop-only) shfaqet pas kolonës "OS":
  - Badge jeshile nëse `agent_version === activePackageVersion`
  - Badge portokalli nëse versioni është i vjetër
  - "—" gri nëse null
- `DeviceMobileCard` merr prop `activePackageVersion` dhe shfaq
  `Agent v{version} ⚠️` (portokalli) ose `Agent v{version}` (jeshile) në Row 4.

**Frontend — DashboardMobile:**
- Prop `agentsOutdated` i ri; shfaqet si `"Agent updates pending: N →"` në
  seksionin "Needs Attention" (link → `/devices?filter=needs_agent_update`).

**Frontend — AgentCommandsPanel:**
- Target select merr opsionin `"Devices needing agent update"`.
- Zgjidhet si `"all"` në API call (agjentët vetë kontrollojnë versionin).
- InfoNote shpjegon sjelljen.

### Files
- `backend/app/schemas/device.py`
- `backend/app/services/device_overview_service.py`
- `frontend/src/api/devices.ts`
- `frontend/src/components/DevicesTable.tsx`
- `frontend/src/components/DeviceMobileCard.tsx`
- `frontend/src/pages/DashboardMobile.tsx`
- `frontend/src/components/AgentCommandsPanel.tsx`
- `frontend/src/pages/Devices.tsx`
- `frontend/src/pages/Dashboard.tsx`

## [2026-06-16] Agent Update Plan — Dokumentuar

- Krijuar `docs/AGENT-UPDATE-PLAN.md` me planin e plotë teknik
- Filozofia: MSI instalohet 1 herë, gjithçka tjetër kontrollohet nga UI
- 3 faza: Backend/UI Command Center → Agent v2.0 Golang → MSI final deploy via GPO

## 2026-06-13 - Mobile "Command Center" Redesign — BottomNav, DashboardMobile, FilterSheet, Load More

### Problem

Mobile UX (<768px) ishte i papërdorshëm: Dashboard shfaqte tabela me 10 kolona,
`/devices` kishte DeviceTree + 6 stats cards + filter dropdowns që zinin gjithë
ekranin. Nuk kishte navigim persistent në fund (BottomNav). Filter-at ishin
të paarritshëm pa scroll.

### Zgjidhja

**Arkitekturë e ndryshuar (breakpoint shift):**
- `AppShell.tsx`: kalim nga `sm:` (640px) te `md:` (768px) për sidebar dhe
  grid layout. Range 640–767px tani shfaq mobile layout (BottomNav) jo desktop
  sidebar. `<main>` merr `pb-16 md:pb-0` për hapësirë mbi BottomNav.

**Komponentë të rinj:**

1. `components/BottomNav.tsx` — nav i fiksuar poshtë (4 tabs: Dashboard, Devices,
   Alerts me badge, Menu). `md:hidden`. Alert badge nga `useAppData()`. Active
   state sipas `useLocation()`. `env(safe-area-inset-bottom)` padding.
   "Menu" tab → hap mobile sidebar ekzistues (callback nga AppShell).

2. `pages/DashboardMobile.tsx` — SVG health ring (% online, ngjyrë sipas
   threshold: emerald ≥90% / amber ≥70% / red <70%), grid 2×2 stat tiles
   (Total/Online/Critical/Alerts, çdo tile Link → /devices?filter=...), seksioni
   "Needs Attention" (listë çështjesh me count + link, ose "✅ All systems healthy").
   Nuk bën fetch shtesë — konsumon të dhëna nga `fleetOverview` + `alertCount`
   të AppDataContext-it.

3. `components/FilterSheet.tsx` — bottom sheet slide-up (82vh max), `md:hidden`.
   Kapaku (backdrop) mbyll me tap. Permban: quick filter pills (9 opsione),
   connection state pills, listë klientësh tap-able → aplikon `client_id` filter.
   `body.style.overflow = hidden` kur është hapur.

**Ndryshime ekzistuese:**

4. `contexts/AppDataContext.tsx` — shtohen `alertCount`, `totalOpenAlerts`,
   `alerts` duke integruar `useAlerts` brenda providerit. Kjo shmang double-polling
   (ishte i thirrur veçmas në `Devices.tsx`, tani 1 instancë globale).
   `Devices.tsx` tani konsumon `alerts`/`alertCount` nga `useAppData()`.

5. `pages/Dashboard.tsx` — split `md:hidden` (DashboardMobile) /
   `hidden md:block space-y-4` (desktop layout i paprekur).

6. `pages/Devices.tsx` — mobile header minimal (titull + alert badge `md:hidden`);
   desktop header card, DeviceTree, stat cards (4+2), info panels → `hidden md:block`
   / `hidden md:grid` / `hidden md:flex`. `mobileExtraLimit` ref + `handleMobileLoadMore`
   callback: rrit limitin e API call-it (20→40→60) pa prek URL pagination.

7. `components/DevicesTable.tsx`:
   - Fleet health mini-cards (6 butonë): `hidden md:grid`
   - "Devices catalog" card (search + filter dropdowns): `hidden md:block`
   - Mobile branch: shtohet sticky search bar (top-0 z-10) + active filter chip
     + "⚙ Filters" buton → FilterSheet
   - Load More buton poshtë kartave (shfaqet kur `mobileHasMore`)
   - Footer (pagination) → `hidden md:flex`
   - Props të reja: `clients`, `onMobileLoadMore`, `mobileHasMore`, `mobileLoadingMore`

### Vendime arkitekturore

- **Single polling**: `useAlerts` zhvendoset te `AppDataContext` — jo më thirrje
  dyfishe. `Devices.tsx` fsheh `import { useAlerts }`.
- **Load More si limit-growth**: jo accumulator array, jo URL param ndryshim.
  Desktop pagination mbetet e paprekur (konsumon URL `?page=N&limit=N`).
  Mobile konsumon tërë `tableDevices` me limit në rritje.
- **Breakpoint md: (768px)**: konsistente me deklaratën e userit "mobile <768px".
  Range 640-767px: ishte desktop (sidebar), tani: mobile (BottomNav).
- **FilterSheet**: vetëm client list (pa DeviceTree me subgroups) — DeviceTree
  mbetet desktop-only për kompleksitet të reduktuar.
- **"Needs Attention"**: listë çështjesh sipas kategorive (offline/critical/updates
  /alerts) pa fetch shtesë — të dhënat nga `fleetOverview`.

### Testim Manual

**Mobile (390px viewport):**
1. Dashboard → shihen: SVG ring + 2×2 tiles + Needs Attention lista; nuk shihen: tabela, cards
2. BottomNav → 4 tabs të dukshëm fixed poshtë; Alerts tab ka badge nëse ka alerts
3. Devices → shihet: sticky search + "Filters" buton, kartat e device-ve; nuk shihen: DeviceTree, stat cards, filter dropdowns
4. "Filters" tap → FilterSheet slide-up me client list dhe quick filters
5. "Load More" → shfaqet kur ka devices shtesë, rrit listën pa reload
6. "Menu" tab → hap mobile sidebar me të gjithë nav items

**Desktop (1440px viewport):**
1. Dashboard → identik me para (nuk ka ndryshim)
2. Devices → sidebar, stat cards, DeviceTree, DevicesTable identike
3. Filter dropdowns, pagination → të paprekura

## 2026-06-13 - Mobile responsive DevicesTable (card view) + PWA "Add to Home Screen"

### Problem

`/devices` në mobile (~390px) shfaqte tabelën e plotë me 10 kolona duke
shkaktuar scroll horizontal. Butoni Connect ishte i fshehur jashtë ekranit.
Gjithashtu nuk kishte asnjë manifest PWA, kështu që iPhone Safari nuk ofronte
"Add to Home Screen" me ikonë dhe emër korrekt — hapej si faqe web normale.

### Zgjidhja

**DevicesTable responsive:**
- Krijohet `DeviceMobileCard.tsx` — komponent i veçantë, ripërdor të gjithë
  logjikën badge/status/health nga DevicesTable pa duplikim fetch/filter.
  Karta: status dot + hostname + Connect (40×40 px touch target) inline djathtas,
  pastaj badges, Client/Group · Domain, User · IP · Last seen.
- Në `DevicesTable.tsx`: shtuar `<div className="md:hidden">` me listën e
  kartave dhe `<div className="hidden md:block">` që wraps tabelën ekzistuese.
  **Zero ndryshime** në desktop layout — tabela mbetet identike bit-për-bit.
- Checkbox bulk-select hiqet në mobile (nuk ka kuptim pa hover/selection).
- Footer (pagination) mbetet i përbashkët dhe i dukshëm në të dyja.

**PWA:**
- `public/manifest.json` me name/short_name/theme_color/icons.
- 3 ikona PNG të gjeneruara nga `apple-touch-icon.png` me Pillow: 192×192,
  512×512, dhe maskable-512 (ikonë në 80% canvas #0a0a0a për safe-zone Android).
- `index.html`: `<link rel="manifest">`, `<meta name="theme-color">`, dhe meta
  tags iOS (`apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`,
  `apple-mobile-web-app-title`).
- `public/sw.js`: service worker minimal network-first, pa cache agresiv të API
  (dashboard live data). Fallback te cache vetëm nëse rrjeti është plotësisht
  i padisponueshëm.
- `main.tsx`: regjistrim SW pas `window load`.
- `nginx.conf`: location blocks të dedikuara — `manifest.json` dhe `/icons/`
  me `max-age=86400`, `/sw.js` me `no-cache` (browser duhet ta kontrollojë
  çdo herë). Shtuar `worker-src 'self'` në CSP për Firefox.

### Testim manual

1. **iPhone Safari / mobile 390px** — hap `/devices`, verifiko:
   - Secili device shfaqet si kartë, pa scroll horizontal
   - Butoni Connect është gjithmonë i dukshëm inline djathtas hostname
   - Tap kartë → hapet DeviceDrawer
   - Tap Connect → hapet RustDesk (direkt, pa alert)

2. **PWA — iPhone Safari** — hap `https://rdp.techi.com.al`, Share →
   "Add to Home Screen":
   - Ikona TECHI shfaqet saktë
   - Emri tregon "TECHI"
   - Hapja nga Home Screen → standalone mode (pa adresë bar)

3. **Desktop ≥ 768px** — hap `/devices`:
   - Tabela identike si para ndryshimit
   - Asnjë ndryshim vizual a funksional

## 2026-06-13 - Connect button: iOS bypass — shkoni direkt te RustDesk, pa alert

### Problem

Në iOS Safari, butoni Connect provonte `techiremotesupport://` si hap të parë.
Meqë TECHI Remote Support nuk ekziston si app iOS, Safari shfaqte alertin nativ
"Cannot Open Page — the address is invalid". Fallback-i i vonuar (`setTimeout`
1200 ms) për `rustdesk://` nuk ekzekutohej kurrë: iOS Safari kërkon që çdo
navigim me custom scheme të jetë rezultat DIREKT i një user gesture (tap) —
navigimi nga `setTimeout` konsiderohet jashtë stack-ut të gestit dhe bllokohet
në heshtje pa asnjë gabim.

### Zgjidhja

`rustdeskLaunch.ts` fitoi dy shtesa:

- `isIOS()` — helper privat që kontrollon `navigator.userAgent` dhe detekton
  edhe iPadOS (shumë touch points + MacIntel platform).
- `launchConnect(techiUrl, rustdeskUrl, onFallback?)` — wrapper i ri i
  eksportuar që bëhet `entry point` i vetëm për butonin Connect:
  - **iOS**: kapërcen plotësisht `techiremotesupport://`, thërret
    `clickProtocolUrl(rustdeskUrl)` brenda stack-ut të gestit (pa delay), pastaj
    thërret `onFallback?.()` për toast-in "Opening with RustDesk instead".
  - **Çdo platformë tjetër**: delegon te `launchWithFallback()` — sjellja
    ekzistuese me blur-detection nuk preket fare.

`DevicesTable.tsx` dhe `DeviceDrawer.tsx` ndërruan vetëm emrin e thirrjes:
`launchWithFallback` → `launchConnect`. Parametrat identikë.

### Testim manual

- **iPhone/iPad Safari**: kliko Connect → RustDesk hapet menjëherë (pa asnjë
  alert "Cannot Open Page"), shfaqet toast "Opening with RustDesk instead".
- **PC me TECHI Remote Support**: kliko Connect → TECHI Remote Support hapet
  brenda ~300 ms, nuk shfaqet RustDesk, nuk shfaqet toast.
- **PC pa TECHI Remote Support / Android**: kliko Connect → pas ~1200 ms hapet
  RustDesk, shfaqet toast.

## 2026-06-13 - Connect button: TECHI Remote Support first, RustDesk fallback

### Problem

The Connect button always launched `techiremotesupport://` via `window.open()`.
On mobile devices (and any PC without TECHI Remote Support installed) nothing
happened — the protocol was not registered and the browser silently did nothing.
Users on mobile had to use RustDesk manually.

### Solution

`rustdeskLaunch.ts` gained two new exports:

- `buildRustDeskFallbackUrl(id)` — builds `rustdesk://{id}` (same RustDesk ID,
  different scheme).
- `launchWithFallback(techiUrl, rustdeskUrl, onFallback?)` — attempts
  `techiremotesupport://` first via a hidden anchor click (no page navigation),
  then listens for a window `blur` event within 1200 ms. If the OS accepted the
  protocol it hands app focus over and the tab blurs — the listener fires and
  the fallback is suppressed. If no blur arrives the tab remained focused,
  meaning no app handled the protocol, so `rustdesk://` is attempted and the
  optional `onFallback` callback fires (used for toasts). Module-level
  timer/listener state ensures rapid re-clicks cancel any in-flight attempt.

`DevicesTable.tsx` and `DeviceDrawer.tsx` both switched their Connect button
`onClick` from `launchRustDesk()` to `launchWithFallback()` with the
appropriate toast callback (bulk toast / `rsToast`) so users see "Opening with
RustDesk instead" when the fallback fires.

### Manual verification

1. On a PC with TECHI Remote Support installed: click Connect — TECHI Remote
   Support opens within ~100–300 ms, no RustDesk, no toast.
2. On a mobile device or a PC without TECHI Remote Support: click Connect —
   after ~1200 ms RustDesk opens and a brief toast "Opening with RustDesk
   instead" appears.
3. Rapid double-click: only one protocol launch occurs (the second click cancels
   the first attempt's pending timer).

Note: on first use browsers may show an "Open this link in [App]?" confirmation
dialog before handing off — the dialog itself triggers a blur so the heuristic
correctly treats this as success and no fallback fires.

## 2026-06-12 - Token usage warnings: page banner, table badges, and alerts feed

### Problem

Nothing surfaced a token approaching its enrollment limit. Operators found
out only when agents started failing with "token exhausted" — historically
made worse by the (now fixed) re-enrollment inflation.

### Solution

`EnrollmentToken` gained a computed `usage_warning` property: `critical` when
`use_count >= max_uses`, `warning` at 90%+ (constant
`TOKEN_USAGE_WARNING_THRESHOLD = 0.9` in the model), `null` otherwise. Only
`active`/`used` tokens report it; revoked/expired stay silent. The field
rides along on every endpoint that serializes a token, including the list the
Enrollment Bootstrap page loads.

The alerts feed integration is computed on read — no new table, no background
job. `device_alerts.device_id` is NOT NULL, so instead of a migration, the
new `token_usage_alert_service.build_token_usage_alerts` synthesizes alert
rows (kind `token_usage_warning`/`token_usage_critical`, negative ids equal
to `-token_id`, `device_id` null, internal bootstrap tokens excluded) and the
`/alerts/` and `/alerts/count` endpoints merge them in. They cannot be
resolved manually and disappear on their own once `max_uses` is raised.

Enrollment Bootstrap page: an amber banner at the top lists affected tokens
with `use_count/max_uses (percent%)`, the Uses column shows a "⚠️ 90%" or
"🔴 FULL" badge, and clicking either opens a new "Raise Max Uses" modal — the
first UI for the existing PATCH endpoint, whose service layer already
reactivates a `used` token when the limit rises above the use count. The
notification bell (Devices page) routes token alerts to
`/enrollment-bootstrap` instead of a device drawer and hides their resolve
button.

### Verification

New backend tests `test_usage_warning_thresholds` and
`test_build_token_usage_alerts` (thresholds, internal/revoked exclusion,
message format, negative ids); all 16 enrollment tests pass under Python 3.12
in a throwaway backend container. Frontend `tsc --noEmit` is clean — the
nullable `device_id` on alerts required a guard in the Devices page alert
map, which now skips synthetic alerts.

## 2026-06-12 - Exhausted enrollment tokens no longer block re-enrollment of existing devices

### Problem

Once a token reached `max_uses` (status `used`), every enrollment with it was
rejected at `validate_for_enrollment` — including re-enrollments of devices
that were originally enrolled with that token. Since the previous fix made
re-enrollments free (they no longer consume a use slot), rejecting them on an
exhausted token was inconsistent: a PC that reinstalled its agent could be
locked out even though it claimed no new capacity.

### Root cause and solution

`AgentEnrollmentService.enroll` enforced token status before it knew whether
the request matched an existing device; `find_reenrollment_match` only ran
later, inside `_upsert_device`. The order is now: resolve the token without a
status check (`get_for_enrollment`, new method that still rejects unknown
tokens), run the device match on the payload's agent_id / rustdesk_id /
hostname / IPs, and only then enforce status. A matched device accepts
`active` or `used` tokens; a genuinely new device still requires `active`.
Revoked and expired tokens remain rejected on both paths so revocation stays
an effective kill switch. The `/enroll` endpoint now returns "Enrollment
token exhausted, max_uses reached" for the `used` rejection; audit reasons
(`token_used`, `token_invalid`, ...) are unchanged.

### Verification

New regression tests: `test_exhausted_token_still_allows_reenrollment_of_existing_device`
(token forced to `use_count == max_uses`, status `used`; the same payload
re-enrolls to the same device and `use_count` stays at max) and
`test_exhausted_token_rejects_new_device` (unmatched payload on the same
exhausted token fails with `token_used` audit). All 14 enrollment tests pass
under Python 3.12 in a throwaway backend container on techi-server.

## 2026-06-12 - Enrollment token use_count no longer increments on re-enrollment

### Problem

Every agent `POST /api/v1/agent/enroll` incremented the enrollment token's
`use_count`, including re-enrollments that matched an existing device
(`reenrollment_match`). A single physical PC could consume 2-7 token uses over
its lifetime, so tokens approached `max_uses` far ahead of real deployments.
Production audit data showed the inflation clearly: "Global Fast Food Albania"
had `use_count` 251 against 38 distinct devices and only 1 `device_created`
audit event in the audited window; "Metropol" had 181 against 31 devices.

### Root cause and solution

In `AgentEnrollmentService.enroll`, `mark_enrollment_used(token)` ran
unconditionally after `_upsert_device`, regardless of whether the upsert
created a new device or reconciled to an existing one via
`find_reenrollment_match` (agent_id/rustdesk_id/hostname/IP matching). The
trusted-domain path was unaffected because it never touches a token, and the
operator-facing `/enrollment-tokens/verify` endpoint already used the
non-incrementing `peek()`.

The fix gates the increment on the existing `reenrollment_matched` flag:
`mark_enrollment_used` is now called only when a new device record was
created. Re-enrollments still update the device, write the
`updated_existing`/`reenrollment_match` audit event, and bump the device's
own `enrollment_count`.

### Verification

New regression test `test_reenrollment_does_not_increment_use_count` enrolls
the same payload twice and asserts the second call reconciles to the same
device with `use_count` still 1. Full enrollment test files (12 tests) pass
under Python 3.12 in a throwaway backend container on techi-server with the
patched files volume-mounted; the production container was not modified.

Existing inflated `use_count` values in production were not reset; audit data
is incomplete for older history, so any correction needs an operator decision
on the baseline (for example distinct audited devices per token).

### Problem

Top-level client counts came from `/api/v1/devices/overview`, but the nested
`Servers` and `Client PC` counts were calculated from the currently loaded,
paginated Devices table. A client with 122 devices could therefore initially
show `Client PC: 1` or `0`. Clicking the folder changed the table filter and
made the number appear to correct itself from the newly loaded page.

The same partial dataset caused `Show empty groups` to display populated
folders with a zero count.

### Root cause and solution

`DeviceTree` mixed two count sources: complete overview counts for clients and
partial page data for child folders. The overview aggregation now includes a
`by_client_category` breakdown using the same canonical group and OS rules as
the server/workstation filters. It remains part of the existing count query,
so the overview still uses two database statements.

All tree levels now render from the same cached overview snapshot. Paginated
table data is retained only for row rendering and realtime maintenance
indicators, never for folder counts.

Persisted overview snapshots from the older response format are discarded
once, ensuring the first reload after deployment fetches the category
breakdown instead of briefly rendering zero subgroup counts.

## 2026-06-12 - Persistent session and shared fleet overview architecture

### Problem

Navigating through Dashboard, Clients, Operators, Audit, and Devices could
produce a visible `Loading session...` gate followed by empty tree counts and
stat-card skeletons. Devices table data arrived first, but fleet cards could
take 8 seconds or substantially longer.

Production access logs showed full document requests during the affected
navigation sequence. A document reload destroys module-level React caches, so
the previous in-memory auth cache could not prevent another auth bootstrap.
The bootstrap also made two sequential requests:

- `/api/v1/auth/me`
- `/api/v1/auth/permissions/me`

The fleet cards and tree depended on `/api/v1/devices/summary`. That endpoint
loads complete device records, telemetry, inventory, alerts, health details,
and patch details for the whole fleet even when the UI only needs a handful of
counts.

### Before

Production measurements taken on 2026-06-12:

| Request | Time | Payload |
| --- | ---: | ---: |
| `/api/v1/auth/me` | 1.70 s | 244 B |
| `/api/v1/auth/permissions/me` | 1.15 s | 352 B |
| `/api/v1/devices/?skip=0&limit=20` | 0.32 s | 41 KB |
| `/api/v1/devices/tree` | 0.31 s | 142 B |
| `/api/v1/devices/summary` | 22.81 s | 1.16 MB |

Consequences:

- auth bootstrap blocked the route for roughly 2.85 seconds after a document
  reload;
- the table could render while fleet cards and tree counts remained pending;
- Dashboard and Devices maintained separate caches for the same fleet data;
- Dashboard, Devices, and Remote Support could create separate device
  WebSocket connections as pages mounted and unmounted.

### Backend solution

`GET /api/v1/auth/session` now returns the authenticated operator and effective
permissions in one request.

`GET /api/v1/devices/overview` now returns:

- total, online, stale, and offline counts;
- tree totals and per-client counts;
- critical and warning health counts;
- average fleet health;
- devices needing updates;
- overview load timestamp.

The overview uses two database statements:

1. one grouped aggregation for freshness stats and client tree counts;
2. one joined, minimal health-input query for latest telemetry, inventory, and
   open alert counts.

The response is cached per operator scope for 30 seconds. The existing full
`/devices/summary` endpoint remains available for detailed reports, but it is
not used during Dashboard or Devices page mount.

A local SQLite benchmark with 700 devices completed the uncached overview in
44.5 ms with a 226-byte JSON payload. Production timing must be measured after
deployment, but this is well below the previous full-summary work and payload.

### Frontend solution

`sessionStore.ts` is a module singleton backed by `useSyncExternalStore`.

- user and permissions persist in `sessionStorage`;
- a page reload hydrates auth synchronously;
- one `bootstrapPromise` deduplicates concurrent session requests;
- auth data is removed only by logout or an HTTP 401;
- transient request failures do not erase the stored session.

`AppDataContext.tsx` is mounted once above the routed application.

- fleet overview persists in `sessionStorage`;
- fresh data renders synchronously;
- stale data renders immediately and refreshes in the background;
- concurrent overview requests are deduplicated;
- one shared device WebSocket publishes status and the latest event;
- Dashboard, Devices, and Remote Support no longer create page-owned device
  WebSocket connections.

Devices now loads its paginated table independently and reads all six large
cards plus top-level tree counts from the shared overview. Dashboard reads the
same overview and loads only its small recent-activity datasets.

Row-level health and patch badges load in the background from
`/api/v1/devices/table-details` for only the IDs on the current page. This
preserves table filters and badges without putting the full summary back on the
page-mount critical path.

### Expected behavior

- `Loading session...` appears only when a valid token exists but no persisted
  session has ever been loaded in the current browser tab.
- Route navigation never re-runs auth bootstrap.
- Reloading a tab with persisted session data does not show the auth gate.
- Devices cards and tree use one compact overview request.
- The Devices table remains independently paginated and can render without
  waiting for overview refresh.

### Verification

- Backend application modules compile successfully.
- The overview service smoke test confirms two SQL statements and cache reuse.
- The 700-device overview benchmark completes in 44.5 ms locally.
- The combined auth-session contract returns user and permissions together.
- `npm run build` succeeds after the AuthContext, AppDataProvider, Dashboard,
  Devices, and Remote Support refactor.
- The repository's local pytest environment uses Python 3.9 while existing
  backend code requires Python 3.10+ syntax, so focused pytest collection must
  run in the production-compatible backend environment.

## 2026-06-12 - Devices stat cards stay loading after a hard refresh

### Symptom

After an F5 reload on the Devices page, the paginated table loaded but the
Total, Online, Stale, Offline, Critical, and Warnings cards could remain in
their loading state until the user clicked Refresh.

### Investigation

- `loadTableData()` and `loadSnapshot()` own separate state. The table loader
  does not overwrite snapshot stats, health, patches, or snapshot loading.
- `loadSnapshot()` already handled an empty in-memory cache correctly: a cache
  miss continues to `getDevicesSummary()`.
- The six large cards all use `snapshotLoading` to decide whether to display
  their values or skeletons.
- `getDevicesSummary()` could successfully populate `snapshotStats`,
  `allDevices`, and `healthMap` while `snapshotLoading` remained true.
- The loading flag was cleared only after a `Promise.all()` containing both
  `getDevicesSummary()` and a redundant `getDeviceTree()` request. If the tree
  request remained pending, the summary-backed values existed but the cards
  continued to render skeletons.

### Fix

The snapshot loader now:

- waits only for `getDevicesSummary()` before clearing `snapshotLoading`;
- uses `snapshot.tree_counts` for the tree, which was already part of the
  summary response;
- no longer makes the redundant `getDeviceTree()` request.

```tsx
const snapshotPromise = getDevicesSummary().then((snapshot) => {
  setSnapshotStats(snapshot.stats);
  setTreeCounts({
    total: snapshot.tree_counts.total,
    unassigned: snapshot.tree_counts.unassigned,
    byClient: new Map(
      Object.entries(snapshot.tree_counts.by_client).map(([id, count]) => [Number(id), count])
    ),
  });
  setHealthMap(Object.fromEntries(snapshot.health.map((item) => [item.device_id, item])));
});

await snapshotPromise;
```

### Expected flow

1. The Devices page mounts.
2. `loadSnapshot()` starts one summary request for cards, health, patches, and
   tree counts.
3. `loadTableData()` independently starts the paginated devices request.
4. Each request updates only its own loading and data state.

### Verification

- Run `npm run build` from `frontend`.
- Hard-refresh `/devices` with the browser network panel open.
- Confirm one initial `/api/v1/devices/summary` request, no redundant
  `/api/v1/devices/tree` request, and one paginated `/api/v1/devices/` request.
- Confirm the stat cards populate without clicking Refresh.
