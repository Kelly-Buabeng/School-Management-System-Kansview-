#!/usr/bin/env bash
# Owner: Agent H. Restore the production Docker stack from a backup (see docs/operations/backup-and-recovery-runbook.md).
#
#   sudo scripts/restore.sh --list                         show the backups on the backup disk
#   sudo scripts/restore.sh                                latest backup + all WAL (newest possible state)
#   sudo scripts/restore.sh --time "2026-11-19 10:45:00+00"   back to a moment (Africa/Accra = UTC+0)
#   sudo scripts/restore.sh --from-offsite                 backup disk lost: download from off-site storage first
#   options: --backup <ID>  --yes (no questions)  --skip-files (keep current uploaded files)
#
# The current database and uploaded files are NOT deleted: they are moved aside inside their volumes
# (".before-restore-<time>") so you can go back if the restore is wrong. Remove them only after checking.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/infra/compose"
project="${COMPOSE_PROJECT_NAME:-kansview-sms}"
dc() { docker compose -p "$project" "$@"; }

args=() yes=0 skip_files=0 list=0
while (( $# )); do
  case "$1" in
    --time|--backup) args+=("$1" "$2"); shift 2 ;;
    --from-offsite) args+=("$1"); shift ;;
    --yes) yes=1; shift ;;
    --skip-files) skip_files=1; shift ;;
    --list) list=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

identity="$root/infra/secrets/backup_age_identity"
[[ -r "$identity" ]] || { echo "The backup key $identity is missing. Copy it from the recovery kit (USB stick or printed copy) first." >&2; exit 1; }
run_backup() { # run a command in a one-off backup container with the restore key and both volumes mounted
  dc run --rm --no-deps -T \
    -v "$identity:/run/secrets/backup_age_identity:ro" \
    -v "${project}_pgdata:/var/lib/postgresql" \
    -v "${project}_storage:/data/storage-rw" \
    --entrypoint bash backup -c "$1"
}

if (( list )); then run_backup "restore.sh --list ${args[*]:-}"; exit 0; fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
echo "This will STOP the school system, restore the database ${args[*]:+(${args[*]}) }and start it again."
echo "The current data is kept aside as *.before-restore-$ts until you delete it."
if (( ! yes )); then read -r -p "Type RESTORE to continue: " answer; [[ "$answer" == "RESTORE" ]] || { echo "Cancelled."; exit 1; }; fi

t0=$(date +%s)
echo "[1/5] stopping services"
dc stop caddy api worker backup postgres

echo "[2/5] moving current data aside"
files_opt=""
(( skip_files )) || files_opt="--files-dir /data/storage-rw"
run_backup "set -e
  cd /var/lib/postgresql/18
  [ -d docker ] && mv docker docker.before-restore-$ts
  if [ -z '$files_opt' ]; then exit 0; fi
  mkdir -p /data/storage-rw/.before-restore-$ts
  find /data/storage-rw -mindepth 1 -maxdepth 1 ! -name '.before-restore-*' -exec mv {} /data/storage-rw/.before-restore-$ts/ \\;"

echo "[3/5] restoring (decrypt, verify checksums, prepare WAL replay)"
quoted=""
for a in "${args[@]}"; do quoted+=" $(printf '%q' "$a")"; done
run_backup "set -e
  restore.sh --target-dir /var/lib/postgresql/18/docker $files_opt $quoted
  chown -R 999:999 /var/lib/postgresql/18/docker
  chown -R 1000:1000 /data/storage-rw"

echo "[4/5] starting the database and replaying WAL (can take a few minutes)"
dc up -d postgres
for _ in $(seq 1 720); do
  state="$(dc exec -T postgres psql -U postgres -d sms -XAtc 'SELECT pg_is_in_recovery()' 2>/dev/null || true)"
  [[ "$state" == "f" ]] && break
  sleep 5
done
[[ "$state" == "f" ]] || { echo "Recovery did not finish. Check: docker compose logs postgres" >&2; exit 1; }

echo "[5/5] checks"
dc exec -T postgres psql -U postgres -d sms -XAt <<'SQL'
SELECT 'students:        ' || count(*) FROM app.students;
SELECT 'payments:        ' || count(*) || ' (last receipt ' || coalesce(max(receipt_no), '-') || ')' FROM app.payments;
SELECT 'receipt gaps:    ' || coalesce(max(n) - min(n) + 1 - count(*), 0) FROM (SELECT substring(receipt_no from '[0-9]+$')::int AS n FROM app.payments) x;
SELECT 'audit chain:     ' || CASE WHEN count(*) = 0 THEN 'OK' ELSE count(*) || ' PROBLEMS' END FROM audit.verify_chain(0);
SELECT 'last activity:   ' || coalesce(max(occurred_at)::text, '-') FROM audit.events;
SQL
dc up -d
echo "Restore finished in $(( ($(date +%s) - t0) / 60 )) min. Sign in and check the last payments before telling staff to continue."
echo "Old data kept as /var/lib/postgresql/18/docker.before-restore-$ts and storage/.before-restore-$ts (inside the Docker volumes)."
