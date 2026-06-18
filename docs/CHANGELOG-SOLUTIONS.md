# TECHI Platform Changes and Solutions

Use this file as a running record of user-facing fixes, their root causes, and
the checks used to verify them. Add new entries at the top.

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
- Fresh install vazhdon të kalojë `TOKEN=%TOKEN%`; upgrade ruan konfigurimin
  ekzistues dhe nuk e ri-enroll-on pajisjen.

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
