-- 0006 database roles and grants.
-- Roles are cluster-wide, so several test databases migrating at once on the same server can race on
-- CREATE ROLE. Each creation is wrapped so duplicate_object / unique_violation are ignored.
-- Roles are NOLOGIN groups; deployments create LOGIN users that are members (see db/README.md).
-- Migrations run as the database owner/superuser (the "sms_owner" role of schema.md).
SET LOCAL search_path = app, public;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['sms_app', 'sms_audit_writer', 'sms_readonly'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;  -- created concurrently by another database's migration
      END;
    END IF;
  END LOOP;
END $$;

-- (Re)applies the whole grant policy for this database. Later migrations that add tables call
-- `SELECT app.apply_grants();` at their end.
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

  -- sms_audit_writer: INSERT only on audit
  EXECUTE 'GRANT INSERT ON audit.events TO sms_audit_writer';
  EXECUTE 'GRANT USAGE ON SEQUENCE audit.events_id_seq TO sms_audit_writer';

  -- sms_readonly: SELECT everywhere (reports, backups)
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA app, audit, import TO sms_readonly';
  EXECUTE 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA app, audit, import TO sms_readonly';
  EXECUTE 'REVOKE EXECUTE ON FUNCTION app.apply_grants() FROM sms_app';
END $$;

REVOKE ALL ON FUNCTION app.apply_grants() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.mark_payment_reversed(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.refresh_student_balances() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.verify_chain(bigint) FROM PUBLIC;

SELECT app.apply_grants();
