# One-device Remote Support recovery canary — preparation

`techi-policy.canary.example.json` is a **valid** policy (strict JSON, so no
inline comments) with `rollout_mode` **disabled** by default. It references the
deterministic native Remote Support bundle
`TECHI-Remote-Support-1.4.6-windows-amd64.zip` and its real `bundle_sha256`
(`e1aa5097…d4d9d`, reproducible via `agent/scripts/build-native-bootstrap.sh`).

**No secrets** are in this file. Enrollment keeps its existing NETLOGON path.

## Prepare the canary (do NOT run live recovery until explicitly authorised)

1. Build the artifacts locally (unpushed):
   ```
   OUT_DIR=dist/native agent/scripts/build-native-bootstrap.sh
   ```
   Produces `techi-bootstrap.exe` (+`.sha256`, `identity.json`) and
   `TECHI-Remote-Support-1.4.6-windows-amd64.zip` (+`.sha256`,
   `.manifest.json`, `.identity.json`).

2. Fill in the real agent `sha256` / `repair_msi_sha256` from the **activated**
   `agent_binary` / `msi` packages (the placeholder zeros are structural only).
   The Remote Support `sha256` already matches the built bundle.

3. Stage on ONE device (local-copy-first), in a restricted dir:
   `C:\ProgramData\TechiAgent\bootstrap\` ← `techi-bootstrap.exe` + this policy
   (renamed `techi-policy.json`); place the bundle + `.manifest.json` where
   `--artifact-dir` points (default: the policy's directory).

4. **Dry-run first** (never mutates):
   ```
   techi-bootstrap.exe repair-remote-support --policy techi-policy.json --json
   ```
   Expect classification `stale_service` and, under `disabled`, detect-only.

5. To exercise the real plan on the canary device, set `rollout_mode` to
   `canary` in a COPY and run with `--execute` **only after explicit
   authorisation**. Validate: EXE present, correct version, service RUNNING,
   exact image path, no stale helper, no `TBD*.tmp`, no retry loop.

## Rollback artifacts

- Pre-promotion install dir is backed up to `<install-dir>.techibak`; the
  executor restores it automatically on failed validation.
- To abort the whole approach: keep `rollout_mode=disabled`, do not run
  `--execute`; the legacy MSI/CMD path is untouched.

## Signing / AV

Binaries are **unsigned** (`identity.json` reports `signed:false`). Distribution
is **LAN-local; AV/EDR policies remain applicable** — there is no zero-detection
claim. Sign + timestamp + resubmit to AV vendors before fleet use.
