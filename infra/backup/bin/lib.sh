#!/usr/bin/env bash
# Owner: Agent H. Shared helpers for the backup scripts. Sourced, not executed.
# All paths are overridable through the environment so the same scripts run inside the backup container
# and on a plain host (restore drills, CI).
set -euo pipefail

: "${BACKUP_ROOT:=/backups}"                # the local backup disk
: "${BASE_DIR:=$BACKUP_ROOT/base}"          # one folder per nightly backup: YYYYMMDDTHHMMSSZ/
: "${WAL_DIR:=$BACKUP_ROOT/wal}"            # continuous WAL archive (written by archive-wal.sh in the postgres container)
: "${STAGING_DIR:=$BACKUP_ROOT/offsite-staging}"
: "${STATUS_DIR:=$BACKUP_ROOT/status}"      # JSON status files, read by GET /api/v1/system/status
# Readable pg_basebackup output is staged here and encrypted from here, never on the backup disk (CP5-05).
# Must be on the server's own (encrypted) system disk; Compose mounts the backup_staging volume.
: "${PLAIN_WORK_DIR:=/staging}"
: "${FILES_DIR:=/data/storage}"             # uploaded files volume (read-only mount)
: "${AGE_RECIPIENTS_FILE:=/run/secrets/backup_age_recipients}"
: "${AGE_IDENTITY_FILE:=/run/secrets/backup_age_identity}"
: "${PGHOST:=postgres}" "${PGPORT:=5432}" "${PGUSER:=sms_backup}" "${PGDATABASE:=sms}"
export PGHOST PGPORT PGUSER PGDATABASE
export TZ="${TZ:-Africa/Accra}"

if [[ -z "${PGPASSWORD:-}" && -n "${PGPASSWORD_FILE:-}" && -r "${PGPASSWORD_FILE}" ]]; then
  PGPASSWORD="$(tr -d '\r\n' < "$PGPASSWORD_FILE")"
  export PGPASSWORD
fi

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() { # log <level> <message...>   one JSON line per event (Docker log driver rotates these)
  local level="$1"; shift
  printf '{"time":"%s","level":"%s","component":"%s","msg":%s}\n' "$(now_iso)" "$level" "${COMPONENT:-backup}" "$(json_str "$*")" >&2
}

json_str() { # JSON-encode a string without needing jq
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

# write_status <component> <result: success|failure|running|waiting> <message> [extra JSON members without braces]
# Keeps lastSuccessAt from the previous file so the dashboard can say "last good backup: ...".
write_status() {
  local component="$1" result="$2" message="$3" extra="${4:-}"
  mkdir -p "$STATUS_DIR"
  local file="$STATUS_DIR/$component.json" last_success="null" last_failure="null"
  if [[ -f "$file" ]]; then
    last_success="$(sed -n 's/.*"lastSuccessAt": *\("[^"]*"\).*/\1/p' "$file" | head -n1)"; last_success="${last_success:-null}"
    last_failure="$(sed -n 's/.*"lastFailureAt": *\("[^"]*"\).*/\1/p' "$file" | head -n1)"; last_failure="${last_failure:-null}"
  fi
  local ts; ts="$(now_iso)"
  [[ "$result" == "success" ]] && last_success="\"$ts\""
  [[ "$result" == "failure" ]] && last_failure="\"$ts\""
  local tmp="$file.tmp.$$"
  {
    printf '{"component":"%s","result":"%s","updatedAt":"%s","lastSuccessAt":%s,"lastFailureAt":%s,"message":%s' \
      "$component" "$result" "$ts" "$last_success" "$last_failure" "$(json_str "$message")"
    [[ -n "$extra" ]] && printf ',%s' "$extra"
    printf '}\n'
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$file"
}

# Optional Uptime Kuma "push" monitor: alerts when a push is missing or reports down.
push_monitor() { # push_monitor <url-file-env-var-name> <up|down> <message>
  local var="$1" status="$2" msg="$3" file url
  file="${!var:-}"
  [[ -n "$file" && -r "$file" ]] || return 0
  url="$(tr -d '\r\n' < "$file")"
  [[ -n "$url" ]] || return 0
  curl -fsS -m 15 --get --data-urlencode "status=$status" --data-urlencode "msg=$msg" "$url" >/dev/null 2>&1 \
    || log warn "could not reach the monitoring push URL (no internet?)"
}

require_cmd() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { log error "required command not found: $c"; exit 127; }; done; }

age_encrypt() { # age_encrypt <in|-> <out>
  [[ -r "$AGE_RECIPIENTS_FILE" ]] || { log error "backup encryption key (age recipients) not readable at $AGE_RECIPIENTS_FILE"; return 1; }
  age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" --output "$2" "$1"
}

# under_dir <path> <dir>: true when <path> is <dir> or inside it (after resolving symlinks and ..).
under_dir() {
  local p d
  p="$(realpath -m -- "$1")"; d="$(realpath -m -- "$2")"
  [[ "$p" == "$d" || "$p" == "$d/"* ]]
}

age_decrypt() { # age_decrypt <in> <out|->
  [[ -r "$AGE_IDENTITY_FILE" ]] || { log error "backup decryption key (age identity) not readable at $AGE_IDENTITY_FILE"; return 1; }
  if [[ "$2" == "-" ]]; then age --decrypt --identity "$AGE_IDENTITY_FILE" "$1"; else age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$2" "$1"; fi
}

dir_bytes() { du -sb "$1" 2>/dev/null | cut -f1; }

latest_backup() { # newest complete backup folder name, or empty
  local d
  for d in $(ls -1 "$BASE_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r); do
    [[ -f "$BASE_DIR/$d/meta.json" ]] && { echo "$d"; return 0; }
  done
  return 0
}
