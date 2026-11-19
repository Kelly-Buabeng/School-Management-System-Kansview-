# Monitoring and alerts

Owner: Agent H.

## Signals

| Signal | Source | Healthy | Alert when |
|---|---|---|---|
| App up | `GET /api/v1/health/live` | 200 | 2 failures in a row |
| App ready (DB reachable) | `GET /api/v1/health/ready` (through Caddy: `https://<SMS_DOMAIN>/api/v1/health/ready`) | 200 | 503 or no answer for 2 min |
| Container health | `docker compose ps` (Dockerfile/Compose healthchecks for caddy, api, worker, postgres, backup) | `healthy` | `unhealthy` |
| Last full backup | `backup` container push → Uptime Kuma; `/system/status` → `backup.lastBackupAt` | < 26 h old, result success | missing push for 26 h, or `down` push |
| WAL archiving | `pg_stat_archiver` (checked every 10 min by the backup scheduler; backup container healthcheck) | no failures newer than the last success | failing |
| Off-site copy | `offsite.json` status, `OFFSITE_PUSH_URL_FILE` push | success, or waiting < 36 h | failure |
| Disk space | scheduler `df` every 10 min (backup disk + data volume); `/system/status` → `disks` | ≥ 15 % free | < 15 % free |
| Queue backlog | `/system/status` → `queue.pending`, `queue.failed` (pg-boss) | failed = 0 | failed jobs in the last 7 days |
| Audit trail integrity | worker job `audit-verify-chain` daily at 03:47; `/system/status` → `auditChain`; worker log `AUDIT CHAIN BROKEN` | `intact`, checked < 26 h ago | `broken` (possible tampering), or no check for 26 h |
| Slow queries | PostgreSQL log (`log_min_duration_statement = 500ms`) | rare | many per hour |
| TLS certificate | Uptime Kuma HTTPS monitor (certificate expiry notification) | > 14 days | < 14 days (cloud only; the LAN CA renews itself) |

## The admin status page

`GET /api/v1/system/status` (permission `system:read`, ADMIN only) returns:

```json
{
  "version": "1.0.0", "checkedAt": "…", "overall": "ok | warning | problem",
  "problems": ["plain-English sentences for the administrator"],
  "backup": { "lastBackupAt": "…", "lastBackupResult": "success", "backupOverdue": false, "components": [ … ] },
  "disks": [{ "label": "data", "freePercent": 71, "low": false }, { "label": "backup", … }],
  "queue": { "available": true, "pending": 0, "failed": 0 },
  "auditChain": { "result": "intact | broken | unknown", "checkedAt": "…", "headId": 812, "count": 812, "overdue": false, "problems": [] },
  "smsProvider": "mock"
}
```

`overall` is `problem` for a failed/overdue backup, a failing WAL archiver or off-site copy, low disk or failed jobs;
`warning` while the off-site copy waits for the internet or the queue schema is not created yet.

`auditChain` comes from `<storage>/audit-anchors/latest.json`, written by the worker's daily audit hash-chain check
(CP5-04). The file holds the newest audit event id, its hash and the event count, outside PostgreSQL, so deleting
the newest audit events is noticed at the next check. A `broken` result or a check older than 26 hours makes
`overall` a `problem`; `unknown` (the job has not run yet on a new server) does not. If the chain is broken: do not
restore or "fix" anything yet, keep every backup, tell the headteacher, and follow the breach procedure in
`docs/security/data-protection/`. `anchors.jsonl` next to it is the daily history; keep it with the backups.

Optional Uptime Kuma push: create a **Push** monitor "Audit trail" (heartbeat interval 26 h), save its URL in a
file mounted into the worker and set `SMS_AUDIT_PUSH_URL_FILE` to that path; the job pushes `up` when intact and
`down` when broken.

## Uptime Kuma setup (profile `monitoring`)

1. `sudo docker compose --profile monitoring up -d uptime-kuma`, open it through an SSH tunnel
   (`ssh -L 3001:127.0.0.1:3001 admin@server`, then `http://localhost:3001`) and create the admin account.
2. Monitors:
   - **HTTP(s)** `https://<SMS_DOMAIN>/api/v1/health/ready`, every 60 s (LAN: tick "Ignore TLS error" or import the
     Caddy root certificate).
   - **Push** monitor "Nightly backup", heartbeat interval 26 h → copy its push URL into
     `infra/secrets/backup_push_url`.
   - **Push** monitors "Off-site copy" (interval 36 h → `offsite_push_url`) and "Disk space" (interval 30 min →
     `disk_push_url`).
   - **Docker container** monitors are optional (needs the Docker socket; not mounted by default for security).
3. Notifications: e-mail (SMTP) and/or an SMS gateway to the administrator and the technician. When the internet is
   down, alerts are delayed; the admin status page still works on the LAN.
4. `sudo docker compose up -d backup` after filling the push URL files.

## Logs

- All services log JSON to stdout; Docker rotates them (10 MB × 5). `sudo docker compose logs --since 1h api worker`.
- The api masks phone numbers, Ghana Card and medical text in logs; never paste logs with personal data into chats.
- The audit trail of who viewed or changed a child's record is in the database (`/audit-events`), not in the logs.

## Housekeeping jobs (worker, hourly)

| Data | Kept for | How |
|---|---|---|
| `app.user_sessions` | 30 days after expiry or revocation | `DELETE` by the worker |
| `app.password_reset_tokens` | 7 days after use or expiry | `DELETE` by the worker |
| `app.login_attempts` | 180 days | `app.purge_login_attempts(interval)` (SECURITY DEFINER, CR-0009) once Agent A adds it; until then the worker logs one warning and keeps the rows |
| pg-boss jobs | 14 days (queue setting) | pg-boss maintenance in the worker |
| Backups | 7 daily / 4 weekly / 12 monthly | `prune-backups.sh` |
