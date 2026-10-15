# Current Phase

**Updated:** 2026-10-15
**Production branch:** `backport/platform-components-92a521c` (rdp.techi.com.al, API on api-rdp.techi.com.al)
**Status:** in production, changed in small deploys, each one recorded

This file is a short orientation for whoever (or whichever AI) picks up the
work. It does not hold the state itself:

| What | Where |
|---|---|
| What runs in production now (SHAs, schema version, risks) | [../PROJECT_STATE.md](../PROJECT_STATE.md) |
| What changed, when, why, and how it was verified | [../CHANGELOG-SOLUTIONS.md](../CHANGELOG-SOLUTIONS.md) |
| Open and approved work | [../IMPLEMENTATION-ROADMAP.md](../IMPLEMENTATION-ROADMAP.md) |
| How to work in this repository | [rules.md](rules.md) |

## The product today

TECHI Connect is the internal RMM console of TECHI's staff (about ten
people) for ~930 managed devices, almost all Windows, on one 1 vCPU / 2 GB
server. Main areas: Dashboard, Devices (Explorer, catalogue, device drawer),
client profiles, Alerts, Reports, Onboarding (packages, tokens, installer),
Operators and Teams (scoped permissions, 2FA), Credential Vault, Remote
Support (branded RustDesk) and the Windows agent (2.1.20 in production).

## Recently finished (2026-10-13 → 15)

- **Client profile** `/clients/:id`: Overview, Devices, Locations, Alerts,
  Activity (20 a page), Analytics (loaded in the background), Documentation;
  Tickets wait for HubSpot (INIT-CLIENT-003).
- **Client locations (sites):** per-client sites with IP/LAN rules, the most
  specific rule wins, manual placement, suggestions from shared public IPs,
  a 15-minute placement sweep; Explorer client → city → site → category;
  "Client / location" column; Locations tab with search and its own scroll;
  location picker (with "+ New location…") in the device drawer.
- **Global search (⌘K):** a client opens its profile, an operator opens
  Operators narrowed to them, a device opens its drawer.
- **Devices:** the Explorer selection lives in the URL (`?folder=`), so a
  reload keeps it; one heading-alignment standard checked on ten tables;
  split Connect in the drawer header; OS release and CPU / memory / storage
  rows in the drawer.
- **Database review:** id lists as one array parameter (`id_in`), 38
  redundant indexes dropped, pg_stat_statements reset, `max_connections`
  100, `jit` off.

## Working agreements with the owner

- Every production deploy needs the owner's explicit go-ahead; the
  sequence (guard, dump when the database changes, rollback images, bounded
  steps, smoke, changelog) is in [rules.md](rules.md).
- Size advice to the real load: ten users, one small server. No scale-out
  architecture.
- The owner writes in Albanian; the console's UI text is English.
