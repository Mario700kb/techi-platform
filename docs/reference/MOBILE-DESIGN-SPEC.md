# TECHI MOBILE UI 2.0 — DESIGN SPECIFICATION

| | |
|---|---|
| **Status** | ✅ IMPLEMENTUAR & DEPLOYED — 7/7 faza live në prodhim (2026-07-06). Design mbetet LOCKED për ndryshime të reja UX/UI (kërkon amendament). |
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
   *(Ende e pazbatuar — shtyrë te Phase 6 së bashku me Global Search.)*
5. **[Phase 4] "Terminal" hiqet nga Sticky Action Bar.** Nuk ekziston asnjë
   feature terminal/shell për pajisje të vetme askund në app (as backend, as
   frontend) — `AgentCommandsPanel` është mjet fleet-wide vetëm desktop.
   Action bar mban 3 slote reale: Connect · Restart · More.
6. **[Phase 4] "Shutdown Device" hiqet nga More-sheet.** Nuk ekziston
   `ActionType` "shutdown_device" në backend; sheet-i mban vetëm aksionet
   reale ekzistuese (Restart Agent, Sync/Restart/Repair RS, Refresh
   Inventory, Enter/Exit Maintenance).
7. **[Phase 4] Software dhe Timeline janë versione përmbledhëse** (jo
   tabela të plota si "Management"/"Notes" e desktop DeviceDrawer) —
   mjaftueshëm për triage mobil; redaktim i plotë i shënimeve/software
   mbetet detyrë desktop.
8. **[Amendament pas deploy-it, 2026-07-06] Software NUK fetch-ohet
   automatikisht.** Owner-i vërejti (nga prodhimi) që lista e plotë e
   software-it (20-50+ paketa, VC++ redistributables etj.) fetch-ohej
   sapo hapej accordion-i, njësoj si desktop DeviceDrawer — por mobile
   hapet më rastësisht/shpesh nga operatorët. `Software` tani kërkon një
   tap eksplicit ("Load software list") përpara se të thërrasë
   `getDeviceInventory`; patch/reboot status mbetet i dukshëm pa fetch
   shtesë te seksioni Performance (nga `health.reasons`, tashmë i
   ngarkuar). Asnjë ndryshim backend.
9. **[Amendament pas deploy-it, 2026-07-06] Sparkline real i shtuar te
   Performance** (mungonte në zbatimin e parë të Phase 4, edhe pse
   mockup-i e kërkonte: "sparkline 1h CPU/RAM/latency"). Ndërtuar
   komponenti i ri `Sparkline.tsx` (SVG, pa varësi të re), i ushqyer nga
   `getDeviceTelemetryHistory(deviceId, 20)` (endpoint ekzistues, i
   paprekur).
10. **[Amendament pas deploy-it 2, 2026-07-06] Uptime/Latency riformatuar
    për konsistencë me Desktop.** Owner-i vërejti se Uptime në mobile
    dukej "jo real" krahasuar me web — shkaku i vërtetë: **e njëjta e
    dhënë** (`useDeviceTelemetry`, `uptime_seconds`/`heartbeat_latency_ms`,
    identike me DeviceDrawer.tsx), por mobile e ndante vetëm në orë totale
    (p.sh. "123h") ndërsa Desktop përdor `formatUptime()` me ndarje
    ditë+orë+minuta (p.sh. "5d 4h") — thjesht formatim i ndryshëm i të
    njëjtës vlerë, jo të dhëna të ndryshme. Latency: amendamenti #9 kishte
    shtuar një supozim (0ms = "e pamatur") që s'përputhej me sjelljen
    ekzistuese të Desktop-it (`!== null`, shfaq edhe 0ms si vlerë reale) —
    hequr; mobile tani përdor saktësisht të njëjtin kontroll si Desktop.
    Rregull: `formatUptime()` në DeviceDetailsMobile.tsx duhet të mbetet
    identike me atë të DeviceDrawer.tsx.
