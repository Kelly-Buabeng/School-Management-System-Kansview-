# Phase 1 plan: agent task breakdown

All agents start at the same time against the frozen contracts. Before launch the Orchestrator commits a **scaffold** (pnpm workspace, NestJS bootstrap, `common/`, `packages/shared`, generated contract types, and typed stubs for every cross-agent interface listed in `conventions.md`), so nobody waits on anyone else.

## Agent A: Database (`db/`, `packages/db-types/`)

- SQL migrations for every table in `schema.md`: constraints, partial unique indexes, exclusion constraints, trigram + full-text indexes for search.
- Functions: `next_student_code` (row-locked counter + Damm check digit), `next_doc_no` (gap-free), append-only triggers, payment status guard, student code immutability, audit hash chain.
- DB roles and grants (`sms_app` has no UPDATE/DELETE on finance or audit tables).
- `v_sibling_links` view, `mv_student_balances` materialised view.
- Import staging schema.
- Seed generator: realistic fake Ghanaian data (Akan, Ewe, Ga, Dagbani, Hausa names, `+23324…` style fake numbers in a reserved test range, Accra/Kumasi/Tema addresses), 1,000 students across all levels, ~650 guardian families with siblings, staff, 2 academic years, fee structures, sample payments.
- Tests: pgTAP for constraints, triggers (UPDATE on ledger fails), concurrency test for ID and receipt counters (parallel sessions), migration up from empty.
- Deliverable for CP1: migrations apply, types generated.

## Agent B: Backend core (`apps/api/src/modules/{settings,academic-setup,students,guardians,emergency,enrolment,promotion,staff,attendance,academics,welfare,withdrawals,search,dashboard}`)

- All endpoints in those OpenAPI tags with role scoping (TEACHER sees own classes only) via Agent D's guards.
- Admission transaction (code, enrolment, guardians, medical, contacts) and duplicate detection (trigram name similarity ≥ 0.6 + same DOB + any shared guardian phone).
- Emergency View, contact log.
- Enrolment history (close/open, never overwrite), capacity checks.
- Promotion engine: preview, exceptions, arrears policy (calls `LedgerService`), commit in one transaction, undo within window with dependency checks.
- Withdrawals with clearance checklist; transfer letter via `PdfService`.
- Attendance with absence SMS via `NotificationService` (once per student per day).
- Scores, grading, positions with ties, report-card data (PDF via F).
- Global search (p95 < 300 ms at 1,000 students), dashboard widgets.
- `ImportTarget` implementation for Agent G.
- Tests: integration per endpoint incl. role denials and IDOR; promotion undo checksum test.

## Agent C: Finance (`apps/api/src/modules/finance/`)

- Fee items, fee structures (draft → active, immutable once active), optional items.
- Invoice generation (dry run, idempotent, skips already invoiced, brought-forward snapshot from ledger).
- Manual payment recording: one transaction for payment + receipt number + allocations + ledger; automatic oldest-first allocation by fee-item priority; overpayment → credit; credit auto-applied to new invoices; duplicate method+reference warning with audited override; `Idempotency-Key` handling.
- Reversals (same day by bursar; after cash-up close needs admin approval), re-allocation by appending rows, invoice void.
- Adjustments with maker-checker approval.
- `LedgerService` (balance per student, per guardian, per class, school).
- Cash-up open/close with variance.
- Reports: collections, aging, defaulters, daily cash-up, reconciliation (gap check); JSON/XLSX/PDF.
- **No gateway code.** Payment table v2 fields left unused and documented.
- Tests: property-based tests (fast-check) that ledger balance = invoices − payments − adjustments for random sequences; concurrency test for receipts; crash-mid-transaction test; idempotent replay.

## Agent D: Security (`apps/api/src/security/`, `apps/api/src/modules/{auth,users,audit,data-protection}`, `docs/security/`)

- Threat model (STRIDE per component and data flow) and security test plan.
- Auth: Argon2id, password policy (min 12 chars, breached-password list check offline, no forced rotation), lockout (5 failures → 15 min, progressive), sessions (idle 30 min, absolute 12 h, rotate on login/MFA), TOTP with recovery codes, mandatory for ADMIN/BURSAR, password reset (email token + admin reset), force logout.
- RBAC guard, permission decorator, scope service, field policy serialisers, CI check that every route declares a permission.
- Field encryption (AES-256-GCM envelope, key rotation command), blind index.
- Audit interceptor + `AuditService` + hash chain verification job.
- CSRF (synchroniser token), security headers + CSP via Caddy and Helmet, CORS locked, rate limits (login, search, exports), request size limits.
- Upload pipeline: allow-list by magic bytes, size limits, image re-encode (strips EXIF/GPS), PDF checks, ClamAV scan, quarantine.
- Data protection (Act 843): processing register, lawful basis per data category, privacy notice text for admission forms, retention schedule, data subject request process (endpoints + procedure), breach response procedure (incl. notifying the Data Protection Commission), DPC registration note.
- Tests: auth flows, lockout, session expiry, every role × permission matrix test generated from `rbac.md`, crypto round-trip, audit tamper test.

