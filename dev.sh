#!/usr/bin/env bash
# Kansview SMS: start everything for local development with one command.
#
#   ./dev.sh            database + migrations + seed (first run) + API + worker + web app
#   ./dev.sh --reset    drop and re-create the dev database, then seed again
#   ./dev.sh --no-seed  never seed (start with an empty school)
#   ./dev.sh --demo     web app only, on built-in demo data (no database or API needed)
#   ./dev.sh --help
#
# Ctrl-C stops everything it started. Development only: not for the school's production server
# (see docs/operations/ for the Docker deployment).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DB_NAME="${SMS_DEV_DB_NAME:-sms_dev}"
PG_HOST="${SMS_DEV_PG_HOST:-localhost}"
PG_PORT="${SMS_DEV_PG_PORT:-5432}"
PG_USER="${SMS_DEV_PG_USER:-sms}"
PG_PASS="${SMS_DEV_PG_PASSWORD:-sms}"
API_PORT="${SMS_PORT:-3000}"
WEB_PORT=5173
VAR="$ROOT/var/dev"
ADMIN_URL="postgres://$PG_USER:$PG_PASS@$PG_HOST:$PG_PORT/postgres"
DB_URL="postgres://$PG_USER:$PG_PASS@$PG_HOST:$PG_PORT/$DB_NAME"

RESET=0; SEED=1; DEMO=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --no-seed) SEED=0 ;;
    --demo) DEMO=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
command -v node >/dev/null || die "Node.js 22+ is needed (https://nodejs.org)."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || die "Node.js 22+ is needed (found $(node -v))."
command -v pnpm >/dev/null || die "pnpm is needed: run 'corepack enable' (comes with Node.js)."

