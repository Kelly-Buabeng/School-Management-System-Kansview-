# Follow-ups after the Phase 1 queue

Small interface clean-ups agreed in change requests. None blocks a checkpoint; each has a safe workaround today.

| # | From | Change | Owner |
|---|---|---|---|
| 1 | CR-0007 | Add `confirmNotDuplicate` + `duplicateOverrideReason` to `ImportStudentRow` so an import row resolved as "create new" can pass admission's duplicate check | B (+ Orchestrator for the interface) |
| 2 | CR-0007 | Export a `LedgerService.postOpeningBalance` (or `FinanceStore`) so imports stop building their own `FinanceStore` | C |
| 3 | CR-0007 | Add `ImportTarget.upsertStaff`; imports currently insert staff rows directly | B |
| 4 | CR-0004 | Switch B's 409 conflicts from `VALIDATION_FAILED` to `RECORD_ALREADY_EXISTS` | B |
| 5 | Agent D report | Agent C's test helper `auditEvents()` should query `audit.events` instead of the test-mode in-memory copy | C |
| 6 | Agent F report | End-to-end route tests for every finance PDF (statements, arrears notice, invoice, reports) | C / F |
| 7 | Agent A report | Production must connect as a login member of `sms_app`, not a superuser | H |
| 8 | Agent D / F reports | Grant pg-boss its `pgboss` schema in production; clean-up jobs for old sessions, login attempts and reset tokens | H |
| 9 | Agent B report | Class report-card PDF and attendance summary xlsx/pdf as background export jobs (202) | B / F |
| 10 | CR-0009 | Migration adding `app.purge_login_attempts(interval)` (SECURITY DEFINER, minimum 30 days); the worker's hourly housekeeping already calls it when present | A |
| 11 | Agent H report | A system-status screen in the web app reading `GET /system/status` (backups, disk, queue) for the administrator | E |
| 12 | Agent H report | Run `scripts/restore.sh` end to end and build the backup image during the CP6 rehearsal | H |
| 13 | Agent E/orchestrator | `GET /dashboard` to return today's payments so the "Collected today" tile shows in real mode; student list to return a balance for fee badges | B / C |
| 14 | Checkpoint runs | `scripts/e2e.sh` should rebuild `apps/api/dist` / `apps/web/dist` when sources are newer (or always in CI), not only with `E2E_REBUILD=1` | H |
| 15 | Checkpoint runs | Run the EICAR upload check against the real ClamAV container (only mocked so far) | H / D |
