# TECHI MOBILE UI 2.0 — DESIGN SPECIFICATION

| | |
|---|---|
| **Status** | DESIGN LOCKED — aprovuar nga Mario (2026-07-05) |
| **Roli i dokumentit** | Kontrata zyrtare e dizajnit Mobile UI 2.0. Jo changelog, jo histori. |
| **Mockup i aprovuar** | https://claude.ai/code/artifact/af146cd9-d000-49d3-b723-35442ee3eaae (versioni `mockup-v2-emri-i-dukshem`) |
| **Baza** | Audit vizual në produksion me Playwright (2026-07-05, 54 screenshots, gjetjet B1–B10) + audit kodi |
| **Scope** | VETËM Mobile (<768px). Desktop, API, Backend, Agent — të paprekura. |

Çdo devijim nga ky dokument gjatë implementimit është i ndaluar. Problemet
teknike dokumentohen te **Implementation Notes** — nuk zgjidhen duke ndryshuar
dizajnin.

---

# Vision

TECHI Mobile është vegla e xhepit e administratorit MSP: hap → sheh problemin →
hap pajisjen → vepron → mbyll, brenda 15 sekondash, me një dorë, me besim të
plotë te freskia e të dhënave. Niveli i synuar: NinjaOne / Datto / Atera, me
identitet TECHI.

# Goals

1. Zero qorrsokaqe (search, alerts, offline — gjetjet B1, B2 të auditit).
2. Freski transparente: përdoruesi e di gjithmonë nëse sheh live apo cached.
3. Aksionet kritike gjithmonë nën gisht (sticky action bar në Device Details).
4. Një numër i vetëm i alerteve kudo (B4); një etiketë e vetme tipi (B5).
5. Light theme funksionale në çdo ekran mobile (B3).
6. Asnjë regresion Desktop; asnjë ndryshim API/backend.

# Scope

**Brenda:** gjithçka `<768px` — AppShell mobile, BottomNav, TopBar mobile,
Dashboard, Devices, Device Details, Alerts, More, Settings, FilterSheet,
gjendjet (loading/empty/error/offline), design tokens mobile.

**Jashtë:** Desktop UI/logic, API contracts, Backend (vetëm nëse absolutisht i
domosdoshëm për Mobile UI — dokumentohet), Agent, klienti Flutter i Remote
Support (ikonat Android janë projekt më vete).

# Design Principles

1. **Live by default, transparent when stale** — FreshnessPill i përhershëm;
   çdo refresh invalidon cache përpara leximit.
2. **Triage-first** — informacioni "glanceable" lart, aksionet në thumb zone.
3. **Emri i pajisjes dominon** — 16.5px me rresht të vetin; badges poshtë tij
   (aprovuar në mockup v2).
4. **Një burim stili** — vetëm CSS vars `--th-*`; asnjë hex jashtë tokens.
5. **Mobile ≠ Desktop i ngjeshur** — faqet pa vlerë mobile deklarohen
   "Desktop console", nuk shfaqen si tabela të ngjeshura.
6. **Overlays MBI BottomNav** — sheet/drawer/snackbar kanë z-index mbi nav;
   në Device Details BottomNav fshihet fare (B6/B7).

# Information Architecture

```
Mobile App
├── Dashboard        (triage i flotës)
├── Devices          (kërkim + filtra + lista; → Device Details)
│   └── Device Details (/devices/:id — faqe, jo drawer)
├── Alerts           (inbox i grupuar; → Device Details)
└── More
    ├── Workspace: Remote Support, Clients, Audit Log
    ├── Desktop console: Deployment, Enrollment, Packages,
    │   Operators, Teams, Agent Config (dim, "vetëm desktop")
    └── App: Settings, Version, Sign out
```

Sidebar-i slide-in **HIQET nga mobile** (mbetet identik në Desktop).
Inventory **nuk shfaqet** në More (faqe placeholder — gjetja e auditit).

# Navigation

- **BottomNav — 4 tabs fikse:** Dashboard `/`, Devices `/devices`,
  Alerts `/alerts`, More `/more`.
