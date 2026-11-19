#!/usr/bin/env bash
# Owner: Agent H. Take a full encrypted backup right now (e.g. before an upgrade), then copy it off-site.
#   sudo scripts/backup-now.sh
set -euo pipefail
cd "$(dirname "$0")/../infra/compose"
dc() { docker compose -p "${COMPOSE_PROJECT_NAME:-kansview-sms}" "$@"; }
dc exec -T backup base-backup.sh
dc exec -T backup prune-backups.sh >/dev/null
dc exec -T backup offsite-sync.sh || echo "Off-site copy will be retried automatically when the internet is back."
dc exec -T backup cat /backups/status/base-backup.json
