# TECHI Platform Runbook

This index links the primary operational and architecture notes for common
platform administration tasks.

## Heartbeat Interval

- [Heartbeat Interval Architecture](architecture/heartbeat-interval.md)

Use this guide when changing agent heartbeat cadence or reviewing online,
stale, and offline thresholds.

## Agent Config

- Backend policy endpoint: `GET` and `PUT /api/v1/agent-config`
- Rollout script endpoint: `GET /api/v1/agent-config/heartbeat-script`
- Implementation: `backend/app/services/agent_config_service.py`

Agent configuration changes require admin or owner access. Validate heartbeat
threshold compatibility before rollout.

## Enrollment Audit

- [Enrollment Audit Architecture](architecture/enrollment-audit.md)

Use this guide to understand audit event storage, result types, legacy
inference, performance, and security behavior.

## Token Diagnostics

- [Token Diagnostics Operations Guide](operations/token-diagnostics.md)

Use this guide to reconcile token uses with unique devices, duplicate
enrollments, failures, archived devices, and orphaned uses.

## Bootstrap-config Contract Mismatch ("refusing unsupported flags")

Symptom: after `Agent MSI complete (exit 0)`, the bootstrap log shows
`ERROR: Agent bootstrap-config contract does not match the active bootstrap
package; refusing unsupported flags.` and enrollment never completes.

This gate is **fail-closed by design** — do not weaken or bypass it. It rejects
any agent binary whose emitted `bootstrap-config-contract` payload does not
exactly match the deployed backend (agent version, `contract_version`, required
flags). The cause is a **deploy skew that can run in either direction** — the
backend and the shipped agent/MSI declare different `contract_version`s. Prove
the direction, don't assume it (the 2026-07-17 incident's first guess was
backwards):

1. Download the active MSI and run its agent:
   `msiextract TECHI-Agent-<v>.msi` → `wine techi-agent.exe bootstrap-config-contract`
   (or run on a Windows box). Note its `contract_version`.
2. Read the **deployed** backend's expectation:
   `ssh techi-server "grep BOOTSTRAP_CONFIG_CONTRACT_VERSION /opt/techi/techi-platform/backend/app/services/bootstrap_config_contract.py"`
   and confirm the running container:
   `docker exec techi-platform-backend-1 python -c "from app.services.bootstrap_config_contract import BOOTSTRAP_CONFIG_CONTRACT_VERSION as v; print(v)"`.
3. They must be equal. In the 2026-07-17 incident the **backend was behind**
   (backend "1", MSI "2"); the fix was to advance the backend, never to downgrade
   the MSI. Backend code is baked into the image — apply the change on disk then
   `docker compose build backend && docker compose up -d backend`.

Diagnose from `C:\Windows\Temp\techi-bootstrap.log` — the gate now logs the
exact failing check just before the ERROR:

- `contract_check=fail reason=no_contract` — the installed agent does not
  implement `bootstrap-config-contract` (predates the feature) or exited
  nonzero / emitted non-JSON. Rebuild+publish a current agent MSI.
- `contract_check=fail reason=contract_version_mismatch expected=<X> received=<Y>`
  — served MSI is stale/out-of-band. Republish and **activate** the CI-verified
  MSI whose contract matches the deployed backend.
- `contract_check=fail reason=agent_version_mismatch expected=<X> received=<Y>`
  — the active package metadata version and the installed binary disagree.
- `contract_check=fail reason=unsupported_flag missing_flag=<flag>` — a genuine
  flag-level contract gap; the agent build lacks a required flag.

Also compare the logged `contract_received` vs `contract_expected` lines
directly. Resolution: ensure the active `windows-amd64` `msi` package is the
current CI-built artifact (CI probes `bootstrap-config-contract` and runs
`scripts/verify_bootstrap_config_contract.py` post-build, so a correctly built
MSI cannot ship a mismatched contract), and always deploy the backend contract
bump **together with** activating the matching MSI — never backend first.

## Remote Support Version Mismatch / Connect Opens Home Screen

