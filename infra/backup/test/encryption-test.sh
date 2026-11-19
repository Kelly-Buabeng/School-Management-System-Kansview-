#!/usr/bin/env bash
# Owner: Agent H. Checks that nothing readable is ever written to the backup disk (CP5-05):
#   A. archive-wal.sh writes only age-encrypted WAL, is idempotent, refuses different content, and fails (so that
#      PostgreSQL keeps the segment) when the public key is missing.            needs: age, age-keygen, gzip
#   B. with a throwaway PostgreSQL cluster archiving through archive-wal.sh: a marker value written to the database
#      never appears in any file under the backup folder; base-backup.sh stages pg_basebackup output outside the
#      backup folder (and refuses a staging folder inside it); restore.sh brings the marker back from the encrypted
#      base backup + encrypted WAL.                                              needs also: PG_BIN (initdb ... pg_basebackup)
# Usage: [PG_BIN=/usr/lib/postgresql/16/bin] infra/backup/test/encryption-test.sh [--no-db]
#        Part B runs as a non-root user (initdb refuses root), e.g. runuser -u postgres -- infra/backup/test/encryption-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
BIN="$here/../bin"
work="$(mktemp -d)"
cleanup() {
  [[ -n "${PG_BIN:-}" ]] && { "$PG_BIN/pg_ctl" -D "$work/src" -m immediate stop >/dev/null 2>&1 || true; "$PG_BIN/pg_ctl" -D "$work/restored" -m immediate stop >/dev/null 2>&1 || true; }
  rm -rf "$work"
}
trap cleanup EXIT
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
# readable <dir>: true when the marker can be read from any file under <dir>, directly or after gunzip.
readable() {
  grep -rqa 'KWAME-MENSAH-PLAINTEXT-MARKER' "$1" && return 0
  local f
  while IFS= read -r -d '' f; do gzip -dc "$f" 2>/dev/null | grep -qa 'KWAME-MENSAH-PLAINTEXT-MARKER' && return 0; done < <(find "$1" -type f -name '*.gz' -print0)
  return 1
}

age-keygen -o "$work/identity" 2>/dev/null
age-keygen -y "$work/identity" > "$work/recipients"
export AGE_RECIPIENTS_FILE="$work/recipients" AGE_IDENTITY_FILE="$work/identity"

# ------------------------------------------------------------------ A. archive-wal.sh
wal="$work/A/backups/wal"; mkdir -p "$wal" "$work/A/backups/status" "$work/A/pg_wal"
seg=000000010000000000000003
{ printf 'KWAME-MENSAH-PLAINTEXT-MARKER '; head -c 200000 /dev/zero; } > "$work/A/pg_wal/$seg"
export WAL_ARCHIVE_DIR="$wal" WAL_STATUS_DIR="$work/A/backups/status"
"$BIN/archive-wal.sh" "$work/A/pg_wal/$seg" "$seg" && ok "segment archived" || bad "archive-wal.sh failed"
[[ -f "$wal/$seg.age" && ! -e "$wal/$seg.gz" && ! -e "$wal/$seg" ]] && ok "only $seg.age is on the backup disk" || bad "unexpected files: $(ls -A "$wal")"
[[ "$(head -c 21 "$wal/$seg.age")" == "age-encryption.org/v1" ]] && ok "file is age-encrypted" || bad "file is not an age file"
readable "$work/A/backups" && bad "plaintext marker found on the backup disk" || ok "no plaintext on the backup disk"
age --decrypt --identity "$work/identity" "$wal/$seg.age" | gzip -dc | cmp -s - "$work/A/pg_wal/$seg" && ok "decrypts back to the original segment" || bad "round trip differs"
"$BIN/archive-wal.sh" "$work/A/pg_wal/$seg" "$seg" && ok "retry with the same segment succeeds (idempotent)" || bad "retry failed"
cp "$work/A/pg_wal/$seg" "$work/A/other"; echo changed >> "$work/A/other"
if "$BIN/archive-wal.sh" "$work/A/other" "$seg" 2>/dev/null; then bad "different content overwrote the archive"; else ok "different content is refused"; fi
seg2=000000010000000000000004; cp "$work/A/pg_wal/$seg" "$work/A/pg_wal/$seg2"
if WAL_AGE_RECIPIENTS_FILE="$work/missing" AGE_RECIPIENTS_FILE="$work/missing" "$BIN/archive-wal.sh" "$work/A/pg_wal/$seg2" "$seg2" 2>/dev/null; then
  bad "archived without an encryption key"