- Tab aktiv: ngjyra `--th-accent` + underline 2.5px lart + `aria-current="page"`.
- Badge i Alerts: numri i alerteve open, **cap "99+"** (kurrë "9+").
- More është aktiv edhe në nënfaqet e tij (`/settings`, faqet e workspace kur
  hapen nga More).
- BottomNav fshihet: në Device Details (sticky action bar zë vendin), në
  Login, dhe kur tastiera është e hapur.
- **TopBar mobile (52px):** titulli i ekranit majtas (me buton ‹ back në
  nënfaqe), djathtas FreshnessPill + ikona e kërkimit global (Phase 3).
- **Deep links:** `/devices/:id` (Phase 4), query params ekzistuese
  `?filter=&q=` ruhen.
- **Back:** browser/Android back mbyll overlay-in e hapur përpara se të
  largohet nga faqja.

# Screen Map

| Ekrani | Route | Faza | Statusi aktual |
|---|---|---|---|
| Dashboard | `/` | 2 | rifinim (tokens, activity, copy) |
| Devices | `/devices` | 3 | rifinim (karta v2, chips, empty fix) |
| Device Details | `/devices/:id` | 4 | **rindërtim nga zero** (nga drawer → faqe) |
| Alerts | `/alerts` | 5 | **rindërtim** (grupim, emra, undo) |
| More | `/more` | 1 | i ri |
| Settings | `/settings` | 1 (minimal) → 6 (i plotë) | i ri |
| Remote Support mobile | `/remote-support` | 6 | pamje e re mobile |
| FilterSheet v2 | overlay | 3 | rindërtim |
| Global Search | overlay | 3 | i ri |
| Login | `/login` | 7 (polish) | ekziston |

# User Flows

**Flow kryesor (alert → veprim, target <15s):**
```
Alerts (badge 99+) → tap grup/alert → Device Details (Alerts section hapur)
→ Restart në action bar → konfirmim me emër → toast + status live
```

**Kërkimi:** Devices → shkruaj → debounce → rezultate me highlight →
(0 rezultate) → empty state MBAN search-in + "Pastro kërkimin" → korrigjo.

**Filtrimi:** Filters → FilterSheet (Status + Klient/subgrupe) → Apply
("Shfaq N pajisje") → chips aktive nën search → ✕ mbi chip e heq.

**Freskia:** WS live → pill "● Live"; WS fallback → "Updated Xs ago" (tap =
refresh); kthim në foreground → revalidim automatik; pull-to-refresh manual.

# Dashboard

**Wireframe (mockup ekrani 1):**
```
[TopBar: Dashboard          ● Live  ⌕]
        (unaza 57% — 408/720 online)
[TOTAL 720] [ONLINE 408]
[CRITICAL 347] [ALERTS 466]
[NEEDS ATTENTION            ]
[ Offline devices      309 ›]
[ Critical health      347 ›]
[ Pending updates      671 ›]
[ Agent updates        183 ›]
[RECENT ACTIVITY            ]
[ self_update · AC-SRV    2m]
[Dashboard][Devices][Alerts 99+][More]
```

- **Përshkrimi:** health ring (ngjyra sipas %: ≥90 jeshile, ≥70 amber, tjetër
  e kuqe), 4 stat tiles klikueshme, Needs Attention (vetëm problemet aktive,
  stale përfshirë si rresht normal), Recent activity (5 ngjarjet e fundit nga
  API ekzistuese e desktop Dashboard).
- **UX reasoning:** përgjigje 5-sekondëshe "a ka gjë urgjente?"; çdo rresht →
  Devices e parafiltruar.
- **Enterprise reasoning:** paritet me pattern-in Intune/NinjaOne "fleet
  health at a glance"; pa KPI dekorativë.
- **Komponentë:** HealthRing (SVG, tokens), StatTile, AttentionList,
  ActivityList, FreshnessPill.
- **Të reja:** HealthRing theme-aware; ActivityList mobile.
- **Hiqet:** ngjyrat hardcoded (`#27272a`, `fill=white`, skeleton `#374151`),
  copy e gabuar "stale (seen <15 min ago)", footnote 11px.

# Devices

