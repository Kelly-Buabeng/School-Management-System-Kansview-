-- 0001 foundation: extensions, schemas, utility functions, enum types.
-- Runs on PostgreSQL 16 and 18 (CR-0001). Applied by db/tools/migrate.mjs in one transaction.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS import;

SET LOCAL search_path = app, public;

-- New connections to this database resolve unqualified names in `app` first
-- (Kysely queries use unqualified app table names; audit/import are always qualified).
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path = app, public', current_database());
END $$;

-- ---------------------------------------------------------------------------
-- UUID v7 (time-ordered). PostgreSQL 18 has uuidv7(); this works on 16 too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  b bytea := uuid_send(gen_random_uuid());
BEGIN
  b := overlay(b PLACING substring(int8send(ms) FROM 3 FOR 6) FROM 1 FOR 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);  -- RFC 4122 variant
  RETURN encode(b, 'hex')::uuid;
END $$;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Optimistic locking: every UPDATE increments version by exactly one.
-- The API checks `WHERE version = :ifMatch`; setting version = version + 1 itself is harmless.
CREATE OR REPLACE FUNCTION app.bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table %.% is append-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege', HINT = 'Insert a correcting/reversing row instead.';
END $$;

-- ---------------------------------------------------------------------------
-- Damm check digit (identical to packages/shared/src/damm.ts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.damm_check_digit(digits text) RETURNS int
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  t int[] := ARRAY[
    [0,3,1,7,5,9,8,6,4,2],
    [7,0,9,2,1,5,4,8,6,3],
    [4,2,0,6,8,7,1,3,5,9],
    [1,7,5,0,9,8,3,4,2,6],
    [6,1,2,3,0,4,5,9,7,8],
    [3,6,7,4,2,0,9,5,8,1],
    [5,8,6,9,7,2,0,1,3,4],
    [8,9,4,5,3,6,2,0,1,7],
    [9,4,3,8,6,1,7,2,0,5],
    [2,5,8,1,4,3,6,7,9,0]];
  interim int := 0;
  i int;
BEGIN
  IF digits !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'damm_check_digit: digits only' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR i IN 1..length(digits) LOOP
    interim := t[interim + 1][substr(digits, i, 1)::int + 1];
  END LOOP;
  RETURN interim;
END $$;

CREATE OR REPLACE FUNCTION app.is_valid_student_code(code text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT code ~ '^[A-Z]{3}-[0-9]{2}-[0-9]{5}-[0-9]$'
     AND app.damm_check_digit(substr(code, 5, 2) || substr(code, 8, 5) || substr(code, 14, 1)) = 0
$$;

-- ---------------------------------------------------------------------------
-- Enum types (stable sets only; admin-configurable lists are tables)
-- ---------------------------------------------------------------------------
CREATE TYPE app.period_status AS ENUM ('planned', 'current', 'closed');
CREATE TYPE app.gender AS ENUM ('male', 'female');
CREATE TYPE app.student_status AS ENUM ('applicant', 'active', 'withdrawn', 'transferred_out', 'graduated', 'deceased');
CREATE TYPE app.guardian_relationship AS ENUM ('mother', 'father', 'grandparent', 'aunt', 'uncle', 'sibling', 'guardian', 'other');
CREATE TYPE app.student_document_type AS ENUM ('birth_certificate', 'previous_report', 'passport_photo', 'transfer_letter', 'other');
CREATE TYPE app.file_scan_status AS ENUM ('pending', 'clean', 'infected', 'error');
CREATE TYPE app.contact_outcome AS ENUM ('reached', 'no_answer', 'wrong_number', 'message_left');
CREATE TYPE app.status_change_source AS ENUM ('admission', 'promotion', 'withdrawal', 'manual', 'import');
CREATE TYPE app.enrolment_status AS ENUM ('active', 'completed', 'repeated', 'withdrawn', 'moved');
CREATE TYPE app.promotion_run_status AS ENUM ('draft', 'committed', 'undone');
CREATE TYPE app.promotion_action AS ENUM ('promote', 'repeat', 'skip', 'withdraw', 'transfer_out', 'graduate');
CREATE TYPE app.staff_type AS ENUM ('teaching', 'non_teaching');
CREATE TYPE app.staff_status AS ENUM ('active', 'on_leave', 'left');
CREATE TYPE app.staff_assignment_role AS ENUM ('class_teacher', 'subject_teacher', 'assistant');
CREATE TYPE app.attendance_session_kind AS ENUM ('am', 'pm');
CREATE TYPE app.attendance_status AS ENUM ('present', 'absent', 'late', 'excused');
CREATE TYPE app.report_card_status AS ENUM ('draft', 'published');
CREATE TYPE app.incident_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE app.withdrawal_type AS ENUM ('withdrawal', 'transfer_out');
CREATE TYPE app.withdrawal_status AS ENUM ('pending_clearance', 'completed', 'cancelled');
CREATE TYPE app.fee_category AS ENUM ('tuition', 'pta', 'feeding', 'transport', 'uniform', 'books', 'exams', 'extracurricular', 'other');
CREATE TYPE app.fee_structure_status AS ENUM ('draft', 'active', 'retired');
CREATE TYPE app.invoice_status AS ENUM ('issued', 'void');
CREATE TYPE app.payment_method AS ENUM ('cash', 'bank_transfer', 'cheque', 'momo_mtn', 'telecel_cash', 'at_money');
CREATE TYPE app.payment_status AS ENUM ('confirmed', 'reversed');      -- v2 adds 'pending', 'failed'
CREATE TYPE app.payment_source AS ENUM ('manual');                     -- v2 adds 'gateway'
CREATE TYPE app.adjustment_type AS ENUM ('discount', 'scholarship', 'bursary', 'sibling_discount', 'waiver', 'refund', 'write_off', 'manual_charge');
CREATE TYPE app.adjustment_status AS ENUM ('pending', 'approved', 'rejected', 'reversed');
CREATE TYPE app.ledger_entry_type AS ENUM ('invoice_charge', 'payment', 'adjustment', 'reversal', 'opening_balance');
CREATE TYPE app.cash_up_status AS ENUM ('open', 'closed');
CREATE TYPE app.message_channel AS ENUM ('sms', 'whatsapp');
CREATE TYPE app.message_status AS ENUM ('draft', 'pending_approval', 'queued', 'sending', 'done', 'partially_failed', 'cancelled');
CREATE TYPE app.recipient_status AS ENUM ('queued', 'sent', 'delivered', 'failed', 'skipped_opt_out');
CREATE TYPE app.user_type AS ENUM ('staff');                           -- v2 adds 'guardian'
CREATE TYPE app.user_status AS ENUM ('active', 'locked', 'disabled');
CREATE TYPE app.dsr_type AS ENUM ('access', 'correction', 'deletion', 'objection');
CREATE TYPE app.dsr_status AS ENUM ('received', 'in_progress', 'completed', 'rejected');
CREATE TYPE app.retention_action_type AS ENUM ('anonymised', 'archived');
CREATE TYPE import.job_type AS ENUM ('students_guardians', 'staff', 'opening_balances');
CREATE TYPE import.job_status AS ENUM ('uploaded', 'validated', 'committing', 'committed', 'failed');
CREATE TYPE import.row_status AS ENUM ('valid', 'warning', 'error', 'duplicate');
