# Kansview School Management System

Administrative back-office system (admissions, guardians, classes, promotion, fees, attendance, report cards, notifications) for a basic school in Ghana.

**Status: Phase 0 approved 2026-11-17. Phase 1 in progress.** Branch and commit names follow `featurebeingpushed-whatitdoes` (see `docs/contracts/conventions.md`).

| Document | Path |
|---|---|
| Architecture decision and stack | `docs/adr/0001-architecture-and-stack.md` |
| Database schema outline + ERD | `docs/contracts/schema.md` |
| OpenAPI specification | `packages/contracts/openapi.yaml` |
| RBAC permission matrix | `docs/contracts/rbac.md` |
| Folder structure, ownership, naming, errors, branching | `docs/contracts/conventions.md` |
| Definition of done and checkpoints | `docs/contracts/definition-of-done.md` |
| Phase 1 agent task breakdown | `docs/plan/phase1-agent-tasks.md` |

## Developer quick start

```bash
pnpm install
pnpm --filter @sms/shared --filter @sms/contracts --filter @sms/db-types build
SMS_DB_URL=postgres://sms:sms@localhost:5432/sms_dev pnpm db:migrate
SMS_TEST_DB_ADMIN_URL=postgres://sms:sms@localhost:5432/postgres pnpm test
```
