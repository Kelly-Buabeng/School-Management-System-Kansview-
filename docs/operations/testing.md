# Testing: CI, end-to-end and load

Owner: Agent H.

## CI (`.github/workflows/ci.yml`)

| Job | What it checks |
|---|---|
| checks | `pnpm install --frozen-lockfile` (cached), shared packages build, OpenAPI contract check, generated API types up to date, `pnpm -r typecheck`, unit tests (api, shared, web), shellcheck, Compose files and Caddyfile valid |
| integration (matrix PostgreSQL 16 and 18) | `db` tests (migrations, guards, audit chain, seed), `test:rbac-coverage`, contract test (Nest routes vs `openapi.yaml`), all API integration tests |
| web | production build, **bundle budget** (`scripts/check-bundle-size.mjs`: initial JS ≤ 250 KB gzip; currently 168 KB), Playwright smoke on mocks (`--trace off`) |
| e2e | full stack: fresh seeded PostgreSQL 18 + real API + production web build, Playwright `--trace off` (`tests/e2e`) |
| ownership (PRs) | `scripts/check-ownership.sh auto origin/<base>`: owner derived from the branch name prefix |
| security | `pnpm audit --prod --audit-level high`, osv-scanner on `pnpm-lock.yaml`, gitleaks over the whole history |
| images | builds api, web and backup images, checks they are non-root, Trivy image scans (HIGH/CRITICAL, fixed vulnerabilities fail) and Trivy config scan of `infra/` |

`.github/workflows/dependency-scan.yml` runs weekly (Monday 03:17) so new advisories are found without a push.

### Contract test (`apps/api/test/contract-routes.int-spec.ts`)

Boots the AppModule, lists every Nest route and compares with the paths/methods in `packages/contracts/openapi.yaml`.
Fails on routes that exist in code but not in the spec; prints spec operations not implemented yet. Known drift is
listed in `KNOWN_UNDOCUMENTED` with its change request (CR-0009); the test also fails when such an entry becomes stale.
Current state: 199 of 203 spec operations implemented (missing: `GET /exports/{id}`, `GET /exports/{id}/download`,
`GET /reports/class-list`, `GET /reports/enrolment`).

## End-to-end (`tests/e2e`)

```bash
bash scripts/e2e.sh                       # builds what is missing, then runs all specs
bash scripts/e2e.sh specs/cp3-finance.spec.ts
bash scripts/e2e.sh --typecheck
```

`support/start-api.mjs` drops and recreates database `h_e2e`, applies the migrations, runs the fake seed (1,000
students) and starts the built API; `support/serve-web.mjs` serves `apps/web/dist` and proxies `/api` like Caddy (same
origin, real session cookie and CSRF). Specs use real sign-in, TOTP for ADMIN and BURSAR.

| Spec | Covers |
|---|---|
| `smoke` | health through the web origin, UI sign-in, `/system/status` ADMIN-only |
| `cp2-onboarding` | duplicate warning; admission with new + existing guardian (sibling link); medical alert; ordered emergency contacts; Emergency View with `tel:` links; contact log; audit `create` + `emergency_view`; BURSAR 403 on medical; other-class TEACHER 404; 20 parallel admissions → distinct valid codes; UI Emergency View on a phone viewport |
| `cp3-finance` | partial MoMo payment, sequential receipt, receipt PDF, balance; duplicate reference 409 + audited override; idempotent replay; reversal entry and restored balance (ADMIN approval path when a cash-up is closed); overpayment credit used by the next term invoice; guardian balance sum |
| `cp4-promotion` | next year + classes, arrears policy `block`, exceptions (repeat, transfer out), blocked commit until override reasons, commit keeps history, undo restores the exact checksum, second undo refused |

Marked `test.fixme` (not yet automatable here): bursar UI flow through the MFA screen; undo after the window (needs a
clock override; covered by the API integration test); upload with ClamAV + EICAR (needs the clamav container).

Last local run (2026-11-18/19): 17 passed, 2 fixme.

## Load test (`tests/load/school-day.k6.js`)

```bash
bash scripts/load-test.sh                 # fresh seeded stack on ports 3200/4400, then k6 (DURATION=3m VUS=15)
BASE_URL=https://sms.school.lan k6 run tests/load/school-day.k6.js    # against a running server (use a copy!)
```

15 virtual staff, 1–3 s think time, mix: search 40 % (6 different users, under the 120/min search limit), student
profile 25 %, payment entry 20 % (unique `Idempotency-Key` each), attendance register save 15 %.
Thresholds: p95 < 500 ms per action, 0 failed requests, all checks pass.

### Result 2026-11-19 (development container, PostgreSQL 16, API without Docker)

| Action | p50 | p95 | p99 | max |
|---|---|---|---|---|
| search | 12 ms | 23 ms | 87 ms | 462 ms |
| student profile | 12 ms | 23 ms | 95 ms | 812 ms |
| payment entry | 21 ms | 39 ms | 275 ms | 659 ms |
| attendance save (full class register) | 39 ms | 79 ms | 264 ms | 694 ms |
| **all** | 14 ms | **52 ms** | 177 ms | 812 ms |

1,372 requests in 3 minutes, **0 errors**, 1,340/1,340 checks passed: **PASS**. Repeat on the real server hardware
before go-live (expect higher numbers on a 4-core mini PC, still well inside 500 ms).

## Backups

`scripts/restore-drill.sh` and `infra/backup/test/retention-test.sh`: see `restore-drill-2026-11-19.md`.
