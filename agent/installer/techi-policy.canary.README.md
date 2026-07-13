# One-device Remote Support recovery canary — preparation

`techi-policy.canary.example.json` is a **valid** policy (strict JSON, so no
inline comments) with `rollout_mode` **disabled** by default. It references the
deterministic native Remote Support bundle
`TECHI-Remote-Support-1.4.6-windows-amd64.zip` and its real `bundle_sha256`
(`e1aa5097…d4d9d`, reproducible via `agent/scripts/build-native-bootstrap.sh`).

**No secrets** are in this file. Enrollment keeps its existing NETLOGON path.

## Prepare a disposable Windows lab first (do NOT run a device canary yet)

1. Build the artifacts locally (unpushed):
   ```
   OUT_DIR=dist/native agent/scripts/build-native-bootstrap.sh
   ```
   Produces `techi-bootstrap.exe` (+`.sha256`, `identity.json`) and
   `TECHI-Remote-Support-1.4.6-windows-amd64.zip` (+`.sha256`,
   `.manifest.json`, `.identity.json`).

2. Fill in hashes from the locally built candidate artifacts. Do not activate or
   publish anything as part of this procedure. Both the ZIP SHA and manifest SHA
   must match the exact local sidecars; placeholder zeros are structural only.

3. Stage on ONE device (local-copy-first), in a restricted dir:
   `C:\ProgramData\TechiAgent\bootstrap\` ← `techi-bootstrap.exe` + this policy
   (renamed `techi-policy.json`); place the bundle + `.manifest.json` where
   `--artifact-dir` points (default: the policy's directory).

4. **Dry-run first** (never mutates):
   ```
   techi-bootstrap.exe repair-remote-support --policy techi-policy.json --json
   ```
   Expect classification `stale_service` and, under `disabled`, detect-only.

5. Only in a disposable lab, set `remote_support.recovery_mode` to `canary`, add
   the lab identity to `eligible_device_ids`, and pass the same identity with
   `--device-id`. `rollout_mode` controls Agent rollout and does not authorize
   RS recovery. A later real-device `--execute` needs separate authorization
   after the lab passes. Validate EXE/file hashes, exact version/path/arguments,
   service PID image, config identity, rollback injection, task ownership, and
   bounded reboot retry.

## Rollback artifacts

- Pre-promotion files are moved to the TECHI-owned backup root and the executor
  attempts strict reverse-order restoration on failure. Treat any reported
  incomplete rollback as a failed lab.
- To abort the whole approach: keep `recovery_mode=disabled`, do not run
  `--execute`; the legacy MSI/CMD path is untouched.

## Signing / AV

Binaries are **unsigned** (`identity.json` reports `signed:false`). Distribution
is **LAN-local; AV/EDR policies remain applicable** — there is no zero-detection
claim. Sign + timestamp + resubmit to AV vendors before fleet use.
