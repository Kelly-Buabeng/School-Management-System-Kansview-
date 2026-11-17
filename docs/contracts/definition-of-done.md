# Contract: definition of done and integration checkpoints

## Definition of done (every task, every agent)

A task is done only when **all** of these are true:

1. Follows the frozen contracts (schema, OpenAPI, RBAC, conventions). Any deviation has an accepted change request.
2. Touches only paths the agent owns (`scripts/check-ownership.sh` passes).
3. TypeScript strict, `pnpm lint` and `pnpm typecheck` clean.
4. Tests written alongside the code and passing:
   - unit tests for logic (money maths, allocation, Damm, grading, positions, policy decisions);
   - integration tests against a real PostgreSQL (Testcontainers or CI service) for every endpoint touched, **including one 403 test per role that must be denied and one 404 IDOR test** for `/:id` routes;
   - coverage ≥ 80% lines for the module; **100% of finance posting, ID generation and RBAC guard code paths**.
5. Every endpoint has `x-permission`; every always-audited action writes an audit event (asserted in tests).
6. Money is integer pesewas end to end; no `number` division on money without the shared `money` helpers; no floats in DB.
7. Errors return the RFC 9457 problem format with a plain-English message; errors are logged with requestId and context; no silent `catch {}`.
8. No secrets, real personal data or real phone numbers in code, seeds, fixtures or logs. Logs mask phone numbers, Ghana Card, medical text.
9. New config is documented in `.env.example`; new behaviour visible to staff is noted for the user manual (`docs/user/_notes/<agent>.md`).
10. Dependency scan (`pnpm audit --prod`, osv-scanner) shows no high/critical issues introduced.
11. Report back: what was built, what was tested (with command and result), what is incomplete, risks, assumptions made.

## Integration checkpoints (Phase 2)

Each checkpoint is a tagged commit on the integration branch, with the evidence listed in `docs/plan/checkpoints.md`.

| # | Checkpoint | Pass criteria | Evidence |
|---|---|---|---|
| **CP1** | Contracts compile, mock frontend runs | `openapi.yaml` lints clean; TS client + Zod generated; migrations apply on empty DB and `kysely-codegen` types compile; API boots with all routes registered (stubs return 501 problem); `test:rbac-coverage` passes; web app runs against MSW mocks for every screen. | CI run green; screenshots of main screens on mocks |
| **CP2** | Onboarding → Emergency View | E2E: registrar logs in → duplicate warning shown for a matching child → admits student with 2 guardians (one existing → sibling auto-linked) → uploads birth certificate (scan passes; EICAR test file is rejected) → adds medical alert + ordered contacts → opens Emergency View on a phone viewport → taps contact → logs the call. Audit shows `create`, `emergency_view`, contact log. Concurrency test: 20 parallel admissions get 20 distinct, valid codes. BURSAR cannot read medical (403/field absent). | Playwright report; audit query output; concurrency test output |
| **CP3** | Invoice → payment → receipt → balance | E2E on seeded data: fee structure activated → invoices generated (dry run then real) with brought-forward arrears → partial payment (MoMo ref) → receipt PDF with sequential number → balance correct → overpayment creates credit that is used by next term's invoice → second payment with same MoMo ref triggers duplicate warning; override with reason works and is audited → payment reversal posts reversal entry, receipt shows REVERSED, balance restored → idempotent replay of a payment POST returns the same receipt → kill the API mid-request and verify no partial payment exists → receipt sequence report shows no gaps after 500 concurrent payment attempts → guardian balance sums all children → sibling discount needs a second approver. | Playwright + integration test reports; reconciliation report |
| **CP4** | Year-end promotion | On a copy of seeded data (1,000 students): preview whole school → exceptions (repeat, skip, withdraw, transfer out, graduate JHS3 → alumni) → arrears policy `block` stops flagged students until override reason given → commit → enrolment history intact (old rows closed, new opened) → undo within window restores the exact prior state (checksum of enrolments and statuses before/after equal) → undo after window refused. | Test report; before/after checksums |
| **CP5** | Independent security review | A separate review agent (not one of A–H) attacks the running system using the threat model and test plan: auth bypass, IDOR across all `/:id` routes, privilege escalation per role, mass assignment, SQLi/XSS/CSRF/SSRF, upload attacks (polyglot, oversized, SVG, zip bomb), rate limiting and lockout, session fixation, audit tampering (UPDATE on `audit.events` must fail), ledger tampering, secrets in repo/images, security headers, dependency CVEs. **All critical and high findings fixed and retested**; medium findings fixed or accepted in writing. | Findings report with status per item |
| **CP6** | Restore from backup | Fresh VM: install from deployment guide → restore latest off-site encrypted backup + WAL to a point in time → app runs, audit chain verifies, receipt sequence continuous, row counts match the source → measured RTO under 4 h, data loss within RPO. | Restore log with timings |

## Phase 3 handover deliverables

README, admin user manual (non-technical), one-page quick-starts for registrar and bursar, deployment guide, backup and recovery runbook, security and privacy documentation (Act 843), known limitations, v2 roadmap (mobile money gateway, parent portal, timetabling) with the list of prepared fields and interfaces.
