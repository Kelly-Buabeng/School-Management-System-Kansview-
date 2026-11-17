-- 0004 communication, import staging, data protection, audit (hash-chained, append-only).
SET LOCAL search_path = app, public;

-- ===========================================================================
-- Communication
-- ===========================================================================
CREATE TABLE app.message_templates (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code text NOT NULL,
  channel app.message_channel NOT NULL DEFAULT 'sms',
  name text NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT message_templates_code_channel_key UNIQUE (code, channel)
);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  kind text NOT NULL,                                 -- template code or 'custom'
  channel app.message_channel NOT NULL DEFAULT 'sms',
  template_id uuid REFERENCES app.message_templates(id),
  body_rendered_preview text,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  status app.message_status NOT NULL DEFAULT 'queued',
  recipient_count int NOT NULL DEFAULT 0,
  requested_by uuid REFERENCES app.users(id),
  approved_by uuid REFERENCES app.users(id),
  approved_at timestamptz,
  scheduled_for timestamptz,
  dedupe_key text UNIQUE,                             -- e.g. 'absence:<student>:<date>' (once per student per day)
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE INDEX messages_status_idx ON app.messages (status, created_at DESC);

CREATE TABLE app.message_recipients (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  message_id uuid NOT NULL REFERENCES app.messages(id),
  guardian_id uuid REFERENCES app.guardians(id),
  student_id uuid REFERENCES app.students(id),
  phone text NOT NULL,
  body text NOT NULL,
  status app.recipient_status NOT NULL DEFAULT 'queued',
  provider_message_id text,
  cost_units int,
  sent_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE INDEX message_recipients_message_idx ON app.message_recipients (message_id);
CREATE INDEX message_recipients_status_idx ON app.message_recipients (status) WHERE status IN ('queued', 'failed');
CREATE INDEX message_recipients_provider_idx ON app.message_recipients (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX message_recipients_student_idx ON app.message_recipients (student_id) WHERE student_id IS NOT NULL;

ALTER TABLE app.attendance_records
  ADD CONSTRAINT attendance_records_sms_message_id_fkey FOREIGN KEY (sms_message_id) REFERENCES app.messages(id);

CREATE TABLE app.delivery_attempts (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  recipient_id uuid NOT NULL REFERENCES app.message_recipients(id),
  attempt_no int NOT NULL CHECK (attempt_no >= 1),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  response_code text,
  error text,
  CONSTRAINT delivery_attempts_recipient_attempt_key UNIQUE (recipient_id, attempt_no)
);

-- ===========================================================================
-- Import staging
-- ===========================================================================
CREATE TABLE import.jobs (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  type import.job_type NOT NULL,
  file_id uuid REFERENCES app.files(id),
  original_filename text,
  status import.job_status NOT NULL DEFAULT 'uploaded',
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  dry_run_report_file_id uuid REFERENCES app.files(id),
  error_report_file_id uuid REFERENCES app.files(id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  validated_at timestamptz,
  committed_at timestamptz,
  committed_by uuid REFERENCES app.users(id),
  version int NOT NULL DEFAULT 1
);
CREATE INDEX import_jobs_created_idx ON import.jobs (created_at DESC);

CREATE TABLE import.rows (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  job_id uuid NOT NULL REFERENCES import.jobs(id) ON DELETE CASCADE,
  row_number int NOT NULL CHECK (row_number >= 1),
  raw jsonb NOT NULL,
  normalised jsonb,
  status import.row_status NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_student_id uuid REFERENCES app.students(id),
  target_guardian_ids uuid[] NOT NULL DEFAULT '{}',
  target_staff_id uuid REFERENCES app.staff(id),
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_rows_job_row_key UNIQUE (job_id, row_number)
);
CREATE INDEX import_rows_job_status_idx ON import.rows (job_id, status);

-- ===========================================================================
-- Data protection
-- ===========================================================================
CREATE TABLE app.data_subject_requests (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  requester_name text NOT NULL,
  relationship text,
  student_id uuid REFERENCES app.students(id),
  guardian_id uuid REFERENCES app.guardians(id),
  type app.dsr_type NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  status app.dsr_status NOT NULL DEFAULT 'received',
  handled_by uuid REFERENCES app.users(id),
  outcome text,
  response_file_id uuid REFERENCES app.files(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (student_id IS NOT NULL OR guardian_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION app.dsr_default_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.due_at IS NULL THEN
    NEW.due_at := NEW.received_at + interval '21 days';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_subject_requests_default_due BEFORE INSERT ON app.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION app.dsr_default_due();

CREATE TABLE app.retention_actions (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action app.retention_action_type NOT NULL,
  basis text NOT NULL,
  approved_by uuid REFERENCES app.users(id),
  performed_by uuid REFERENCES app.users(id),
  performed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_actions_entity_idx ON app.retention_actions (entity_type, entity_id);

-- ===========================================================================
-- Audit (append-only, SHA-256 hash chain)
-- ===========================================================================
CREATE TABLE audit.events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_role text,
  session_id text,
  ip inet,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_]*$'),
  entity_type text NOT NULL,
  entity_id text,
  student_id uuid,
  changes jsonb,
  reason text,
  request_id text,
  prev_hash text,
  hash text NOT NULL DEFAULT ''                     -- set by the chain trigger
);
CREATE INDEX audit_events_occurred_idx ON audit.events (occurred_at DESC);
CREATE INDEX audit_events_entity_idx ON audit.events (entity_type, entity_id);
CREATE INDEX audit_events_student_idx ON audit.events (student_id, occurred_at DESC) WHERE student_id IS NOT NULL;
CREATE INDEX audit_events_actor_idx ON audit.events (actor_user_id, occurred_at DESC);
CREATE INDEX audit_events_action_idx ON audit.events (action, occurred_at DESC);

-- Canonical hash of one event given the previous hash. Used by the insert trigger and the verifier.
CREATE OR REPLACE FUNCTION audit.compute_hash(e audit.events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(public.digest(convert_to(concat_ws('|',
    coalesce(e.prev_hash, ''),
    e.id::text,
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(e.actor_user_id::text, ''),
    coalesce(e.actor_role, ''),
    coalesce(e.session_id, ''),
    coalesce(host(e.ip), ''),
    e.action,
    e.entity_type,
    coalesce(e.entity_id, ''),
    coalesce(e.student_id::text, ''),
    coalesce(e.changes::text, ''),
    coalesce(e.reason, ''),
    coalesce(e.request_id, '')), 'UTF8'), 'sha256'), 'hex')
$$;

-- Serialises audit inserts (transaction-scoped advisory lock) so the chain is linear; the id is
-- re-drawn after taking the lock so id order == chain order. Rolled-back inserts leave id gaps only.
CREATE OR REPLACE FUNCTION audit.chain_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = audit, pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit.events.chain'));
  NEW.id := nextval(pg_get_serial_sequence('audit.events', 'id'));
  NEW.occurred_at := coalesce(NEW.occurred_at, now());
  SELECT e.hash INTO NEW.prev_hash FROM audit.events e ORDER BY e.id DESC LIMIT 1;
  NEW.hash := audit.compute_hash(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER events_chain BEFORE INSERT ON audit.events
  FOR EACH ROW EXECUTE FUNCTION audit.chain_event();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_update_delete();

-- Verifies the whole chain (or from a given id). Returns broken rows; empty result = intact.
CREATE OR REPLACE FUNCTION audit.verify_chain(from_id bigint DEFAULT 0)
RETURNS TABLE (id bigint, problem text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = audit, pg_catalog AS $$
DECLARE
  r audit.events;
  expected_prev text := NULL;
  first boolean := true;
BEGIN
  IF from_id > 0 THEN
    SELECT e.hash INTO expected_prev FROM audit.events e WHERE e.id < from_id ORDER BY e.id DESC LIMIT 1;
  END IF;
  FOR r IN SELECT * FROM audit.events e WHERE e.id >= from_id ORDER BY e.id LOOP
    IF (first AND from_id = 0 AND r.prev_hash IS NOT NULL) OR (NOT (first AND from_id = 0) AND r.prev_hash IS DISTINCT FROM expected_prev) THEN
      id := r.id; problem := 'prev_hash does not match previous event'; RETURN NEXT;
    END IF;
    IF r.hash <> audit.compute_hash(r) THEN
      id := r.id; problem := 'hash does not match event content'; RETURN NEXT;
    END IF;
    expected_prev := r.hash;
    first := false;
  END LOOP;
END $$;
