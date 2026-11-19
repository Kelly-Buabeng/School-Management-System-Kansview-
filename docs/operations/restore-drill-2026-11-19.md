# Restore drill, 2026-11-19

Owner: Agent H. Repeat this drill every term (and before checkpoint CP6) with `scripts/restore-drill.sh`.

## What was tested

The production backup scripts in `infra/backup/bin/` were run end to end against a **throwaway** PostgreSQL 16.15
cluster on port 5499 (work folder `/var/tmp/h-restore-drill/run2`). The shared development server was not touched.

1. New cluster with `wal_level=replica`, `archive_mode=on`, `archive_command = archive-wal.sh` (the production script),
   data checksums, `fsync`/`synchronous_commit`/`full_page_writes` on.
2. All 9 real migrations (`db/migrations`) and the fake seed: 1,068 students (1,000 active), 5,143 payments,
   24,554 ledger entries, 38 MB database; 50 fake "uploaded files"; 200 audit events.
3. Nightly backup with `base-backup.sh`: `pg_basebackup` (tar, gzip, WAL streamed, SHA-256 manifest), uploaded files
   archive, each part encrypted with **age** to the backup public key; `SHA256SUMS` and `meta.json` written.
4. Phase A writes (5,000 marker rows, 25 student updates, 20 audit events) → snapshot of counts and checksums →
   target time **T** → phase B writes (777 rows, 10 updates) that must not survive a restore to T.
5. Source cluster stopped (simulated server loss).
6. `restore.sh --time T --files-dir …`: checksum verification, decryption, WAL replay to T, files restored.
7. Second restore without `--time` (latest state).
8. Off-site path: `offsite-sync.sh` to an rclone remote (local-folder backend standing in for S3), then
   `restore.sh --from-offsite` into an empty "replacement disk".

## Results: PASSED

| Check | Result |
|---|---|
| Counts + checksums (students, payments, ledger sum and hash, audit last hash, marker rows) equal the snapshot at T | OK |
| Phase B rows (written after T) absent | OK |
| Phase A updates present | OK |
| Audit hash chain (`audit.verify_chain`) | OK, 220 events, 0 problems |
| Receipt numbers continuous | OK, RCP-000001 .. RCP-005143, 0 gaps |
| Uploaded files identical (`diff -r`) | OK, 50 files |
| Latest restore equals the source at shutdown | OK (no data loss with the WAL archive) |
| Off-site upload: base backup + 9 encrypted WAL files; remote copy verified (`rclone check`) | OK |
| Offline behaviour: unreachable remote → status `waiting`, not an error, retried next run | OK |
| Restore from off-site only (local backup disk "lost") | OK, latest state incl. phase B, 4 s |
| Retention (`infra/backup/test/retention-test.sh`, 400 simulated nights) | OK: 7 daily + weekly + monthly = 20 kept, WAL older than the oldest daily removed |

## Timings

| Step | Time |
|---|---|
| Create cluster | 0.7 s |
| Migrate + seed (1,000 students) | 4.7 s |
| Encrypted base backup (17 MB encrypted) | 2.6 s |
| Phase A/B writes + archive | 7.5 s |
| **Point-in-time restore to T, incl. WAL replay** | **2.1 s** |
| Verification queries | 0.1 s |
| Restore to latest + verify | 2.1 s |
| Restore from off-site (download + decrypt + replay) | 4 s |

Total drill run time: about 20 s.

## What this means for RPO / RTO

- **RPO local 15 min:** WAL segments are archived when full and at least every 5 minutes (`archive_timeout=300`),
  so at most about 5 minutes of work can be lost if the main disk dies; the drill's "latest" restore lost nothing.
- **RPO off-site 24 h:** the nightly backup is copied off-site the same night; WAL is shipped every 15 minutes when the
  internet is up, so in practice off-site loss is usually under 30 minutes.
- **RTO 4 h:** restoring and replaying took seconds for a 38 MB database. A school database after several years
  (estimate 1–3 GB plus uploaded files) restores in well under 30 minutes on the target hardware. The 4-hour budget is
  dominated by people and hardware: getting a replacement machine, installing it from the deployment guide
  (about 1–2 h), and finding the recovery kit. Measure the full CP6 rehearsal on a fresh VM with the real images.

## Not exercised here (environment limits)

- The `backup` container image itself could not be built in this environment (Debian apt mirror blocked), so the
  scripts ran on the host with the same PostgreSQL client tools; the API image and PostgreSQL 18 container were
  tested separately (`base-backup.sh` and `restore.sh` were also run against PostgreSQL 18.7 in Docker on 2026-11-17).
- `scripts/restore.sh` (the Docker wrapper that stops the stack, moves the old data aside and restarts) was
  shell-checked but not run end to end; do that during CP6.
- Real S3-compatible storage (an rclone local remote was used).

## How to repeat

```bash
sudo install -d -o postgres -g postgres /var/tmp/drill
sudo runuser -u postgres -- env PATH="$PATH" PG_BIN=/usr/lib/postgresql/16/bin scripts/restore-drill.sh /var/tmp/drill/run1
PATH=/usr/lib/postgresql/16/bin:$PATH infra/backup/test/retention-test.sh
```
