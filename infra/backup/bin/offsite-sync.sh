#!/usr/bin/env bash
# Owner: Agent H. Copies encrypted backups to off-site S3-compatible storage with rclone, when the internet is up.
#  1. Encrypts new WAL segments (age) into the staging folder and *moves* them to <remote>/wal/.
#  2. Copies every complete nightly backup folder (already encrypted) to <remote>/base/<id>/ (never re-uploads).
#  3. Mirrors local retention on the remote, but only when at least MIN_LOCAL_BACKUPS exist locally, so an empty or
#     replaced local disk can never wipe the off-site copies.
# A missing internet connection is not an error until the last success is older than OFFSITE_MAX_AGE_HOURS.
# Configuration: RCLONE_REMOTE (e.g. "offsite:kansview-sms-backups"), RCLONE_CONFIG (rclone.conf from a Docker secret).
set -euo pipefail
COMPONENT=offsite
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

: "${RCLONE_REMOTE:=}"
: "${OFFSITE_MAX_AGE_HOURS:=36}"
: "${MIN_LOCAL_BACKUPS:=3}"
: "${OFFSITE_ATTEMPTS:=4}"
: "${OFFSITE_WAL_RETENTION:=8d}"
RCLONE_FLAGS=(--retries 5 --low-level-retries 10 --retries-sleep 30s --contimeout 30s --timeout 5m --transfers 2 --checkers 4 --stats-log-level DEBUG)

if [[ -z "$RCLONE_REMOTE" ]]; then
  write_status offsite waiting "Off-site copy is not set up (RCLONE_REMOTE is empty). Backups are only on the local disk."
  log warn "RCLONE_REMOTE not configured; skipping off-site sync"
  exit 0
fi
require_cmd rclone age
mkdir -p "$STAGING_DIR/wal" "$STAGING_DIR/wal-done"

started="$(now_iso)"

# ---- 1. stage encrypted WAL (works offline; upload happens below) ----
staged=0
for f in "$WAL_DIR"/*.gz; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  [[ -e "$STAGING_DIR/wal-done/$name" ]] && continue
  age_encrypt "$f" "$STAGING_DIR/wal/.$name.age.tmp" && mv "$STAGING_DIR/wal/.$name.age.tmp" "$STAGING_DIR/wal/$name.age"
  : > "$STAGING_DIR/wal-done/$name"
  staged=$((staged + 1))
done
for f in "$WAL_DIR"/*.history "$WAL_DIR"/*.backup; do   # uncompressed timeline/backup history files, if any
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  [[ -e "$STAGING_DIR/wal-done/$name" ]] && continue
  age_encrypt "$f" "$STAGING_DIR/wal/$name.age" && : > "$STAGING_DIR/wal-done/$name"
done

# ---- reachability check ----
if ! rclone lsf --max-depth 1 "${RCLONE_FLAGS[@]:0:2}" --contimeout 20s --timeout 60s "$RCLONE_REMOTE" >/dev/null 2>&1; then
  last_ok="$(sed -n 's/.*"lastSuccessAt": *"\([^"]*\)".*/\1/p' "$STATUS_DIR/offsite.json" 2>/dev/null | head -n1)"
  age_h=999999
  [[ -n "$last_ok" ]] && age_h=$(( ( $(date -u +%s) - $(date -u -d "$last_ok" +%s) ) / 3600 ))
  if (( age_h > OFFSITE_MAX_AGE_HOURS )); then
    write_status offsite failure "Off-site storage unreachable and the last off-site copy is ${age_h}h old. Check the internet connection." "\"stagedWal\":$staged"
    push_monitor OFFSITE_PUSH_URL_FILE down "offsite unreachable for ${age_h}h"
    exit 1
  fi
  write_status offsite waiting "No internet connection to off-site storage. Will retry automatically." "\"stagedWal\":$staged"
  log warn "off-site storage unreachable; will retry on the next run"
  exit 0
fi

attempt() { # attempt <description> <command...>  retries with exponential backoff
  local desc="$1"; shift
  local n=1 delay=30
  until "$@"; do
    if (( n >= OFFSITE_ATTEMPTS )); then log error "$desc failed after $n attempts"; return 1; fi
    log warn "$desc failed (attempt $n), retrying in ${delay}s"
    sleep "$delay"; n=$((n + 1)); delay=$((delay * 2))
  done
}

errors=0
# ---- 2. upload WAL and base backups ----
attempt "WAL upload" rclone move "${RCLONE_FLAGS[@]}" --exclude '.*' "$STAGING_DIR/wal" "$RCLONE_REMOTE/wal" || errors=$((errors + 1))
uploaded=0
mapfile -t local_backups < <(ls -1 "$BASE_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort || true)
for b in "${local_backups[@]}"; do
  [[ -f "$BASE_DIR/$b/meta.json" ]] || continue
  [[ -f "$BASE_DIR/$b/.offsite-done" ]] && continue
  if attempt "upload of backup $b" rclone copy "${RCLONE_FLAGS[@]}" --exclude '.offsite-done' "$BASE_DIR/$b" "$RCLONE_REMOTE/base/$b" \
     && rclone check "${RCLONE_FLAGS[@]:0:2}" --one-way --size-only --exclude '.offsite-done' "$BASE_DIR/$b" "$RCLONE_REMOTE/base/$b" >/dev/null 2>&1; then
    : > "$BASE_DIR/$b/.offsite-done"
    uploaded=$((uploaded + 1))
    log info "backup $b copied off-site"
  else
    errors=$((errors + 1))
  fi
done

# ---- 3. remote retention (guarded) ----
remote_removed=0
complete_local=0
for b in "${local_backups[@]}"; do [[ -f "$BASE_DIR/$b/meta.json" ]] && complete_local=$((complete_local + 1)); done
if (( errors == 0 && complete_local >= MIN_LOCAL_BACKUPS )); then
  while IFS= read -r rb; do
    rb="${rb%/}"
    [[ "$rb" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || continue
    if [[ ! -d "$BASE_DIR/$rb" ]]; then
      log info "off-site retention: removing $rb"
      rclone purge "${RCLONE_FLAGS[@]:0:2}" "$RCLONE_REMOTE/base/$rb" && remote_removed=$((remote_removed + 1)) || errors=$((errors + 1))
    fi
  done < <(rclone lsf --dirs-only "$RCLONE_REMOTE/base" 2>/dev/null || true)
  rclone delete "${RCLONE_FLAGS[@]:0:2}" --min-age "$OFFSITE_WAL_RETENTION" "$RCLONE_REMOTE/wal" || errors=$((errors + 1))
fi

if (( errors > 0 )); then
  write_status offsite failure "Off-site copy had $errors problem(s); will retry automatically." "\"startedAt\":\"$started\",\"uploadedBackups\":$uploaded"
  push_monitor OFFSITE_PUSH_URL_FILE down "offsite sync had $errors errors"
  exit 1
fi
write_status offsite success "Off-site copy up to date" "\"startedAt\":\"$started\",\"finishedAt\":\"$(now_iso)\",\"uploadedBackups\":$uploaded,\"remoteRemoved\":$remote_removed,\"stagedWal\":$staged"
push_monitor OFFSITE_PUSH_URL_FILE up "offsite ok"
exit 0