**Wireframe (mockup ekrani 2, karta v2):**
```
[🔍 Kërko emër, host, user, IP…  ✕][⚙][⇅]
[chips: Vasgroup ✕  Client PC ✕]
┌────────────────────────────────┐
│● AC-SRV                [Connect]│  ← emri 16.5px, rresht i vetit
│  76 SERVER reboot               │  ← health chip + badges
│  Eugreen · Servers              │
│  techi 185.175.255.57 v2.1.5 tani│
├────────────────────────────────┤
│● CEO                   [Connect]│
│  DESKTOP-4F7K2                  │  ← hostname mono kur ≠ display name
│  24 WS Power?                   │
└────────────────────────────────┘
(infinite scroll · 715 të tjera)
```

- **Rregulli i kartës (LOCKED, v2):** L1 = emri i vetëm (16.5px/800) +
  Connect djathtas; L1b = hostname mono 11px vetëm kur ndryshon nga emri;
  L2 = health chip me ngjyrë + badges tipi/gjendjeje; L3 = klienti · grupi;
  L4 = user, IP mono, agent version, last seen (djathtas, me ngjyrë).
- **Empty state i kërkimit (B1):** search + Filters + Sort MBETEN të dukshme;
  mesazhi përmban termin; CTA "Pastro kërkimin".
- **Sort:** buton ⇅ → sheet i vogël (Name / Last seen / Client / Health).
- **Chips aktive:** çdo filtër i aplikuar (përfshirë klient/subgrup nga
  sheet) shfaqet si chip me ✕ nën search — gjendja kurrë e padukshme.
- **Infinite scroll** zëvendëson "Load More" (IntersectionObserver).
- **UX reasoning:** gjej pajisjen ≤5s; Connect = 1 tap (LOCKED, e paprekshme).
- **Komponentë:** SearchBar, FilterChips, DeviceCard v2, FilterSheet v2,
  SortSheet, EmptyState.

# Device Details

**Wireframe (mockup ekrani 3) — faqe, JO drawer:**
```
[‹  AC-SRV  SERVER        Health 76]
[Eugreen · Servers · user techi · parë 2m]
[CPU 34%▂][RAM 71%▅][DISK 88%█]      ← vitals live
[⚠ Alerts (2)                    ▼]  ← hapur si default kur ka
[📈 Performance                  ▼]
[🖥 Hardware                     ›]
[📦 Software (1 upd)             ›]
[🛰 Remote Support (Running)     ›]
[🕒 Timeline & Notes             ›]
[  Connect  |  ↻ Restart | >_ | ⋯ ]  ← STICKY ACTION BAR
```

- Route `/devices/:id`; back ‹ kthen te lista; reload nuk humb kontekstin
  (zgjidh B7/B8). Desktop-i e mban drawer-in ekzistues të paprekur.
- Header 2 rreshta; **"Device #id" HIQET** nga UI. Një etiketë tipi e vetme
  nga një burim i vetëm (`resolved_device_category` me fallback
  `device_type`) — zgjidh B5.
- Vitals strip: CPU/RAM/Disk me meter bars, live nga WS `telemetry_updated`.
- Sections accordion (lazy-load kur hapen, si tabs ekzistuese): Alerts (të
  pajisjes, dismiss inline; auto-hapur kur ka), Performance (sparkline 1h,
  uptime, latency), Hardware, Software (search inline, patch status),
  Remote Support (status, versioni, sync, RS password vetëm owner/admin —
  ruhet rregulli ekzistues i permissions), Timeline & Notes (të bashkuara).
- **Sticky Action Bar** (44px butona, mbi safe-area): Connect (primar,
  accent), Restart, Terminal, ⋯ → action sheet me: Restart Agent, Sync RS,
  Clipboard, Enter/Exit Maintenance, Favorite, Shutdown (danger). Permissions
  ekzistuese respektohen — butonat e palejuar nuk shfaqen.
- BottomNav i fshehur në këtë ekran.
- **UX reasoning:** aksionet gjithmonë nën gisht; skanim pa tabs të fshehura.
- **Enterprise reasoning:** ky është 60% e vlerës mobile për MSP —
  device-centric si NinjaOne device page.

# Alerts

