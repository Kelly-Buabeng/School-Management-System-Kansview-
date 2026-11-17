#!/usr/bin/env bash
# Owner: Agent H. Long-running loop in the backup container (no cron daemon, runs unprivileged).
#  - Nightly at BACKUP_TIME (Africa/Accra): full backup, then retention.
#  - At start-up: if the last good backup is older than 26 h (e.g. the server was off overnight), back up now.
#  - Every OFFSITE_INTERVAL_MIN minutes: off-site sync (retries itself; waits quietly while offline).
#  - Every 10 minutes: disk space check (alert below DISK_MIN_FREE_PERCENT).
set -euo pipefail
COMPONENT=scheduler
BIN="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$BIN/lib.sh"

: "${BACKUP_TIME:=01:30}"
: "${OFFSITE_INTERVAL_MIN:=15}"
: "${DISK_MIN_FREE_PERCENT:=15}"
: "${STALE_BACKUP_HOURS:=26}"

mkdir -p "$BASE_DIR" "$WAL_DIR" "$STATUS_DIR" "$STAGING_DIR"
log info "backup scheduler started (nightly at $BACKUP_TIME $TZ, off-site every ${OFFSITE_INTERVAL_MIN} min)"

running=1
trap 'running=0; log info "stopping scheduler"' TERM INT

last_success_epoch() {
  local ts
  ts="$(sed -n 's/.*"lastSuccessAt": *"\([^"]*\)".*/\1/p' "$STATUS_DIR/base-backup.json" 2>/dev/null | head -n1)"
  [[ -n "$ts" ]] && date -u -d "$ts" +%s || echo 0
}

run_backup() {
  if "$BIN/base-backup.sh"; then
    "$BIN/prune-backups.sh" >/dev/null || log error "retention run failed"
    "$BIN/offsite-sync.sh" || log warn "off-site sync after backup did not finish; will retry"
  else
    log error "nightly backup failed; will retry in 1 hour"
    next_retry=$(( $(date +%s) + 3600 ))
  fi
}

check_disk() {
  local path pct free_pct
  for path in "$BACKUP_ROOT" "$FILES_DIR"; do
    [[ -d "$path" ]] || continue
    pct="$(df -P "$path" | awk 'NR==2 {gsub("%","",$5); print $5}')"
    free_pct=$((100 - pct))
    if (( free_pct < DISK_MIN_FREE_PERCENT )); then
      log error "low disk space on $path: ${free_pct}% free"
      write_status disk failure "Low disk space on $path: only ${free_pct}% free" "\"path\":$(json_str "$path"),\"freePercent\":$free_pct"
      push_monitor DISK_PUSH_URL_FILE down "low disk: $path ${free_pct}% free"
      return
    fi
  done
  write_status disk success "Disk space OK" "\"freePercentBackupDisk\":$((100 - $(df -P "$BACKUP_ROOT" | awk 'NR==2 {gsub("%","",$5); print $5}')))"
  push_monitor DISK_PUSH_URL_FILE up "disk ok"
}

check_wal() {
  local row archived failed last_wal last_time is_failing
  local q="SELECT archived_count, failed_count, coalesce(last_archived_wal,''), coalesce(to_char(last_archived_time AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),''), coalesce(last_failed_time > coalesce(last_archived_time,'epoch'), false) FROM pg_stat_archiver"
  if row="$(psql -X -Atq -F '|' -d "$PGDATABASE" -c "$q" 2>&1)"; then
    IFS='|' read -r archived failed last_wal last_time is_failing <<<"$row"
    if [[ "$is_failing" == "t" ]]; then
      write_status wal-archiver failure "WAL archiving is failing: check that the backup disk is mounted and has space" "\"failedCount\":$failed,\"lastArchivedWal\":\"$last_wal\""
      push_monitor WAL_PUSH_URL_FILE down "WAL archiving failing"
    else
      write_status wal-archiver success "WAL archiving working" "\"archivedCount\":$archived,\"failedCount\":$failed,\"lastArchivedWal\":\"$last_wal\",\"lastArchivedAt\":\"$last_time\""
    fi
  else
    log warn "cannot query pg_stat_archiver: $row"
  fi
}

next_retry=0
last_day_done=""
# A backup already taken today (container restarted during the day) counts as done.
if (( $(last_success_epoch) > 0 )) && [[ "$(date -d "@$(last_success_epoch)" +%F)" == "$(date +%F)" ]]; then last_day_done="$(date +%F)"; fi
last_offsite=0
last_disk=0
# Catch-up after downtime.
if (( $(date +%s) - $(last_success_epoch) > STALE_BACKUP_HOURS * 3600 )); then
  log warn "last good backup is older than ${STALE_BACKUP_HOURS}h; running one now"
  run_backup
  last_day_done="$(date +%F)"
fi

while (( running )); do
  now=$(date +%s)
  today="$(date +%F)"
  if [[ "$(date +%H:%M)" > "$BACKUP_TIME" || "$(date +%H:%M)" == "$BACKUP_TIME" ]] && [[ "$last_day_done" != "$today" ]]; then
    last_day_done="$today"
    run_backup
  elif (( next_retry > 0 && now >= next_retry )); then
    next_retry=0
    run_backup
  fi
  if (( now - last_offsite >= OFFSITE_INTERVAL_MIN * 60 )); then
    last_offsite=$now
    "$BIN/offsite-sync.sh" || log warn "off-site sync did not finish; will retry"
  fi
  if (( now - last_disk >= 600 )); then
    last_disk=$now
    check_disk
    check_wal
  fi
  # sleep in short steps so `docker stop` is quick
  for _ in $(seq 1 30); do (( running )) || break; sleep 2; done
done
