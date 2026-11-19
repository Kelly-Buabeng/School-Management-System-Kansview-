# Notes for the user manual (Agent H)

- **System status (administrator only):** `GET /api/v1/system/status` reports the last backup (time and result),
  off-site copy, WAL archiving, free disk space, failed background jobs (e.g. SMS) and the version, with plain-English
  "problems". There is no web screen for it yet (follow-up for Agent E: an "Admin → System status" tile); until then the
  administrator opens the address in the browser after signing in. Weekly check described in
  `docs/operations/backup-and-recovery-runbook.md`.
- **Backups happen by themselves** every night at 01:30, plus continuous copying of changes; off-site copies wait for
  the internet. Staff need to do nothing; the administrator checks weekly and keeps the recovery kit safe.
- **After a power cut** the server starts by itself; wait about 5 minutes before signing in.
- **Old sign-in sessions** are removed automatically 30 days after they end; used password-reset links after 7 days.
