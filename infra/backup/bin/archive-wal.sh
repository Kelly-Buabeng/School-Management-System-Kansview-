#!/usr/bin/env bash
# Owner: Agent H. PostgreSQL archive_command: archive-wal.sh "%p" "%f"
# Runs inside the postgres container as the postgres user. Compresses one finished WAL segment and encrypts it with
# age (public key only) on the way to the backup disk: the disk only ever holds "<name>.age", never readable WAL
# (CP5-05; WAL carries full row images of names, addresses, pickups and payments).
# Must be idempotent and must only return 0 once the file is safely on disk: PostgreSQL keeps the segment and retries
# until this script succeeds, so nothing is lost while the disk or the key is missing.
set -euo pipefail
src="$1"; name="$2"
dest="${WAL_ARCHIVE_DIR:-/backups/wal}"
status_dir="${WAL_STATUS_DIR:-/backups/status}"
recipients="${WAL_AGE_RECIPIENTS_FILE:-${AGE_RECIPIENTS_FILE:-/run/secrets/backup_age_recipients}}"
final="$dest/$name.age"
# SHA-256 of the original segment, so a retry can confirm "already archived, same content" without the private key.
sums="$dest/.sha256"

[[ -d "$dest" ]] || { echo "archive-wal: backup disk folder $dest is missing (is the backup disk mounted?)" >&2; exit 1; }
[[ -s "$recipients" ]] || { echo "archive-wal: backup encryption key (age recipients) not readable at $recipients; WAL is kept by PostgreSQL until it is fixed" >&2; exit 1; }
command -v age >/dev/null || { echo "archive-wal: age is not installed in this container" >&2; exit 1; }

sum="$(sha256sum "$src" | cut -d' ' -f1)"
if [[ -f "$final" ]]; then
  # Already archived (e.g. retried after a crash). Succeed only if it is the same content.
  if [[ -f "$sums/$name" && "$(cat "$sums/$name")" == "$sum" ]]; then exit 0; fi
  echo "archive-wal: $final exists with different (or unknown) content; refusing to overwrite" >&2
  exit 1
fi
if [[ -f "$dest/$name.gz" ]]; then
  # Archived in plain gzip by an older version of this script.
  if gzip -dc "$dest/$name.gz" | cmp -s - "$src"; then exit 0; fi
  echo "archive-wal: $dest/$name.gz exists with different content; refusing to overwrite" >&2
  exit 1
fi

mkdir -p "$sums"
tmp="$dest/.$name.age.tmp.$$"
trap 'rm -f "$tmp" "$sums/.$name.tmp.$$"' EXIT
# The pipe never touches the disk: only the encrypted stream is written.
gzip -1 -c "$src" | age --encrypt --recipients-file "$recipients" --output "$tmp"
sync "$tmp"
printf '%s\n' "$sum" > "$sums/.$name.tmp.$$"
mv "$sums/.$name.tmp.$$" "$sums/$name"
mv "$tmp" "$final"
sync "$dest"
trap - EXIT

# Cheap heartbeat for the status page (never fail archiving because of it).
if [[ -d "$status_dir" ]]; then
  printf '{"component":"wal","result":"success","updatedAt":"%s","lastSuccessAt":"%s","lastFailureAt":null,"message":"WAL segment archived (encrypted)","lastSegment":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" > "$status_dir/.wal.json.$$" 2>/dev/null \
    && mv -f "$status_dir/.wal.json.$$" "$status_dir/wal.json" 2>/dev/null || true
fi
exit 0
