# Integration checkpoints: results

Criteria: `docs/contracts/definition-of-done.md`. Each run was on a fresh checkout of `main`. PostgreSQL 16 was used locally; CI also runs PostgreSQL 18.

## Summary

| # | Checkpoint | Result | Date | `main` at |
|---|---|---|---|---|
| CP1 | Contracts compile, mock frontend runs | **PASS** | 2026-11-19 | `0c475d7` |
| CP2 | Onboarding → Emergency View | **PASS** (one criterion covered by a mocked ClamAV only; see notes) | 2026-11-19 | `0c475d7` |
| CP3 | Invoice → payment → receipt → balance | **PASS** after fix PR #29 (kill test found a stuck-retry issue; no data loss) | 2026-11-19 | `0c475d7` + #29 |
| CP4 | Year-end promotion | **PASS** | 2026-11-19 | `0c475d7` |
| CP5 | Independent security review | not started | | |
| CP6 | Restore from backup | partly done by Agent H (drill PASSED on PG16; full Docker restore still to rehearse) | | |

## CP1: contracts compile and the mock frontend runs

| Criterion | Evidence | Result |
|---|---|---|
| `openapi.yaml` valid; every operation has `operationId` and `x-permission` | `pnpm --filter @sms/contracts test` → `openapi ok: 204 operations` | pass |
| TS client generated and current | `pnpm contracts:generate` gives no diff to the committed `src/openapi.ts` | pass |
| Migrations apply on an empty DB; db-types compile | `db` Vitest: 47 passed (migrations from empty, guards, concurrency, audit chain, seed) | pass |
| Typecheck across the monorepo | `pnpm -r typecheck` → 0 errors | pass |
| API boots with all routes; routes match spec | `test/contract-routes.int-spec.ts` 2/2 (no route outside the spec) | pass |
| `test:rbac-coverage` | 509 passed (every route declares a permission matching the spec and the role matrix) | pass |
| Web app runs on MSW mocks | `apps/web` Playwright smoke on mocks: 2/2 | pass |

## CP2: onboarding → Emergency View

Full-stack e2e (`E2E_REBUILD=1 bash scripts/e2e.sh`: fresh 1,000-student seed, real API, production web build, real sign-in with TOTP): **17 passed, 0 failed, 2 skipped** (known fixmes, see CP3/CP4).

| Criterion | Evidence | Result |
|---|---|---|
| Duplicate warning for a matching child; admission with 2 guardians, one existing → sibling auto-linked; medical alert | e2e `cp2-onboarding` test 1 | pass |
| Ordered emergency contacts; Emergency View with `tel:` links; call logged; audit `create` + `emergency_view` | e2e test 2 | pass |
| BURSAR cannot read medical (403); TEACHER of another class gets 404 | e2e test 3 | pass |
| 20 parallel admissions → 20 distinct valid codes | e2e test 4, and `test/b/students.int-spec.ts` | pass |
| Emergency View on a phone viewport (registrar finds the child) | e2e test 5 (UI) | pass |
| Upload a birth certificate; EICAR rejected | Upload pipeline unit test "with ClamAV enabled: EICAR is rejected and nothing is stored; clean files pass" (**mocked clamd socket**) | pass (mock only) |

Note: ClamAV isn't in the e2e stack, so the EICAR case has only run against a mocked clamd. Running it against the real `clamav` container is for CP5/CP6 on the Docker stack.

## CP3: invoice → payment → receipt → balance

| Criterion | Evidence | Result |
|---|---|---|
| Fee structure activated; invoices generated (dry run, then real) with brought-forward arrears | `test/c` "invoice generation: dry run preview with problems, then idempotent real run"; e2e test 10 (brought forward) | pass |
| Partial MoMo payment; sequential receipt; receipt PDF; balance correct | e2e `cp3-finance` test 6 | pass |
| Overpayment → credit used by the next term's invoice | e2e test 10; `test/c` overpayment test | pass |
| Same MoMo reference → duplicate warning; override with reason, audited | e2e test 7; `test/c` | pass |
| Reversal posts a reversal entry, receipt REVERSED, balance restored; after cash-up close needs ADMIN (requester can't approve) | e2e test 9; `test/c` (2 tests) | pass |
| Idempotent replay returns the same receipt | e2e test 8; `test/c` | pass |
| **Kill the API mid-request; no partial payment** | Ad-hoc test: 60 concurrent cash payments, `kill -9` on the API mid-flight, restart, retry with the same keys. **Integrity held: 0 partial, 0 duplicates, no receipt gaps, counter = stored receipts.** **Found: 1 request whose claim was saved before the kill stayed blocked (409) for ever.** Fixed in PR #29 (stale claims taken over after 2 min). Rerun with the fix: **60/60 stored, 0 duplicates, 0 partial, no gaps.** | pass with #29 |
| **500 concurrent payment attempts → receipt sequence has no gaps** | `test/c` "100 parallel payments…" run as a one-off copy at **500**: 500 contiguous receipts, no duplicates | pass |
| Guardian balance sums all children | e2e test 11; `test/c` | pass |
| Sibling discount needs a second approver | `test/c` "adjustments: percentage discount needs a second approver; self-approval refused; bursar cannot approve" | pass |

Skipped e2e: "UI: bursar opens Record payment" (fixme: the bursar's MFA step in the UI harness). The same flow is covered by the web app's mock Playwright smoke test and by the API-level e2e tests above.

## CP4: year-end promotion

| Criterion | Evidence | Result |
|---|---|---|
| Preview with exceptions (repeat, transfer out, …) on the seeded 1,000-student school; arrears policy `block` | e2e `cp4-promotion` test 13 | pass |
| Blocked students stop the commit until override reasons are given; commit keeps history (old enrolments closed, new opened) | e2e test 14; `test/b/promotion.int-spec.ts` "commits in one transaction; history intact; replay is harmless" | pass |
| Undo within the window restores the exact prior state (checksum of enrolments and statuses equal); second undo refused | e2e test 15; `test/b` "undo restores exactly the previous state (checksum)…" | pass |
| Undo after the window refused | `test/b` "refuses undo after the window and when later records depend on it" (e2e version skipped: needs a server clock override) | pass |

## Other things found while running the checkpoints
- **Fixed, PR #30:** the API suite passed every test but exited 1. The integration-test helper pools had no error listener for connections terminated by the forced database drop at teardown. This is why the CI "integration" job was red.
- **Gotcha:** `scripts/e2e.sh` reuses existing `apps/api/dist` and `apps/web/dist` unless `E2E_REBUILD=1`. Stale builds made 3 UI tests fail on the first run (an old API build without `/system/status`, and a mock-mode web build). They passed on the rebuilt run. Follow-up 14: rebuild automatically when sources are newer.
