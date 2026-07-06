# TECHI Platform — PROJECT STATE (Single Source of Truth)

## PROJECT STATUS

| | |
|---|---|
| **Last Updated** | 2026-07-06 |
| **Production Verified** | 2026-07-06 (live server deploy + Playwright verification against https://rdp.techi.com.al) |
| **Current Production Branch** | `stable/phase-2-heartbeat` (prod runs the pushed tip, commit `a8a35ea`) |
| **Current Development Branch** | `stable/phase-2-heartbeat` (in sync with origin and prod); agent work parked on `pending-agent-2.1.6` |
| **Backend Version** | `PROJECT_VERSION 1.0.0`, code of commit `e0df46a` (verified in prod by md5) |
| **Agent Version** | **2.1.5** — fleet target, NETLOGON/GPO rollout in progress (~700 devices, mixed during rollout) |
| **TECHI Remote Version** | 1.4.6.0 (repo build default in `remote-support.wxs`; exact fleet version: needs verification) |
| **Heartbeat Interval** | **250 s** (global UI policy, verified in prod) |
| **Heartbeat Retention** | **7 days** (verified in prod) |
| **Production Server** | Linode VPS `139.162.158.208` (ssh alias `techi-server`), 25 GB disk, live deploy dir **`/root`** |
| **Documentation Version** | 1.0 (two-document standard, effective 2026-07-04) |

## CURRENT PRIORITIES

1. ✅ Documentation Baseline — completed (2026-07-05, this standard)
2. ✅ Mobile UI 2.0 (7 phases) + storage optimization batch — deployed to
   production 2026-07-06 (see RDP TECHI MOBILE UI 2.0 section below)
3. Complete the Agent **2.1.5** rollout (~700 devices via NETLOGON/GPO)
4. Start Agent **2.1.6** (from branch `pending-agent-2.1.6`, only after the
   rollout completes; SHA-alignment procedure)
5. Standardize the deployment working directory (decision pending — see
   Known Issues #1)
6. Recreate the postgres container's log-cap benefit was already applied
   as a side effect of the 2026-07-06 deploy (see below) — no longer
   pending.

This document describes the CURRENT state only. History (incidents, fixes,
decisions, deploys) lives exclusively in
[CHANGELOG-SOLUTIONS.md](CHANGELOG-SOLUTIONS.md). Together these two files are
the complete, canonical knowledge base — every other document is historical or
deep-dive reference only (see `docs/reference/`, `docs/archive/`).

Facts marked **(verified)** were confirmed by direct inspection of production
on 2026-07-04. Facts marked **(needs verification)** are believed true but not
proven — verify before relying on them.

---

# Përmbledhje

TECHI Platform is a self-hosted RMM/MSP platform: fleet monitoring, remote
command execution, and remote desktop support for **~700 managed Windows
devices** across multiple client Active Directory domains, operated by 5–6
concurrent operators through a realtime web dashboard. Remote desktop is a
branded RustDesk ("TECHI Remote Support") against a self-hosted RustDesk server.

# Arkitektura

| Component | What it is |
|---|---|
| **Backend** | FastAPI (Python 3.12 in the container), SQLAlchemy sync ORM, Alembic, single uvicorn worker. Layers: `api/v1/endpoints` (routers) → `services` (orchestration) → `repositories` (queries) → `models`. WebSocket realtime channel `/ws/devices` via an async publisher queue (750 ms dedupe, maxsize 1000). |
| **Frontend** | React + Vite + TypeScript + Tailwind. Custom dark "premium" design system (`techi-orange #FF553F`, `.premium-*` classes); **no external component libraries**. One WS connection per page, polling fallback 15 s. |
| **Agent** | Go, Windows service `TechiAgent` (LocalSystem, SCM recovery 1m/1m/5m). Heartbeat loop + remote-action dispatcher + script-free self-update (binary swap via one-shot SYSTEM Scheduled Task) + independent watchdog Scheduled Task (5-min cadence). Files split by build tags `_windows.go` / `_other.go`. Cross-compiles from macOS (`GOOS=windows GOARCH=amd64`). |
| **TECHI Remote Support** | Branded RustDesk client (Flutter build, `librustdesk.dll`), installed by the combined MSI, runs as Windows service + tray. Self-healing (install/config/service/password) driven by the agent every heartbeat cycle. |
| **RustDesk server** | Self-hosted `rustdesk-server` containers `techi-hbbs`/`techi-hbbr` on the same VPS (`/opt/techi/rustdesk-server`). Identity keys: `data/id_ed25519*` — critical, see Disaster Recovery. |
| **Database** | PostgreSQL 15-alpine in production (Docker volume `techi-platform_postgres_data`); SQLite for local dev with `schema_compat_service.ensure_sqlite_dev_schema` (SQLite-only column guard). |
| **Docker** | Single `docker-compose.yml`: postgres, backend (mem_limit 800m), frontend. RustDesk server and nginx-proxy-manager are separate compose projects on the same host. |
| **Deployment** | Single Linode VPS. git pull + `docker compose build && up -d`. Edge: nginx-proxy-manager terminates TLS for `rdp.techi.com.al` (frontend) and `api-rdp.techi.com.al` (backend). Agents deploy via AD GPO/NETLOGON bootstrap; updates via UI self_update. |

**Device identity resolution** (heartbeat/enroll): agent_id cache → agent_id →
device_id → rustdesk_id → fingerprint scorer (hostname/IPs/hw/domain/OS
weighted; ≥0.90 auto-reuse, 0.70–0.89 flag `duplicate_candidate`, safety-block
if active device with different RustDesk ID).

# Production (verified 2026-07-04)

| Item | Value |
|---|---|
| Server | Linode VPS `139.162.158.208`, Ubuntu, 25 GB disk (62% used after 2026-07-04 cleanup). SSH alias `techi-server` (root, key `~/.ssh/techi-server`) **(verified)** |
| **Deploy working dir** | **`/root`** — live compose project `techi-platform` (backend/frontend labels) **(verified)**. `/opt/techi/techi-platform` is a SECOND, STALE checkout (postgres container still carries its label). Always confirm with `docker inspect <c> --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'` |
| Containers | `techi-platform-{backend,frontend,postgres}-1`, `techi-hbbs`, `techi-hbbr`, `nginx-proxy-manager` — all healthy **(verified)** |
| Backend code | content of commit `e0df46a` (tip of `stable/phase-2-heartbeat` as pushed) — proven by md5 of files in the running container **(verified)** |
| Heartbeat interval | **250 s** (global policy file `/app/data/agent_policy.json`, volume `backend_data`; set from UI) — measured effective ~246 s across ~417 active devices/hour **(verified)** |
| DB retention | heartbeats/telemetry/activity events **7 days** — proven by `min(created_at)` = exactly the 03:00 UTC boundary **(verified)**. All other tables: no retention yet (fix committed, not deployed — see Pending) |
| DB size | ~1.8 GB; device_heartbeats 972 MB + device_telemetry 710 MB ≈ 91% **(verified 2026-07-04)** |
| Backups | cron `0 3 * * * /root/techi-backup.sh`: `pg_dumpall|gzip` → `/opt/backups/techi/` (~100 MB/day), RustDesk keys tar, config tar; retention 14 days **(verified)**. ⚠️ config tar reads the STALE `/opt` checkout (identical to `/root` as of 2026-07-04) |
| Host housekeeping | NPM logrotate (`/etc/logrotate.d/npm-techi` + hourly cron, 100 MB cap), journald capped 200 MB, weekly `docker builder prune` cron **(verified — installed 2026-07-04)** |
| Postgres container log | **no docker cap** (fix committed, not deployed) **(verified)** |
| Server leftovers awaiting owner decision | orphan 2.0 GB postgres volume `6b7b55…` (unattached since 2026-06-28), `/opt/techi/backups/backup_pre_enrollment_fix.sql` (1.1 GB, outside auto-retention), 34 empty `techi_verify_*` volumes **(verified)** |

# Heartbeat

- Agent POSTs a full JSON snapshot to `POST /api/v1/agent/heartbeat` every
  `heartbeat_interval_seconds`; 3 retries, 5 s gap. Legacy agents use
  `/api/heartbeat` (compat route → same handler).
- **Interval**: global (fleet-wide, NOT per-device), file-backed policy, UI page
  Agent Config → `PUT /api/v1/agent-config` (admin+), bounds 60–600 s. Every
  heartbeat **response** carries the current value; the agent applies it live
  (ticker reset), does not persist it (config file value applies until first
  response after restart). Current prod value: **250 s (verified)**.
- Per beat, backend fast path (blocks the response): resolve device → update
  `devices` row → status transition (+history row if changed) → RustDesk sync
  → trusted-domain assignment → INSERT `device_heartbeats` snapshot →
  collect pending actions. Side effects run in a BackgroundTask: WS events,
  INSERT `device_telemetry`, upsert `device_inventory` (only when the agent
  sends inventory — collect flags default OFF), alert engine, health score.
- Response fields: `pending_actions[]`, `heartbeat_interval_seconds`,
  `remote_support_password` (per-device, ≥2.1.5 applies it), `agent_update`,
  device/heartbeat ids.
- Freshness thresholds (fixed constants): Online ≤ 6 min, Stale ≤ 25 min,
  Offline > 25 min. Reconciliation worker (in-process, 30 s) marks stale
  devices offline.
- Load at 1000 devices / 300 s: ~3.3 beats/s steady, ~55 KB/s WS output at 6
  operators (from the 2026-06 scalability audit; still representative).
- **Retention**: 7 days (see Scheduler). Cleanup deletes + `VACUUM ANALYZE`.
- Quirk: per-device `change_heartbeat_interval` action is overridden by the
  global response value within the same cycle — per-device intervals do not stick.

# Update System

- Philosophy: "MSI installs once — everything else from the UI."
- `self_update`: agent downloads the active `agent_binary` exe to
  `%ProgramData%\TechiAgent\cache\techi-agent-<ver>.exe`, verifies SHA256,
  swaps itself via one-shot SYSTEM Scheduled Task (`techi-agent.exe
  swap-binary`) — no PowerShell/scripts anywhere (AV/AMSI-strict domains:
  Symantec, CybeeAI). Rollback to `techi-agent-old.exe` if the service doesn't
  come back.
- Completion verified by the next heartbeat's `agent_sha256`
  (`verify_self_update_for_device`), not by the action callback.
- Watchdog Scheduled Task (`watchdog-check`, 5 min): restarts TechiAgent
  service; ≥2.1.5 also starts the TECHI Remote Support service if stopped.
- **SHA-alignment rule (critical):** "Needs Agent Update" compares each
  device's `agent_sha256` with the active `agent_binary` package SHA. Go builds
  are NOT reproducible — always extract the exe from the ACTIVE combined MSI
  (`msiexec /a <msi> /qn TARGETDIR=…`) and upload THAT as agent_binary. Never
  rebuild MSIs without need.
- CI: `.github/workflows/build-agent-msi.yml` (windows-latest, WiX v4) builds
  the MSI on pushes touching `agent/`; artifacts in the Actions tab.

# Package System

Three package types in Agent Packages UI, all can be active simultaneously
(manifest-based store, volume `agent_packages`):

| file_type | Contains | Consumed by | Public download endpoint |
|---|---|---|---|
| `msi` | agent + TECHI Remote Support (combined) | GPO/NETLOGON bootstrap, new PCs | `/api/v1/agent-packages/platform/windows-amd64/download` |
| `agent_binary` | techi-agent.exe only | self_update (agents ≥ 2.1.1) | `/api/v1/agent-packages/agent-binary/download` |
| `agent_update_msi` | agent-only "bridge" MSI (no RS) | self_update (agents < 2.1.1) | `/api/v1/agent-packages/agent-update-msi/download` |

# Logging

| Log | Config | State |
|---|---|---|
| Backend `techi.log` | RotatingFileHandler 10 MB × 5, volume `backend_logs` | Rotates ~hourly due to heartbeat access-log noise (filter committed, not deployed) **(verified)** |
| Backend/frontend containers | docker json-file 10m × 5 | OK **(verified)** |
| Postgres container | none | Unbounded (fix committed, not deployed) **(verified)** |
| NPM edge logs | host logrotate hourly, 100 MB cap, 3 gz | OK **(verified)**; heartbeats of the whole fleet hit `proxy-host-2_access.log` |
| Agent `agent.log` (endpoints) | `C:\ProgramData\TechiAgent\logs\agent.log`, append-only | **No rotation in 2.1.5** (~0.5–1.5 MB/day/device); rotation parked in `pending-agent-2.1.6` |
| journald | SystemMaxUse=200M | OK **(verified)** |

# Security

- Operators: JWT auth, roles owner/admin/operator/readonly, teams + team
  permissions, operator scopes (client/group). Role gates on sensitive
  commands (run_powershell owner-only; set_remote_password, reboot_pc admin+).
- Per-device Remote Support password: server-generated, encrypted at rest
  (`app/core/secret_cipher.py`, keyed off SECRET_KEY), delivered in every
  heartbeat response; agents ≥2.1.5 apply+persist it. `/connect-url` has a
  version-gated fallback to the legacy shared password for agents <2.1.5
  (retires itself as the fleet upgrades). Password endpoints audited,
  owner/admin only.
- Enrollment: token-based with audit trail; trusted-domain auto-assignment.
- Heartbeat identity is payload-based (agent_id/device_id/rustdesk_id) — the
  heartbeat endpoint itself is not operator-authenticated by design.
- Security headers middleware (nosniff, referrer-policy); CORS configurable.
- Frontend CSP (nginx.conf): fully self-contained since 2026-07-06 —
  JetBrains Mono is self-hosted under `/fonts/` (was Google Fonts CDN,
  which ad blockers routinely blocked); `style-src`/`font-src` no longer
  allow any third-party origin.
- **Open issues**: enrollment token plaintext in `\\DOMAIN\NETLOGON\techi-deploy.cmd`
  (readable by any domain user — ACL restriction pending); code signing declined
  by owner (AMSI-strict domains need first hop via GPO instead).

# Scheduler

One asyncio task inside the backend process (started in `app/main.py`
lifespan), fires daily at **03:00 UTC**: cleanup of heartbeats, telemetry,
activity events (7 days each) + `VACUUM ANALYZE`. No cron/systemd timer does DB
cleanup. The 03:00 host cron is the backup script (separate). The in-process
reconciliation worker (30 s) and the realtime publisher also start with the app.

# API

- Prefix `/api/v1` (OpenAPI at `/api/v1/docs`); plus legacy compat routes
  (`/api/heartbeat`, `/api/enroll`) that call the v1 handlers.
- Routers: agent (heartbeat/enroll), devices (+activity, rustdesk health/verify
  /override, notes), clients, groups, teams, operators, operator-scopes, auth,
  alerts, audit, enrollment-tokens, enrollment-bootstrap, trusted-domains,
  agent-commands (bulk/progress/history), agent-config (+heartbeat-script),
  agent-packages, packages, remote-support (incl. per-device password +
  connect-url), deployments (mock data only), actions, bootstrap, health.
- WebSocket: `/ws/devices` (scoped events per operator role/scope);
  `/ws/deployments` exists but unused.

# PostgreSQL

- 15-alpine, `max_connections=200`, `shared_buffers` default 128MB, autovacuum
  on (defaults) **(verified)**. pg_wal ~80 MB.
- **Schema gotcha (caused a fleet-wide heartbeat 500 outage once):** nothing
  runs Alembic in prod. Any new column/index on the heartbeat/enrollment fast
  path MUST be applied manually (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`) with the deploy.
  `ensure_sqlite_dev_schema` covers SQLite dev only.
- Alembic has a **pre-existing two-head fork** (`a1b2c3d4e5f7`,
  `e6f7a8b9c0d1`) — never run `alembic upgrade heads` blindly in prod; apply
  SQL by hand, optionally `alembic stamp`.
- Index facts **(verified)**: `ix_device_heartbeats_created_at` exists
  (hand-created); `ix_device_heartbeats_id`/`ix_device_telemetry_id` are exact
  duplicates of PKs (~200 MB); several heartbeat indexes have 0 lifetime scans
  (~165 MB). Any drop requires owner approval.

# Docker

- Compose project `techi-platform` (postgres/backend/frontend); backend
  mem_limit 800m; `agent_packages`, `backend_logs`, `backend_data`,
  `postgres_data` named volumes; `/opt/techi/packages` mounted ro.
- Separate projects: `rustdesk-server` (hbbs/hbbr), `nginx-proxy-manager`.
- NPM caveat: the proxy-host "Cache Assets" toggle strips upstream
  Cache-Control; it was disabled by hand — **UI edits to proxy hosts regenerate
  the conf and re-enable it**; durable fix is keeping "Cache Assets" unticked.

# Branch-et

| Branch | State |
|---|---|
| `stable/phase-2-heartbeat` | THE working + deploy branch. Local has **unpushed `49fce27`** (see Pending) |
| `pending-agent-2.1.6` | Parked agent changes (log rotation + cache pruning, commit `313cb74`). **Do not build/merge/deploy until the 2.1.5 rollout completes** (owner's order) |
| `main` | Stale initial commit — not used |

# Versionet

- **Agent fleet target: 2.1.5** — rolling out to ~700 devices via
  NETLOGON/GPO; fleet is mixed during rollout (`agent_version` per device in
  UI). Source constant is `0.0.0-dev`; real version set at build.
- **Backend/frontend prod: content of `e0df46a`** (verified by container md5).
- Exact standalone 2.1.5 exe SHA and rollout wave status: **(needs
  verification** — check Agent Packages UI / fleet dashboard**)**.

# Known Issues (real, current — not a backlog)

1. **Split-brain deploy dirs**: `/root` (live) vs `/opt/techi/techi-platform`
   (stale) — highest operational risk; standardization decision pending.
2. Backup config tar reads the stale checkout (currently harmless — identical).
3. `49fce27` unpushed → in prod: 5 tables grow unbounded (device_alerts ~224k,
   audit_logs, remote_actions incl. PowerShell output, enrollment_audit ~87k,
   device_status_history ~172k), postgres log unbounded, techi.log hourly churn.
4. Agent 2.1.5: `agent.log` unrotated on endpoints; stale MSI/exe caches
   accumulate per version (fixes parked in `pending-agent-2.1.6`).
5. Alembic two-head fork.
6. ~365 MB duplicate/never-used indexes in prod DB (approval needed to drop).
7. `change_heartbeat_interval` per-device is overridden by global policy in the
   same cycle.
8. Enrollment token plaintext in NETLOGON (ACL pending).
9. Orphan 2 GB postgres volume + 1.1 GB stray dump on server (approval pending).
10. Stale docstring in `agent_config.py` (claims interval needs GPO scripts;
    response-driven propagation is the real mechanism).
11. 25 GB disk structurally tight (~14 GB steady baseline).
12. 4 pre-existing test failures in
    `backend/tests/test_enrollment_audit_diagnostics.py` (missing
    `trusted_domains` table in test setup) — not caused by recent work.
13. Deployments page serves mock data (`/deployments/recent` is hardcoded).

# RDP TECHI MOBILE UI 2.0

| | |
|---|---|
| **Status** | ✅ DEPLOYED — të 7 fazat live në prodhim (2026-07-06), verifikuar me Playwright kundër https://rdp.techi.com.al. 5 raunde rregullimesh pas deploy-it, gjithashtu live. |
| **Current Phase** | E përfunduar. Punë e ardhshme (Notifications/Web Push, tablet layout, etj.) kërkon amendament të ri të MOBILE-DESIGN-SPEC.md |
| **Progress** | 7/7 faza të commit-uara: Phase 1 → `27f1687`, Phase 2 → `6db4ed9`, Phase 3 → `e3dcdff`, Phase 4 → `259e1fc`, Phase 5 → `d0dd447`, Phase 6 → `1a660aa`, Phase 7 → `a8a35ea`. Push-uar (`origin/stable/phase-2-heartbeat`) dhe deploy-uar në prodhim 2026-07-06. Post-deploy: Raundi 1 (Software lazy-fetch + Sparkline) → `44770fd`, Raundi 2 (Uptime/Latency format) → `7161f73`, Raundi 3 (No Client te FilterSheet + Disk filter te Alerts) → `c1b5f9f`, Raundi 4 (iOS Safari auto-zoom fix te input-et) → `b833138`, Raundi 5 (apple-touch-icon.png i vjetëruar + nginx cache 1-vjeçar) → `3fe523c`. |
| **Current Sprint** | I mbyllur. Shih CHANGELOG-SOLUTIONS.md (2026-07-06) për detajet e deploy-it dhe 5 raundeve të rregullimeve. |
| **Reference Document** | [reference/MOBILE-DESIGN-SPEC.md](reference/MOBILE-DESIGN-SPEC.md) — kontrata zyrtare e dizajnit (design-locked; ndryshimet vetëm me amendament) |
| **Mockup i aprovuar** | https://claude.ai/code/artifact/af146cd9-d000-49d3-b723-35442ee3eaae |

**Current Priorities**: Phase 1 (shell/nav/tokens/shared) → Phase 2 Dashboard →
Phase 3 Devices/Search/Filters → Phase 4 Device Details (faqe `/devices/:id`) →
Phase 5 Alerts → Phase 6 More/Settings/RS → Phase 7 states/a11y/polish.
Commit në fund të çdo faze, vetëm pas aprovimit; pa push, pa merge, pa deploy.

**Documentation**: specifikimi i plotë, wireframes, design tokens, rregullat
a11y/responsive dhe Implementation Notes jetojnë VETËM te
`docs/reference/MOBILE-DESIGN-SPEC.md` (mos e dubliko këtu); progresi i fazave
përditësohet aty (Progress Log) + kjo tabelë (vetëm rreshtat Status/Phase/
Progress).

**Known Risks**: (1) regresion desktop nga ndarjet `md:hidden` në AppShell —
mitigohet duke mos prekur komponentët desktop dhe me `tsc --noEmit` + verifikim
vizual desktop pas çdo faze; (2) Device Details si faqe e re krah drawer-it
desktop — komponentë të ndarë, drawer i paprekur; (3) sjellje browser-i mobile
(pull-to-refresh, keyboard) — testim në pajisje reale në Phase 7.

**Implementation Rules**: vetëm UX/UI mobile (`<768px`); API contracts,
permissions, auth, realtime, business logic — të paprekura; asnjë ngjyrë
hardcoded jashtë tokens; asnjë TODO/FIXME/placeholder; devijimet teknike
regjistrohen si Implementation Notes në spec, jo si ndryshime dizajni.

**Deploy 2026-07-06** (shih CHANGELOG-SOLUTIONS.md për detaje të plota):
push i 9 commits (7 fazat mobile + `49fce27` storage batch + `1fe93de` docs,
aprovuar shprehimisht nga owner-i pas pyetjes për scope-in e push-it); pull
në `/root`; index `ix_device_heartbeats_created_at` (ekzistonte tashmë) i
"stamped" në Alembic; backend+frontend rindërtuar dhe rikrijuar; postgres
u rikrijua **vetë nga Docker Compose** (jo e planifikuar — ndryshimi i
log-cap në docker-compose.yml e detyroi) — u shërua në ~30s, 0 humbje
heartbeat, verifikuar menjëherë me logje. Të tre kontejnerët "healthy";
verifikuar vizualisht me Playwright kundër site-it real (login manual):
Dashboard/Devices/Device Details (`/devices/714`)/Alerts/More/Settings —
0 gabime 4xx/5xx në sweep të pastër të 6 rrugëve kryesore.

# Pending Features (committed/decided but not live)

- ~~Deploy of `49fce27`~~ — **done 2026-07-06**, deployed alongside Mobile
  UI 2.0 (see CHANGELOG-SOLUTIONS.md entry for that date). The
  `ix_device_heartbeats_created_at` index already existed in prod (applied
  by hand previously) and was stamped in Alembic; the postgres log-cap
  took effect as a side effect of an unplanned container recreation
  (Compose auto-recreated postgres when it detected the compose-file
  change) — verified healthy within ~30s, no heartbeat loss.
- Agent 2.1.6 (branch `pending-agent-2.1.6`): log rotation + cache pruning —
  awaiting rollout completion.
- Heartbeat storage redesign — **proposal only**, awaiting approval:
  [architecture/heartbeat-storage-redesign.md](architecture/heartbeat-storage-redesign.md).
- NPM `access_log off` for heartbeat locations — proposed, awaiting approval.
- Deploy-dir standardization to `/opt/techi/techi-platform` — proposed,
  awaiting decision.
- `techi-backup.sh` config-source fix — follows the standardization decision.

# Roadmap

**High**: complete 2.1.5 rollout; push+deploy `49fce27`; deploy-dir
standardization + backup script fix.
**Medium**: cut agent 2.1.6 from the parked branch (SHA-alignment procedure);
NPM heartbeat access_log off; drop duplicate PK indexes (with approval);
NETLOGON token ACL; disk resize decision; archive approved server leftovers.
**Low/Future**: heartbeat storage redesign (per proposal doc); telemetry
downsampling; move binaries out of git history (.git ≈ 183 MB of exe/msi/dll).

# Deploy Process

1. Local: backend tests green (`backend/venv/bin/python -m pytest tests -q`,
   `LOG_DIR=<writable>` env; expect only the 4 known failures in
   test_enrollment_audit_diagnostics), `npx tsc --noEmit` for frontend.
2. Add the CHANGELOG-SOLUTIONS entry (top, standard format).
3. Push `stable/phase-2-heartbeat`.
4. **Schema first** (gotcha): manual `ALTER/CREATE INDEX CONCURRENTLY … IF NOT
   EXISTS` on prod Postgres for anything the fast path reads.
5. `ssh techi-server` → **`cd /root`** → `git pull --ff-only` →
   `docker compose build <svc>` → `docker compose up -d <svc>`.
6. Verify: `curl localhost:8000/health` → 200; `docker ps` healthy; heartbeats
   flowing (NPM access log / dashboard); no error burst in backend logs.
7. Agent packages changed? Follow the SHA-alignment rule (Update System).
8. Rollback: `git revert` + rebuild; DB rollback SQL lives in the changelog
   entry for that deploy.
9. Update PROJECT_STATE.md if the change altered anything this file describes.

# Disaster Recovery

- **Inputs** (all on the VPS — no offsite copy exists **(verified)**):
  `/opt/backups/techi/postgres-<date>.sql.gz` (daily pg_dumpall, 14-day
  retention), `rustdesk-keys-<date>.tar.gz` (hbbs/hbbr `id_ed25519*` — losing
  these breaks remote support fleet-wide: every endpoint pins the public key),
  `techi-platform-config-<date>.tar.gz` (.env + compose), git repo (GitHub
  `Mario700kb/techi-platform`).
- **Restore outline**: provision host with Docker → clone repo → restore
  `.env`/compose → `docker compose up -d postgres` → `gunzip -c dump | docker
  exec -i … psql -U techi` → up backend/frontend → restore RustDesk keys into
  `rustdesk-server/data` before starting hbbs/hbbr → NPM proxy hosts + TLS
  certs re-created (NPM data lives in `/root/nginx-proxy-manager/data` — **NOT
  in any backup (verified)**).
- **A full restore has never been rehearsed (needs verification).** Known gaps:
  NPM config unbackuped; backups have no offsite copy; config tar comes from
  the stale checkout.
- Fleet continuity: agents retry and re-enroll via NETLOGON bootstrap; device
  identity survives via agent_id/fingerprint resolution as long as the DB dump
  is restored.

# PROJECT DOCUMENTATION POLICY

**Permanent rule from the owner (2026-07-04). This project has exactly TWO
canonical documents.**

1. **`docs/PROJECT_STATE.md`** — describes ONLY the current state of the
   project. Any change to: Backend, Frontend, Agent, TECHI Remote Support,
   PostgreSQL, Docker, Deployment, Production, API, Security, Heartbeat,
   Scheduler, Logging, or Architecture **MUST update PROJECT_STATE.md
   immediately, in the same task**.

2. **`docs/CHANGELOG-SOLUTIONS.md`** — contains ONLY the history. Every Bug,
   Incident, Deploy, Technical Decision, Root Cause, Analysis, Hotfix,
   Migration, or Optimization **MUST be recorded there immediately** (entry
   format is defined in its header).

No critical information may exist only in AI chat conversations. Every
technical decision must be documented. State lives here, history lives there —
never duplicated, never mixed. All other documents are reference
(`docs/reference/`) or archive (`docs/archive/`) material — never a source of
current state.

# AI Instructions

**Read this section fully before doing anything.**

1. **Apply the PROJECT DOCUMENTATION POLICY above** — it is the first and
   non-negotiable working rule for every session.
2. **Standing orders** (as of 2026-07-04): do NOT touch agent code, builds, or
   the agent↔backend protocol while the 2.1.5 rollout is in progress —
   agent-side work goes to branch `pending-agent-2.1.6`. No DB deletions,
   volume/backup removal, VACUUM FULL, index drops, or proxy-config changes
   without explicit owner approval. Server hygiene of the pre-approved kind
   (build cache, tmp, journal vacuum, log rotation setup) has precedent.
3. **Never assume production == code.** The owner requires evidence: ssh
   `techi-server` and inspect (docker labels, `docker exec` + md5, psql
   SELECT/SHOW, policy files, crontab). Read-only first; cite the evidence in
   your report. Verify which checkout is live before any deploy (see
   Production).
4. **How to analyze code**: read files before editing; heartbeat fast path
   (`DeviceHeartbeatService.process_heartbeat_core`) is fleet-wide hot — side
   effects belong in `_run_side_effects` (BackgroundTask). Services thin,
   queries in repositories. WS events only via `build_event()` +
   `realtime_publisher.publish_threadsafe()`. Frontend: no new component
   libraries, keep the TECHI design system, one WS connection per page.
5. **Local dev**: backend venv at `backend/venv` (do not recreate); set
   `LOG_DIR` before importing the app; SQLite dev DB; agent: `go vet`,
   `GOOS=windows go build`, `go test ./...`.
6. **Git**: work on `stable/phase-2-heartbeat`; do not auto-commit or push —
   only when asked. The owner communicates in Albanian; code/docs are English.
7. **When uncertain about prod state**: this file first, then the changelog
   (newest first), then verify live. Do not trust pre-standard docs
   (`ai-context/*`, old plans/runbooks) for current state — they are historical.

# Things Never To Change

1. **Heartbeat contract**: request/response of `POST /api/v1/agent/heartbeat`
   (+ legacy `/api/heartbeat`). New response fields must be optional; agents
   from v1.0 onward must keep working.
2. **`pending_actions[]` format** — backward compatible since v1.
3. **Enrollment endpoints** (`POST /api/v1/agent/enroll`, legacy `/api/enroll`).
4. **MSI UpgradeCode `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`** — never.
5. **Windows service name `TechiAgent`**; agent config path
   `C:\ProgramData\TechiAgent\agent.config.json` (+ legacy
   `C:\ProgramData\TECHI\agent.config.json` migration path).
6. **RustDesk server keys** (`/opt/techi/rustdesk-server/data/id_ed25519*`).
7. **Agent code during an active fleet rollout** (current: 2.1.5).
8. **SHA-alignment procedure** for agent packages (never upload a
   separately-built exe as agent_binary).
9. **Production NPM proxy config** without approval (and keep "Cache Assets"
   unticked).
10. The two-document documentation standard above.

---

## LAST VERIFIED

| | |
|---|---|
| **Production Verified** | 2026-07-04 — live ssh audit: deploy dir via docker labels, retention via `min(created_at)`, interval via policy file + measured beat rate, backups via cron + script + artifacts |
| **Code Verified** | 2026-07-04 — running container files matched commit `e0df46a` by md5 |
| **Database Verified** | 2026-07-04 — psql: table/index sizes, row counts, min/max timestamps, autovacuum, pg_wal, settings |
| **Docker Verified** | 2026-07-04 — `docker inspect` (labels, LogConfig, restart policies), `docker system df`, volume inventory |
| **Restore / DR rehearsal** | Needs verification — a full restore has never been tested |
| **TECHI Remote Support fleet version** | Needs verification — 1.4.6.0 is the repo build default, not confirmed per device |
| **Verified By** | AI-assisted audit (Claude, Fable 5) under owner supervision; evidence recorded in CHANGELOG-SOLUTIONS.md entries of 2026-07-04 |
