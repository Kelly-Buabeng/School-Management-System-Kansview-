# CR-0010: handle idle-connection errors on the API's PostgreSQL pool

- Raised by: Agent H, 2026-11-19
- Status: **Proposed** (Orchestrator owns `apps/api/src/common/db/database.module.ts`)

## Problem

The full API suite (`npx vitest run` in `apps/api`) intermittently ends with
`Unhandled error: terminating connection due to administrator command (57P01)` from a client with
`application_name: 'sms-api'`, reported against whichever test file was tearing down (seen on `test/c/cp3-payments`,
`test/b/students`). All tests pass, but Vitest exits 1. Reproduced on plain `origin/main` (3 of 3 runs had 1–4 such
errors), so it is not caused by any single feature branch.

Cause: `DatabaseModule` creates `new Pool(...)` without an `'error'` listener. When a test database is dropped
`WITH (FORCE)` (or, in production, when PostgreSQL restarts or an idle connection is cut), node-postgres emits the error
on the pool; with no listener Node treats it as an uncaught exception. In production that would crash the API process
on a database restart instead of letting the pool reconnect.

## Proposed change

```ts
useFactory: (cfg: AppConfig) => {
  const pool = new Pool({ connectionString: cfg.SMS_DB_URL, max: 20, application_name: 'sms-api' });
  // Idle client lost (DB restart, network cut, test DB dropped): log it; the pool replaces the client on next use.
  pool.on('error', (err) => logger.warn({ err }, 'idle database connection lost'));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
},
```

The same applies to any other long-lived `pg.Pool` (pg-boss already has an `error` handler in `BossService`).
