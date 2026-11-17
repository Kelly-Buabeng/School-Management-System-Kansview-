# Contract: RBAC permission matrix (v1)

- Status: **Proposed, frozen on approval**. Owner after freeze: Agent D (enforcement), Orchestrator (matrix changes).
- Enforced on the server for **every endpoint** (`@RequirePermission('students:read')`) and **every sensitive field** (response serialisers drop fields the caller may not see). The frontend only hides buttons; it is never the control.
- Deny by default. A route with no permission declaration fails the CI check (`test:rbac-coverage`).
- A user can hold more than one role (a small school may make one person ADMIN + BURSAR). Permissions are the union.
- Object-level checks (IDOR): every `/:id` lookup goes through a scoped repository that applies role scope (e.g. TEACHER sees only students in their assigned classes) and returns 404 (not 403) for out-of-scope records.

## Roles

| Role | Who | Notes |
|---|---|---|
| `ADMIN` | School administrator | Full control of records, users and settings. Approves finance adjustments and late reversals. Does **not** record payments unless also given BURSAR (separation of duties). MFA mandatory. |
| `BURSAR` | Bursar / accounts | Finance. MFA mandatory. |
| `HEADTEACHER` | Head | Read everything except secrets; reports; approves discounts and report-card remarks. MFA recommended. |
| `REGISTRAR` | Front office | Admissions, guardians, contacts, documents, emergency view, attendance entry on behalf of classes. |
| `TEACHER` *(proposed, see open question 2)* | Class/subject teachers | Only for their assigned classes: attendance, scores, remarks, Emergency View. Can be turned off entirely. |

Legend: **R** read, **C** create, **U** update, **A** archive (soft delete), **X** export/print, **Ap** approve, **—** no access, **own** = only assigned classes/students, **mask** = value masked (e.g. `GHA-•••••••-1234`), **alert** = alert summary only.

## Matrix

| Resource / permission | ADMIN | BURSAR | HEADTEACHER | REGISTRAR | TEACHER |
|---|---|---|---|---|---|
| **Students** core profile (`students:*`) | R C U A X | R (name, code, class, guardians for billing) | R X | R C U X | R own (no address) |
| Student documents (`student_documents:*`) | R C A | — | R | R C | — |
| Medical record (`medical:*`) full detail | R U | — | R | R C U | alert |
| Medical alert summary (Emergency View) | R | R | R | R | R own |
| Emergency View (`emergency_view:read`, always audited) | R | R | R | R | R own |
| Emergency contact log (`emergency_log:create`) | C R | C | C R | C R | C own |
| Guardians (`guardians:*`) | R C U A X | R (name, phones, fee payer) | R | R C U | R own (name, phones) |
| Ghana Card number (`ghana_card:reveal`) | R (reveal, audited) | mask | mask | write-only, mask on read | — |
| Authorised pickups (`pickups:*`) | R C U A | — | R | R C U A | R own |
| Classes, levels, years, terms (`academic_setup:*`) | R C U A | R | R | R | R own |
| Enrolment / class placement (`enrolments:*`) | R C U | R | R | R C U | R own |
| Promotion runs (`promotion:*`) | R C U commit undo | R (arrears flags) | R | — | — |
| Withdrawals / transfers (`withdrawals:*`) | R C U complete X | R, U fee clearance | R Ap | R C U X | — |
| Staff records (`staff:*`) | R C U A X | R (name, role) | R | R (name, phone) | — |
| Staff sensitive (Ghana Card, SSNIT) | R (reveal, audited) | — | — | — | — |
| Attendance (`attendance:*`) | R U X | — | R X | R U | R U own |
| Scores and report cards (`academics:*`) | R U X publish | — | R U (head remark) Ap publish X | — | R U own (until locked) |
| Incidents / discipline (`incidents:*`) | R C U | — | R C U | C | C own, R own (own entries) |
| Health visits (`health_visits:*`) | R C U | — | R | R C U | C own |
| Fee items and structures (`fee_structures:*`) | R Ap activate | R C U | R | — | — |
| Invoices (`invoices:*`) | R X | R C (generate) X, void (reason) | R X | — | — |
| Payments (`payments:create`) | — (unless BURSAR) | C R X | R | — | — |
| Payment reversal (`payments:reverse`) | Ap (after cash-up close) | C (same day, before close) | — | — | — |
| Adjustments: discount, scholarship, bursary, sibling, waiver (`adjustments:*`) | C Ap | C (request) | Ap | — | — |
| Refunds / write-offs | Ap | C (request) | — | — | — |
| Balances & statements (`balances:read`) | R X | R X | R X | R (total only, for clearance) | — |
| Finance reports (`finance_reports:*`) | R X | R X | R X | — | — |
| Cash-up (`cash_up:*`) | R | C U close | R | — | — |
| Messages: send to individual guardian (`messages:send`) | C | C (fee reminders only) | C | C | — |
| Messages: bulk class/level/school (`messages:bulk`) | C Ap | C fee reminders (needs ADMIN Ap if > 50 recipients) | C | C (needs ADMIN Ap if > 50) | — |
| Emergency bulk SMS (`messages:emergency`) | C (no approval wait) | — | C (no approval wait) | — | — |
| Message templates (`templates:*`) | R C U | R | R | R | — |
| Delivery log (`messages:read`) | R X | R own sends | R | R own sends | — |
| Bulk import (`imports:*`) | R C validate commit | C validate (opening balances only); commit needs ADMIN | — | C validate | — |
| Dashboards (`dashboard:*`) | R (all widgets) | R (finance widgets) | R (all widgets) | R (enrolment, birthdays) | R own (attendance) |
| Search (`search:read`) | R | R (finance-safe fields) | R | R | R own |
| Users and roles (`users:*`), force logout, unlock, reset MFA | R C U A | — | — | — | — |
| Settings: school profile, policies, grading (`settings:*`) | R U | R | R | R | — |
| Audit log (`audit:read`) | R X | — | R (read only, no export) | — | — |
| Data subject requests, SAR export, anonymise (`dpa:*`) | R C U X anonymise | — | R | C (log a request) | — |
| Backups / system health (`system:*`) | R | — | — | — | — |

## Field-level rules (enforced by serialisers)

| Field group | Visible to |
|---|---|
| `student_medical.*` except `alert_summary`, `has_alert` | ADMIN, HEADTEACHER, REGISTRAR |
| `guardians.ghana_card` | ADMIN via explicit `POST /guardians/{id}/ghana-card/reveal` (audited, reason required). Everyone else gets `ghanaCardLast4` only. |
| `staff.ghana_card`, `staff.ssnit_no` | ADMIN via reveal endpoint |
| `students.home_address`, `guardians.home_address/work_address` | ADMIN, HEADTEACHER, REGISTRAR |
| Finance amounts on student profile | ADMIN, BURSAR, HEADTEACHER; REGISTRAR sees balance total only |
| `incidents.*` | ADMIN, HEADTEACHER, author |

## Always-audited actions

Emergency View open, any medical read, Ghana Card/SSNIT reveal, any export/print/PDF, SAR export, payment create/reverse, adjustment approve, invoice void, promotion commit/undo, user/role changes, login success/failure, settings change, import commit, anonymisation.
