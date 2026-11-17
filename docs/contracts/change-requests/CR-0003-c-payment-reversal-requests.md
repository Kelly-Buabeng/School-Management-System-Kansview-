# CR-0003-C: table for payment reversals (reversal number, reason, approval)

- Raised by: Agent C (Finance), 2026-11-17
- Affects: Agent A (schema), Agent C (finance), Agent E (payment screen shows "awaiting approval")
- Status: **Proposed**

## Problem

The contract says a reversal gets a gap-free number from `app.next_doc_no('reversal')`, needs a reason, and after the
day's cash-up is closed becomes a *pending request* that an ADMIN approves (`POST /payments/{id}/reverse/approve`).
The schema has nowhere to store the reversal number, the reason, or a pending request:

- `payments` only allows the update `status confirmed → reversed` (guard trigger), and has no reason/number columns;
- `ledger_entries` is append-only and only gets a row once the reversal is actually posted.

## Proposed change (additive)

```sql
CREATE TYPE app.payment_reversal_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE app.payment_reversals (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_id        uuid NOT NULL REFERENCES app.payments(id),
  reversal_no       text UNIQUE,                     -- set when posted (gap-free 'reversal' counter)
  reason            text NOT NULL CHECK (length(trim(reason)) >= 5),
  status            app.payment_reversal_status NOT NULL DEFAULT 'pending',
  requested_by      uuid NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  approved_by       uuid,
  approved_at       timestamptz,
  ledger_entry_id   uuid REFERENCES app.ledger_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz,
  updated_by        uuid,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
-- at most one open or completed reversal per payment
CREATE UNIQUE INDEX payment_reversals_one_active ON app.payment_reversals(payment_id) WHERE status IN ('pending', 'approved');
```

`sms_app` needs `SELECT, INSERT` and `UPDATE (status, reversal_no, approved_by, approved_at, ledger_entry_id, updated_at, updated_by)`.

Optional, same spirit, for adjustments: `adjustments.decision_reason text`, `adjustments.reversed_by uuid`,
`adjustments.reversed_at timestamptz`, `adjustments.reversal_reason text`.

## Assumption while waiting

Agent C codes against `app.payment_reversals` exactly as above. If the table is missing at merge time, Agent C will
store the reason and reversal number in the reversal ledger entry `description` and the audit event, and the
"pending approval" path returns 501 until this CR is accepted.
