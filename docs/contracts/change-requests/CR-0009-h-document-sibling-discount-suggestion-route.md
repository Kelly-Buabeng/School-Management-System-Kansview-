# CR-0009: document the sibling-discount suggestion route, and add a login-attempt purge function

- Raised by: Agent H, 2026-11-18
- Status: **Accepted** by Orchestrator 2026-11-19. Part 1: the route is added to `openapi.yaml` and the allow-list entry removed. Part 2: accepted; the migration is assigned to Agent A as follow-up item 10 (the worker already skips the purge safely until the function exists).

## 1. Undocumented route found by the contract test

`apps/api/test/contract-routes.int-spec.ts` boots the AppModule and compares every registered route with
`packages/contracts/openapi.yaml`. One route exists in code but not in the spec:

| Route | Code | Permission in code |
|---|---|---|
| `GET /api/v1/students/{id}/sibling-discount-suggestion` | `AdjustmentsController.sibling` (`apps/api/src/modules/finance/finance.controllers.ts`, Agent C) | `adjustments:create` |

**Proposed change (Orchestrator, additive):** add to `openapi.yaml` under FINANCE:

```yaml
  /students/{id}/sibling-discount-suggestion:
    parameters: [{$ref: '#/components/parameters/Id'}]
    get: {tags: [finance], operationId: getSiblingDiscountSuggestion, x-permission: 'adjustments:create', summary: Suggested sibling discount for a student (no posting), responses: {'200': {description: OK}}}
```

**Assumption until decided:** the route is listed in `KNOWN_UNDOCUMENTED` in the contract test so CI stays green;
any *new* undocumented route still fails CI. When the spec gains the path, the test fails until the allow-list entry
is removed (so the list cannot rot).

## 2. Purge function for `app.login_attempts` (follow-ups item 8)

`app.login_attempts` is append-only for `sms_app` (no DELETE, migration 0006), so the worker's hourly housekeeping
(`apps/api/src/modules/system/maintenance.service.ts`) cannot remove old rows. Sessions and reset tokens are already
cleaned up.

**Proposed change (Agent A, new migration):**

```sql
CREATE FUNCTION app.purge_login_attempts(p_older_than interval) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = app, pg_temp AS $$
  WITH d AS (DELETE FROM app.login_attempts WHERE at < now() - greatest(p_older_than, interval '30 days') RETURNING 1)
  SELECT count(*) FROM d $$;
REVOKE ALL ON FUNCTION app.purge_login_attempts(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_login_attempts(interval) TO sms_app;
```

The worker already calls it when `to_regprocedure('app.purge_login_attempts(interval)')` exists (retention 180 days);
until then it logs one warning and keeps the rows.
