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

## Run everything with one command

```bash
./dev.sh
```

This installs dependencies if needed, starts PostgreSQL, applies migrations, seeds a fake school on the first run (1,000 students), then starts the API, the background worker and the web app. Ctrl-C stops everything.

- Web app: http://localhost:5173 · API: http://localhost:3000/api/v1
- Dev sign-ins (development only) are printed at start-up and listed in `db/seeds/README.md`.
- PostgreSQL: it uses a server already running on `localhost:5432` (user/password `sms`/`sms`). If none is running, it starts one in Docker, or a local PostgreSQL install.
- Options:
  - `./dev.sh --reset` gives a fresh database;
  - `./dev.sh --no-seed` starts an empty school;
  - `./dev.sh --demo` runs the web app only, on built-in demo data;
  - `pnpm dev:all` and `pnpm dev:demo` do the same.
- This is for development only. Production uses the Docker deployment in `docs/operations/`.

## Developer quick start (step by step)

```bash
pnpm install
pnpm --filter @sms/shared --filter @sms/contracts --filter @sms/db-types build
SMS_DB_URL=postgres://sms:sms@localhost:5432/sms_dev pnpm db:migrate
SMS_TEST_DB_ADMIN_URL=postgres://sms:sms@localhost:5432/postgres pnpm test
```
