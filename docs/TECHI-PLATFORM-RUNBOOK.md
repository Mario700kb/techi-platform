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
`config\TECHI Remote Support.toml` file. Treat these fields as one identity:
`id`/`enc_id`, `password`, `salt`, `key_pair`, and `key_confirmed`; preserve
`keys_confirmed` when present. `TECHI Remote Support2.toml` is the separate
options store. `TECHI Remote Support_local.toml` stores UI-local state such as
the most recently used remote peer and is not a local identity source.

For config repair, do not copy an encrypted `enc_id` alone between the user and
LocalService profiles. Stop the service and every owned server/tray/UI process,
then atomically write the complete canonical material to both required
suffixless files with the verified existing UI ID in plaintext `id` and an
empty `enc_id`. On first load, each RustDesk profile will encrypt that same ID
for its runtime context. Missing key pair or key confirmation is a failed
repair; never allow RustDesk to generate replacement identity material.

Restart and validate in this order:

1. Start the Remote Support service.
2. Require the live service ID to equal the canonical UI ID.
3. Launch the normal UI in the active interactive session and require a usable main window.
4. Require the live ID to still equal the canonical UI ID before reporting success.

Do not launch the UI after a service identity mismatch, and do not report a
file-only semantic match as a successful identity repair.
