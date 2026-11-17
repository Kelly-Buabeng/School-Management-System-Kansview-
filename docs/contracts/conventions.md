# Contract: folder structure, ownership, naming, errors, branching

Status: **Proposed, frozen on approval**.

## 1. Monorepo layout and ownership

pnpm workspaces. **Each agent edits only the paths it owns.** Anything else needs a change request (CR).

```
/
├── docs/
│   ├── adr/                          Orchestrator
│   ├── contracts/                    Orchestrator (frozen; edit only via accepted CR)
│   │   └── change-requests/          Any agent may ADD a CR file; Orchestrator decides
│   ├── security/                     Agent D (threat model, DPA/Act 843 docs, test plan)
│   ├── operations/                   Agent H (deploy, backup/restore runbook)
│   └── user/                         Orchestrator in Phase 3 (manual, quick-starts)
├── packages/
│   ├── contracts/                    Orchestrator: openapi.yaml + generated TS types/Zod
│   ├── db-types/                     Agent A: kysely-codegen output (generated, committed)
│   └── shared/                       Orchestrator: money (pesewas) helpers, Damm, date utils, error codes
├── db/
│   ├── migrations/                   Agent A (SQL, numbered: 0001_init.sql …)
│   ├── seeds/                        Agent A (fake Ghanaian data generator)
│   └── tests/                        Agent A (pgTAP / SQL tests)
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── main.ts, worker.ts, app.module.ts   Orchestrator (bootstrap only)
│   │       ├── common/               Orchestrator: errors, pagination, request-id, db provider
│   │       ├── security/             Agent D: guards, permission decorator, field policy,
│   │       │                         crypto (field encryption), rate limit, CSRF, headers,
│   │       │                         upload hardening, audit interceptor & AuditService
│   │       └── modules/
│   │           ├── auth/ users/ audit/ data-protection/          Agent D
│   │           ├── settings/ academic-setup/ students/ guardians/
│   │           │   emergency/ enrolment/ promotion/ staff/
│   │           │   attendance/ academics/ welfare/ withdrawals/
│   │           │   search/ dashboard/                           Agent B
│   │           ├── finance/ (fee-structures, invoices, payments,
│   │           │   adjustments, ledger, balances, cash-up, reports) Agent C
│   │           ├── notifications/ documents/ (PDF) files/        Agent F
│   │           └── imports/                                      Agent G
│   └── web/                          Agent E (React app; src/features/<domain>/)
├── infra/                            Agent H (docker, compose, caddy, backup scripts, monitoring)
├── tests/
│   ├── e2e/                          Agent H (Playwright), other agents add specs via PR to H
│   └── load/                         Agent H (k6)
└── .github/workflows/                Agent H
```

Unit and integration tests live **next to the code they test** (`*.spec.ts`, `*.int-spec.ts`) and belong to that code's owner.

### Cross-agent interfaces (defined by Orchestrator before Phase 1, implemented by owner)

| Interface | Owner | Consumers |
|---|---|---|
| `@RequirePermission(perm)`, `@Public()`, `CurrentUser`, `ScopeService.studentScope(user)` | D | B, C, F, G |
| `FieldPolicy.apply(resource, dto, user)` | D | B, C |
| `AuditService.record(event)` and `@Audited(action, entity)` | D | all |
| `FieldCrypto.encrypt/decrypt/blindIndex` | D | A (key ids), B, G |
| `FileStore.put/get/stat`, `UploadPipeline.accept(file, policy)` | D (pipeline), F (store) | B, C, G |
| `NotificationService.enqueue(template, recipients, ctx)` | F | B (absence), C (fee reminders), D (password reset) |
| `PdfService.render(docType, data)` | F | B (report cards, letters), C (receipts, statements) |
| `LedgerService.balance(studentId)` / `outstandingByStudent(ids)` | C | B (promotion arrears check, withdrawal clearance), dashboard |
| `StudentLookup.getBillingInfo(id)` | B | C, F |
| `ImportTarget.upsertStudentWithGuardians(row, tx)` | B | G |

