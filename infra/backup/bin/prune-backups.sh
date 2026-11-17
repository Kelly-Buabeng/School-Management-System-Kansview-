#!/usr/bin/env bash
# Owner: Agent H. Retention: keep the newest backup of each of the last 7 days, 4 ISO weeks and 12 months
# (grandfather-father-son, like `restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12`).
# WAL older than the oldest kept *daily* backup is removed, so point-in-time recovery covers the last 7 days;
# weekly and monthly backups restore to the moment they were taken.
# Usage: prune-backups.sh [--dry-run]
set -euo pipefail
COMPONENT=retention
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

: "${KEEP_DAILY:=7}" "${KEEP_WEEKLY:=4}" "${KEEP_MONTHLY:=12}"
dry_run=0; [[ "${1:-}" == "--dry-run" ]] && dry_run=1

mapfile -t backups < <(ls -1 "$BASE_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r || true)
complete=()
for b in "${backups[@]}"; do [[ -f "$BASE_DIR/$b/meta.json" ]] && complete+=("$b"); done
if (( ${#complete[@]} == 0 )); then log info "no complete backups yet; nothing to prune"; exit 0; fi

declare -A keep=() days=() weeks=() months=()
oldest_daily=""
for b in "${complete[@]}"; do               # newest first
  d="${b:0:8}"
  w="$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2}" +%G-W%V)"
  m="${d:0:6}"
  if [[ -z "${days[$d]:-}" && ${#days[@]} -lt $KEEP_DAILY ]]; then days[$d]=1; keep[$b]=daily; oldest_daily="$b"; fi
  if [[ -z "${weeks[$w]:-}" && ${#weeks[@]} -lt $KEEP_WEEKLY ]]; then weeks[$w]=1; keep[$b]="${keep[$b]:-weekly}"; fi
  if [[ -z "${months[$m]:-}" && ${#months[@]} -lt $KEEP_MONTHLY ]]; then months[$m]=1; keep[$b]="${keep[$b]:-monthly}"; fi
done
keep[${complete[0]}]="${keep[${complete[0]}]:-newest}"   # never delete the newest backup

removed=0
for b in "${complete[@]}"; do
  if [[ -z "${keep[$b]:-}" ]]; then
    log info "retention: removing backup $b"
    (( dry_run )) || rm -rf "${BASE_DIR:?}/$b"
    removed=$((removed + 1))
  fi
done
# Unfinished backups (power cut during backup) older than a day.
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  log warn "retention: removing unfinished backup folder $p"
  (( dry_run )) || rm -rf "$p"
done < <(find "$BASE_DIR" -maxdepth 1 -name '.partial-*' -mmin +1440 2>/dev/null)

# WAL archive: keep everything from the oldest kept daily backup's start segment onwards.
wal_removed=0
if [[ -n "$oldest_daily" && -d "$WAL_DIR" ]]; then
  start_wal="$(sed -n 's/.*"startWal":"\([0-9A-F]\{24\}\)".*/\1/p' "$BASE_DIR/$oldest_daily/meta.json")"
  if [[ -n "$start_wal" ]]; then
    wal_removed="$(pg_archivecleanup -n -x .gz "$WAL_DIR" "$start_wal" | wc -l | tr -d ' ')"
    (( dry_run )) || pg_archivecleanup -x .gz "$WAL_DIR" "$start_wal"
    # Drop off-site "already shipped" markers for WAL that no longer exists locally.
    if [[ -d "$STAGING_DIR/wal-done" ]]; then
      for mk in "$STAGING_DIR"/wal-done/*; do
        [[ -e "$mk" ]] || continue
        [[ -f "$WAL_DIR/$(basename "$mk")" ]] || { (( dry_run )) || rm -f "$mk"; }
      done
    fi
  fi
fi

summary="kept ${#keep[@]} backups (oldest point-in-time start: ${oldest_daily:-none}), removed $removed backups and $wal_removed WAL files"
log info "$summary"
(( dry_run )) || write_status retention success "$summary" "\"kept\":${#keep[@]},\"removed\":$removed,\"walRemoved\":$wal_removed"
for b in "${complete[@]}"; do [[ -n "${keep[$b]:-}" ]] && echo "keep $b ${keep[$b]}"; done
exit 0
