#!/usr/bin/env bash
# Owner: Agent H. Docker HEALTHCHECK for the backup container. Unhealthy when:
#  - the last good full backup is older than STALE_BACKUP_HOURS, or
#  - PostgreSQL reports that WAL archiving is failing (last failure newer than last success in pg_stat_archiver).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
: "${STALE_BACKUP_HOURS:=26}"
if [[ -f "$STATUS_DIR/base-backup.json" ]]; then   # a brand-new installation has time to take its first backup
  ts="$(sed -n 's/.*"lastSuccessAt": *"\([^"]*\)".*/\1/p' "$STATUS_DIR/base-backup.json" | head -n1)"
  [[ -n "$ts" ]] || { echo "no successful backup yet"; exit 1; }
  (( $(date -u +%s) - $(date -u -d "$ts" +%s) <= STALE_BACKUP_HOURS * 3600 )) || { echo "last good backup too old ($ts)"; exit 1; }
fi
failing="$(psql -X -Atq -d "$PGDATABASE" -c "SELECT coalesce(last_failed_time > coalesce(last_archived_time, 'epoch'), false) FROM pg_stat_archiver" 2>/dev/null || echo unknown)"
[[ "$failing" == "t" ]] && { echo "WAL archiving is failing (see postgres logs)"; exit 1; }
exit 0
