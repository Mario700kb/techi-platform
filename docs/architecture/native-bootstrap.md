# Native Bootstrap / Update Architecture

Status: **source candidate only. The decision core, standalone `techi-bootstrap.exe`, hardened bundle contract, backend ZIP+manifest binding, and Windows executor are implemented and locally tested. `apply-policy` is explicitly report-only. The native GPO publication/local-copy/task lifecycle is incomplete and the generator emits no native operational task even if `NATIVE_BOOTSTRAP_ENABLED` is accidentally set; the flag defaults OFF. Nothing was deployed or activated, no NETLOGON/GPO change was made, and all Windows mutations remain unproven on a real device.**

## Components added in the second pass

- `agent/internal/native/execute.go` — `Executor` interface + `ExecutePlan` orchestrator (dry-run vs `--execute`, verify-before-mutate, rollback on failed validation, one boot retry, unsafe-target refusal). Fake-tested off Windows.
- `agent/internal/native/executor_windows*.go` — real Windows executor: exact-name SCM stop/start/delete/create, exact-image-path (not name-only) process termination via `QueryFullProcessImageName`, tray scheduled-task disable, pending-reboot + `TBD*.tmp` detection, restricted-ACL staging (`icacls` SYSTEM+Administrators), zip-slip-safe extraction, reparse-point refusal, no-TEMP execution, atomic rename promotion + rollback, one ONSTART boot-retry, `VerQueryValue` version validation, and a native state prober (`ObserveRemoteSupport`).
- `agent/internal/native/executor_other.go` — non-Windows stub: every mutating primitive returns `ErrNotWindows`; pure payload verify still runs.
- `agent/cmd/techi-bootstrap/` — the standalone `techi-bootstrap.exe`: `apply-policy` / `repair-remote-support`, `--dry-run`/`--execute`, `--json`, reuses `internal/native`, does **not** depend on `techi-agent.exe` to orchestrate.
- Backend `EnrollmentBootstrapService.build_native_policy` / `build_native_bootstrap` describe a future artifact contract. The live GPO response does **not** expose the native task while publication/copy/task ownership is incomplete.
- `agent/scripts/build-native-bootstrap.sh` + `.github/workflows/build-native-bootstrap.yml` build the bootstrap and RS bundle only. The canonical Agent binary comes exclusively from `build-agent-msi.yml`, which proves the standalone binary equals the MSI-embedded binary.

Cross-language contract is verified: the Python-generated policy validates against the Go `apply-policy` validator.

## Native Remote Support bundle (pass 3)

