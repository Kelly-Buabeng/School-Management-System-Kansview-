# Retention schedule

- The periods below are the system defaults (table `settings`, keys `retention.*`, editable by ADMIN in **Settings → Policies**).
- **[CONFIRM]** every period with a lawyer and the school's accountant before go-live, in particular the finance period under Ghana's tax and companies law and any Ghana Education Service requirement to keep pupil records.

| Record | Kept for | Then | How it happens |
|---|---|---|---|
| Pupil personal data (name, date of birth, address, photo, documents, family links, pickups, emergency contacts) | While enrolled + **7 years** after leaving (`retention.student_records_years_after_leaving`) | **Anonymised**: names replaced, date of birth reduced to the year, address/photo/IDs removed, documents archived | ADMIN reviews **Data protection → Retention candidates** each term and anonymises each record with typed confirmation. Each action is written to `retention_actions` and the audit log |
| Pupil health record and sick-bay visits | Same as above | Health fields blanked at anonymisation | Same |
| Incidents / discipline | Same as above | Description and actions blanked | Same |
| Attendance and marks | Same as above | Kept without notes/remarks, linked only to the anonymised student code (statistics, re-issuing results) | Same |
| Permanent student code (`KSV-26-00417-7`) | **Permanently** | Never reused | Enforced by the database |
| Finance (invoices, payments, receipts, adjustments, ledger, cash-ups) | **7 years** after the end of the financial year (`retention.finance_records_years`) **[CONFIRM]** | Kept as an append-only ledger linked to the student code. Not deleted by the system in v1 | Finance tables are append-only by design; a later archiving job can move very old years to cold storage |
| Parent/guardian data | Until 7 years after their last child leaves | Anonymised together with that last child | Automatic during the child's anonymisation (guardians linked to no other child) |
| SMS message bodies | **365 days** (`retention.message_bodies_days`) | Body text blanked; delivery status kept | Worker job (Agent F) |
| Audit log | **7 years** (`retention.audit_events_years`) | Older events may be exported to an encrypted archive and removed by the database owner only | Manual, documented in the operations runbook; the app cannot delete audit events |
| Login attempts | **90 days** (`retention.login_attempts_days`) | Deleted | Daily job run with the database owner role (the app role is insert-only on this table); to be added to the maintenance scripts (Agent H) |
| Idempotency records | **7 days** | Deleted | Daily job (`DbIdempotencyService.purgeExpired`) |
| Password reset tokens | 30 minutes validity; rows kept 90 days | Deleted | Maintenance job (to be scheduled, Agent H) |
| Sessions | 12 hours maximum; revoked rows kept 90 days | Deleted | Maintenance job (to be scheduled, Agent H) |
| Data subject request log | 3 years after the request is closed **[CONFIRM]** | Deleted | Manual review |
| Backups | 7 daily, 4 weekly, 12 monthly | Rotated | Backup tooling (Agent H). Note: an anonymised record can still exist in older backups until they rotate out (maximum 12 months) |
| CCTV | Not applicable: the system does not hold CCTV footage | — | — |

## What anonymisation keeps and why

Kept: student code, admission year, gender, year of birth, class history, marks without remarks, and all finance records. These let the school confirm "this student code attended P1–P6 from 2026 to 2032 and owed nothing" and meet accounting duties, without identifying the child.

Not changed (append-only by design): the emergency contact log (phone numbers called) and the audit log. They are covered by their own 7-year retention and are visible only to senior staff.