Symptom: installed `C:\Program Files\TECHI Remote Support\TECHI Remote Support.exe`
reports an older version than the package label (e.g. package "1.4.8" but exe
"1.4.6+64"), and/or clicking Connect opens the GUI on its home screen instead of
the device session.

Verify the artifact — never trust the package label:
1. Download the active MSI:
   `curl -fsSL https://api-rdp.techi.com.al/api/v1/agent-packages/remote-support-msi/download -o rs.msi`
   and confirm its sha256 == the DB active `remote_support_msi` row.
2. `msiextract rs.msi`; read the embedded GUI exe version (`pefile` StringFileInfo,
   or Windows Explorer → Properties → Details). `msiinfo export rs.msi Property`
   gives the MSI `ProductVersion`.
3. If the embedded `TECHI Remote Support.exe` version < MSI ProductVersion, the
   MSI shipped a **stale GUI**. The Windows GUI is a vendored prebuilt at
   `agent/installer/TECHI-Remote-Support/` (git-tracked) harvested verbatim by
   `build-agent-msi.yml`; bumping wxs/filename without replacing that payload
   produces a mislabeled MSI. Fix = rebuild the GUI to the target version,
   replace the vendored payload, align all version stamps, rebuild+activate.

Connect flow (for triage): `techiremotesupport://connect?token=<opaque>` →
`techi-remote-support-bridge.exe "%1"` → `POST /remote-support/connect-tokens/redeem`
→ `{remote_id, password, receipt}` → bridge writes the one-time password into
`%APPDATA%\TECHI Remote Support\config\peers\<id>.toml` (ACL'd) and launches
`--connect <id>`. The **secure auto-connect GUI contract is macOS-only**
(`secure_connect.rs.txt`, `#[cfg(target_os="macos")]`, stdin→IPC). Windows has no
GUI-side connect customization, so a stale/plain RustDesk GUI ignores the bare
`--connect` when the tray/service instance is already running. Fixing Connect on
Windows requires a GUI build that implements the Windows connect contract — not a
bridge-only or MSI-repackage change.

## Remote Support Clean Reinstall

Use the device action `Reinstall TECHI Remote Support` only when Remote Support
itself must be replaced. The action is independent from Agent repair and uses
the latest active Windows package whose Package Manager type is
`remote_support_msi`.

Expected phase order in the action result/log is:

1. `resolve_package`: bind, download, and SHA256-verify the active MSI.
2. `preserve_identity`: retain only verified Remote ID and credential/key fields.
3. `stop_runtime`: stop the Remote Support service and exact owned processes.
4. `uninstall_msi`: uninstall registered `TECHI Remote Support` MSI products.
5. `remove_application_files`: remove the exact install directory; malformed
   TOML is renamed with a timestamp and `.corrupt` suffix.
6. `install_msi`: install the verified active MSI and stop its initial runtime
   before restoring identity.
7. `restore_identity`: write minimal identity TOML and fresh managed options.
8. `start_service`: recreate/start the Remote Support service.
9. `validate_installation`: require the full Flutter runtime, exact restored
   identity, valid options TOML, and SCM Running state.
10. `start_ui`: launch and validate a usable main window in the active user
    session. A 16x16 tray/helper window is rejected.

`reinstalled_ui_pending_login` is successful when no interactive user is
logged in; the service and complete runtime remain installed. Any other failure
returns `reinstall phase=<phase>` with the underlying OS/MSI error. MSI failures
also include the verbose log path under
`C:\ProgramData\TechiAgent\recovery\remote-support-msi\logs`. Do not run Agent
repair, reinstall, GPO, or rollout procedures as part of this action.

### MSI custom-action validation

The Remote Support MSI configures its service through a deferred SYSTEM custom
action. Its verbose MSI log must contain `WixQuietExec` output with:

- `identity=NT AUTHORITY\SYSTEM`;
- each `step=...`, native `exit_code`, `stdout`, and `stderr`;
- `success service_status=Running runtime_exe=true app_so=true`.

Warnings from exact-process cleanup, service recovery-policy configuration, or
tray-task setup do not make the MSI fatal. A fatal Error 1722 is valid only when
the log identifies a missing/empty required runtime file or a service
create/config/start failure that prevents SCM from reaching `Running` within 30
seconds. Preserve the full verbose MSI log when either occurs.

Before publishing a Remote Support MSI, the Windows validation job must pass
all three cases: clean install, reinstall after deleting `data\app.so`, and
uninstall/reinstall. Each install must return exit code 0 and leave these files
non-empty plus the service Running:

- `TECHI Remote Support.exe`;
- `flutter_windows.dll`;
- `librustdesk.dll`;
- `data\app.so`;
- `data\icudtl.dat`.

The CI artifact `TECHI-Remote-Support-MSI-validation-logs` contains the verbose
logs for these cases. Do not activate a package or retest an endpoint when this
gate fails.

### Identity synchronization

For `Repair TECHI Remote Support Config` and `Reinstall TECHI Remote Support`,
the canonical identity is the valid active-interactive-user
`config\TECHI Remote Support.toml`. It must contain a usable numeric `id`, plus
the permanent password and salt, or a non-empty `enc_id` with those credential
fields; key pair and key confirmation are preserved when present. Never use an MSI-generated LocalService plaintext
password as the canonical source.

Before either action writes config, the Remote Support service and all exact
owned tray/server/UI processes must be stopped. The action atomically
synchronizes the canonical identity and managed `TECHI Remote Support2.toml` to:

- the active interactive user's Roaming profile;
- `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming`;
- LocalSystem's systemprofile only when SCM reports that account;
- an existing root-level mirror for any required profile.

After restarting the service and UI, the identity fields in every required
profile must match and the service's `--get-id` result must exactly equal the
canonical user ID. When TOML stores only `enc_id`, use the Agent's existing
verified Remote ID for that numeric comparison. `identity_mismatch` is a failed repair; preserve the action
result and do not overwrite the user config with a newly generated password.
Remote Support binary `1.4.6+64` displayed from MSI 1.4.8 is expected and is not
an identity-repair issue.

For `Repair TECHI Remote Support Config` specifically, the required files are
`config\TECHI Remote Support.toml` and
`config\TECHI Remote Support2.toml` under exactly these two profiles:

- the active interactive user's `AppData\Roaming\TECHI Remote Support`;
- `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\TECHI Remote Support`.

The active user's `AppData\Local` tree is optional. The repair action must not
create or verify it merely because the user is active. ProgramData, root-level
mirrors, and unused systemprofile paths are likewise outside this repair
contract. Verify both required files and every file actually written. A
failure must report the exact required path and field; do not replace it with a
generic config mismatch. The final UI/service ID equality check is still
required. These repair-only rules do not alter reinstall profile handling.

RustDesk 1.4.6 derives its local device ID only from the suffixless
`config\TECHI Remote Support.toml` file. Canonical selection priority is:

1. a valid plaintext `id`;
2. an encrypted-only `enc_id` with complete `key_pair`/`key_confirmed` material and an independently verified numeric UI ID;
3. fail without writing or generating an identity.

Password and salt are preserved when valid. Preserve `key_pair`,
`key_confirmed`, and `keys_confirmed` only as one complete usable set; omit an
incomplete set when a valid plaintext ID already exists.
`TECHI Remote Support2.toml` is the separate options store.
`TECHI Remote Support_local.toml` stores UI-local state such as the most
recently used remote peer and is not a local identity source.

For config repair, do not copy an encrypted `enc_id` alone between the user and
LocalService profiles. Stop the service and every owned server/tray/UI process,
then atomically write the complete canonical material to both required
suffixless files with the verified existing UI ID in plaintext `id` and an
empty `enc_id`. On first load, each RustDesk profile will encrypt that same ID
for its runtime context. Missing or incomplete key material does not invalidate
a canonical plaintext ID and must not be copied. It remains fatal for an
encrypted-only candidate. Never allow RustDesk to generate replacement
identity material.

Restart and validate in this order:

1. Start the Remote Support service.
2. Require the live service ID to equal the canonical UI ID.
3. Launch the normal UI in the active interactive session and require a usable main window.
4. Require the live ID to still equal the canonical UI ID before reporting success.

Do not launch the UI after a service identity mismatch, and do not report a
file-only semantic match as a successful identity repair.