11. **[Amendament pas deploy-it 3, 2026-07-06] "No Client" i shtuar te
    FilterSheet.tsx + filtri "Disk" i shtuar te AlertsMobile.tsx.** Owner-i
    vërejti se Desktop `DeviceTree.tsx` ka një zë "No Client" (ikona `Box`,
    numërim nga `treeCounts.unassigned`, konventa `client_id = -1`) që
    mungonte te seksioni "Client" i FilterSheet mobile. Shtuar butoni "No
    Client" menjëherë pas "All clients" (njësoj si renditja e Desktop-it),
    duke ripërdorur saktësisht të njëjtën konventë `client_id = -1` që
    `Devices.tsx`'s `handleTreeSelect`/`handleFilterChange` tashmë e
    kuptojnë — asnjë ndryshim backend. `unassignedCount` rrjedh nga
    `fleetOverview.tree_counts.unassigned` (i njëjti burim si Desktop).
    Chip-i aktiv në DevicesTable.tsx u përditësua të shfaqë "No Client" kur
    `client_id === -1` (më parë kërkonte një `client` real me atë id, dhe
    s'shfaqej fare). Për Alerts: `low_disk` ekzistonte tashmë plotësisht në
    `AlertKind`/`KIND_LABEL`/`KindIcon` (etiketë "Low Disk", ikonë
    `HardDrive`) por mungonte nga `FilterId`/`FILTER_PILLS` — shtim thjesht
    aditiv (asnjë logjikë e re, `applyFilter`'s fallback gjenerik e
    trajtonte tashmë saktë). Verifikuar Playwright (mock): "No Client"
    zgjedh+aplikohet+chip korrekt, pajisja e paklientuar shfaqet; pilula
    "Disk" filtron saktë vetëm alertet `low_disk`, 0 gabime console. Zero
    prekje Desktop (FilterSheet/AlertsMobile janë mobile-only; ndryshimet
    te DevicesTable.tsx janë brenda seksionit `md:hidden`).
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
| 3 — Devices, Search, Filters | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | DeviceMobileCard v2 (emri 16.5px dominues + hostname; health chip + badges via MBadge/StatusDot; ngjyra token-based, hoq hardcoded hex ekzistues); DevicesTable: header mobil (search+Filters+Sort) gjithmonë i dukshëm — zgjidh B1; empty state e re me CTA "Clear search"/"Clear filters"; chips aktive multi-filtër (quick+client+subgrup); FilterSheet v2 mbi MobileSheet, pa "Connection" dublikat, draft+Apply/Reset (Impl. Note: "Apply filters" pa numërim live — do duhej të dublikonte predikatin e plotë të filtrimit); Sort sheet i ri (Name/Last seen/Client/Health); infinite scroll (IntersectionObserver) zëvendëson Load More. **2 bugs reale u zbuluan dhe u rregulluan gjatë verifikimit** (jo gjetje mockup-i): (1) `MobileSheet`'s `history.back()` në mbyllje anullonte navigim tjetër që ndodhte njëkohësisht (hequr); (2) `setSearchParams` i thirrur disa herë brenda të njëjtit handler sinkron e anullonte njëri-tjetrin (Devices.tsx kalua në functional-updater form; FilterSheet's Apply e riorganizoi rendin që `onQuickFilterChange` të thirret i fundit). Verifikuar Playwright: empty-search e vërtetuar (search input mbetet), Apply+chip+filtrim i vërtetuar hap pas hapi, Sort sheet OK, **desktop identik/0 gabime** (smoke test i veçantë). Known issue: asnjë. Remaining: asgjë për Phase 3. |
| 4 — Device Details | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | Faqe e re `/devices/:id` (jo drawer): header (back, status dot, emri + rename inline, type/health badges, freshness, star), VitalsStrip live (CPU/RAM/Disk), 6 AccordionSection (Alerts auto-hapur kur ka, Performance, Hardware, Software me lazy-fetch, Remote Support, Timeline & Notes me lazy-fetch), StickyActionBar (Connect · Restart · More). Zero business-logic duplication: ripërdor drejtpërdrejt hooks/API-t ekzistuese të DeviceDrawer-it (`useDeviceTelemetry`, `useDeviceAlerts`, `useDeviceActivity`, `getDeviceInventory`, `getDeviceNotes`/`createDeviceNote`, `queueDeviceAction`, `enterDeviceMaintenance`/`clearDeviceMaintenance`, `updateDevice`, `getConnectUrl`+`launchConnect`). DevicesTable: karta mobile tani navigon te faqja (`navigate(/devices/:id)`); rreshti i tabelës desktop **i paprekur**, vazhdon të hapë DeviceDrawer siç ishte. AppShell fsheh MobileTopBar+BottomNav për këtë rrugë (faqja ka header+action-bar të vet). **2 Implementation Notes** (spec → real): (1) nuk ekziston asnjë feature "Terminal" për pajisje të vetme në app (AgentCommandsPanel është mjet fleet-wide desktop) — slot-i "Terminal" i mockup-it u hoq nga action bar në vend që të fabrikohej jo-funksional; (2) s'ekziston `ActionType` "shutdown_device" — u hoq nga sheet-i More në vend që të shtohej sjellje e re backend-i; sheet-i mban vetëm aksione reale (Restart Agent, Sync/Restart/Repair RS, Refresh Inventory, Enter/Exit Maintenance). Verifikuar Playwright: navigim kartë→faqe→back, rename inline, Alerts/Software/Timeline lazy-load, More-sheet, Restart me konfirmim që përmban emrin e pajisjes, **0 gabime console**; desktop DeviceDrawer i rindërtuar plotësisht identik (0 gabime pas plotësimit të mock-ut — endpointet mungues në mock, jo regresion real). Remaining: asgjë kritike; Software/Timeline janë versione përmbledhëse (jo tabela të plota si desktop) — të mjaftueshme për triage mobil. |
| 5 — Alerts | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | Rindërtim i plotë: grupim sipas `device_id` (jo më listë e sheshtë "Device #93"); emri real i pajisjes + klienti nxirren me `getDevice(id)` (endpoint ekzistues, jo hack teksti mbi `message`), me fallback "Device #id" derisa të ngarkohet; grup "Token usage" për alertet sintetike (`device_id === null`); vijë severity 3px + `Pill`/`Snackbar` nga primitives.tsx; tap mbi header grupi → `/devices/:id`; "Dismiss all (N)" te grupet me >1 alert; Refresh real (pret `reloadAlerts`, jo `setTimeout` kozmetik); "View all affected devices" shfaqet vetëm kur >3 grupe (jo footer 11px gjithmonë). **Dismiss me UNDO real**: s'ekziston endpoint "reopen alert" në backend, kështu UNDO funksionon duke **shtyrë** `resolveAlert` 5s (fshihet optimistikisht nga UI menjëherë; nëse s'ka UNDO brenda 5s, apeli real ndodh atëherë; UNDO brenda kohës anulon timer-in pa thirrur fare API-në) — verifikuar me Playwright që `resolveAlert` s'thirret as menjëherë as pas undo, vetëm pas kohës. **1 bug real u zbulua dhe u rregullua**: `<button>` i ngulitur brenda `<button>` (header grupi + "Dismiss all") shkaktonte `validateDOMNesting` warning dhe **crash të plotë të faqes** (blank screen) kur Playwright klikonte pikën qendrore që bie mbi butonin e ngulitur — rregulluar duke i ndarë në elementë vëllazëror brenda një `<div>`. Verifikuar: grupim, dismiss+undo (0 thirrje API para kohës), dismiss-all, navigim nga header grupi, 0 gabime console (përveç WS refused, pritur). Remaining: asgjë. |
| 6 — More, Settings, RS | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | **Remote Support mobile**: shtuar brenda `RemoteSupport.tsx` ekzistues (`md:hidden` vs `hidden md:block`, i njëjti model si Dashboard/Devices) — zero logjikë e duplikuar, ripërdor `filtered`, `search`, `actionStates`, `handleConnect`/`handleRepair`/`handleRestart`. Grupim Issues/Online & ready/Not installed siç kërkon spec-i. **Settings i plotë**: shtuar "System" theme (ThemeContext i zgjeruar me `themePreference`/`setThemeMode`, `theme` ekzistues mbetet gjithmonë "dark"|"light" — Topbar desktop i paprekur, verifikuar toggle akoma funksionon); Preferences → Default screen (Dashboard/Devices/Alerts), lidhur realisht te `Login.tsx` (nuk anulon kurrë redirect-in "from" të një route të mbrojtur); Diagnostics → realtime status + versione + "Copy diagnostic info" (real, jo placeholder). **Notifications e Web Push NUK u shtuan** — Known Limitation ekzistues: s'ka infrastrukturë backend (VAPID/subscriptions); shtimi i një toggle-i tani do të ishte placeholder jo-funksional, i ndaluar nga Quality Rules. Verifikuar Playwright: RS mobile me grupim real, System theme zgjidhet dhe rezolvohet live, Default screen ruhet, Copy diagnostics funksionon (0 gabime); desktop RemoteSupport + Topbar theme-toggle të rikonfirmuar 100% identikë. Remaining: Notifications mbetet e varur nga Known Limitations (infrastrukturë push). |
| 7 — States, A11y, Polish | ✅ Implementuar — pret aprovimin e commit-it | 2026-07-06 | **Offline (zgjidh B2)**: `sw.js` rishkruar — precache i shell-it (`/`, `/manifest.json`) + runtime cache "stale-while-revalidate" për JS/CSS/imazhe (populluar automatikisht në çdo fetch të suksesshëm, pa pasur nevojë të njohë emrat e hash-uar në build-time); API/`/ws/` kurrë nuk cache-ohen. `OfflineBanner` i ri (mobile-only, në AppShell) dëgjon `online`/`offline` dhe tregon "Offline — showing cached data from HH:MM" (nga `lastFetchTime` i `AppDataContext`). **Verifikuar në 2 hapa** (kritike): (1) reload offline PA vizitë paraprake online → bosh (sjellje standarde e SW-ve, "s'kontrollon faqen që e regjistroi"); (2) reload offline PAS një vizite/reload online (skenari real) → shell i plotë + banner, **konfirmuar kundër build-it të prodhimit** (`vite preview`), jo vetëm dev server. **Session expired (zgjidh B9)**: `sessionStore.ts` vendos një flag `sessionStorage` VETËM në rrugën e 401 (jo në logout manual); `Login.tsx` e lexon dhe shfaq "Session expired — please sign in again." **1 bug real u zbulua dhe u rregullua**: leximi+fshirja e flag-ut brenda një `useState` lazy-initializer ishte i papastër (side-effect), dhe React StrictMode e thërret dy herë në dev — thirrja e dytë e gjente flag-un tashmë të fshirë nga e para dhe mesazhi s'shfaqej kurrë; zgjidhur duke e lëvizur në `useEffect` me `useRef` guard (StrictMode-safe, funksionon edhe për navigim client-side pa reload). **A11y**: `:focus-visible` global (buton/link/input, accent ring, i padukshëm me mouse); font ≥11px tashmë i respektuar që nga fazat 2–6. **Responsive**: BottomNav "compact" (pa etiketa teksti) për landscape shumë të shkurtër (`max-height:500px`) — **gjetje e ndershme**: në 3 pajisjet referencë (iPhone 15 Pro/Pixel 8/S24 Ultra), gjerësia e landscape-it (852/915/824px) kalon breakpoint-in `md:768px` ekzistues, kështu që ato shfaqin layout-in desktop në landscape (sjellje e arsyeshme paraekzistuese, jo e re) — rregulli landscape mbetet mbrojtje për viewport më të ngushta. Verifikuar Playwright: offline banner + reload real (prodhim), session-expired (0 gabime pas fix-it), focus-ring i dukshëm via Tab, 6 kombinime dark/light × mobile/desktop pa asnjë gabim console. Remaining: pull-to-refresh dhe sjellje tastiere mbeten Known Limitation (kërkojnë pajisje reale, jo Playwright). |
| Post-deploy fix — Round 3 | ✅ Implementuar | 2026-07-06 | Shih Implementation Note #11: "No Client" te FilterSheet.tsx (Devices) + pilula "Disk" te AlertsMobile.tsx (low_disk). Ripërdor konventën ekzistuese `client_id = -1` dhe `AlertKind` "low_disk" ekzistues — zero ndryshim backend, zero prekje Desktop. Verifikuar Playwright (mock, 0 gabime console); deploy vetëm frontend. |
