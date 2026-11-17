# CR-0001: migrations must also run on PostgreSQL 16

- Raised by: Orchestrator, 2026-11-17
- Status: **Accepted**

## Change
Production stays on PostgreSQL 18 (Docker image `postgres:18`). The build/test container only has PostgreSQL 16, and PostgreSQL 18 could not be installed here (apt repository blocked, Docker Hub rate-limited).

So every migration must run on **PostgreSQL 16 and 18**:
- Do not use the built-in `uuidv7()` (18 only). Migration `0001` defines `app.uuid_v7()` in SQL/PLpgSQL; all `DEFAULT uuidv7()` in `schema.md` read as `DEFAULT app.uuid_v7()`.
- No other 17/18-only features (e.g. virtual generated columns, `RETURNING OLD/NEW`, `MERGE ... RETURNING`).
- pgTAP is not installed: database tests are written as Vitest tests that connect with `pg` (in `db/tests/`).

## Affected
Agent A (migrations), Agent H (CI runs on 16 and 18 when a registry is reachable).
