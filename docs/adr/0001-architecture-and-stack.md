# ADR 0001: Architecture and final stack

- Status: **Proposed (Phase 0, waiting for approval)**
- Date: 2026-11-17
- Decider: Orchestrator, pending school approval

## Context

A back-office School Management System for one private basic school in Ghana (about 1,000 students, 4 to 10 staff users at once). Internet is unreliable and power cuts happen. Payment records must never be lost. The data is about children, so privacy and security come first. It must run on one modest server (4 vCPU, 8 GB RAM, 100 GB SSD is the target; 2 vCPU / 4 GB must still work with ClamAV turned off).

## Decision summary

| Concern | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 18** | Transactions, row locks for race-safe counters, check constraints, triggers that make the ledger append-only, `uuidv7()` built in, full-text and trigram search. |
| Backend | **Node.js 22 LTS + TypeScript (strict) + NestJS 11** | Typed, modular (one Nest module per domain fits the agent split), good guard/interceptor model for RBAC and audit, same language as the frontend. |
| DB access | **Kysely** (typed query builder) + **plain SQL migrations** (node-pg-migrate) | The DB is the source of truth. Triggers, sequences, constraints and row locks are written in SQL that Agent A owns. `kysely-codegen` produces TS types from the live schema, so backend agents cannot drift from it. An ORM would hide the locking and append-only rules. |
| Validation | **Zod** schemas generated from OpenAPI (`openapi-zod-client` / `orval`) | One contract, used by the API (request validation, mass-assignment protection by strict schemas) and by the frontend. |
| Job queue | **pg-boss** (queue in PostgreSQL) | No Redis to run, back up or lose. Jobs are durable across power cuts because they live in the same backed-up database. Fine for this load (hundreds of SMS per day, a few PDFs per minute). |
| Frontend | **React 19 + Vite + TypeScript + TanStack Query + React Router + React Hook Form + Zod + Mantine UI** | Mature, fast to build forms and tables. Code-split per screen so it loads on a low-end laptop and a phone. API client generated from OpenAPI (`openapi-typescript` + `openapi-fetch`); mocks generated with **MSW**. |
| PDF | **pdfmake** (pure JS, in the worker) | Light on memory, no headless Chrome on a small server, deterministic layout for receipts and report cards. |
| Excel | **ExcelJS** (import and export) | Reads and writes `.xlsx` and `.csv`. |
| File storage | Local volume behind a `FileStore` interface (S3-compatible adapter ready) | Works offline. Files outside the web root, random object keys, served only through an authorised endpoint. |
| Malware scan | **ClamAV** container (on by default, can be turned off on 4 GB servers) plus magic-byte checks and image re-encoding with `sharp` | Defence in depth for uploads. |
| SMS / WhatsApp | `MessageProvider` interface, **mock** provider in v1, one real Ghana SMS adapter behind config (see open question 4) | Messages queue in pg-boss and send when the internet is back. |
| Reverse proxy | **Caddy** | Automatic TLS (Let's Encrypt in the cloud, internal CA on the LAN), security headers, simple config. |
| Deployment | **Docker Compose** on one host: `caddy`, `api`, `worker`, `web` (static files served by Caddy), `postgres`, `clamav` (optional), `backup` | One command to run; easy to restore. |
| Auth | Server-side sessions in PostgreSQL, `HttpOnly; Secure; SameSite=Strict` cookie, CSRF token, Argon2id password hashes, TOTP MFA | Easy forced logout (delete the session rows); no JWTs in browser storage. |
| Field encryption | AES-256-GCM in the app with envelope keys (data keys encrypted by a master key from the environment/secret file), HMAC blind index for Ghana Card lookups | Medical and Ghana Card data is encrypted even in a database dump. Plus full-disk encryption (LUKS) on the server. |
| Observability | Structured JSON logs (pino) with request id, `/health/live` and `/health/ready`, Uptime Kuma (optional container) and disk/backup alerts by SMS/email | Simple enough for a school to run. |
| CI | GitHub Actions: lint, typecheck, unit, integration (Postgres service), e2e (Playwright), `npm audit` + `osv-scanner`, Trivy image scan, gitleaks, OpenAPI contract check | |

### Alternatives considered

- **Python/FastAPI**: equally valid. Rejected only so the backend and frontend share one language, one set of generated types, and one toolchain for a small team.
- **Prisma**: rejected because append-only triggers, `SELECT ... FOR UPDATE` counters and partial indexes are central here and are awkward in Prisma.
- **BullMQ + Redis**: rejected to avoid a second stateful service that must be backed up.
- **Headless Chrome for PDF**: rejected for memory use on a small server.

## Deployment topology (decision needed: see open question 1)

**Recommended: on-premise primary server + cloud backup.**

```
 School LAN (works with no internet)                      Internet (when available)
 ┌────────────────────────────────────────────┐          ┌──────────────────────────┐
 │ Staff laptops / phones ──HTTPS──► Caddy     │          │ Off-site object storage  │
 │                                   │         │  nightly │ (encrypted backups,      │
 │   UPS-protected mini server:      ▼         │ ───────► │  e.g. Backblaze B2 / S3) │
 │   api ── worker ── postgres ── clamav       │          │                          │
 │   local backup disk (WAL archive, hourly)   │ ───────► │ SMS provider API         │
 └────────────────────────────────────────────┘  queued  └──────────────────────────┘
```

- Staff keep working when the internet is down; only SMS and off-site backup wait.
- A UPS (at least 30 minutes) lets the server shut down cleanly; the server auto-starts the stack when power returns.
- Alternative: a cheap cloud VM. Simpler hardware, but the school cannot work during internet outages. The same Compose files support both.

## How the system fails safely

1. **Payments are written in one database transaction**: payment row, allocations, ledger entries and the receipt number together. Either all are saved or none.
2. **`synchronous_commit = on`, `fsync = on`, `full_page_writes = on`** (never turned off for speed). A power cut after "Saved" is shown cannot lose the payment.
3. **Idempotency keys**: the frontend creates a key when the payment form opens and sends it in an `Idempotency-Key` header. If the network drops and the bursar clicks Save again, the server returns the first result instead of creating a second payment.
4. The UI never says "Saved" until the server has confirmed the commit. On a network error it says "Not sure it saved. Check the payment list before trying again" and offers a lookup by idempotency key.
5. **WAL archiving** to a second local disk every 5 minutes plus nightly encrypted off-site base backups. **RPO: 15 minutes local, 24 hours off-site. RTO: 4 hours** (restore runbook tested at checkpoint 6).
6. Jobs (SMS, PDFs, exports) are in pg-boss tables, so a crash or power cut does not lose them; they retry with backoff.
7. Startup is ordered by health checks; the API refuses traffic until migrations and DB connectivity are ready.

## Key domain decisions

- **Permanent student ID**: `KSV-26-00417-7` = school code, 2-digit admission year, 5-digit sequence per admission year, **Damm check digit** (catches every single-digit error and every adjacent swap, which the Luhn method does not). Generated inside the insert transaction by locking a row in `id_counters` (`SELECT ... FOR UPDATE`), so two registrars can never get the same number. Numbers are never reused because the counter only goes up and student rows are never hard-deleted. The current class and roll number live in `enrolments`, not in the ID.
- **Money**: `bigint` pesewas everywhere. API field names end in `Pesewas`. No floats in DB, API or UI arithmetic.
- **Ledger**: one sub-ledger per student. Every charge, payment, discount, waiver, refund and reversal is a row in `ledger_entries`. Balance = sum of entries. A trigger rejects `UPDATE` and `DELETE`; the app's DB role also has no `UPDATE/DELETE` grant on finance tables. Corrections are reversal entries that point to the original.
- **Gap-free receipt numbers**: `receipt_counters` row locked in the same transaction as the payment. If the transaction rolls back, so does the counter, so there are no gaps. Reversed receipts keep their number and are printed "REVERSED".
- **Arrears carry-forward**: the ledger balance is the truth. A new term invoice shows "Balance brought forward" as a snapshot taken from the ledger at issue time; it is not charged again.
- **Time**: all timestamps `timestamptz`; display zone `Africa/Accra` (UTC+0, no daylight saving). Dates as ISO `YYYY-MM-DD`.
- **Parent portal readiness**: `guardians.user_id` (nullable) and `users.user_type` (`staff` now, `guardian` later); RBAC is permission-based so a `GUARDIAN` role with row-level scoping can be added without schema changes.
- **Online payment readiness**: `payments.status`, `payments.source`, `payments.external_reference` (unique, nullable), `payments.idempotency_key` (unique), `payments.provider` (nullable). No gateway code in v1.

## Consequences

- Agent A's SQL migrations are the single source of truth for the schema; backend agents regenerate types after each migration.
- pg-boss means a long queue backlog lives in the main database; acceptable at this scale.
- On-prem hosting puts hardware care on the school; the runbook must be written for a non-technical admin.
