# CR-0005-C: allow attaching payment evidence after recording

- Raised by: Agent C (Finance), written up by Orchestrator, 2026-11-18
- Status: **Accepted** by Orchestrator 2026-11-18. Migration to be written by Agent A in its next queue turn.

## Problem
`PUT /payments/{id}/attachment` lets the bursar attach a MoMo screenshot or bank slip. The payment guard trigger (`app.guard_payment_update`) only allows `status confirmed → reversed`, so `attachment_file_id` can never be set after the payment row is inserted. The endpoint currently returns a clear 422.

## Change (new migration, additive)
Allow exactly one update of `payments.attachment_file_id` from NULL to a value, and only while the payment's cash-up is open (or the payment has no cash-up and was received today, Africa/Accra), through a SECURITY DEFINER function `app.attach_payment_evidence(payment_id uuid, file_id uuid)`. The guard trigger permits this single column change; no other column may change. The change is audited by the API.
