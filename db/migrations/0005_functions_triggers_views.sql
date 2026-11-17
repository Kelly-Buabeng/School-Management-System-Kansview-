-- 0005 business functions, guard triggers, updated_at/version triggers, views.
SET LOCAL search_path = app, public;

-- ---------------------------------------------------------------------------
-- Student code: {school_code}-{yy}-{seq:05d}-{damm(yy||seq)}; equals packages/shared formatStudentCode.
-- Row-locked counter per admission year: concurrent callers serialise on the id_counters row,
-- and a rolled-back admission releases its number (student codes need not be gap-free).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.next_student_code(admission_year int) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  yy text := lpad((admission_year % 100)::text, 2, '0');
  seq int;
  code text;
BEGIN
  IF admission_year IS NULL OR admission_year < 0 THEN
    RAISE EXCEPTION 'admission_year is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT school_code INTO code FROM app.school_profile WHERE id = 1;
  IF code IS NULL THEN
    RAISE EXCEPTION 'School profile is not set up (no school code)' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO app.id_counters AS c (scope, last_value) VALUES ('student:' || yy, 1)
  ON CONFLICT (scope) DO UPDATE SET last_value = c.last_value + 1, updated_at = now()
  RETURNING c.last_value INTO seq;
  IF seq > 99999 THEN
    RAISE EXCEPTION 'Student number range for 20% is full', yy USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN code || '-' || yy || '-' || lpad(seq::text, 5, '0') || '-' || app.damm_check_digit(yy || lpad(seq::text, 5, '0'))::text;
END $$;

