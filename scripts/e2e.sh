#!/usr/bin/env bash
# Owner: Agent H. Runs the full-stack Playwright suite in tests/e2e.
#   bash scripts/e2e.sh [playwright args...]     e.g. bash scripts/e2e.sh specs/cp3-finance.spec.ts
# Needs: PostgreSQL reachable at SMS_TEST_DB_ADMIN_URL (creates/drops database h_e2e), Playwright browsers.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# tests/ is not a pnpm workspace package: borrow the web app's Playwright install (same version as apps/web).
ln -sfn ../../apps/web/node_modules tests/e2e/node_modules
[[ -f packages/shared/dist/index.js ]] || pnpm --filter @sms/shared --filter @sms/contracts --filter @sms/db-types build
[[ -f apps/api/dist/main.js && "${E2E_REBUILD:-0}" == "0" ]] || pnpm --filter @sms/api build
[[ -f apps/web/dist/index.html && "${E2E_REBUILD:-0}" == "0" ]] || VITE_API_MODE=real pnpm --filter @sms/web build
if [[ "${1:-}" == "--typecheck" ]]; then
  exec apps/web/node_modules/.bin/tsc -p tests/e2e/tsconfig.json
fi
exec apps/web/node_modules/.bin/playwright test -c tests/e2e/playwright.config.ts --trace off "$@"
