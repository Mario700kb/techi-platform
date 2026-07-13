# Native Bootstrap / Update Architecture

Status: **foundation landed on `stable/phase-2-heartbeat` (report/plan-only, non-destructive). Rollout = disabled. Not deployed, not activated, no NETLOGON change.**

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

## Target flow

```
GPO Scheduled Task
  -> \\DOMAIN\NETLOGON\techi-bootstrap.exe apply-policy --policy \\DOMAIN\NETLOGON\techi-policy.json
     -> parse + validate techi-policy.json (versioned contract, NO secrets)
     -> detect state (native SCM/process/file inspection)
     -> Agent: EvaluateAgent()  -> native updater | first-install/repair MSI | recreate service | no-op
     -> Remote Support: PlanRemoteSupportRecovery() -> ordered native recovery plan
```

The bootstrap is currently the Agent binary itself (`techi-agent.exe apply-policy` /
`repair-remote-support`), reusing the Agent's verified SHA256, version, service,
swap, and config code. A separate signed `techi-bootstrap.exe` can be split out
later without changing the decision logic — it already lives in the standalone,
OS-neutral `agent/internal/native` package.

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
missing/corrupt → MSI repair. UI self-update and NETLOGON use **byte-identical**
Agent artifacts.

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
Disabling runtime rollout does **not** strip the native artifacts from generated
GPO output — the transitional generator publishes the native bootstrap + policy
regardless, behind a default-disabled feature flag, with the legacy CMD script as
explicit fallback.

## Signing / release gate (future, not yet implemented)

`build → sign (Authenticode) → timestamp → SHA256 → publish → activate`. The
`AuthenticodeVerifier` seam exists; **no certificate is fabricated and no signing
has occurred**. Release checklist: code sign, timestamp, AV scan, Kaspersky
clean-file + Symantec clean-software (+ other EDR) submission, canary, keep
rollback artifacts.

## What still needs a real Windows canary

The decision core is fully unit-tested off Windows. The **execution** of each
action (SCM control, exact-PID termination, atomic bundle promotion, ACL
lockdown, boot-retry scheduling) is implemented against existing Agent Windows
functions but must be validated on a **single real affected device** before any
batch. See the recovery canary checklist in the session report / OPERATOR-MANUAL.