-- ---------------------------------------------------------------------------
-- Gap-free document numbers (receipt, reversal, invoice, transfer_letter): e.g. RCP-000413.
-- Must be called inside the business transaction: the counter row stays locked until commit,
-- and a rollback also rolls back the increment, so committed numbers have no gaps.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.next_doc_no(doc_type text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  p text;
  w int;
  n bigint;
BEGIN
  UPDATE app.doc_counters c SET last_value = c.last_value + 1, updated_at = now()
   WHERE c.doc_type = next_doc_no.doc_type
  RETURNING c.prefix, c.pad_width, c.last_value INTO p, w, n;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown document type %', doc_type USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN p || '-' || lpad(n::text, greatest(w, length(n::text)), '0');
END $$;

-- ---------------------------------------------------------------------------
-- Student code immutability
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.forbid_student_code_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.student_code IS DISTINCT FROM OLD.student_code
     OR NEW.admission_year IS DISTINCT FROM OLD.admission_year
     OR NEW.admission_seq IS DISTINCT FROM OLD.admission_seq THEN
    RAISE EXCEPTION 'Student ID % is permanent and cannot be changed', OLD.student_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER students_forbid_code_change BEFORE UPDATE ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.forbid_student_code_change();
CREATE TRIGGER students_no_delete BEFORE DELETE ON app.students
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

-- school_code is locked once the first student exists.
CREATE OR REPLACE FUNCTION app.lock_school_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.school_code IS DISTINCT FROM OLD.school_code AND EXISTS (SELECT 1 FROM app.students) THEN
    RAISE EXCEPTION 'The school code cannot be changed after the first student is admitted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER school_profile_lock_code BEFORE UPDATE ON app.school_profile
  FOR EACH ROW EXECUTE FUNCTION app.lock_school_code();
CREATE TRIGGER school_profile_no_delete BEFORE DELETE ON app.school_profile
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

-- ---------------------------------------------------------------------------
-- Append-only tables
-- ---------------------------------------------------------------------------
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
CREATE TRIGGER emergency_contact_logs_append_only BEFORE UPDATE OR DELETE ON app.emergency_contact_logs
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
CREATE TRIGGER student_status_history_append_only BEFORE UPDATE OR DELETE ON app.student_status_history
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON app.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
CREATE TRIGGER invoice_lines_append_only BEFORE UPDATE OR DELETE ON app.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ledger_entries','emergency_contact_logs','student_status_history','payment_allocations','invoice_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_update_delete()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Payment reversal helper (SECURITY DEFINER): the supported way to flip a payment's status.
-- Call it in the same transaction that inserts the reversal ledger entry.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.mark_payment_reversed(p_payment_id uuid, p_reversed_by uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  UPDATE app.payments
     SET status = 'reversed', reversed_at = now(), reversed_by = p_reversed_by,
         reversal_reason = p_reason, updated_by = p_reversed_by
   WHERE id = p_payment_id AND status = 'confirmed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % does not exist or is already reversed', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at and version triggers on every table that has those columns
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('app', 'import') AND c.column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()',
                   r.table_schema, r.table_name);
  END LOOP;
  FOR r IN
    SELECT c.table_schema, c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('app', 'import') AND c.column_name = 'version'
  LOOP
    EXECUTE format('CREATE TRIGGER bump_version BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION app.bump_version()',
                   r.table_schema, r.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Siblings: derived from shared (non-archived) guardians; never stored.
-- ---------------------------------------------------------------------------
CREATE VIEW app.v_sibling_links AS
SELECT a.student_id,
       b.student_id AS sibling_student_id,
       array_agg(DISTINCT a.guardian_id ORDER BY a.guardian_id) AS via_guardian_ids
  FROM app.student_guardians a
  JOIN app.student_guardians b ON b.guardian_id = a.guardian_id AND b.student_id <> a.student_id
  JOIN app.guardians g ON g.id = a.guardian_id AND g.archived_at IS NULL
 GROUP BY a.student_id, b.student_id;

-- ---------------------------------------------------------------------------
-- Balances for list screens. Live single-student balance always reads ledger_entries.
-- oldest_unpaid_term_id: first term (by start date) whose cumulative charges exceed total credits (FIFO).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW app.mv_student_balances AS
WITH totals AS (
  SELECT le.student_id,
         sum(le.amount_pesewas)::bigint AS balance_pesewas,
         (-sum(le.amount_pesewas) FILTER (WHERE le.amount_pesewas < 0))::bigint AS credits_pesewas
    FROM app.ledger_entries le GROUP BY le.student_id
), last_pay AS (
  SELECT p.student_id, max(p.received_at) AS last_payment_at
    FROM app.payments p WHERE p.status = 'confirmed' GROUP BY p.student_id
), term_charges AS (
  SELECT le.student_id, le.term_id, t.start_date, sum(le.amount_pesewas) AS charged
    FROM app.ledger_entries le JOIN app.terms t ON t.id = le.term_id
   WHERE le.amount_pesewas > 0
   GROUP BY le.student_id, le.term_id, t.start_date
), cum AS (
  SELECT tc.student_id, tc.term_id, tc.start_date,
         sum(tc.charged) OVER (PARTITION BY tc.student_id ORDER BY tc.start_date, tc.term_id) AS cum_charged
    FROM term_charges tc
), oldest AS (
  SELECT DISTINCT ON (c.student_id) c.student_id, c.term_id
    FROM cum c LEFT JOIN totals t ON t.student_id = c.student_id
   WHERE c.cum_charged > coalesce(t.credits_pesewas, 0)
   ORDER BY c.student_id, c.start_date, c.term_id
)
SELECT s.id AS student_id,
       coalesce(t.balance_pesewas, 0)::bigint AS balance_pesewas,
       lp.last_payment_at,
       CASE WHEN coalesce(t.balance_pesewas, 0) > 0 THEN o.term_id END AS oldest_unpaid_term_id,
       now() AS refreshed_at
  FROM app.students s
  LEFT JOIN totals t ON t.student_id = s.id
  LEFT JOIN last_pay lp ON lp.student_id = s.id
  LEFT JOIN oldest o ON o.student_id = s.id;
CREATE UNIQUE INDEX mv_student_balances_student_key ON app.mv_student_balances (student_id);
CREATE INDEX mv_student_balances_balance_idx ON app.mv_student_balances (balance_pesewas);

-- Owner-only operation exposed to the app role.
CREATE OR REPLACE FUNCTION app.refresh_student_balances() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY app.mv_student_balances;
END $$;
