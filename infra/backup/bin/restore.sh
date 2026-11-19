#!/usr/bin/env bash
# Owner: Agent H. Prepares a PostgreSQL data directory (and optionally the uploaded-files folder) from a backup,
# with optional point-in-time recovery. It does NOT start PostgreSQL: the caller (scripts/restore.sh, or the drill)
# starts the server, which then replays WAL up to the target and opens for business.
#
# Usage:
#   restore.sh --target-dir DIR [--backup ID|latest] [--time "YYYY-MM-DD HH:MM:SS+00"] [--no-wal]
#              [--files-dir DIR] [--from-offsite] [--yes]
#   --target-dir   empty (or missing) folder that becomes the new PGDATA
#   --backup       nightly backup folder name (default: latest complete one)
#   --time         recover up to this moment (Africa/Accra is UTC+0). Default: replay all archived WAL (latest state).
#   --no-wal       restore exactly as at the end of the nightly backup (ignore the WAL archive)
#   --files-dir    also restore uploaded files into this folder (must be empty)
#   --from-offsite download the backup and WAL from RCLONE_REMOTE first (when the local backup disk is lost)
#   --list         show available backups and exit
set -euo pipefail
COMPONENT=restore
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

target="" backup="latest" ptime="" use_wal=1 files_target="" from_offsite=0 list=0
while (( $# )); do
  case "$1" in
    --target-dir) target="$2"; shift 2 ;;
    --backup) backup="$2"; shift 2 ;;
    --time) ptime="$2"; shift 2 ;;
    --no-wal) use_wal=0; shift ;;
    --files-dir) files_target="$2"; shift 2 ;;
    --from-offsite) from_offsite=1; shift ;;
    --list) list=1; shift ;;
    --yes) shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
require_cmd age tar gzip sha256sum

t0=$(date +%s)
if (( from_offsite )); then
  require_cmd rclone
  [[ -n "${RCLONE_REMOTE:-}" ]] || { log error "RCLONE_REMOTE is not set"; exit 1; }
  cache="$BACKUP_ROOT/restore-cache"
  mkdir -p "$cache/base" "$cache/wal-enc"
  if [[ "$backup" == "latest" ]]; then
    backup="$(rclone lsf --dirs-only "$RCLONE_REMOTE/base" | tr -d '/' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | tail -n1)"
    [[ -n "$backup" ]] || { log error "no backups found off-site at $RCLONE_REMOTE/base"; exit 1; }
  fi
  log info "downloading backup $backup from off-site storage"
  rclone copy --retries 5 "$RCLONE_REMOTE/base/$backup" "$cache/base/$backup"
  if (( use_wal )); then
    log info "downloading WAL archive from off-site storage"
    # Kept encrypted here (this cache is on the backup disk); decrypted below next to the new data folder.
    rclone copy --retries 5 "$RCLONE_REMOTE/wal" "$cache/wal-enc"
  fi
  BASE_DIR="$cache/base"; WAL_DIR="$cache/wal-enc"
fi