else
  [[ ! -e "$wal/$seg2.age" && -z "$(find "$wal" -name "*$seg2*" -not -path '*/.sha256/*')" ]] && ok "no key: fails and writes nothing (PostgreSQL keeps the WAL)" || bad "no key: something was written"
fi
legacy=000000010000000000000002; cp "$work/A/pg_wal/$seg" "$work/A/pg_wal/$legacy"; gzip -1 -c "$work/A/pg_wal/$legacy" > "$wal/$legacy.gz"
"$BIN/archive-wal.sh" "$work/A/pg_wal/$legacy" "$legacy" && ok "segment already archived by the old gzip format is accepted" || bad "legacy retry failed"

if [[ "${1:-}" == "--no-db" || -z "${PG_BIN:-}" ]]; then
  echo "(part B skipped: set PG_BIN to run it)"
  [[ $fail -eq 0 ]] && { echo "BACKUP ENCRYPTION TEST PASSED (part A)"; exit 0; } || exit 1
fi

# ------------------------------------------------------------------ B. cluster, base backup, restore
[[ "$(id -u)" != "0" ]] || { echo "part B must run as a non-root user (PostgreSQL refuses root)" >&2; exit 2; }
export PATH="$PG_BIN:$PATH"
port="${TEST_PORT:-5497}"
export BACKUP_ROOT="$work/B/backups" STATUS_DIR="$work/B/backups/status" FILES_DIR="$work/B/files"
export WAL_ARCHIVE_DIR="$BACKUP_ROOT/wal" WAL_STATUS_DIR="$STATUS_DIR" WAL_DIR="$BACKUP_ROOT/wal" BASE_DIR="$BACKUP_ROOT/base"
export PGHOST="$work/sock" PGPORT="$port" PGUSER=postgres PGDATABASE=sms
mkdir -p "$work/sock" "$BACKUP_ROOT"/{base,wal,status} "$FILES_DIR"
echo "Ama Owusu, guardian of KWAME-MENSAH-PLAINTEXT-MARKER" > "$FILES_DIR/note.txt"
initdb -D "$work/src" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
cat >> "$work/src/postgresql.conf" <<CONF
port = $port
listen_addresses = ''
unix_socket_directories = '$work/sock'
wal_level = replica
archive_mode = on
archive_command = '$BIN/archive-wal.sh "%p" "%f"'
max_wal_senders = 4
CONF
pg_ctl -D "$work/src" -l "$work/src.log" -w start >/dev/null
q() { psql -X -At -h "$work/sock" -p "${2:-$port}" -U postgres -d sms -c "$1"; }
psql -X -q -h "$work/sock" -p "$port" -U postgres -d postgres -c "CREATE DATABASE sms"
q "CREATE TABLE pupils (name text); INSERT INTO pupils SELECT 'KWAME-MENSAH-PLAINTEXT-MARKER before backup' FROM generate_series(1, 2000)" >/dev/null

# A staging folder on the backup disk is refused before anything is written.
if PLAIN_WORK_DIR="$BACKUP_ROOT/staging" "$BIN/base-backup.sh" >/dev/null 2>"$work/refused.log"; then bad "base-backup accepted a staging folder on the backup disk"; else
  grep -q 'must not be on the backup disk' "$work/refused.log" && ok "staging folder on the backup disk is refused" || bad "refused for another reason: $(tail -n1 "$work/refused.log")"
