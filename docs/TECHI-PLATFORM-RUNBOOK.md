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
