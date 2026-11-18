# CR-0008-E: align response shapes that the Phase 0 spec left as "OK"

- Raised by: Agent E (Frontend), 2026-11-18
- Affects: Agents B, C, D, F, G (response bodies only), Orchestrator (openapi.yaml schemas)
- Status: **Proposed**

## Context

Many operations in `packages/contracts/openapi.yaml` only say `description: OK`, so the frontend had to assume shapes.
I ran the web app in real mode (`VITE_API_MODE=real`, Vite proxy to the API on the dev seed) and compared.
Sign-in with MFA, search, student profile, ledger, Emergency View, recording a payment and the receipt all work.
Where shapes differ, `apps/web/src/api/normalise.ts` accepts **both** forms, so nothing is blocked. This CR asks that
the real shapes be written into the spec (additive) so the adapters can be removed later.

## Assumption while waiting

The frontend keeps the adapters. No backend code was changed by Agent E.

## Bugs found (please fix)

| # | Where | What happens |
|---|---|---|
| 1 | `GET /cash-ups` (Agent C) | 500 `RangeError: amount must be a whole number of pesewas` in `CashUpsService.view` on the dev seed. `counted_by_method` / expected totals probably arrive from Postgres as strings (bigint). The Cash-up screen shows the error with a "Try again" button. |
| 2 | `GET /payments/{id}` (Agent C) | `recordedBy` is the user **id**, so the receipt shows a UUID. Please add `recordedByName` (or return the name). |

## Shape differences the frontend now adapts to (please document in openapi.yaml)

| Endpoint | Frontend expected | API returns |
|---|---|---|
| `GET /academic-years`, `/classes`, `/levels`, `/subjects`, `/grading-scales`, `/promotion-runs`, `/withdrawals`, `/students/{id}/guardians` | `{ data: [...] }` like other lists | bare arrays. Pick one convention for non-paged lists (suggest `{ data }`). |
| `GET /auth/me`, login `user` | `Me` | adds `sessionPhase` (`mfa_pending`, `mfa_enrolment`, `password_change`, `full`). The UI now uses it. Please add it to the `Me` schema. Also: the MFA step needs the CSRF token from the login response's `user.csrfToken`. Please say so in the spec. |
| `GET /academic-years` | `isCurrent` on years and terms | `status: current/closed/planned` |
| `GET /classes` | `name` | `displayName` |
| `GET /students/{id}/guardians` | `{ guardian: Guardian, relationship, isPrimary, … }` | flat guardian row plus link flags |
| `GET /students/{id}/ledger` | `debitPesewas`, `creditPesewas`, `reference` | one signed `amountPesewas`, `receiptNo` |
| `GET /invoices` (list) | `lines` on each invoice | no lines (the payment form now loads `GET /invoices/{id}` for invoices that still owe) |
| `GET /fee-structures` (list) | `lines` | no lines (loaded from `GET /fee-structures/{id}`) |
| `GET /fee-items` | `optional`, `priority`, `active` | `isOptional`, `allocationPriority`, `isActive` |
| `GET /adjustments` | `requestedById`, `decidedBy/At` | `requestedBy` (name only), `approvedBy/At`. Please add `requestedById` so the UI can hide "Approve" on your own request. The server already refuses self-approval. |
| `GET /audit-events` | `at`, `summary` | `occurredAt`, no summary (the UI shows entity type and reason) |
| `GET /withdrawals` | `student {…}`, `clearance` as a map, `kind`, `balancePesewas` | flat `studentId/studentName/studentCode`, `clearance` as an array of `{ item, cleared, by, at }`, `type`, `feeBalancePesewas` |
| `GET /cash-ups` | `expected`, `counted`, `note` | `expectedByMethod`, `countedByMethod`, `notes` |
| `GET /dashboard` | `widgets: string[]` plus top-level widget data | `widgets: { finance, enrolmentByClass, upcomingBirthdays, attendanceTrend }`. Finance has no `studentsOwing` or per-class arrears. Please add `studentsOwing` and `topClasses`. |
| `GET /reports/*` | `columns[].money` | `columns[].type`. The UI treats `type: 'money'` or a key ending in `Pesewas` as money. |
| `GET /settings/policies` | camelCase keys (`arrearsPromotionPolicy`, …) | dotted keys (`promotion.block_on_arrears`, …). **Not adapted yet**: the Policies tab shows the camelCase form only in mock mode. Please agree on one form. |
| `GET /search` | guardians have `phone`, `childrenCount` | `id`, `fullName` only. Please add both (the phone is what front-office staff search by). |
| `POST /payments` | `payerName` optional (spec) | **required** unless `payerGuardianId` is given. The form now asks for the payer and fills in the fee payer by default. Please mark it in the spec. |
| `POST /students` 409 | `meta.candidates[].matchReasons` | candidates without `matchReasons`. Optional, but it helps staff decide. |

## Not checked against the real API (mock only)

Promotion run detail and items, report cards, scores grid, attendance register, messages compose and preview, imports
rows, users admin actions, settings saves. Their shapes follow `apps/web/src/api/types.ts`. Owners, please compare.