## Agent E: Frontend (`apps/web/`)

- React app built from the generated client; MSW mocks first, real API later behind a flag.
- Screens: login + MFA, dashboard, global search (keyboard shortcut `/`), student list/profile tabs, admission wizard with duplicate warning, guardian screens, **Emergency View** (big text, tap-to-call, works on a phone), classes and roll, **promotion wizard** (preview → exceptions → confirm → undo), attendance register (one tap per child), score entry grid, report cards, staff, withdrawals, finance (fee structures, invoice generation with preview, **payment entry** with duplicate warning and "not sure it saved" handling, receipts, ledger, adjustments approvals, cash-up, reports), messages, imports (upload → preview → fix → commit), settings, users, audit log.
- Money formatting from pesewas only via shared helper; dates in Africa/Accra.
- Performance: initial JS < 250 KB gzipped, lazy routes, works on a 2 GB RAM laptop and a phone over 3G. Accessibility: keyboard use, labels, WCAG AA contrast.
- Tests: component tests (Vitest + Testing Library), Playwright flows shared with Agent H.

## Agent F: Notifications and documents (`apps/api/src/modules/{notifications,documents,files}`, worker jobs)

- `MessageProvider` interface, mock provider (writes to delivery log; can simulate failures), one real Ghana SMS adapter behind config (pending open question 4), WhatsApp interface stub.
- Templates with placeholder allow-list, GSM-7/Unicode segment counting, cost estimate, approval flow for bulk, pg-boss queue with retries (exponential backoff, max 5), quiet hours (no non-emergency SMS 20:00–07:00), opt-out handling, delivery log.
- `PdfService` with pdfmake templates: receipt (A5 and 80 mm thermal), fee statement, arrears notice, invoice, report card, transfer letter; school logo; "COPY" and "REVERSED" watermarks.
- `FileStore` (local volume, S3-compatible adapter).
- Tests: template rendering, retry behaviour, PDF snapshot tests (text extraction), queue survives restart.

## Agent G: Data import (`apps/api/src/modules/imports/`, `docs/import-templates/`)

- XLSX templates with an instructions sheet and example rows (fake data): students + guardians (one row per student, up to 2 guardians), staff, opening balances.
- Parsing (XLSX/CSV), normalisation (names, dates in several Ghanaian formats like `12/03/2015`, phones `024…` → `+233…`), validation, duplicate detection within the file and against the DB, guardian de-duplication by phone (creates sibling links), dry-run report, downloadable error report, row resolution, batched resumable commit, assigning class placements.
- Opening balances import posts `opening_balance` ledger entries (needs ADMIN commit).
- Tests: messy sample files (blank rows, merged cells, wrong dates, duplicate phones), 1,000-row import under 2 minutes, re-running commit does not duplicate.

## Agent H: DevOps and QA (`infra/`, `.github/`, `tests/e2e/`, `tests/load/`, `docs/operations/`)

- Dockerfiles (multi-stage, non-root, read-only FS), Compose for dev and prod, Caddy config (TLS, headers), `.env.example`, secrets via Docker secrets files.
- CI: lint, typecheck, unit, integration (Postgres), e2e (Playwright, `--trace off`), contract check (spec ↔ routes), RBAC coverage, `pnpm audit`, osv-scanner, Trivy, gitleaks, ownership check.
- Backups: nightly `pg_basebackup` + continuous WAL archiving (pgBackRest), encrypted (age/GPG), off-site sync when online, uploaded files included, retention 7 daily / 4 weekly / 12 monthly; backup success/failure alert; scripted restore and point-in-time recovery.
- Health checks, log rotation, disk-space alert, Uptime Kuma (optional), UPS-triggered clean shutdown notes.
- Test suites: E2E for CP2–CP4 flows; k6 load test with 1,000 students and 15 concurrent users (search, payment entry, attendance save) → target p95 < 500 ms, zero errors; soak test for payments.
- Restore drill for CP6; deployment guide and runbook.

## Orchestrator responsibilities during Phase 1

- Commit the scaffold and stubs, then launch A–H in parallel in isolated worktrees.
- Review every hand-back for contract and ownership compliance, merge to the integration branch, run CI.
- Rule on change requests within the same working session.
- Run checkpoints CP1–CP6 in order; spawn the independent security reviewer for CP5.
