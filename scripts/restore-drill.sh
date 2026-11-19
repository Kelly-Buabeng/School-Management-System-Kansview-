#!/usr/bin/env bash
# Owner: Agent H. Restore drill on a THROWAWAY local PostgreSQL cluster (never touches the real server).
# Uses the production backup scripts (infra/backup/bin) end to end:
#   1. new cluster on DRILL_PORT with WAL archiving -> real migrations + 1,000-student fake seed + uploaded files
#   2. encrypted nightly backup (pg_basebackup + age)
#   3. "phase A" writes (payments through the ledger tables' own functions are not needed: a marker table + counters)
#      -> target time T is recorded -> "phase B" writes that must NOT survive a point-in-time restore to T
#   4. the source cluster is stopped (the "server died"), restore.sh rebuilds it to T on a second port
#   5. checks: phase A present, phase B absent, row counts and checksums equal to the snapshot at T,
#      audit hash chain intact, receipt numbers continuous, uploaded files identical
#   6. second restore to the latest state (all WAL) must contain phase B
# Prints a timing table (Markdown) at the end. Usage:
#   PG_BIN=/usr/lib/postgresql/16/bin scripts/restore-drill.sh [work-dir]
#   (run as an ordinary user: initdb refuses root, e.g. `runuser -u postgres -- env PATH=$PATH scripts/restore-drill.sh /var/tmp/drill`)
set -euo pipefail
[[ "$(id -u)" != "0" ]] || { echo "run the drill as a non-root user (PostgreSQL refuses to run as root)" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DRILL_PORT="${DRILL_PORT:-5499}"
RESTORE_PORT="${RESTORE_PORT:-5498}"
work="${1:-$(mktemp -d -t h-restore-drill-XXXX)}"
mkdir -p "$work"; work="$(cd "$work" && pwd)"
export PATH="$PG_BIN:$PATH"
BIN="$root/infra/backup/bin"

declare -a TIMES=()
t_start=0
step() { t_start=$(date +%s.%N); echo; echo "== $1"; }
done_step() { local d; d=$(echo "$(date +%s.%N) - $t_start" | bc); TIMES+=("| $1 | $(printf '%.1f' "$d") s |"); echo "   done in $(printf '%.1f' "$d") s"; }
cleanup() {
  pg_ctl -D "$work/src" -m fast stop >/dev/null 2>&1 || true
  pg_ctl -D "$work/restored" -m fast stop >/dev/null 2>&1 || true
  pg_ctl -D "$work/restored-latest" -m fast stop >/dev/null 2>&1 || true
}
trap cleanup EXIT
q() { psql -X -At -h "$work/sock" -p "$1" -U postgres -d "${3:-sms}" -c "$2"; }

export BACKUP_ROOT="$work/backups" FILES_DIR="$work/files" STATUS_DIR="$work/backups/status"
export WAL_ARCHIVE_DIR="$work/backups/wal" WAL_STATUS_DIR="$work/backups/status"
export AGE_RECIPIENTS_FILE="$work/keys/recipients" AGE_IDENTITY_FILE="$work/keys/identity"
export PLAIN_WORK_DIR="$work/staging"   # stands in for the system-disk staging volume (outside the backup folder)
export PGHOST="$work/sock" PGPORT="$DRILL_PORT" PGUSER=postgres PGDATABASE=sms
mkdir -p "$work/sock" "$work/keys" "$BACKUP_ROOT"/{base,wal,status} "$FILES_DIR"
[[ -f "$AGE_IDENTITY_FILE" ]] || { age-keygen -o "$AGE_IDENTITY_FILE" 2>/dev/null; age-keygen -y "$AGE_IDENTITY_FILE" > "$AGE_RECIPIENTS_FILE"; }

step "1. create source cluster (PostgreSQL $(postgres --version | awk '{print $3}'), port $DRILL_PORT) with WAL archiving"
initdb -D "$work/src" -U postgres --auth=trust --data-checksums -E UTF8 --locale=C.UTF-8 >/dev/null
cat >> "$work/src/postgresql.conf" <<CONF
port = $DRILL_PORT
listen_addresses = ''
unix_socket_directories = '$work/sock'
wal_level = replica
archive_mode = on
archive_command = '$BIN/archive-wal.sh "%p" "%f"'
archive_timeout = 60
max_wal_senders = 4
timezone = 'Africa/Accra'
fsync = on
synchronous_commit = on
full_page_writes = on
CONF
pg_ctl -D "$work/src" -l "$work/src.log" -w start >/dev/null
q "$DRILL_PORT" "CREATE DATABASE sms" postgres >/dev/null
done_step "Create cluster"

step "2. apply migrations and the 1,000-student fake seed; add fake uploaded files"
keyfile="$work/keys/master.key"
[[ -f "$keyfile" ]] || { printf '1:%s\nbidx:%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > "$keyfile"; chmod 600 "$keyfile"; }
dburl="postgres://postgres@localhost:$DRILL_PORT/sms?host=$work/sock"
SMS_DB_URL="$dburl" node "$root/db/tools/migrate.mjs" >/dev/null
SMS_DB_URL="$dburl" SMS_MASTER_KEY_FILE="$keyfile" node "$root/db/seeds/seed.mjs" >/dev/null
for i in $(seq 1 50); do head -c $((RANDOM * 4)) /dev/urandom > "$FILES_DIR/doc-$i.bin"; done
q "$DRILL_PORT" "CREATE TABLE public.drill_events (id bigserial PRIMARY KEY, phase text NOT NULL, at timestamptz NOT NULL DEFAULT now())" >/dev/null
# Some audit events so the hash chain has something to verify (the seed writes none).
q "$DRILL_PORT" "INSERT INTO audit.events (action, entity_type, reason) SELECT 'view', 'student', 'restore drill ' || g FROM generate_series(1, 200) g" >/dev/null
echo "   students: $(q "$DRILL_PORT" "SELECT count(*) FROM app.students")  payments: $(q "$DRILL_PORT" "SELECT count(*) FROM app.payments")  ledger entries: $(q "$DRILL_PORT" "SELECT count(*) FROM app.ledger_entries")  db size: $(q "$DRILL_PORT" "SELECT pg_size_pretty(pg_database_size('sms'))")"
done_step "Migrate + seed (1,000 students)"

step "3. nightly backup (pg_basebackup + age encryption + uploaded files)"
backup_id="$("$BIN/base-backup.sh" 2>"$work/backup.log" | tail -n1)"
echo "   backup $backup_id: $(du -sh "$BACKUP_ROOT/base/$backup_id" | cut -f1) encrypted"
done_step "Encrypted base backup"

snapshot() { # counts + checksums of the tables that matter, on port $1
  q "$1" "SELECT 'students=' || count(*) || ' md5=' || md5(string_agg(id::text || student_code, ',' ORDER BY id)) FROM app.students"
  q "$1" "SELECT 'payments=' || count(*) || ' md5=' || md5(string_agg(receipt_no || amount_pesewas || status, ',' ORDER BY receipt_no)) FROM app.payments"
  q "$1" "SELECT 'ledger=' || count(*) || ' sum=' || sum(amount_pesewas) || ' md5=' || md5(string_agg(id::text || amount_pesewas, ',' ORDER BY id)) FROM app.ledger_entries"
  q "$1" "SELECT 'audit=' || count(*) || ' last_hash=' || coalesce((SELECT hash FROM audit.events ORDER BY id DESC LIMIT 1), '-') FROM audit.events"
  q "$1" "SELECT 'drill_events=' || count(*) || ' phases=' || coalesce(string_agg(DISTINCT phase, '+'), '-') FROM public.drill_events"
}

step "4. phase A writes (kept), record target time T, then phase B writes (must disappear in the PITR)"
q "$DRILL_PORT" "INSERT INTO public.drill_events (phase) SELECT 'A' FROM generate_series(1, 5000)" >/dev/null
q "$DRILL_PORT" "INSERT INTO audit.events (action, entity_type, reason) SELECT 'update', 'student', 'phase A ' || g FROM generate_series(1, 20) g" >/dev/null
q "$DRILL_PORT" "UPDATE app.students SET preferred_name = 'DrillA' WHERE id IN (SELECT id FROM app.students ORDER BY id LIMIT 25)" >/dev/null
q "$DRILL_PORT" "SELECT pg_switch_wal()" >/dev/null
snapshot "$DRILL_PORT" > "$work/snapshot-T.txt"
sleep 2
target="$(q "$DRILL_PORT" "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 2
q "$DRILL_PORT" "INSERT INTO public.drill_events (phase) SELECT 'B' FROM generate_series(1, 777)" >/dev/null
q "$DRILL_PORT" "UPDATE app.students SET preferred_name = 'DrillB' WHERE id IN (SELECT id FROM app.students ORDER BY id DESC LIMIT 10)" >/dev/null
q "$DRILL_PORT" "SELECT pg_switch_wal()" >/dev/null
snapshot "$DRILL_PORT" > "$work/snapshot-latest.txt"
sleep 3   # let the archiver copy the last segment
echo "   target time T = $target"
echo "   WAL archived: $(q "$DRILL_PORT" "SELECT archived_count || ' segments, failed ' || failed_count FROM pg_stat_archiver")"
pg_ctl -D "$work/src" -m fast -w stop >/dev/null
echo "   source cluster stopped (simulated server loss)"
done_step "Phase A/B writes + archive"

restore_and_start() { # restore_and_start <dir> <port> [--time T]
  local dir="$1" port="$2"; shift 2
  "$BIN/restore.sh" --target-dir "$dir" --backup "$backup_id" "$@" 2>>"$work/restore.log" | tail -n1
  sed -i "s/^port = .*/port = $port/; s/^archive_mode = .*/archive_mode = off/" "$dir/postgresql.conf"
  pg_ctl -D "$dir" -l "$dir.log" -o "-p $port -c archive_mode=off" -w -t 600 start >/dev/null
  for _ in $(seq 1 600); do [[ "$(q "$port" "SELECT pg_is_in_recovery()" 2>/dev/null)" == "f" ]] && return 0; sleep 1; done
  echo "recovery did not finish" >&2; return 1
}

step "5. point-in-time restore to T (decrypt, verify checksums, replay WAL) and restore uploaded files"
restore_and_start "$work/restored" "$RESTORE_PORT" --time "$target" --files-dir "$work/files-restored"
done_step "PITR restore to T (incl. WAL replay)"

step "6. verify the restored database"
fail=0
snapshot "$RESTORE_PORT" > "$work/snapshot-restored.txt"
if diff -u "$work/snapshot-T.txt" "$work/snapshot-restored.txt"; then echo "   OK  counts and checksums equal the snapshot at T"; else echo "   FAIL snapshot differs"; fail=1; fi
[[ "$(q "$RESTORE_PORT" "SELECT count(*) FROM public.drill_events WHERE phase = 'B'")" == "0" ]] && echo "   OK  phase B (after T) is absent" || { echo "   FAIL phase B present"; fail=1; }
[[ "$(q "$RESTORE_PORT" "SELECT count(*) FROM app.students WHERE preferred_name = 'DrillA'")" == "25" ]] && echo "   OK  phase A updates present" || { echo "   FAIL phase A updates missing"; fail=1; }
broken="$(q "$RESTORE_PORT" "SELECT count(*) FROM audit.verify_chain(0)")"
[[ "$broken" == "0" ]] && echo "   OK  audit hash chain verifies ($(q "$RESTORE_PORT" "SELECT count(*) FROM audit.events") events)" || { echo "   FAIL audit chain: $broken problems"; fail=1; }
gaps="$(q "$RESTORE_PORT" "WITH n AS (SELECT substring(receipt_no from '[0-9]+$')::int AS n FROM app.payments) SELECT max(n) - min(n) + 1 - count(*) FROM n")"
[[ "$gaps" == "0" ]] && echo "   OK  receipt numbers continuous ($(q "$RESTORE_PORT" "SELECT min(receipt_no) || ' .. ' || max(receipt_no) FROM app.payments"))" || { echo "   FAIL $gaps receipt numbers missing"; fail=1; }
if diff -r "$FILES_DIR" "$work/files-restored" >/dev/null; then echo "   OK  uploaded files identical ($(find "$work/files-restored" -type f | wc -l) files)"; else echo "   FAIL uploaded files differ"; fail=1; fi
done_step "Verification queries"

step "7. restore to the latest state (all archived WAL) must include phase B"
restore_and_start "$work/restored-latest" $((RESTORE_PORT - 1))
snapshot $((RESTORE_PORT - 1)) > "$work/snapshot-restored-latest.txt"
if diff -u "$work/snapshot-latest.txt" "$work/snapshot-restored-latest.txt"; then echo "   OK  latest restore equals the source at shutdown (zero data loss with WAL)"; else echo "   FAIL latest restore differs"; fail=1; fi
done_step "Restore to latest + verify"

echo
echo "| Step | Time |"
echo "|---|---|"
printf '%s\n' "${TIMES[@]}"
echo
echo "Work folder: $work"
[[ $fail -eq 0 ]] && echo "RESTORE DRILL PASSED" || echo "RESTORE DRILL FAILED"
exit $fail
