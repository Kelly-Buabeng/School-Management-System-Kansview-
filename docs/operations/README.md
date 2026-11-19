# Operations

Owner: Agent H.

| Document | For |
|---|---|
| [deployment-guide.md](deployment-guide.md) | Installing the server: on-premise mini server or cloud VM, LUKS, firewall, NTP/time zone, first run, TLS, UPS (NUT) |
| [backup-and-recovery-runbook.md](backup-and-recovery-runbook.md) | Administrator checklist, recovery kit, RPO/RTO, technical restore procedures |
| [monitoring-and-alerts.md](monitoring-and-alerts.md) | Health checks, status endpoint, Uptime Kuma, disk/backup alerts, housekeeping jobs |
| [upgrade-procedure.md](upgrade-procedure.md) | Upgrading and rolling back |
| [testing.md](testing.md) | CI, end-to-end tests, load test results |
| [restore-drill-2026-11-19.md](restore-drill-2026-11-19.md) | Latest restore drill with timings |

## Targets

- **RPO** 15 minutes local, 24 hours off-site. **RTO** 4 hours.
- Load: 1,000 students, 15 concurrent staff, p95 < 500 ms, zero errors.

## Local development vs. deployment

- **Developers:** `./dev.sh` at the repository root starts everything for development with one command
  (database, migrations, seed on first run, API, worker, web app). `./dev.sh --demo` runs the web app on demo data.
  Optionally `docker compose -f infra/compose/docker-compose.dev.yml up -d` gives a PostgreSQL 18 container on port
  5433 (point `./dev.sh` at it with `SMS_DEV_PG_PORT=5433`).
- **School server:** `infra/compose/docker-compose.yml` only (see the deployment guide). Never run `./dev.sh` there.