**Wireframe (mockup ekrani 4):**
```
[All][Critical][Warning][Offline][CPU][RAM]
┌ ● LogiposSRV-Mensa — Vasgroup · Server  [Dismiss all (3)]
│ ▎CPU 100% — critical              2m
│ ▎RAM 81% — elevated              28m
└──
┌ ● SINGC-WS01 — Singc · Client PC
│ ▎Device offline                   5m
│   "2 pajisje të tjera Singc offline — dyshim site"
└──
[snackbar: Alert u hoq        UNDO]
```

- **Grupim sipas pajisjes** me emër + klient si titull grupi (zgjidh
  "Device #93" dhe alert storm). Tap mbi header → Device Details.
- Vija severity 3px majtas çdo alerti.
- **Dismiss me UNDO** (snackbar 5s); "Dismiss all (N)" për grup.
- Konteksti i mençur ruhet (mesazhet ekzistuese të backend-it).
- Refresh real (pret fetch-in, jo timeout kozmetik).
- **Komponentë:** AlertGroup, AlertItem, Snackbar, FilterPills.

# Global Search

- Overlay full-screen nga ikona ⌕ e TopBar (çdo ekran). Input autofocus,
  debounce 250ms, clear ✕, `enterKeyHint="search"`.
- Rezultate në grupe: **Devices** (API ekzistuese `search`), **Clients**
  (client-side mbi listën e cache-uar), **Alerts** (client-side).
- **Highlight** i termit; etiketë "matched: user/IP" kur match-i s'është në
  emër (zgjidh B10).
- Recent searches (5, localStorage) + clear all.
- Search-i lokal i Devices mbetet — plotësohen, s'zëvendësohen.

# Remote Support

- **Rruga primare e lidhjes mbetet e paprekur:** Connect në kartë/action bar
  = 1 tap (mekanizmi ekzistues `rustdeskLaunch` + fallback + toast).
- Faqja `/remote-support` në mobile (Phase 6): search + 3 grupe — *Issues*
  (RS stopped/conflict/sync failed, me Repair), *Online & ready*, *Not
  installed*. Karta: emër, RS status, versioni, Connect. Pjesa e konfigurimit
  mbetet desktop.

# More

**Wireframe (mockup ekrani 5):**
```
[（M） Mario Lika / OWNER          ]
[WORKSPACE]
[ 🛰 Remote Support        mobile ]
[ 🏢 Clients               mobile ]
[ 🧾 Audit Log          read-only ]
[DESKTOP CONSOLE]
[ 🖥 Deployment      vetëm desktop]  (dim)
[ 🖥 Enrollment · Packages …      ]  (dim)
[APP]
[ ⚙ Settings   tema · njoftimet   ]
[ ℹ Versioni   v0.2.0 · agent 2.1.5]
[ ⎋ Sign out                      ]  (e kuqe)
```

- Zëvendëson sidebar-in mobile. Tab i vërtetë me gjendje aktive (zgjidh B6
  për menunë). Permissions ekzistuese filtrojnë rreshtat (si Sidebar sot).
- **Inventory nuk shfaqet** (faqe placeholder në prodhim — gjetje auditi).
- Version real nga `package.json` + versioni aktiv i agent-it nga
  fleetOverview.

# Settings

- **Phase 1 (minimal, funksional):** Appearance (Dark/Light), Account
  (emër/email/rol read-only + Change Password me modalin ekzistues), About
  (versioni), Sign out.
- **Phase 6 (i plotë):** theme System (`prefers-color-scheme`), Notifications
  (Web Push kur të shtohet), Preferences (default screen, densiteti),
  Diagnostics (WS status, copy diagnostic info).

# Login

- Mbetet struktura ekzistuese (auditimi e vlerësoi pozitivisht). Phase 7
  polish: `autocomplete="username"`, `inputMode`, mesazh i qartë
  "Session expired" kur vjen nga 401 (zgjidh B9), spacing mobile.

# Loading States

- Skeleton që imiton formën reale: kartë-skeleton për lista, ring-skeleton
  për Dashboard — pa hapësira boshe 40% (gjetje auditi).
- Kurrë spinner bosh mbi faqe të tërë; kurrë timeout kozmetik.
- Skeleton > 3s → kalon në error state me Retry.

