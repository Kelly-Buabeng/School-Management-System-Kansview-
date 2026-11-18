# CR-0007: import writers for staff, opening balances, and a duplicate override for ImportTarget

- Raised by: Agent G (data import), 2026-11-18
- Status: **Accepted** by Orchestrator 2026-11-18. Item 4 (additive imports API fields) is accepted as documented. Items 1–3 are accepted in principle; the current workarounds (create-new duplicates refused by admission, ImportsService using its own FinanceStore, staff inserted directly) are safe and stay for now. The proper interface changes are listed in docs/plan/follow-ups.md for a clean-up pass after the queue.
- Affected: Agent B (`ImportTarget`, staff module), Agent C (finance module), Orchestrator (`common/contracts/import-target.ts`, OpenAPI)

## 1. `ImportStudentRow`: let the import confirm "create new" for a possible duplicate

When the dry run finds a possible duplicate (same rule as admission: similar name + same date of birth + shared guardian
phone), the administrator can choose "create new". `StudentImportTarget` builds the admission body without
`confirmNotDuplicate`, so admission refuses with 409 `STUDENT_POSSIBLE_DUPLICATE` and the row is reported as
"Not imported". Proposed additive fields:

```ts
// common/contracts/import-target.ts, ImportStudentRow
confirmNotDuplicate?: boolean;
duplicateOverrideReason?: string; // e.g. "Import: administrator chose create new (job <id>, row <n>)"
```

B passes them into `AdmitStudentBody`. G will send them only for rows resolved as `create_new`.
**Assumption until accepted:** such rows fail with a clear message and can be added through the normal admission screen.

## 2. Export `FinanceStore` (or add `LedgerService.postOpeningBalance`)

Opening balances must go through the ledger rules. G reuses Agent C's `FinanceStore.lockStudent` and
`FinanceStore.postLedger` (append-only insert, per-student advisory lock). `FinanceModule` does not export
`FinanceStore`, so `ImportsService` creates `new FinanceStore(db)` on the shared Kysely pool.
Proposed: C exports `FinanceStore` from `FinanceModule` (or adds
`postOpeningBalance(tx, { studentId, termId, amountPesewas, description, postedBy })` to `LedgerService`), and G switches to injection.
Nothing else changes.

## 3. A staff writer for imports

There is no cross-agent interface that creates staff. G inserts into `app.staff` and `app.staff_emergency_contacts`
directly (INSERT only, columns per schema.md §4; a missing Staff ID is generated as `STF-0001`, … under an advisory lock).
Proposed: add `upsertStaff(row, tx, actorUserId)` to `ImportTarget` (Agent B), and G switches to it.

## 4. OpenAPI detail for the `imports` tag (additive)

Paths, methods and permissions stay as frozen. Request and response details as built:

- `POST /imports` multipart `file` + `type` → 201 job. Files: `.xlsx` or `.csv` (UTF-8 with or without BOM, comma/semicolon/tab), at most 10 MB and 2,000 data rows.
- `POST /imports/{id}/validate` → 202 job. The dry run runs **synchronously** (2,000-row cap; 1,000 rows take well under a second). It only writes `import.rows` / `import.jobs`.
- `GET /imports/{id}/rows?status=&page=&pageSize=` → `{ data: [{ rowNumber, status, messages[{severity: error|warning|info, code, message, field?}], raw, normalised, duplicates, resolution, committed, targetStudentId, targetStaffId, targetGuardianIds }], page, pageSize, total }`.
- `PATCH /imports/{id}/rows/{rowNumber}` body `{ action: link_existing | create_new | skip | include, existingId? }` (`include` undoes a skip).
- `GET /imports/{id}/error-report.xlsx?include=problems|all`.
- `POST /imports/{id}/commit` (Idempotency-Key) → 202 job. Refused with 422 while possible duplicates are unresolved. Runs synchronously in batches of 200 rows per transaction; a job whose rows partly failed ends in `failed` and a new commit retries only the rows not yet imported.
- Job `totals`: `rows, valid, warning, error, duplicate, unresolvedDuplicates, skipped, toCommit, committed, failed`.
- Type scoping: ADMIN all types; REGISTRAR `students_guardians`; BURSAR `opening_balances`. Jobs of other types return 404. Committing `opening_balances` needs the ADMIN role.