Until an interface's real implementation lands, the owner ships a **typed stub** with the same signature on day 1 so consumers can build against it.

## 2. Naming

| Thing | Convention | Example |
|---|---|---|
| DB tables/columns | snake_case, plural tables | `student_guardians.is_fee_payer` |
| API paths | `/api/v1/`, kebab-case plural nouns | `/api/v1/promotion-runs/{id}/commit` |
| JSON fields | camelCase | `amountPesewas`, `studentCode` |
| Money | integer pesewas, suffix `Pesewas` in API, `_pesewas` in DB; formatted only in the UI (`GH₵ 1,250.00`) | |
| Dates / times | `YYYY-MM-DD` for dates, ISO 8601 with `Z` for instants; display `Africa/Accra` | |
| Phone numbers | stored E.164 (`+233241234567`), accepted as `024…` and normalised | |
| TS files | kebab-case; classes PascalCase; Nest: `students.controller.ts`, `students.service.ts` | |
| Permissions | `resource:action` | `payments:reverse` |
| Error codes | `UPPER_SNAKE`, domain-prefixed | `PAYMENT_DUPLICATE_REFERENCE` |
| Env vars | `SMS_` prefix | `SMS_DB_URL`, `SMS_MASTER_KEY_FILE` |
| Migrations | `NNNN_short_description.sql`, forward-only; a fix is a new migration | `0007_add_cash_ups.sql` |

## 3. Error format (RFC 9457 problem details)

Every error response is `application/problem+json`:

```json
{
  "type": "https://sms.local/errors/payment-duplicate-reference",
  "title": "This reference number was already recorded",
  "status": 409,
  "code": "PAYMENT_DUPLICATE_REFERENCE",
  "detail": "MTN MoMo reference 61234567890 was recorded on receipt RCP-000412 on 2026-11-12 for KSV-26-00417-7.",
  "requestId": "01JD3X8Q…",
  "errors": [
    { "field": "referenceNo", "code": "DUPLICATE", "message": "Already used on receipt RCP-000412" }
  ],
  "meta": { "existingPaymentId": "…", "canOverride": true }
}
```

- `title`/`detail`/`message` are written for school staff, plain English.
- Status codes: 400 validation, 401 not signed in, 403 signed in but not allowed, 404 not found **or out of scope**, 409 conflict/duplicate/version mismatch, 412 `If-Match` failed, 422 business rule, 423 locked (account or record), 429 rate limited, 500 with requestId only (no stack trace).
- The shared list of codes lives in `packages/shared/src/error-codes.ts`.

## 4. Other API rules

- Pagination: `?page=1&pageSize=25` (max 100) → `{ data: [...], page, pageSize, total }`.
- Filtering via explicit query params only; sorting `?sort=lastName,-admissionDate` with an allow-list.
- Strict request schemas: unknown fields rejected (prevents mass assignment).
- `Idempotency-Key` header **required** on `POST /payments`, `POST /payments/{id}/reverse`, `POST /invoices/generate`, `POST /adjustments`, `POST /messages`, `POST /imports/{id}/commit`, `POST /promotion-runs/{id}/commit`.
- `If-Match: <version>` required on PATCH of students, guardians, staff, settings.
- Large exports are async: `202 Accepted` + `Location: /api/v1/exports/{id}`.

## 5. Git branching plan

- `main`: protected, releases only, tagged `v1.0.0` etc.
- Integration branch: in this session it is **`claude/sweet-gauss-um4n2e`** (the only branch this session may push to). If the school approves, a `develop` branch and per-agent branches can be added.
- Agents work in isolated git worktrees on local branches `agent/<letter>-<topic>` (e.g. `agent/c-finance`), commit small, and hand back; the Orchestrator reviews the diff, checks ownership (`scripts/check-ownership.sh` fails if an agent touched paths it does not own), runs CI locally, and merges into the integration branch.
- Checkpoints are tagged `cp1` … `cp6` on the integration branch.
- Commit style: Conventional Commits (`feat(finance): …`, `fix(security): …`).
