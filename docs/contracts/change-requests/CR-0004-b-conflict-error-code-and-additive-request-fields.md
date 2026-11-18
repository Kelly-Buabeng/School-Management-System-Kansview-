# CR-0004: generic conflict error code, and additive request fields for Agent B endpoints

- Raised by: Agent B, 2026-11-18
- Status: **Accepted** by Orchestrator 2026-11-18. `RECORD_ALREADY_EXISTS` added to packages/shared/src/error-codes.ts; Agent B switches its 409 conflicts to it in a follow-up. The additive fields are accepted as documented.

## 1. New shared error code `RECORD_ALREADY_EXISTS` (409)

`ErrorCodes` has no generic conflict code. Agent B currently returns **409 with `VALIDATION_FAILED`** for: duplicate academic year name / overlapping dates, duplicate level code or sort order, duplicate class (year + level + stream), duplicate subject code or grading scale name, a second pending withdrawal for a student, guardian already linked, class already has a class teacher.

Proposal: add `RECORD_ALREADY_EXISTS` to `packages/shared/src/error-codes.ts`. Agent B will switch the 409s to it once accepted (one-line change in each service). Assumption until then: clients key on the HTTP status (409), not the code.

## 2. Additive request/response fields (OpenAPI says detailed schemas are completed by the owning agent)

| Operation | Addition |
|---|---|
| `createLevel` / `updateLevel` | optional `classScoreWeight` + `examScoreWeight` (both or neither, sum 100) → upserts `assessment_config` for the level. There is no separate assessment-config endpoint. |
| `createAcademicYear` | body `{ name, startDate, endDate, terms: [3 × {number, name?, startDate, endDate}] }` |
| `checkStudentDuplicate` | body `{ firstName, middleNames?, lastName, dateOfBirth, guardianPhones[], guardianIds[] }` → `{ isPossibleDuplicate, candidates[] }` |
| `renumberClassRoll` | body `{ mode: 'alphabetical' }` or `{ mode: 'manual', studentIds[] }` (every open enrolment exactly once) |
| `changeClass` | body `{ classId, effectiveDate?, reason }` (same academic year only; next year = promotion) |
| `undoPromotionRun` | body `{ reason }` |
| `generateReportCards` | body `{ classId, nextTermBegins? }`; runs synchronously, returns 202 with counts |
| `publishReportCards` | body `{ termId, classId }` |
| `saveClassAttendance` | query `date` (+ optional `session` am/pm); body `{ records: [{ studentId, status, reasonCode?, note? }] }` |
| `revealStaffSensitive` | body `{ reason, fields?: ['ghanaCard','ssnit'] }` |
| `setClearanceItem` | body `{ cleared, notApplicable?, note? }` |
| `getPolicies` / `updatePolicies` | flat object of policy keys; `ETag`/`If-Match` is a hash of all policy values (settings rows have no single version) |
| `Student` response | adds `guardians[]`, `classId`, `admissionYear`, `archivedAt` |

## 3. Notes (no change needed)

- DB `student_status = 'graduated'` is presented as API `alumni` (both directions) by Agent B.
- `getClassReportCardsPdf` currently renders synchronously (200 PDF) rather than a 202 export job; switch when the export queue exists.

Affected: Orchestrator (contract), Agent E (frontend forms), Agent H (e2e).
