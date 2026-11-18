# Database (`db/`)

PostgreSQL schema for the Kansview School Management System. Migrations are plain SQL. They run on
**PostgreSQL 16 and 18** (CR-0001); production uses 18. The contract is `docs/contracts/schema.md`, with change
requests CR-0003 (payment reversals) and CR-0005 (payment evidence).

```
db/
  migrations/NNNN_name.sql   forward-only, each file in one transaction
  tools/migrate.mjs          migrator (CLI + exported migrate(url))
  seeds/                     fake development data (see seeds/README.md)
  tests/                     Vitest database tests (pg, a fresh database per file)
packages/db-types/           Kysely types generated from the migrated schema
```

## Everyday commands

| Task | Command |
|---|---|
| Apply migrations | `SMS_DB_URL=postgres://… pnpm --filter @sms/db migrate` (or `node db/tools/migrate.mjs`) |
| Seed fake data | `SMS_DB_URL=postgres://… pnpm --filter @sms/db seed` (see `seeds/README.md`) |
| Run DB tests | `pnpm --filter @sms/db test` (creates and drops `a_t_*` databases; admin URL from `SMS_TEST_DB_ADMIN_URL`, default `postgres://sms:sms@localhost:5432/postgres`) |
| Regenerate types | `pnpm --filter @sms/db-types generate`, then `pnpm --filter @sms/db-types build` |

The migrator takes an advisory lock and records each file with its SHA-256 in `public.schema_migrations`. **Never edit
a migration that is already merged.** The migrator refuses to run when a checksum changes, so add a new `NNNN_*.sql`
file instead. A migration that adds tables must end with `SELECT app.apply_grants();` (see Roles). If the new table
needs grants that differ from the defaults, change `apply_grants()` in the same migration, as 0008 does.

