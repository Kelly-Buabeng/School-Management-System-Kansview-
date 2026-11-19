#!/usr/bin/env bash
# Owner: Agent H. Nightly full backup: database (pg_basebackup) + uploaded files, encrypted with age.
# Result: $BASE_DIR/<YYYYMMDDTHHMMSSZ>/{base.tar.gz.age, pg_wal.tar.gz.age, backup_manifest.age, files.tar.gz.age, SHA256SUMS, meta.json}
# Only encrypted files are written to the backup disk: pg_basebackup's readable output is staged in PLAIN_WORK_DIR
# on the system disk and removed once encrypted (CP5-05).
# The base backup is self-contained (WAL streamed in), so it can be restored on its own; together with the WAL
# archive it allows point-in-time recovery to any moment after it was taken.
set -euo pipefail
COMPONENT=base-backup
# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"
require_cmd pg_basebackup age tar gzip sha256sum

id="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BASE_DIR/$id"
work="$BASE_DIR/.partial-$id"       # on the backup disk: only ever holds encrypted files
plain="$PLAIN_WORK_DIR/base-$id"    # readable pg_basebackup output, on the system disk (CP5-05)
started="$(now_iso)"

fail() {
  log error "$1"
  write_status base-backup failure "Backup FAILED: $1" "\"startedAt\":\"$started\""
  push_monitor BACKUP_PUSH_URL_FILE down "backup failed: $1"
  rm -rf "$work" "$plain"
  exit 1
}
if under_dir "$PLAIN_WORK_DIR" "$BACKUP_ROOT" || under_dir "$BACKUP_ROOT" "$PLAIN_WORK_DIR"; then
  fail "PLAIN_WORK_DIR ($PLAIN_WORK_DIR) must not be on the backup disk ($BACKUP_ROOT): unencrypted data would be written there"
fi
mkdir -p "$BASE_DIR" "$work" "$PLAIN_WORK_DIR"
chmod 700 "$work"
(umask 077 && mkdir -p "$plain")
trap 'fail "unexpected error on line $LINENO"' ERR

write_status base-backup running "Backup in progress" "\"startedAt\":\"$started\",\"backupId\":\"$id\""
log info "starting base backup $id from $PGHOST:$PGPORT"

pg_basebackup --pgdata="$plain" --format=tar --gzip --compress=6 --wal-method=stream \
  --checkpoint=fast --label="kansview nightly $id" --manifest-checksums=SHA256 --no-password \
  || fail "pg_basebackup could not copy the database (is postgres running and the sms_backup password right?)"

# Start WAL of this backup: everything older than the oldest kept daily backup can be pruned from the archive.
start_wal="$(tar -xzOf "$plain/base.tar.gz" backup_label | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\)).*/\1/p')"
[[ -n "$start_wal" ]] || fail "could not read START WAL LOCATION from backup_label"
server_version="$(tar -xzOf "$plain/base.tar.gz" PG_VERSION | tr -d '\n')"

files_count=0
if [[ -d "$FILES_DIR" ]]; then
  files_count="$(find "$FILES_DIR" -type f | wc -l | tr -d ' ')"
  tar -C "$FILES_DIR" -cf - . | gzip -6 | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" --output "$work/files.tar.gz.age" \
    || fail "could not back up the uploaded files folder $FILES_DIR"
else
  log warn "uploaded files folder $FILES_DIR not found; backing up the database only"
fi

for f in base.tar.gz pg_wal.tar.gz backup_manifest; do
  [[ -f "$plain/$f" ]] || continue
  age_encrypt "$plain/$f" "$work/$f.age" || fail "encryption of $f failed"
done
plain_bytes="$(dir_bytes "$plain")"
rm -rf "$plain"

(cd "$work" && sha256sum -- *.age > SHA256SUMS)
size="$(dir_bytes "$work")"
finished="$(now_iso)"
cat > "$work/meta.json" <<JSON
{"backupId":"$id","startedAt":"$started","finishedAt":"$finished","startWal":"$start_wal","pgVersion":"$server_version","host":"$PGHOST","database":"$PGDATABASE","encryptedBytes":$size,"plainBytes":$plain_bytes,"uploadedFiles":$files_count,"tool":"pg_basebackup+age"}
JSON
sync -f "$work/meta.json" 2>/dev/null || sync
mv "$work" "$dest"
trap - ERR

log info "backup $id complete ($size bytes encrypted, start WAL $start_wal)"
write_status base-backup success "Backup completed" "\"startedAt\":\"$started\",\"finishedAt\":\"$finished\",\"backupId\":\"$id\",\"sizeBytes\":$size,\"startWal\":\"$start_wal\""
push_monitor BACKUP_PUSH_URL_FILE up "backup $id ok"
echo "$id"
