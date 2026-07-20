# Remote Support credential lifecycle

Status: historical/source security contract; rollout disabled; disposable
Windows lab validation still required. **Current production-recovery exception
(2026-07-20): Agent 2.1.16 deliberately restores Agent 2.1.6 communication
behavior for rollback backend `92a521c`. Existing devices with `agent_id` +
`device_id` do not require `agent_credential`, auth migration, or signed
heartbeat. Do not use this document to require AgentCredential for Agent 2.1.16
production canary.**

## Sources of truth

The backend is authoritative for credential intent and confirmation. `desired_generation` holds an encrypted pending generated/custom password. `applied_generation` and the active ciphertext change only after an authenticated, device-bound Agent acknowledgement for that exact generation. A failed or stale acknowledgement never replaces the last confirmed active credential.

New active/desired passwords and per-operation verification keys use the Vault AES-GCM envelope cipher. Legacy reversible ciphertext is migrated to Vault on successful read. Plaintext is returned only to an authenticated matching Agent for a pending generation or to an authorized admin/owner through the audited manual reveal endpoint. It must not enter logs, audit details, action payloads, URLs, process arguments, policy, or manifests.

The Agent stores the currently applied password in its ACL-restricted local JSON config and in RustDesk identity TOMLs because the service/tray require it. This is plaintext-at-rest protected by Windows ACLs, not encryption. DPAPI LocalMachine protection is not implemented: the service/tray interoperability and recovery implications require a real Windows design/test before that claim can be made.

## Transaction and acknowledgement

1. Set/Regenerate creates a higher desired generation, encrypted password, encrypted one-operation verification key, and backend expected HMAC fingerprint.
2. Only an authenticated matching heartbeat receives that pending tuple.
3. The Agent checks for a newer generation, updates every existing approved identity profile transactionally, restarts the service and tray, and verifies the exact applied bytes before acknowledging.
4. The acknowledgement contains generation, `applied`/`failed`, keyed fingerprint, and a sanitized error. It never contains the password.
5. The backend promotes desired to active only when generation and HMAC match. It then deletes the encrypted verification key. Failed application retains the previous active credential; stale acknowledgements are ignored.

Historical signed-heartbeat design note: existing Agents have no derivable
authentication secret. In the staged-auth design they were classified
`unsupported_legacy` and required explicit re-enrollment; unauthenticated
migration heartbeats received no credential or privileged action. That design is
not active for the Agent 2.1.16 rollback-compatible path: Agent 2.1.16 keeps
legacy heartbeat semantics and does not require re-enrollment solely because
`agent_credential` is absent.

## Connect transport

Password-bearing protocol URLs are prohibited. No authenticated local token resolver/secure IPC launcher exists yet, so `REMOTE_SUPPORT_DIRECT_CONNECT_ENABLED` defaults to `false`. Disabled attempts are audited and return fail-closed. Authorized operators use the manual Remote ID plus audited password reveal workflow. An ID-only URI can be emitted only after the explicit flag is enabled, and only for a confirmed applied generation; it never carries a password.

## Endpoint profile precedence

The LocalSystem `systemprofile` Roaming profile is authoritative for the SCM service. ProgramData, LocalService, NetworkService, and each interactive user's Roaming and Local AppData profiles are discovered as mirrors. Both root-level and `config` directories are inspected. The suffixless TOML is the identity/credential file; `2.toml` is the options file.

Only existing identity files are credential-patched. Options are patched in all existing option profiles; if none exists, only the authoritative LocalSystem options file is initialized. Writes use same-directory temporary files, flush, atomic rename, transaction rollback, and semantic re-read. Full-directory deletion is forbidden. Different non-empty IDs across profiles produce `conflicted` and block mutation. Service and relevant tray processes restart only after a real credential change.

## Sync and repair semantics

In the historical signed-heartbeat design, `remote_support_sync_state` values
are `unknown`, `pending`, `applied`, `failed`, `conflicted`, and
`unsupported_legacy`; `applied` requires a matching authenticated credential
acknowledgement, expected generation, conflict-free profiles, matching managed
server/relay/key options, a Remote ID, and healthy service runtime as reported
by the Agent. For Agent 2.1.16 rollback compatibility, do not infer heartbeat
auth or `agent_credential` requirements from this state model.

Repair telemetry distinguishes attempts, successes, consecutive failures, last reason, and last time. A harmless check does not increment counters. The Agent's 30-minute reconciliation cooldown bounds repeated writes; failures remain alertable without being labeled synced.

## Bootstrap, recovery, and rollback

Bootstrap writes no Remote Support password and performs no Remote Support config cleanup. Reruns leave IDs, password/salt/key-pair, endpoint options, and profile identities byte-for-byte untouched; authenticated Agent reconciliation owns later changes.

Native recovery consumes the bound manifest preservation roots, including the Agent config that holds applied generation/fingerprint plus ProgramData, LocalSystem, LocalService, NetworkService, and all user Roaming/Local profiles at both root and `config` levels. Only the approved Agent JSON and regular TOMLs are accepted. Executable/script-like content and conflicting identities are rejected. Preserved bytes, mode, timestamps, ACL/owner, and hashes are verified after recovery; rollback restores all captured locations. `never_overwrite_paths` rejects Agent config/TOMLs from the runtime payload.

## Historical payload cleanup

`set_remote_password` is retired in backend schema/service, frontend, and Agent dispatch. Historical queued actions are failed before delivery. Treat existing `remote_actions.payload` and `agent_command_batches.payload` rows as sensitive.

Run `backend/scripts/redact_remote_password_payloads.py` in the intended maintenance environment first without flags to obtain counts only. After an approved database backup and change window, use `--execute --confirm REDACT-REMOTE-PASSWORD-PAYLOADS`. The procedure replaces only payloads belonging to the retired command with `{}` and never prints their contents. It has not been run against production.

## Troubleshooting and rollout

- `pending`: wait for an authenticated heartbeat; confirm service/tray can read approved profiles.
- `failed`: inspect the sanitized reason and consecutive failure counter; the previous active password remains valid.
- `conflicted`: do not overwrite. Compare Remote IDs and profile ownership in a disposable Windows lab.
- `unsupported_legacy`: applies only to the historical signed-heartbeat
  migration design. Do not apply this label to Agent 2.1.16 rollback-compatible
  communication; 2.1.16 intentionally accepts existing `agent_id` + `device_id`
  configs without `agent_credential`.

Source validation does not prove Windows session/profile behavior. Before any canary, use a disposable domain-joined Windows VM to verify service authority, multiple interactive users, RustDesk password hashing after restart, ACL behavior after atomic rename, rollback, and exact native preservation. Production push/deploy/activation remains outside this work.