if (( list )); then
  for d in $(ls -1 "$BASE_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort); do
    [[ -f "$BASE_DIR/$d/meta.json" ]] && echo "$d  $(cat "$BASE_DIR/$d/meta.json")"
  done
  exit 0
fi

[[ -n "$target" ]] || { echo "--target-dir is required" >&2; exit 2; }
[[ "$backup" == "latest" ]] && backup="$(latest_backup)"
[[ -n "$backup" && -f "$BASE_DIR/$backup/meta.json" ]] || { log error "backup '$backup' not found in $BASE_DIR"; exit 1; }
src="$BASE_DIR/$backup"
if [[ -d "$target" && -n "$(ls -A "$target" 2>/dev/null)" ]]; then
  log error "target folder $target is not empty. Move the old data away first (never delete it until the restore is checked)."
  exit 1
fi
if [[ -n "$ptime" ]]; then
  date -u -d "$ptime" >/dev/null 2>&1 || { log error "cannot understand --time '$ptime' (use YYYY-MM-DD HH:MM:SS+00)"; exit 2; }
  backup_end="$(sed -n 's/.*"finishedAt":"\([^"]*\)".*/\1/p' "$src/meta.json")"
  if (( $(date -u -d "$ptime" +%s) < $(date -u -d "$backup_end" +%s) )); then
    log error "--time $ptime is before backup $backup finished ($backup_end). Choose an older backup with --backup."
    exit 2
  fi
fi

log info "verifying checksums of backup $backup"
(cd "$src" && sha256sum --check --quiet SHA256SUMS) || { log error "backup $backup is damaged (checksum mismatch)"; exit 1; }

mkdir -p "$target"; chmod 700 "$target"
log info "restoring database files into $target"
age_decrypt "$src/base.tar.gz.age" - | tar -xz -C "$target"
mkdir -p "$target/pg_wal"; chmod 700 "$target/pg_wal"
[[ -f "$src/pg_wal.tar.gz.age" ]] && age_decrypt "$src/pg_wal.tar.gz.age" - | tar -xz -C "$target/pg_wal"
[[ -f "$src/backup_manifest.age" ]] && age_decrypt "$src/backup_manifest.age" "$target/backup_manifest.restored"

if (( use_wal )); then
  # CP5-05: the WAL archive is encrypted. The segments this restore needs (from the backup's start segment on) are
  # decrypted next to the new data folder, on the server's own disk, never on the backup disk, and PostgreSQL reads
  # them from there. Neither the PostgreSQL container nor restore_command ever needs the private key.
  # Formats: <name>.age (archive-wal.sh), <name>.gz.age (older off-site copies), <name>.gz (older local archive).
  wal_abs="$(realpath -m -- "${target%/}.restore-wal")"
  under_dir "$wal_abs" "$BACKUP_ROOT" && { log error "restore folder $wal_abs must not be on the backup disk"; exit 1; }
  rm -rf "$wal_abs"; (umask 077 && mkdir -p "$wal_abs")
  start_wal="$(sed -n 's/.*"startWal":"\([0-9A-F]\{24\}\)".*/\1/p' "$src/meta.json")"
  wal_count=0
  for f in "$WAL_DIR"/*; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"; seg="${base%.age}"; seg="${seg%.gz}"
    [[ "$seg" =~ ^[0-9A-F]{8}\.history$ || "$seg" =~ ^[0-9A-F]{24}(\.[0-9A-F]{8}\.backup)?$ ]] || continue
    [[ "$seg" =~ ^[0-9A-F]{24} && -n "$start_wal" && "${seg:0:24}" < "$start_wal" ]] && continue
    case "$base" in
      *.age) age_decrypt "$f" "$wal_abs/$seg.gz" ;;
      *.gz) cp "$f" "$wal_abs/$seg.gz" ;;
      *) cp "$f" "$wal_abs/$seg" ;;
    esac
    wal_count=$((wal_count + 1))
  done
  log info "prepared $wal_count archived WAL file(s) for replay in $wal_abs"
  : > "$target/recovery.signal"
  {
    echo ""
    echo "# --- added by kansview restore.sh $(now_iso): backup $backup ---"
    echo "restore_command = 'f=$wal_abs/%f; if [ -f \"\$f.gz\" ]; then gzip -dc \"\$f.gz\" > \"%p\"; elif [ -f \"\$f\" ]; then cp \"\$f\" \"%p\"; else exit 1; fi'"
    echo "recovery_target_timeline = 'latest'"
    if [[ -n "$ptime" ]]; then
      echo "recovery_target_time = '$ptime'"
      echo "recovery_target_inclusive = true"
    fi
    echo "recovery_target_action = 'promote'"
  } >> "$target/postgresql.auto.conf"
fi

if [[ -n "$files_target" ]]; then
  if [[ -f "$src/files.tar.gz.age" ]]; then
    if [[ -d "$files_target" && -n "$(ls -A "$files_target" 2>/dev/null | grep -v "^\.before-restore-" || true)" ]]; then
      log error "files folder $files_target is not empty; move it away first"; exit 1
    fi
    mkdir -p "$files_target"
    log info "restoring uploaded files into $files_target"
    age_decrypt "$src/files.tar.gz.age" - | tar -xz -C "$files_target"
  else
    log warn "backup $backup has no uploaded-files archive"
  fi
fi

secs=$(( $(date +%s) - t0 ))
msg="Restore prepared from backup $backup in ${secs}s"
[[ -n "$ptime" ]] && msg="$msg (point in time $ptime)"
log info "$msg. Start PostgreSQL on $target to finish recovery."
mkdir -p "$STATUS_DIR" 2>/dev/null && write_status restore success "$msg" "\"backupId\":\"$backup\",\"seconds\":$secs" 2>/dev/null || true
echo "$msg"