fi

# Record where pg_basebackup writes its readable output.
mkdir -p "$work/shim"
cat > "$work/shim/pg_basebackup" <<SHIM
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in --pgdata=*) echo "\${a#--pgdata=}" >> "$work/pgdata-args" ;; esac; done
exec "$PG_BIN/pg_basebackup" "\$@"
SHIM
chmod +x "$work/shim/pg_basebackup"
export PLAIN_WORK_DIR="$work/B/staging"
backup_id="$(PATH="$work/shim:$PATH" "$BIN/base-backup.sh" 2>"$work/backup.log" | tail -n1)"
[[ -f "$BASE_DIR/$backup_id/meta.json" ]] && ok "base backup $backup_id written" || { bad "base backup failed: $(tail -n3 "$work/backup.log")"; exit 1; }
pgdata_arg="$(cat "$work/pgdata-args")"
case "$(realpath -m "$pgdata_arg")/" in "$(realpath -m "$BACKUP_ROOT")/"*) bad "pg_basebackup wrote readable output on the backup disk ($pgdata_arg)" ;; *) ok "pg_basebackup output staged outside the backup disk" ;; esac
[[ -z "$(ls -A "$PLAIN_WORK_DIR")" ]] && ok "staging folder emptied after encryption" || bad "staging left behind: $(ls -A "$PLAIN_WORK_DIR")"
odd="$(find "$BACKUP_ROOT" -type f ! -name '*.age' ! -name '*.json' ! -name SHA256SUMS ! -path '*/wal/.sha256/*' | head -n5)"
[[ -z "$odd" ]] && ok "backup disk holds only encrypted files, checksums and status" || bad "unexpected files on the backup disk: $odd"

q "INSERT INTO pupils SELECT 'KWAME-MENSAH-PLAINTEXT-MARKER after backup' FROM generate_series(1, 2000); SELECT pg_switch_wal()" >/dev/null
for _ in $(seq 1 30); do [[ "$(q "SELECT failed_count = 0 AND archived_count > 1 FROM pg_stat_archiver")" == "t" ]] && break; sleep 1; done
sleep 2
readable "$BACKUP_ROOT" && bad "plaintext marker found on the backup disk" || ok "no plaintext from the database or files anywhere on the backup disk ($(find "$WAL_DIR" -name '*.age' | wc -l) WAL segments archived)"
pg_ctl -D "$work/src" -m fast -w stop >/dev/null

"$BIN/restore.sh" --target-dir "$work/restored" --backup "$backup_id" >/dev/null 2>"$work/restore.log" || { bad "restore.sh failed: $(tail -n3 "$work/restore.log")"; exit 1; }
under="$(realpath -m "$work/restored.restore-wal")"
case "$under/" in "$(realpath -m "$BACKUP_ROOT")/"*) bad "decrypted WAL placed on the backup disk" ;; *) ok "WAL for the replay decrypted next to the new data folder, not on the backup disk" ;; esac
pg_ctl -D "$work/restored" -l "$work/restored.log" -o "-p $((port + 1)) -c archive_mode=off" -w -t 120 start >/dev/null
for _ in $(seq 1 60); do [[ "$(q "SELECT pg_is_in_recovery()" $((port + 1)) 2>/dev/null)" == "f" ]] && break; sleep 1; done
n="$(q "SELECT count(*) FROM pupils WHERE name LIKE '%after backup'" $((port + 1)))"
[[ "$n" == "2000" ]] && ok "restore replayed the encrypted WAL (rows written after the base backup are back)" || bad "restore is missing WAL changes (got '$n' rows)"

[[ $fail -eq 0 ]] && echo "BACKUP ENCRYPTION TEST PASSED" || { echo "BACKUP ENCRYPTION TEST FAILED"; exit 1; }
