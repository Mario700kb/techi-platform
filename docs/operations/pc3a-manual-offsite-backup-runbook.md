# PC-3A Manual Off-site Backup Runbook

## Status and scope

**Status:** COMPLETE — Manual Operation

This runbook operates the verified WD My Cloud pull of TECHI backups from
Linode. It copies from the Linode source without modifying it, does not delete
anything on WD, and is not a restore procedure.

| Item | Verified value |
|---|---|
| Linode source | `root@139.162.158.208:/opt/backups/techi/` |
| WD destination | `/shares/Backup-TechiPlatform/Linode/` |
| Manual pull script | `/shares/Backup-TechiPlatform/scripts/pc3a-pull-linode-backups.sh` |
| State directory | `/shares/Backup-TechiPlatform/pc3a-state/` |
| SSH identity on WD | `/root/.ssh/id_ed25519` |
| Local backup window | Daily at 03:00 UTC on Linode |

The script has already been verified for SSH key authentication, rsync pull,
lock behavior, incremental behavior, NAS-share logging/state, and gzip integrity
validation of the newest PostgreSQL backup.

## Preconditions

1. Run this procedure only from the WD shell as `root`.
2. Run after the Linode local backup window. Use UTC when deciding the backup
   date; WD local time is not the source of truth.
3. Do not start a second run while one is active.
4. Do not change retention, keys, SSH options, scripts, cron, WD scheduler,
   Docker, database, or source files as part of this procedure.

Check the WD backup share before starting:

```sh
df -h /shares/Backup-TechiPlatform
```

The command must show the expected data volume mounted with usable free space.
If it does not, stop and escalate; do not run the pull.

## Manual execution

Run exactly the verified script:

```sh
/shares/Backup-TechiPlatform/scripts/pc3a-pull-linode-backups.sh
printf 'PC3A_EXIT=%s\n' "$?"
```

Expected result:

- output ends with `SUCCESS latest_postgres=...`;
- `PC3A_EXIT=0`;
- the newest PostgreSQL dump is checked by `gzip -t` by the script itself.

The script uses rsync without `--delete`. It never changes the Linode source.

## Post-run verification

Read the durable status, which is stored on the WD backup share rather than the
small WD root filesystem:

```sh
cat /shares/Backup-TechiPlatform/pc3a-state/last-status
```

Expected successful fields:

```text
status=SUCCESS
utc=...
message=rsync completed; gzip verified: postgres-...
```

Review recent log lines:

```sh
tail -n 30 /shares/Backup-TechiPlatform/pc3a-state/pull.log
```

On an unchanged source, an incremental run can report only directory metadata
such as `.d..t...... ./`; this is expected and does not indicate a failed copy.

## Exit codes and operator response

| Exit code | Meaning | Operator action |
|---|---|---|
| `0` | Pull completed and newest PostgreSQL gzip check passed. | Record the successful status if operational evidence is required. |
| `10` or `11` | Backup share or required WD path is unavailable/unwritable. | Stop. Preserve output and investigate the mounted share. |
| `12` | Lock file could not be opened. | Stop and investigate share/state availability. |
| `20` | SSH source verification failed. | Stop. Do not bypass host-key checks or switch to passwords. |
| `30` | rsync failed. | Preserve log and status; do not use `--delete` or alter source/destination content. |
| `40` or `41` | PostgreSQL backup selection or gzip verification failed. | Treat as backup-integrity failure; preserve evidence and escalate. |
| `70` | Script interrupted. | Inspect status/log before any later manual retry. |
| `75` | Another pull already holds the lock. | Do not run a second instance; wait for the active run to finish. |

The lock test was verified: a concurrent execution exits `75` and leaves the
last successful status intact.

## Known limitations and intentional deferrals

- **No WD automation.** Root crontab was proven non-persistent after reboot.
  Do not add this job to root crontab.
- **Do not use `schedulerAdd.sh`.** It writes directly to `/etc/cron.d` and is
  not an approved production-safe mechanism for PC-3A.
- **WD Remote Backups is not a substitute.** Its vendor scheduler does not meet
  PC-3A's SSH-key, strict host-key, lock, status/log, and gzip-verification
  controls.
- **No inbound access to WD.** Do not open a WAN port on WD for automation.
- **No private transport exists.** Linode cannot currently reach the WD private
  SSH address, and no VPN or reverse tunnel is deployed. A Linode systemd timer
  is therefore not an implementation option until a separately approved secure
  connectivity design exists.
- **Restore proof remains open.** A successful off-site copy and gzip test do
  not prove a full recovery. Restore rehearsal is tracked separately as
  `INIT-BKP-002`.
- **NAS-only artifact.** The PC-3A inventory found one extra 12-byte file,
  `_un`, on the NAS destination and no missing source files. Its purpose is
  unknown; retain it and do not remove or normalize it without separate
  evidence and approval.

## Evidence boundary

PC-3A proves manual off-site replication and gzip readability of the newest
PostgreSQL dump. It does not prove an automated recovery point objective,
firmware-update persistence for a custom WD job, or end-to-end restoration.
