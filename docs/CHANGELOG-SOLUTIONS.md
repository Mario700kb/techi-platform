# TECHI Platform Changes and Solutions

Use this file as a running record of user-facing fixes, their root causes, and
the checks used to verify them. Add new entries at the top.

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
