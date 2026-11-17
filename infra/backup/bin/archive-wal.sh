#!/usr/bin/env bash
# Owner: Agent H. PostgreSQL archive_command: archive-wal.sh "%p" "%f"
# Runs inside the postgres container as the postgres user. Copies one finished WAL segment, gzip-compressed,
# to the backup disk. Must be idempotent and must only return 0 once the file is safely on disk:
# PostgreSQL keeps the segment and retries until this script succeeds, so nothing is lost while the disk is missing.
set -euo pipefail
src="$1"; name="$2"
dest="${WAL_ARCHIVE_DIR:-/backups/wal}"
status_dir="${WAL_STATUS_DIR:-/backups/status}"
final="$dest/$name.gz"

[[ -d "$dest" ]] || { echo "archive-wal: backup disk folder $dest is missing (is the backup disk mounted?)" >&2; exit 1; }

if [[ -f "$final" ]]; then
  # Already archived (e.g. retried after a crash). Succeed only if it is the same content.
  if gzip -dc "$final" | cmp -s - "$src"; then exit 0; fi
  echo "archive-wal: $final exists with different content; refusing to overwrite" >&2
  exit 1
fi

tmp="$dest/.$name.gz.tmp.$$"
trap 'rm -f "$tmp"' EXIT
gzip -1 -c "$src" > "$tmp"
sync "$tmp"
mv "$tmp" "$final"
sync "$dest"
trap - EXIT

# Cheap heartbeat for the status page (never fail archiving because of it).
if [[ -d "$status_dir" ]]; then
  printf '{"component":"wal","result":"success","updatedAt":"%s","lastSuccessAt":"%s","lastFailureAt":null,"message":"WAL segment archived","lastSegment":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" > "$status_dir/.wal.json.$$" 2>/dev/null \
    && mv -f "$status_dir/.wal.json.$$" "$status_dir/wal.json" 2>/dev/null || true
fi
exit 0
