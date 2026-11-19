# Backup and recovery runbook

Owner: Agent H. Part 1 is for the school administrator (no technical knowledge needed). Part 2 is for the
technician who helps in an emergency.

## Our promises (definitions)

| Term | Meaning | Target |
|---|---|---|
| **RPO local** (how much work can be lost if the server's main disk dies) | Changes are copied to the backup disk at least every 5 minutes | **15 minutes** at most |
| **RPO off-site** (how much can be lost if the whole server and backup disk are lost: fire, theft, flood) | Full backup copied off-site every night; small updates every 15 minutes when the internet works | **24 hours** at most |
| **RTO** (how long until staff can work again) | From the decision to restore until staff can sign in | **4 hours** |

## PART 1: for the administrator

### What happens automatically

- Every night at 01:30 the server makes a **full, encrypted backup** of the database and of all uploaded documents
  onto the second disk inside the server.
- All day, every change is copied to the backup disk within a few minutes.
- When the internet works, the backups are copied to **off-site storage** (another company's data centre). If the
  internet is down, the copy waits and happens later by itself.
- Old backups are tidied away: the last **7 days**, **4 weeks** and **12 months** are kept.

### How to check that backups work (once a week, 1 minute)

1. Sign in as administrator.
2. Open **Admin → System status**. (Until that screen is added to the web app, open
   `https://<school address>/api/v1/system/status` in the same browser tab after signing in; it shows the same
   information as text. `"overall": "ok"` means all is well.)
3. Check:
   - "Last backup" shows **last night's date** and the result **success**.
   - "Off-site copy" says **up to date** (or "waiting for internet" for at most a day or two).
   - Disk space: no red warning.
4. If anything is red, or the last backup is older than one day, call the technician (Part 2, "Daily problems").

If Uptime Kuma is set up, the administrator also gets an SMS or e-mail when a backup is missed.

### The recovery kit (prepare on installation day, check every term)

Keep in a **sealed envelope in the school safe**, and a copy with the proprietor (not on the school premises):

1. The **backup key** (`backup_age_identity`), printed and on an encrypted USB stick. Without it, backups cannot be opened.
2. The **data encryption key** (`master_key`). Without it, medical notes and Ghana Card numbers in a restored backup
   cannot be read.
3. The disk encryption passphrases (server disk and backup disk).
4. The off-site storage account login (provider, account e-mail, how to reset the password).
5. The technician's phone number and this runbook printed.

Write the date on the envelope. When a key changes, replace the envelope and destroy the old one.

### When something goes wrong: what to do

| Situation | What to do |
|---|---|
| Power cut | Nothing. The UPS shuts the server down safely and it starts again by itself. Wait 5 minutes after power returns, then sign in. |
| The system shows "Not sure it saved" on a payment | Open the payment list and search before entering it again. The system never saves the same payment twice when Save is clicked twice. |
| Someone deleted or changed records by mistake | Do not keep working on those records. Call the technician; he can bring the data back to a moment before the mistake (point-in-time restore). Note the time it happened as exactly as possible. |
| Server does not start / disk failure | Call the technician. Tell staff to write receipts on the paper receipt book until the system is back. |
| Server stolen or destroyed | Call the technician and the proprietor. Bring the recovery kit. A new server can be set up from the off-site copy. |

After any restore, the bursar checks that the last receipts written before the problem are in the system, and enters
any paper receipts written during the outage.

## PART 2: technical appendix

### Components

| Piece | Where | Script |
|---|---|---|
| Continuous WAL archive, gzip then **age-encrypted** (`<segment>.age`) | `/srv/sms-backup/wal/` | `infra/backup/bin/archive-wal.sh` (PostgreSQL `archive_command`, `archive_timeout=300`; runs in the `sms-postgres` image, which adds `age` to the official image; uses only the public key) |
| Nightly base backup, encrypted with age | `/srv/sms-backup/base/<YYYYMMDDTHHMMSSZ>/` | `base-backup.sh` (`pg_basebackup -Ft -z -X stream`, manifest SHA-256, uploaded-files tar). The readable `pg_basebackup` output is staged in the `backup_staging` Docker volume on the system disk and removed once encrypted; it never touches the backup disk |
| Retention 7/4/12 + WAL clean-up | | `prune-backups.sh` (keeps WAL from the oldest kept daily backup: PITR window ≈ 7 days) |
| Off-site copy (rclone, S3-compatible) | `<RCLONE_REMOTE>/base/<id>/`, `<RCLONE_REMOTE>/wal/*.age` | `offsite-sync.sh` (WAL already encrypted, copied then moved; base copied once and verified; remote retention only when ≥ 3 local backups exist) |
| Scheduler, disk check, WAL archiver check | `backup` container | `scheduler.sh` (catch-up backup if the last good one is > 26 h old) |
| Status files read by the API | `/srv/sms-backup/status/*.json` | written by all scripts; `GET /api/v1/system/status` |
| Restore | | `restore.sh` (core), `scripts/restore.sh` (Docker wrapper) |
| Drill | | `scripts/restore-drill.sh`, `infra/backup/test/retention-test.sh`, `infra/backup/test/encryption-test.sh` |

Encryption: age X25519. The server holds only the **public** key (`backup_age_recipients`), so a stolen server or
off-site account cannot decrypt old backups. The private key (`backup_age_identity`) is only needed for restore and is
not mounted in any running container.

Nothing readable is written to the backup disk (CP5-05), so a stolen backup drive gives away no child records:
WAL segments are compressed and encrypted in a pipe before they are written, and the nightly base backup is staged on
the system disk. If the public key is missing, `archive-wal.sh` fails and PostgreSQL keeps the WAL on the main disk
until it is fixed (the WAL archiver alert below). During a restore, the WAL needed for the replay is decrypted into
`<data folder>.restore-wal` on the system disk (never on the backup disk) and deleted once recovery has finished.
Segments archived as plain `.gz` before this change are still read by `restore.sh` and pruned by `prune-backups.sh`
as they age out (about 7 days). After upgrading, check that no plain copies remain on the backup disk:
`sudo find /srv/sms-backup -name '*.gz' -not -name '*.tar.gz'` should list nothing once a week has passed, and
`base/.partial-*` folders from before the upgrade can be deleted.

### Daily problems

| Symptom (status page / alert) | Check | Fix |
|---|---|---|
| Backup **failure** | `sudo docker compose logs --tail 100 backup` | Disk full? `df -h /srv/sms-backup`. Disk not mounted? `mount | grep sms-backup`. Wrong password? compare `infra/secrets/db_backup_password` with the DB role. Then `sudo scripts/backup-now.sh`. |
| WAL archiver **failure** | `sudo docker compose logs postgres | grep archive` | Usually the backup disk is missing or full, or the public key `infra/secrets/backup_age_recipients` is missing (message "age recipients not readable"). PostgreSQL keeps the WAL and retries, so nothing is lost while you fix it, but the main disk fills up: fix within a day. |
| Off-site **failure** (no copy for > 36 h) | `sudo docker compose exec backup rclone lsd "$RCLONE_REMOTE"` | Internet down, key expired, bucket full. The local backups are still fine. |
| Low disk space | `df -h`, `sudo du -sh /srv/sms-backup/*` | Add space; lower `KEEP_MONTHLY`; never delete WAL by hand. |

### Restore procedures

Always: stop and think, write down the time of the problem, keep the old data (the scripts move it aside, they never
delete it), and put the recovery kit key in `infra/secrets/backup_age_identity` (mode 0400) if it is not on the server.

1. **Latest state** (main disk replaced, database damaged):
   ```bash
   cd /opt/kansview-sms && sudo scripts/restore.sh
   ```
2. **Point in time** (undo a mistake made at 10:47):
   ```bash
   sudo scripts/restore.sh --list
   sudo scripts/restore.sh --time "2026-11-19 10:45:00+00"      # Africa/Accra is UTC+0
   ```
   Choose a time *before* the mistake. Work done after that time is lost and must be re-entered (the audit log of the
   old data, kept aside, shows what was done).
3. **Backup disk also lost / new server**: install from the deployment guide (sections 2–3, but restore the secrets
   from the recovery kit instead of generating new ones: the `master_key` must be the old one), configure
   `rclone.conf` and `RCLONE_REMOTE`, then:
   ```bash
   sudo scripts/restore.sh --from-offsite
   ```

`scripts/restore.sh` stops the stack, moves the current data aside (`…before-restore-<time>`), runs `restore.sh`
in a one-off backup container (checksum verification, decryption, files restore, recovery settings), starts PostgreSQL,
waits for WAL replay, prints checks (student/payment counts, receipt gaps, audit hash chain) and starts everything.

After restore:
- Sign in, check the latest payments and receipts with the bursar.
- `sudo docker compose exec postgres psql -U postgres -d sms -c "SELECT count(*) FROM audit.verify_chain(0)"` → 0.
- Take a fresh backup: `sudo scripts/backup-now.sh` (a restore starts a new WAL timeline).
- Delete the `before-restore` copies only after a week of normal work.

### Manual restore (if the wrapper cannot be used)

```bash
docker compose run --rm --no-deps -v /path/identity:/run/secrets/backup_age_identity:ro \
  -v kansview-sms_pgdata:/var/lib/postgresql --entrypoint bash backup -c \
  'restore.sh --target-dir /var/lib/postgresql/18/docker [--time "..."] && chown -R 999:999 /var/lib/postgresql/18/docker /var/lib/postgresql/18/docker.restore-wal'
docker compose up -d postgres && docker compose logs -f postgres   # wait for "database system is ready to accept connections"
# then remove the decrypted WAL copy:
docker compose run --rm --no-deps -v kansview-sms_pgdata:/var/lib/postgresql --entrypoint rm backup -rf /var/lib/postgresql/18/docker.restore-wal
```

### Drills

Run `scripts/restore-drill.sh` every term (results: `restore-drill-<date>.md`) and a full CP6-style rehearsal on a
spare machine once a year, timing every step against the 4-hour RTO.

`infra/backup/test/encryption-test.sh` (CP5-05) checks that nothing readable reaches the backup disk: WAL is written
only as age files, a marker value from the database or uploaded files is not readable anywhere under the backup
folder, `pg_basebackup` output is staged outside it, and a restore replays the encrypted WAL. Part A (CI) needs only
`age`; part B also needs PostgreSQL binaries and a non-root user:
`runuser -u postgres -- env PATH=$PATH PG_BIN=/usr/lib/postgresql/16/bin infra/backup/test/encryption-test.sh`.