# Offline States

- Banner i qëndrueshëm "Offline — të dhënat e ruajtura nga HH:MM" (nga
  `navigator.onLine` + last fetch).
- Service worker me precache të app shell → **kurrë ekran i bardhë** (B2).
- Aksionet e shkrimit disabled me shpjegim.

# Error States

- Titull i qartë + detaji teknik sekondar + buton Retry.
- Error inline për seksione (një seksion i dështuar s'rrëzon faqen).
- 401 → mesazh "Session expired" + kthim te faqja e mëparshme pas login (B9).

# Empty States

- Gjithmonë me CTA. Search: mban search-in + termin + "Pastro kërkimin" (B1).
- Filtra: "Asnjë pajisje me këta filtra" + "Hiq filtrat".
- Alerts: "✓ All systems healthy" (jeshile).

# Responsive Rules

- Range mobile: `<768px` (ruhet kufiri ekzistues `md:`).
- 384px (S24 Ultra) është minimumi i testuar — asnjë overflow horizontal.
- Landscape: TopBar + search kolapsohen në një rresht; BottomNav mbetet.
- Safe areas: `env(safe-area-inset-bottom)` në BottomNav, action bar, sheets.

# Accessibility Rules

- Font minimum **11px**; 9–10px ndalohen (badges dekorative përjashtim i
  vetëm, max 10.5px).
- Touch targets **≥44px** (butona sheet, tabs, pills, ✕).
- Çdo element klikueshëm = `<button>`/`<a>`; `:focus-visible` ring me accent.
- Overlays: `role="dialog"`, `aria-modal`, focus trap, Escape/back close.
- BottomNav: `aria-current="page"`, badge me `aria-label` ("Alerts, 466 open").
- Status kurrë vetëm me ngjyrë (dot + tekst/chip).
- `prefers-reduced-motion` → transitions bëhen fade ≤100ms.

# Design System

## Colors (tokens të rinj — shtohen në `index.css`, dark + light)

| Token | Dark | Light | Përdorimi |
|---|---|---|---|
| `--th-accent` | `#E85A3C` | `#C75E49` | I VETMI accent (ekzistues; zëvendëson #f97316/#fb923c në mobile) |
| `--th-accent-glow` | `rgba(232,90,60,.12)` | `rgba(199,94,73,.10)` | sfonde aktive (token ekzistues, ripërdoret) |
| `--th-accent-border` | `rgba(232,90,60,.30)` | `rgba(199,94,73,.28)` | kufij aktivë (token ekzistues, ripërdoret) |
| `--th-status-online` | `#34d399` | `#059669` | status |
| `--th-status-stale` | `#fbbf24` | `#b45309` | status |
| `--th-status-offline` | `#94a3b8` | `#64748b` | status |
| `--th-status-critical` | `#f87171` | `#dc2626` | severity |
| `--th-status-warning` | `#fbbf24` | `#b45309` | severity |
| `--th-status-info` | `#60a5fa` | `#2563eb` | severity |
| `--th-status-maint` | `#38bdf8` | `#0284c7` | maintenance |
| `--th-status-agent` | `#a78bfa` | `#7c3aed` | agent update |
| `--th-ring-track` | `#2A2A30` | `#D9DAE0` | unaza, meters |
| `--th-scrim` | `rgba(0,0,0,.62)` | `rgba(15,15,20,.45)` | overlay backdrop |
| `--th-chip-bg` | `rgba(255,255,255,.05)` | `rgba(20,20,28,.05)` | pills/chips |

Rregull: komponentët mobile përdorin VETËM vars. Vars ekzistuese `--th-*`
(bg/text/border) ruhen — desktop i paprekur.

## Typography

Shkallë 5-hapëshe: **22/800** titull faqeje · **16.5/800** emri i pajisjes &
titujt e kartave · **14/700** rreshta veprimi · **12.5/500-600** trup & meta ·
**11/700 UPPERCASE +0.08em** kickers/labels. `tabular-nums` për çdo numër.
Mono (`ui-monospace` stack / JetBrains Mono ku është e ngarkuar) vetëm për
vlera teknike: IP, hostname, SHA, version.

## Icons

lucide-react (ekzistues). Madhësi: 21px BottomNav, 16px inline, 14px badges.
Asnjë emoji në UI real (emoji-t e mockup-it janë placeholder ikonash lucide:
🛰→Satellite/Radio, 🏢→Building2, 🧾→ClipboardList, ⚙→Settings,
🖥→Monitor, ⎋→LogOut, ⚠→AlertTriangle, 📈→TrendingUp, 🖥→Cpu,
📦→Package, 🕒→Clock).

## Cards

`background: var(--th-bg-card)`, `border: 1px solid var(--th-border-card)`,
`border-radius: 14px`, padding 14–16px, gap mes kartave 12px. Pa hije.

## Badges

Një komponent (`MBadge`) me variante: `type` (SERVER violet / WS blu),
`severity` (critical/warning/info), `state` (reboot, maint, updates, offline-
reason). Font 10.5–11px/800, padding 2.5px 7px, radius 6px, ngjyrat vetëm nga
tokens.

## Components (inventari i Phase 1)

| Komponent | File | Roli |
|---|---|---|
| MobileTopBar | `components/mobile/MobileTopBar.tsx` | titull + back + FreshnessPill (+ ⌕ në Phase 3) |
| FreshnessPill | `components/mobile/FreshnessPill.tsx` | Live / Updated Xs / Reconnecting; tap = refresh |
| MobileSheet | `components/mobile/MobileSheet.tsx` | bottom sheet bazë: grip, scrim, focus trap, back close, mbi BottomNav |
| Snackbar | `components/mobile/Snackbar.tsx` | toast me aksion (UNDO) |
| StatusDot / MBadge / Pill | `components/mobile/primitives.tsx` | primitivët e design system |
| BottomNav | `components/BottomNav.tsx` (rishkruar) | 4 tabs, More, 99+, aria-current |

Fazat 2–6 shtojnë: HealthRing, StatTile, AttentionList, ActivityList,
DeviceCard v2, FilterSheet v2, SortSheet, GlobalSearch, VitalsStrip,
AccordionSection, StickyActionBar, AlertGroup/AlertItem, EmptyState.

## Bottom Navigation

64px + safe-area; sfond `--th-bg-sidebar`; aktiv = `--th-accent` + underline
2.5px (top); badge `#EF4444` cap 99+; ikonat 21px stroke 1.8.

## Top Bar

52px; sfond `--th-bg-topbar`; titull 16px/800; back ‹ 34px në nënfaqe;
FreshnessPill djathtas. Theme toggle HIQET nga TopBar mobile → Settings.
(Desktop Topbar i paprekur.)

## Bottom Sheets

Radius 20px lart; grip 36×4px; scrim `--th-scrim`; `max-height 78%`;
transform 260ms `cubic-bezier(.32,.72,0,1)`; footer sticky me Apply/Reset kur
ka; **z-index mbi BottomNav**; swipe-down + back + scrim tap e mbyllin.

## Dialogs

Konfirmimet destruktive përmbajnë **emrin e pajisjes** ("Restart AC-SRV?").
Modalet ekzistuese (ChangePassword, Confirmation) ruhen; stilohen me tokens.

## Animations / Motion

150ms micro (pills, chips) · 250ms sheets/faqe · easing
`cubic-bezier(.32,.72,0,1)` (ekzistues) · `prefers-reduced-motion` → fade
100ms. Pa animacione dekorative.

## Elevation

3 nivele: 0 lista (flat) · 1 kartë (border, pa hije) · 2 overlay (scrim +
hije `0 10px 30px rgba(0,0,0,.4)`).

## Spacing

Grid 4pt: 4/8/12/16/24. Page padding 14–16px; gap kartash 12px; padding
karte 14–16px.

## Shadows

Vetëm në overlays (niveli 2). Asnjë hije në karta/lista.

## Border Radius

14px karta · 10–12px butona/inputs · 999px pills/badges rrethore · 20px
sheets (lart).

# Things Never To Change (pa amendament të këtij dokumenti)

1. 4 tabs e BottomNav dhe përmbajtja e tyre.
2. Device Details si **faqe** me URL + accordion + sticky action bar.
3. Connect = 1 tap nga karta (kurrë më thellë).
4. Karta e pajisjes v2: emri dominues me rresht të vetin.
5. Modeli i freskisë: WS + foreground revalidate + pull-to-refresh + pill.
6. Rregulli i cache: refresh invalidon përpara leximit; key përmban çdo
   parametër që ndikon rezultatin.
7. Accent i vetëm `#E85A3C`; tokens për çdo ngjyrë.
8. Empty state i search-it mban search-in.
9. Dismiss me UNDO.
10. More zëvendëson sidebar-in mobile.

# Implementation Notes

*(Regjistri i detyrueshëm — çdo problem teknik shënohet këtu, jo zgjidhet me
ndryshim dizajni.)*

1. **[Phase 1] Settings ndahet në dy faza:** mockup-i tregon Settings të plotë;
   Phase 1 dorëzon versionin minimal funksional (Appearance/Account/About/
   Sign out) sepse theme toggle hiqet nga TopBar mobile në Phase 1 dhe duhet
   një shtëpi reale që në ditën e parë. Phase 6 e plotëson. Asnjë placeholder.
2. **[Phase 1] Ikona ⌕ e TopBar shtyhet në Phase 3** (Global Search) — një
   buton pa funksion do të shkelte rregullin "asnjë placeholder".
3. **[Phase 1] Rreshtat e kombinuar të "Desktop console"** në mockup
   ("Enrollment · Packages") ndahen në rreshta më vete — një rresht i
   kombinuar s'mund të navigojë në dy faqe. Stili dim + "vetëm desktop"
   ruhet ekzaktësisht.
4. **[Phase 1] Theme "System"** kërkon ndryshim në ThemeContext të përbashkët
   me Desktop → shtyhet në Phase 6 me kujdes të veçantë regresioni.

# Known Limitations

- Pull-to-refresh dhe fshehja e BottomNav nën tastierë varen nga sjellje
  browser-i që ndryshojnë midis iOS Safari / Android Chrome — testohen në
  pajisje reale në Phase 7.
- Web Push kërkon punë backend (subscriptions, VAPID) — jashtë këtij scope;
  Settings e parapërgatit UI-në në Phase 6 vetëm nëse backend-i ekziston.
- Ikonat Android të TECHI Remote Support (RustDesk) janë projekt më vete —
  jashtë Mobile UI 2.0.

# Future Improvements (pas UI 2.0 — kërkojnë aprovim të ri)

Biometric re-auth për aksione destruktive · offline action queue · smart
search syntax (`client:X os:server`) · app badge (`setAppBadge`) · tablet
layout 768–1024.

---

## Progress Log (përditësohet pas çdo faze)

| Faza | Statusi | Data | Shënime |
|---|---|---|---|
| 1 — Shell, Nav, Theme, Shared | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-05 | Tokens dark+light; MobileTopBar + FreshnessPill; BottomNav 4-tab (More, 99+, aria-current); More + Settings (minimal — Impl. Note #1); MobileSheet/Snackbar/primitives gati për fazat 2–6; sidebar mobile i hequr; header-at mobile të dublikuar hequr nga Devices/AlertsMobile. Verifikuar me Playwright kundër dev + API mock (dark/light/desktop — 0 gabime console; desktop identik). Known issue: asnjë. Regression risk: AppShell md-split (i verifikuar vizualisht). Remaining: asgjë për Phase 1. |
| 2 — Dashboard | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | HealthRing/tiles/Needs Attention theme-aware (tokens, jo hardcoded); shtuar "Stale devices" si rresht normal; shtuar Recent Activity nga `getRecentActions` ekzistuese; Alerts tile → `/alerts` (jo filtër Devices). Verifikuar Playwright dark+light — vizualisht i lexueshëm në të dyja, 0 gabime console (përveç WS refused, pritur pa backend real). Known issue: asnjë. Remaining: asgjë. |
| 3 — Devices, Search, Filters | — | | |
| 4 — Device Details | — | | |
| 5 — Alerts | — | | |
| 6 — More, Settings, RS | — | | |
| 7 — States, A11y, Polish | — | | |
