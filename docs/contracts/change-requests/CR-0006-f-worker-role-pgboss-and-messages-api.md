# CR-0006 (Agent F): worker process role, pg-boss schema, messages API details

Status: proposed. Agent F has implemented against the assumptions below and keeps working.

## 1. Worker process role (apps/api/src/worker.ts, Orchestrator)

Job handlers start only when `SMS_PROCESS_ROLE=worker`, so the API process (same AppModule) only enqueues.
Proposed one-line change in `apps/api/src/worker.ts`, before `createApplicationContext`:

```ts
process.env.SMS_PROCESS_ROLE ??= 'worker';
```

Until then, infra (Agent H) must set `SMS_PROCESS_ROLE=worker` on the worker container. Optionally add
`SMS_PROCESS_ROLE: z.enum(['api', 'worker']).default('api')` to `common/config.ts`.

## 2. pg-boss needs its own schema (Agent A / H)

pg-boss creates and migrates schema `pgboss` on first start. The production DB login role must be able to
`CREATE` in the database once (or the schema must be pre-created and owned by the app login role). Tests run as
superuser so this is not exercised. Proposal: migration or ops step `CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION <app login role>`.

## 3. OpenAPI `messages` tag, additive (Orchestrator)

- `SendMessageRequest.variables`: optional object of string values (max 300 chars each) for non-system
  placeholders of the chosen kind, e.g. `{ "message": "...", "dueDate": "30 Nov 2026", "termName": "Term 1" }`.
  System placeholders (guardianName, studentName, studentCode, className, balance, schoolName, schoolPhone)
  cannot be set (422 TEMPLATE_PLACEHOLDER_INVALID).
- `audience.ids` for `defaulters` = optional class ids (empty = whole school).
- POST /messages 202 body: `{ id, status: queued|pending_approval|done, recipientCount, queued, skippedOptOut,
  estimatedCostPesewas, needsApproval, notice? }`. A message waiting for approval is a 202 with
  `notice.code = MESSAGE_NEEDS_APPROVAL`, not an error.
- POST /messages/preview 200 body: `{ recipientCount, optedOutCount, samples[{to (masked), body}], encoding,
  segmentsPerMessage, totalSegments, estimatedCostPesewas, needsApproval, approvalThreshold, quietHoursApply }`.
- Message templates: create `{ code, channel, name, body, isActive }`, PATCH `{ name?, body?, isActive? }` with optional
  `If-Match: <version>` (412 on mismatch); duplicate code+channel → 409 RECORD_ALREADY_EXISTS.

## 4. Rule interpretations (please confirm)

- Bulk approval: the OpenAPI summary says "unless ADMIN/HEADTEACHER"; the task brief and RBAC say "unless the
  user has `messages:bulk_approve`" (ADMIN only). Implemented: permission-based, so a HEADTEACHER's bulk
  non-emergency message above `messaging.bulk_approval_threshold` waits for ADMIN approval. Emergencies never wait.
- Emergency messages also reach guardians with `receives_sms = false` (safety over preference). Every other kind
  records them as `skipped_opt_out`.
- BURSAR (without another sending role) may send `fee_reminder` only; BURSAR and REGISTRAR see their own sends only
  (others' messages are 404).
- PDFs print money as `GHS 1,250.50`: the bundled Roboto font has no cedi sign. SMS bodies use `GHS` too, because
  `₵` is not GSM-7 and would halve the characters per SMS.
