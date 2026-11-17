-- 0008 CR-0003: payment reversal requests (number, reason, approval) and adjustment decision/reversal columns.
SET LOCAL search_path = app, public;

CREATE TYPE app.payment_reversal_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE app.payment_reversals (
  id                uuid PRIMARY KEY DEFAULT app.uuid_v7(),
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
  CONSTRAINT payment_reversals_maker_checker CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
-- at most one open or completed reversal per payment
CREATE UNIQUE INDEX payment_reversals_one_active ON app.payment_reversals (payment_id) WHERE status IN ('pending', 'approved');
CREATE INDEX payment_reversals_pending_idx ON app.payment_reversals (requested_at) WHERE status = 'pending';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON app.payment_reversals
  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER payment_reversals_no_delete BEFORE DELETE ON app.payment_reversals
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

ALTER TABLE app.adjustments
  ADD COLUMN decision_reason text,
  ADD COLUMN reversed_by uuid,
  ADD COLUMN reversed_at timestamptz,
  ADD COLUMN reversal_reason text;

-- Grant policy now also covers payment_reversals (sms_app grants as listed in CR-0003).
CREATE OR REPLACE FUNCTION app.apply_grants() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  -- sms_app: SELECT + INSERT only (append-only / finance / audit)
  insert_only text[] := ARRAY[
    'app.ledger_entries', 'app.payment_allocations', 'app.invoice_lines',
    'app.emergency_contact_logs', 'app.student_status_history', 'app.retention_actions',
    'app.login_attempts', 'audit.events'];
  -- sms_app: no DELETE (people, finance records; soft delete via archived_*)
  no_delete text[] := ARRAY[
    'app.students', 'app.guardians', 'app.staff', 'app.users', 'app.student_medical',
    'app.payments', 'app.invoices', 'app.adjustments', 'app.fee_structures', 'app.cash_ups',
    'app.school_profile', 'app.academic_years', 'app.terms', 'app.enrolments', 'app.withdrawals',
    'app.promotion_runs', 'app.promotion_run_items', 'app.incidents', 'app.health_visits',
    'app.report_cards', 'app.term_scores', 'app.data_subject_requests', 'app.files',
    'app.messages', 'app.message_recipients', 'app.delivery_attempts', 'app.doc_counters', 'app.id_counters',
    'import.jobs'];
  t text;
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA app, audit, import TO sms_app, sms_readonly';
  EXECUTE 'GRANT USAGE ON SCHEMA audit TO sms_audit_writer';
  EXECUTE 'REVOKE CREATE ON SCHEMA app, audit, import FROM PUBLIC';

  -- sms_app: full DML on app/import by default, then narrowed
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, import TO sms_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, import, audit TO sms_app';
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO sms_app';
  EXECUTE 'REVOKE ALL ON audit.events FROM sms_app';
  FOREACH t IN ARRAY insert_only LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM sms_app', t);
    EXECUTE format('GRANT SELECT, INSERT ON %s TO sms_app', t);
  END LOOP;
  FOREACH t IN ARRAY no_delete LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %s FROM sms_app', t);
  END LOOP;
  -- payments: UPDATE only on the reversal columns; the guard trigger enforces confirmed → reversed.
  EXECUTE 'REVOKE UPDATE ON app.payments FROM sms_app';
  EXECUTE 'GRANT UPDATE (status, reversed_at, reversed_by, reversal_reason, updated_at, updated_by, version) ON app.payments TO sms_app';
  EXECUTE 'GRANT EXECUTE ON FUNCTION audit.verify_chain(bigint) TO sms_app, sms_readonly';
  -- payment_reversals (CR-0003): SELECT, INSERT and UPDATE of the decision/posting columns only.
  IF to_regclass('app.payment_reversals') IS NOT NULL THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON app.payment_reversals FROM sms_app';
    EXECUTE 'GRANT SELECT, INSERT ON app.payment_reversals TO sms_app';
    EXECUTE 'GRANT UPDATE (status, reversal_no, approved_by, approved_at, ledger_entry_id, updated_at, updated_by) ON app.payment_reversals TO sms_app';
  END IF;

  -- sms_audit_writer: INSERT only on audit
  EXECUTE 'GRANT INSERT ON audit.events TO sms_audit_writer';
  EXECUTE 'GRANT USAGE ON SEQUENCE audit.events_id_seq TO sms_audit_writer';

  -- sms_readonly: SELECT everywhere (reports, backups)
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA app, audit, import TO sms_readonly';
  EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, audit, import TO sms_readonly';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION app.apply_grants() FROM sms_app';
END $$;

SELECT app.apply_grants();