Type generation (`packages/db-types/scripts/generate.mjs`) creates a throw-away database, migrates it, runs
kysely-codegen for schemas `app`, `audit` and `import`, then drops it. App tables are unqualified (`students`); the
others are qualified (`audit.events`, `import.jobs`, `import.rows`). Three post-processing steps follow: `int8` is typed
as `number` (the API's pg type parser), `date` columns are strings, and `mv_student_balances` is added by hand because
codegen skips materialised views.

## Conventions

- **Schemas**: `app` (domain), `audit` (append-only audit), `import` (staging). `pgboss` belongs to the queue.
  Migration 0001 runs `ALTER DATABASE … SET search_path = app, public`, so new connections resolve app tables unqualified.
- **Ids**: `uuid DEFAULT app.uuid_v7()` (time-ordered v7 in PL/pgSQL; PostgreSQL 18's `uuidv7()` is not used).
  The exception is `audit.events.id bigserial`.
- **Timestamps**: `created_at/created_by/updated_at/updated_by`. A trigger (`set_updated_at`) maintains `updated_at` on
  every table that has the column. The `*_by` columns hold plain user ids without foreign keys, so jobs and imports can
  write them. Business actor columns (`recorded_by`, `approved_by` …) do reference `users`.
- **Optimistic locking**: tables with `version` have a `bump_version` trigger, so every UPDATE sets
  `version = OLD.version + 1`. The API checks `WHERE version = :ifMatch`. Setting `version = version + 1` yourself is harmless.
- **Soft delete**: `archived_at/archived_by/archive_reason` on people and documents. Partial indexes use `WHERE archived_at IS NULL`.
- **Money**: `bigint` pesewas, `_pesewas` suffix, `CHECK >= 0` (or `> 0`) except signed ledger and variance amounts.
- **Encrypted columns**: `*_enc bytea` in the API's field-crypto v1 envelope; searchable ones also have `*_bidx bytea` (HMAC).
- **Enums**: PostgreSQL enums for stable sets (statuses, payment method). Admin-configurable lists are tables.

## Tables by area

| Area | Tables |
|---|---|
| Configuration | `school_profile` (singleton `id = 1`; `school_code` locked after the first student), `settings` (key → jsonb policy switches), `academic_years` (one `current`, no overlaps), `terms` (1–3 per year, one `current`), `levels` (`next_level_id`, `is_final_level`), `classes` (per year; `UNIQUE NULLS NOT DISTINCT (year, level, stream)`), `subjects`, `level_subjects`, `grading_scales` / `grading_bands` (non-overlapping `int4range` exclusion), `assessment_config` (`level_id NULL` = school default, weights sum to 100), `id_counters`, `doc_counters` |
| Students and safety | `students` (permanent Damm-checked `student_code`, generated `search_vector`, trigram indexes on names and code), `student_medical` (restricted; `alert_summary`/`has_alert` for the Emergency View), `files`, `student_documents`, `guardians` (E.164 phones indexed, Ghana Card enc/bidx/last4, `user_id` for the v2 portal), `student_guardians` (one primary per student), `emergency_contacts` (deferrable unique priority), `authorised_pickups`, `emergency_contact_logs` (append-only), `student_status_history` (append-only) |
| Enrolment | `enrolments` (never overwritten; one open row per student; open roll numbers unique per class; `end_date IS NULL` exactly when `active`), `promotion_runs` (`undo_deadline` defaults to commit + 14 days), `promotion_run_items` |
| Staff | `staff`, `staff_emergency_contacts`, `staff_class_assignments` (one open class teacher per class; drives TEACHER scope) |
| Academics and welfare | `attendance_sessions` (unique class/date/session), `attendance_records`, `term_scores` (`numeric(5,2)`, generated `total`), `report_cards`, `incidents`, `health_visits`, `withdrawals` (one pending per student) |
| Finance | `fee_items`, `fee_structures` (one active per term+level[+class]; immutable once active, only active → retired), `fee_structure_lines` (editable only while draft), `student_optional_items`, `invoices` (gap-free `invoice_no`; one issued per student and term; only issued → void), `invoice_lines` (append-only), `cash_ups` (one per business day, at most one open), `payments`, `payment_allocations` (append-only; negative rows mark re-allocation and reversal), `payment_reversals` (CR-0003), `adjustments` (maker-checker CHECK), `ledger_entries` (append-only sub-ledger) |
| Communication | `message_templates`, `messages` (`dedupe_key` for once-per-day absence SMS), `message_recipients`, `delivery_attempts` |
| Import | `import.jobs`, `import.rows` (unique `(job_id, row_number)` for re-runnable commits) |
| Security and audit | `users` (roles `text[]` limited to the 5 roles), `user_sessions` (hashed id), `password_reset_tokens`, `login_attempts`, `idempotency_records`, `data_subject_requests` (`due_at` defaults to received + 21 days), `retention_actions`, `audit.events` |

Views: `v_sibling_links (student_id, sibling_student_id, via_guardian_ids)` derives siblings from shared guardians
that are not archived. `mv_student_balances (student_id, balance_pesewas, last_payment_at, oldest_unpaid_term_id, refreshed_at)`
is a materialised view for list screens. It has a unique index, so it can refresh `CONCURRENTLY` through
`app.refresh_student_balances()`. Single-student balances always read `ledger_entries`.

Ledger sign rule: **positive = owed by the family, negative = paid or credited**. A balance is `SUM(amount_pesewas)`.
Each entry type must carry its reference (`invoice_charge` → `invoice_line_id`, `payment` → `payment_id` …), and a
`reversal` must exactly negate one non-reversal entry of the same student, at most once (`reverses_entry_id` is unique).

## Functions and triggers

| Function | Purpose |
|---|---|
| `app.uuid_v7()` | Default for ids |
| `app.next_student_code(admission_year int) → text` | `KSV-26-00417-7`. Upserts the row-locked `id_counters` row `student:yy` and adds a Damm check digit over `yy‖seq`. The result is identical to `formatStudentCode` in `packages/shared`. Call it inside the admission transaction; a rollback frees the number |
| `app.damm_check_digit(text)`, `app.is_valid_student_code(text)` | Used by the `students` CHECK constraints |
| `app.next_doc_no(doc_type text) → text` | Gap-free `RCP-000413`, `REV-…`, `INV-…`, `TL-…`. Row-locks the `doc_counters` row until commit, so committed numbers never have gaps. **Call it in the business transaction, as late as possible** (the lock serialises receipts) |
| `app.forbid_update_delete()` | Trigger on `ledger_entries`, `audit.events`, `emergency_contact_logs`, `student_status_history`, `payment_allocations`, `invoice_lines` (UPDATE, DELETE, TRUNCATE). Also blocks DELETE on `students`, `payments`, `invoices`, `adjustments`, `payment_reversals` and `school_profile` |
| `app.guard_payment_update()` | Payments allow only `confirmed → reversed` (plus `reversed_*`), or the one-time evidence attachment below |
| `app.mark_payment_reversed(payment_id, reversed_by, reason)` | SECURITY DEFINER: flips the status. Call it in the same transaction as the reversal ledger entry |
| `app.attach_payment_evidence(payment_id, file_id[, user_id])` | SECURITY DEFINER (CR-0005): sets `attachment_file_id` once, NULL → value, while the payment's cash-up is open, or on the day received (Africa/Accra) if it has no cash-up. **Use this function, not a direct UPDATE.** |
| `app.forbid_student_code_change()` | `student_code`, `admission_year` and `admission_seq` never change |
| `app.lock_school_code()` | `school_profile.school_code` is fixed once a student exists |
| `app.guard_fee_structure_update()`, `app.guard_fee_structure_lines()`, `app.guard_invoice_update()` | Immutability of active structures and issued invoices |
| `app.check_ledger_reversal()` | Reversal amount and student must match the original |
| `app.refresh_student_balances()` | SECURITY DEFINER `REFRESH MATERIALIZED VIEW CONCURRENTLY` for the app role |
| `audit.chain_event()` | BEFORE INSERT on `audit.events`. Takes a transaction-scoped advisory lock, re-draws `id`, links `prev_hash` to the latest event and stores `hash = SHA-256(prev_hash‖id‖occurred_at UTC‖actor‖…‖changes‖reason‖request_id)` (see `audit.compute_hash`). Ids can have gaps (rolled-back inserts); the chain cannot |
| `audit.verify_chain(from_id bigint default 0)` | Returns `(id, problem)` rows. An empty result means the chain is intact. Use it in the daily verification job |
| `app.apply_grants()` | Re-applies the whole grant policy (see below) |

Audit inserts are serialised by the chain lock until commit. Record the audit event late in the transaction to keep the
lock short. At this school's volume this is not a bottleneck.

## Roles and grants

Migration 0006 creates three NOLOGIN roles. The creation is race-safe when many test databases migrate at once
(`duplicate_object` and `unique_violation` are caught). Migrations run as the database owner or superuser (the
`sms_owner` of the contract).

| Role | Rights |
|---|---|
| `sms_app` | DML on `app` and `import` tables, except: **SELECT + INSERT only** on `ledger_entries`, `payment_allocations`, `invoice_lines`, `emergency_contact_logs`, `student_status_history`, `retention_actions`, `login_attempts`, `audit.events`. **No DELETE** on people, finance and history tables. `payments`: UPDATE only on `status, reversed_at, reversed_by, reversal_reason, updated_at, updated_by, version` (the guard trigger enforces confirmed → reversed). `payment_reversals`: SELECT, INSERT, and UPDATE only on `status, reversal_no, approved_by, approved_at, ledger_entry_id, updated_at, updated_by`. EXECUTE on `app` functions (not `apply_grants`) and on `audit.verify_chain` |
| `sms_audit_writer` | INSERT on `audit.events` (+ its sequence) |
| `sms_readonly` | SELECT on everything (reports, backups) |

Deployments create LOGIN users that are members, e.g.
`CREATE ROLE sms_api LOGIN PASSWORD '…' IN ROLE sms_app;`. The API should connect as a member of `sms_app`, not as the
owner; otherwise the privilege layer is bypassed and only the triggers protect the data. Today the dev and test setups
connect as the superuser `sms`.

## Retention notes

Policy values are rows in `settings` (`retention.*`, `dpa.request_response_days`) and can be edited by the admin:
student records are kept 7 years after leaving (then anonymised: `student_code` and finance totals are kept), finance
records 7 years, audit events 7 years, login attempts 90 days, idempotency records 7 days, SMS bodies 365 days, and
data subject requests are answered within 21 days. Confirm all of these with counsel.

- `ledger_entries`, `payment_allocations`, `invoice_lines` and `audit.events` cannot be updated or deleted by any role
  while the triggers are on. Purging them after the statutory period is a deliberate owner-level operation: disable the
  trigger in one maintenance transaction, archive or export first, and record a `retention_actions` row.
- People are never hard-deleted. Anonymisation is an UPDATE of the personal fields, plus a `retention_actions` row.
- `login_attempts`, `idempotency_records`, `user_sessions` and `password_reset_tokens` are plain tables that a job can
  purge by date (indexes on `at` and `created_at`).

## v2-ready payment columns (unused in v1)

Online payments are out of scope for v1. These columns exist so v2 needs no table rewrite:

| Column | v1 value | v2 use |
|---|---|---|
| `payments.status` enum `payment_status` | `confirmed`, `reversed` | add `pending`, `failed` (`ALTER TYPE … ADD VALUE`) for gateway callbacks |
| `payments.source` enum `payment_source` | `manual` | add `gateway` |
| `payments.provider` | NULL | gateway name |
| `payments.external_reference` | NULL (unique when set) | gateway transaction id; the unique constraint makes callbacks idempotent |
| `payments.idempotency_key` / `idempotency_request_hash` | set by the API from the `Idempotency-Key` header | same, for gateway retries |
| `guardians.user_id`, `user_type` enum | NULL / `staff` | v2 parent portal (`guardian` user type) |

A v2 `pending → confirmed` transition would also need a change to `app.guard_payment_update()`.

## Tests

`db/tests` (Vitest + pg). Each file creates its own database from `template0` with a pid and random name, retrying on
transient errors, so test runs from several agents can share one server.

- `migrations.test.ts`: applies from empty, reruns are idempotent, reference data, `uuid_v7`, Damm and
  `next_student_code` match `packages/shared`, grants, parallel migrations.
- `guards.test.ts`: append-only tables, payment guard, column privileges, `mark_payment_reversed`, CR-0003 reversals,
  CR-0005 evidence attachment, student code immutability, maker-checker, fee structure immutability, views.
- `concurrency.test.ts`: 50 parallel `next_student_code` calls on separate connections; 200 `next_doc_no` calls with
  rollbacks leave no gaps.
- `audit-chain.test.ts`: concurrent inserts form one chain, the hash format, tamper detection.
- `seed.test.ts`: population, invariants, gap-free numbers, idempotency, determinism, and compatibility with the API's
  Argon2, field crypto, TOTP and `LedgerService`.