PIDS=()
# Kill a process and all its descendants (each service runs under a pipeline subshell).
killtree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do killtree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}
STOPPING=0
cleanup() {
  trap - INT TERM EXIT
  STOPPING=1
  if ((${#PIDS[@]})); then
    say "Stopping…"
    for pid in "${PIDS[@]}"; do killtree "$pid"; done
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

# Run a command in the background with a coloured name prefix on every log line.
run() {
  local name="$1" colour="$2"; shift 2
  ( "$@" 2>&1 | sed -u "s/^/$(printf '\033[%sm' "$colour")[$name]$(printf '\033[0m') /" ) &
  PIDS+=("$!")
}

if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  say "Installing dependencies (pnpm install)…"
  pnpm install --frozen-lockfile
fi
say "Building shared packages…"
pnpm --filter @sms/shared --filter @sms/contracts --filter @sms/db-types build >/dev/null

# ---------------------------------------------------------------- demo mode
if ((DEMO)); then
  say "Demo mode: web app on built-in demo data at http://localhost:$WEB_PORT (no database or API)."
  say "Demo sign-ins are listed in apps/web/README.md. Press Ctrl-C to stop."
  run web 35 env VITE_API_MODE=mock pnpm --filter @sms/web dev --port "$WEB_PORT" --strictPort
  wait
  exit 0
fi

# ---------------------------------------------------------------- PostgreSQL
pg_up() { node -e "const c=new (require('$ROOT/db/node_modules/pg').Client)({connectionString:process.argv[1]});c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" "$ADMIN_URL" 2>/dev/null; }

if pg_up; then
  say "Using PostgreSQL at $PG_HOST:$PG_PORT."
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  say "Starting PostgreSQL 18 in Docker (container sms-dev-postgres, data kept in volume sms-dev-pgdata)…"
  if docker ps -a --format '{{.Names}}' | grep -qx sms-dev-postgres; then
    docker start sms-dev-postgres >/dev/null
  else
    docker run -d --name sms-dev-postgres -p "$PG_PORT:5432" \
      -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" -e TZ=Africa/Accra \
      -v sms-dev-pgdata:/var/lib/postgresql postgres:18-alpine >/dev/null \
      || die "Could not start the PostgreSQL container (is port $PG_PORT free?)."
  fi
  for _ in $(seq 1 60); do pg_up && break; sleep 1; done
  pg_up || die "PostgreSQL in Docker did not become ready."
else
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -z "$PG_BIN" ] && command -v pg_ctl >/dev/null && PG_BIN="$(dirname "$(command -v pg_ctl)")"
  [ -n "$PG_BIN" ] || die "No PostgreSQL found. Install PostgreSQL 16+ or Docker, or set SMS_DEV_PG_HOST/PORT/USER/PASSWORD to an existing server."
  [ "$(id -u)" = 0 ] && die "Local PostgreSQL can't run as root. Use Docker, an existing server, or run this as a normal user."
  PGDATA="$VAR/pgdata"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    say "Creating a local PostgreSQL cluster in var/dev/pgdata…"
    mkdir -p "$VAR"
    pwfile="$(mktemp)"; printf '%s' "$PG_PASS" > "$pwfile"
    "$PG_BIN/initdb" -D "$PGDATA" -U "$PG_USER" --pwfile="$pwfile" -A scram-sha-256 -E UTF8 >/dev/null
    rm -f "$pwfile"
  fi
  say "Starting local PostgreSQL ($PG_BIN) on port $PG_PORT…"
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$VAR/postgres.log" -o "-p $PG_PORT -k /tmp" -w start >/dev/null
  STOP_PG="$PG_BIN/pg_ctl -D $PGDATA -m fast stop"
  trap 'cleanup; $STOP_PG >/dev/null 2>&1 || true' INT TERM EXIT
  pg_up || die "Local PostgreSQL did not become ready (see var/dev/postgres.log)."
fi

psqlq() { node -e "
const {Client}=require('$ROOT/db/node_modules/pg');const c=new Client({connectionString:process.argv[1]});
c.connect().then(()=>c.query(process.argv[2])).then(r=>{if(r.rows&&r.rows[0])console.log(Object.values(r.rows[0])[0]);return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})" "$@"; }

if ((RESET)); then
  say "Resetting database $DB_NAME…"
  psqlq "$ADMIN_URL" "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null
fi
if [ "$(psqlq "$ADMIN_URL" "SELECT count(*) FROM pg_database WHERE datname = '$DB_NAME'")" = "0" ]; then
  say "Creating database $DB_NAME…"
  psqlq "$ADMIN_URL" "CREATE DATABASE $DB_NAME" >/dev/null
fi

say "Applying migrations…"
SMS_DB_URL="$DB_URL" node db/tools/migrate.mjs | sed 's/^/    /'

# ---------------------------------------------------------------- dev secrets
mkdir -p "$VAR/secrets" "$VAR/storage"
chmod 700 "$VAR/secrets"
# The seed and the API must share the same master key (encrypted MFA secrets, Ghana Card, medical notes).
MASTER_KEY="$ROOT/db/.dev-master.key"
SESSION_KEY="$VAR/secrets/session.key"
[ -f "$SESSION_KEY" ] || { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$SESSION_KEY"; chmod 600 "$SESSION_KEY"; }

if ((SEED)) && [ "$(psqlq "$DB_URL" "SELECT count(*) FROM app.students")" = "0" ]; then
  say "Seeding fake Ghanaian school data (1,000 students; about a minute)…"
  SMS_DB_URL="$DB_URL" node db/seeds/seed.mjs | tail -1 | sed 's/^/    /'
fi
[ -f "$MASTER_KEY" ] || node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('base64'), {mode: 0o600})" "$MASTER_KEY"
chmod 600 "$MASTER_KEY"

# ---------------------------------------------------------------- build + start
say "Building the API…"
pnpm --filter @sms/api build >/dev/null

COMMON_ENV=(
  SMS_NODE_ENV=development SMS_DB_URL="$DB_URL" SMS_PORT="$API_PORT"
  SMS_MASTER_KEY_FILE="$MASTER_KEY" SMS_SESSION_SECRET_FILE="$SESSION_KEY"
  SMS_FILE_STORAGE_DIR="$VAR/storage" SMS_SMS_PROVIDER=mock SMS_CLAMAV_ENABLED=false
)
run api    32 env "${COMMON_ENV[@]}" SMS_PROCESS_ROLE=api    node apps/api/dist/main.js
run worker 33 env "${COMMON_ENV[@]}" SMS_PROCESS_ROLE=worker node apps/api/dist/worker.js

for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$API_PORT/api/v1/health/ready" >/dev/null 2>&1 && break; sleep 1
done
curl -fsS "http://localhost:$API_PORT/api/v1/health/ready" >/dev/null 2>&1 || die "The API did not become ready (see the [api] lines above)."

run web 35 env VITE_API_MODE=real SMS_API_ORIGIN="http://localhost:$API_PORT" pnpm --filter @sms/web dev --port "$WEB_PORT" --strictPort

cat <<EOF

$(printf '\033[1;32m')Kansview SMS is running.$(printf '\033[0m')

  Web app      http://localhost:$WEB_PORT
  API          http://localhost:$API_PORT/api/v1   (health: /api/v1/health/ready)
  Database     $DB_URL

  Dev sign-ins (development only; full list in db/seeds/README.md):
    admin  / Kansview-Admin-Dev-2026!    (MFA code: run  pnpm --filter @sms/api exec node -e "console.log(require('otplib').authenticator.generate('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'))")
    bursar / Kansview-Bursar-Dev-2026!   (MFA secret KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU)

  SMS messages are not really sent (mock provider). Press Ctrl-C to stop everything.

EOF

wait -n "${PIDS[@]}" || true
((STOPPING)) || warn "One of the processes stopped; shutting the rest down."
