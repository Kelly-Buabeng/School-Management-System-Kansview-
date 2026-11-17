# infra/secrets

Created on the server by `scripts/generate-secrets.sh`. **Never commit these files** (the `.gitignore` here blocks them).

| File | What it is | Used by |
|---|---|---|
| `db_superuser_password` | PostgreSQL `postgres` superuser (only used inside the container) | postgres |
| `db_owner_password` | `sms_owner`, runs migrations | postgres, migrate |
| `db_app_password` | `sms_api`, used by the api and worker | postgres, api, worker |
| `db_backup_password` | `sms_backup`, replication user for backups | postgres, backup |
| `master_key` | 32 random bytes, base64: field-encryption master key (medical, Ghana Card) | api, worker |
| `session_key` | session/CSRF signing secret | api, worker |
| `backup_age_recipients` | age **public** key: backups are encrypted to it | backup |
| `backup_age_identity` | age **private** key: needed to RESTORE. Not mounted in any running container. Keep a printed copy and a USB copy in the school safe, and one with the proprietor. | restore only |
| `rclone.conf` | off-site storage credentials (S3-compatible) | backup |
| `backup_push_url`, `offsite_push_url`, `disk_push_url` | optional Uptime Kuma push URLs (empty = off) | backup |

The directory is `0700 root`; the files are `0444` so the unprivileged container users can read their bind-mounted copy.

**If the master key is lost, encrypted medical and Ghana Card fields cannot be read, even from a backup.** It is in the off-site recovery kit (see `docs/operations/backup-and-recovery-runbook.md`).