The recovery payload is a **deterministic, immutable, versioned ZIP** — never
the MSI (the MSI's repair loop is what fails on the affected devices). It is
built by `agent/cmd/techi-rs-package` from the authoritative source bytes
(`agent/installer/TECHI-Remote-Support/`, the same tree the MSI wraps).

- **Filename:** `TECHI-Remote-Support-<version>-windows-amd64.zip` (+ `.sha256`, `.manifest.json`, `.identity.json` sidecars).
- **Deterministic:** sorted entries, normalized 2020-01-01 ZIP and metadata timestamps, forward-slash paths, and one declared product root (`TECHI Remote Support/`). CI compares ZIP and manifest hashes across a rebuild.
- **Manifest** (`internal/native/bundle.go`): schema + payload-format versions, product/version/platform/arch, entrypoint, service name+args (`--service`), tray task+args (`--tray`), per-file `sha256`+size, `bundle_sha256`, build commit/timestamp, `config_paths_to_preserve`, `never_overwrite_paths`, `signing_status: unsigned`.
- **Included:** the 97 runtime files (EXE + DLLs + `data/`). **Excluded/preserved:** RustDesk ID/config/password live *outside* the install dir (ServiceProfiles/roaming, `*.toml`) and are never bundled or overwritten.
- **What is replaced:** the install-dir runtime files, atomically (rename promotion + backup + rollback). **What is preserved:** identity/config/password and any `never_overwrite` file.
- **Verification before promotion** (`VerifyExtractedBundle`): every expected file present with matching size+SHA, entrypoint present, **no unexpected extra files**, no symlink/reparse, no path escape. Extraction (`ExtractZipBytesSafe`) additionally rejects `..`/absolute/UNC/drive/duplicate/symlink entries into `C:\ProgramData\TechiAgent\staging\remote-support\<version>\`, never `%TEMP%`.
- **Backend:** `remote_support_bundle` upload requires both ZIP and manifest, validates canonical metadata plus the complete file set/hashes, stores both hashes and validated metadata, and revalidates the exact pair before activation. Empty, non-ZIP, malformed, corrupt, or mismatched inputs are rejected.
- **Canary prep:** `agent/installer/techi-policy.canary.example.json` (valid, `rollout_mode=disabled`, real bundle SHA) + `techi-policy.canary.README.md` (step-by-step, rollback = `<install-dir>.techibak`). Build all artifacts with `agent/scripts/build-native-bootstrap.sh`.

---

_Original foundation notes:_

## Why

The GPO deploy path grew into a ~2,600-line Python generator
(`backend/app/services/enrollment_bootstrap_service.py`) emitting a
tens-of-thousands-of-bytes `techi-deploy.cmd` with many
`powershell -EncodedCommand` blocks that parse registry/service/lifecycle state
through temp `.out` files. It is fragile, hard to test, and its behavioural
chain (CMD → repeated EncodedCommand PowerShell → TEMP → MSI) is exactly what AV/EDR
heuristics score. The Drymadess/Agroblend incident (~30 devices) is the concrete
failure: healthy Agent 2.1.8, but the legacy **combined** MSI uninstall removed
Remote Support files, and the independent RS MSI repair looped on 1321/1603 while
a stale RS service remained.

> Distribution is **LAN-local (NETLOGON)**; AV/EDR policies remain fully
> applicable. There is **no "zero AV detection" guarantee** and none is claimed.

## Target flow (not yet an operational GPO path)

```
GPO Scheduled Task
  -> \\DOMAIN\NETLOGON\techi-bootstrap.exe apply-policy --policy \\DOMAIN\NETLOGON\techi-policy.json
     -> parse + validate techi-policy.json (versioned contract, NO secrets)
     -> detect state (native SCM/process/file inspection)
     -> Agent: EvaluateAgent()  -> native updater | first-install/repair MSI | recreate service | no-op
     -> Remote Support: PlanRemoteSupportRecovery() -> ordered native recovery plan
```

The recovery CLI is the separate `techi-bootstrap.exe`; it does not claim to be
the canonical Agent artifact. `apply-policy` only validates and reports. The
canonical Agent binary remains the binary produced once and checked against the
MSI by `build-agent-msi.yml`.

## Components (this branch)

`agent/internal/native/` — pure, unit-tested, cross-platform decision core:

| file | responsibility |
|---|---|
| `policy.go` | versioned `techi-policy.json` parser + strict validation (rejects unknown/secret fields, path-bearing filenames, non-https api, bad SHA/version) |
| `result.go` | deterministic bounded `ExitCode` contract + JSON `OperationResult` |
| `pathsafe.go` | `SafeJoinUnder` / `StagingPath` / `IsRefusedInstallTarget` — refuse `..`, absolute, UNC, drive, System32/root targets |
| `verify.go` | `VerifyPayload` (SHA256 identity gate, no side effects) + `AuthenticodeVerifier` interface (no-op default that never claims a file is signed) |
| `log.go` | structured key=value logging with automatic secret redaction |
| `recovery.go` | `PlanRemoteSupportRecovery` — RS recovery state machine (spec states A–I) |
| `agentstate.go` | `EvaluateAgent` — Agent update state machine (spec states A–H) |

`agent/bootstrap_native.go` — thin package-main wiring for the two subcommands;
loads policy + an observation JSON and emits the plan/result. **Non-destructive:**
live probing and live mutation are deferred to a Windows, canary-gated executor.

## Exit-code contract (stable)

`0 ok · 1 error · 2 bad_args · 3 identity_failed · 4 busy · 5 pending_reboot · 6 unsafe_target · 7 payload_missing · 8 validation_error`

## Policy schema (v1)

See `agent/installer/techi-policy.example.json`. Carries **no** enrollment
token, RS password, or API secret. Enrollment keeps its existing NETLOGON path
— the plaintext NETLOGON token remains a documented **migration blocker**, with
a future short-lived/domain-scoped bootstrap credential exchange as the path
forward.

## Agent state machine (EvaluateAgent)

A absent → MSI first-install · B lifecycle transiently missing on a healthy,
PID-matched service → **bounded retry, never MSI** · C healthy & older →
**native updater only, never MSI** · D healthy & equal → no-op · E newer → no
downgrade · F valid binary/config, service gone → recreate service · G
missing/corrupt → MSI repair. No native-GPO Agent publication is exposed. UI
self-update uses the canonical active `agent_binary` from the MSI workflow.

## Remote Support recovery (PlanRemoteSupportRecovery)

Payload format decision: RS ships as a **68 MB native bundle** (EXE + DLLs +
`data/`), so recovery uses a **verified bundle/ZIP with manifest**, never an MSI
repair loop. Every mutating plan is gated by a SHA256 payload verification
*before* any service/file mutation; `payload_missing` and bad-SHA are
deterministic refusals, not runtime surprises.

Classifications: healthy_current (never touched) · missing · stale_service
(service present, EXE gone — the incident state) · service_missing · outdated ·
locked · pending_reboot (one bounded boot retry, **no endless loop**) ·
legacy_migration (never trust the pre-Agent-install RS classification).

Ordered plan (example, stale_service):
`verify_payload → preserve_config → stop_service → remove_stale_service →
cleanup_tmp → stage_payload → promote_files → restore_config → create_service →
start_service → validate_final`.

Process termination is **exact-path/PID only** — never a name-only `taskkill`.
Staging is `C:\ProgramData\TechiAgent\staging\<component>\<version>\` (never
`%TEMP%`); the Windows wiring layer restricts ACLs to SYSTEM + Administrators.

## Rollout safety

`rollout_mode=disabled` (the mandatory default) makes the planner **detect-only**:
it classifies and reports but emits no mutating action. `canary` restricts
mutation to allowlisted devices; `enabled` is fleet (still gated on signing).
Native artifacts are not emitted in generated GPO output. The reserved feature
flag remains OFF and fails closed until publication, local-copy, ownership, and
task lifecycle are implemented and lab-tested.

## Signing / release gate (future, not yet implemented)

`build → sign (Authenticode) → timestamp → SHA256 → publish → activate`. The
`AuthenticodeVerifier` seam exists; **no certificate is fabricated and no signing
has occurred**. Release checklist: code sign, timestamp, AV scan, Kaspersky
clean-file + Symantec clean-software (+ other EDR) submission, canary, keep
rollback artifacts.

## What still needs a real Windows canary

The decision core and fake transaction boundary are unit-tested off Windows.
Windows code cross-compiles, but the **execution** of each
action (SCM control, exact-PID termination, atomic bundle promotion, ACL
lockdown, boot-retry scheduling) is implemented against existing Agent Windows
functions but must be validated on a **single real affected device** before any
batch. See the recovery canary checklist in the session report / OPERATOR-MANUAL.
