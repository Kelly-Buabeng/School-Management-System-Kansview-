#!/usr/bin/env bash
# Owner: Agent H. Load test on a fresh seeded stack (1,000 students), 15 concurrent staff, p95 < 500 ms, 0 errors.
#   bash scripts/load-test.sh            (DURATION=3m VUS=15 by default; K6=/path/to/k6 if k6 is not on PATH)
# Or against a running server: BASE_URL=https://sms.school.lan k6 run tests/load/school-day.k6.js
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
K6="${K6:-$(command -v k6 || true)}"
[[ -x "$K6" ]] || { echo "k6 not found: install it (https://grafana.com/docs/k6/latest/set-up/install-k6/) or set K6=/path/to/k6" >&2; exit 1; }
[[ -f apps/api/dist/main.js ]] || pnpm --filter @sms/api build
[[ -f apps/web/dist/index.html ]] || VITE_API_MODE=real pnpm --filter @sms/web build
export E2E_DB_NAME="${E2E_DB_NAME:-h_load}" E2E_API_PORT="${E2E_API_PORT:-3200}" E2E_WEB_PORT="${E2E_WEB_PORT:-4400}"
node tests/e2e/support/start-api.mjs > "${TMPDIR:-/tmp}/sms-load-api.log" 2>&1 & api=$!
node tests/e2e/support/serve-web.mjs > /dev/null 2>&1 & web=$!
trap 'kill $api $web 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs "http://127.0.0.1:$E2E_API_PORT/api/v1/health/ready" >/dev/null 2>&1 && break; sleep 1; done
BASE_URL="http://localhost:$E2E_WEB_PORT" "$K6" run tests/load/school-day.k6.js
