-- 0003 finance (append-only ledger). Money is bigint pesewas.
SET LOCAL search_path = app, public;

CREATE TABLE app.fee_items (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name text NOT NULL,
  category app.fee_category NOT NULL,
  is_optional boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  allocation_priority int NOT NULL DEFAULT 100,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE app.fee_structures (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  term_id uuid NOT NULL REFERENCES app.terms(id),
  level_id uuid NOT NULL REFERENCES app.levels(id),
  class_id uuid REFERENCES app.classes(id),          -- optional per-class override
  name text NOT NULL,
  status app.fee_structure_status NOT NULL DEFAULT 'draft',
  activated_at timestamptz,
  activated_by uuid REFERENCES app.users(id),
  retired_at timestamptz,
  retired_by uuid REFERENCES app.users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (status = 'draft' OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX fee_structures_one_active_level ON app.fee_structures (term_id, level_id)
  WHERE status = 'active' AND class_id IS NULL;
CREATE UNIQUE INDEX fee_structures_one_active_class ON app.fee_structures (term_id, level_id, class_id)
  WHERE status = 'active' AND class_id IS NOT NULL;

CREATE TABLE app.fee_structure_lines (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  fee_structure_id uuid NOT NULL REFERENCES app.fee_structures(id),
  fee_item_id uuid NOT NULL REFERENCES app.fee_items(id),
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas >= 0),
  is_optional boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT fee_structure_lines_item_key UNIQUE (fee_structure_id, fee_item_id)
);

-- Active/retired structures are immutable: only active → retired (plus retired_* / updated_* / version).
CREATE OR REPLACE FUNCTION app.guard_fee_structure_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - ARRAY['status','retired_at','retired_by','updated_at','updated_by','version'])
       = (to_jsonb(OLD) - ARRAY['status','retired_at','retired_by','updated_at','updated_by','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Fee structure % is % and cannot be changed. Retire it and create a new one.', OLD.id, OLD.status
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER fee_structures_guard BEFORE UPDATE ON app.fee_structures
  FOR EACH ROW EXECUTE FUNCTION app.guard_fee_structure_update();

CREATE OR REPLACE FUNCTION app.guard_fee_structure_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st app.fee_structure_status;
BEGIN
  SELECT status INTO st FROM app.fee_structures
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.fee_structure_id ELSE NEW.fee_structure_id END;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Lines of a % fee structure cannot be changed', st USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.fee_structure_id <> NEW.fee_structure_id THEN
    SELECT status INTO st FROM app.fee_structures WHERE id = OLD.fee_structure_id;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'Lines of a % fee structure cannot be changed', st USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER fee_structure_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON app.fee_structure_lines
  FOR EACH ROW EXECUTE FUNCTION app.guard_fee_structure_lines();

CREATE TABLE app.student_optional_items (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  term_id uuid NOT NULL REFERENCES app.terms(id),
  fee_item_id uuid NOT NULL REFERENCES app.fee_items(id),
  opted_in boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT student_optional_items_key UNIQUE (student_id, term_id, fee_item_id)
);

CREATE TABLE app.invoices (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  invoice_no text NOT NULL UNIQUE,
  student_id uuid NOT NULL REFERENCES app.students(id),
  term_id uuid NOT NULL REFERENCES app.terms(id),
  class_id uuid REFERENCES app.classes(id),
  issue_date date NOT NULL DEFAULT current_date,
  due_date date,
  opening_balance_pesewas bigint NOT NULL DEFAULT 0,  -- signed snapshot from the ledger (negative = credit)
  total_pesewas bigint NOT NULL CHECK (total_pesewas >= 0),
  status app.invoice_status NOT NULL DEFAULT 'issued',
  void_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES app.users(id),
  generation_batch_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (due_date IS NULL OR due_date >= issue_date),
  CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE UNIQUE INDEX invoices_one_issued_per_term ON app.invoices (student_id, term_id) WHERE status = 'issued';
CREATE INDEX invoices_term_idx ON app.invoices (term_id);
CREATE INDEX invoices_batch_idx ON app.invoices (generation_batch_id) WHERE generation_batch_id IS NOT NULL;

-- Invoices: only issued → void (with void_* / updated_* / version) may change.
CREATE OR REPLACE FUNCTION app.guard_invoice_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'issued' AND NEW.status = 'void'
     AND (to_jsonb(NEW) - ARRAY['status','void_reason','voided_at','voided_by','updated_at','updated_by','version'])
       = (to_jsonb(OLD) - ARRAY['status','void_reason','voided_at','voided_by','updated_at','updated_by','version']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Invoice % cannot be edited; only issued → void is allowed', OLD.invoice_no
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER invoices_guard BEFORE UPDATE ON app.invoices
  FOR EACH ROW EXECUTE FUNCTION app.guard_invoice_update();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON app.invoices
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

CREATE TABLE app.invoice_lines (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  invoice_id uuid NOT NULL REFERENCES app.invoices(id),
  fee_item_id uuid REFERENCES app.fee_items(id),
  description text NOT NULL,
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas >= 0),
  allocation_priority int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX invoice_lines_invoice_idx ON app.invoice_lines (invoice_id);

CREATE TABLE app.cash_ups (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  business_date date NOT NULL,
  opened_by uuid NOT NULL REFERENCES app.users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES app.users(id),
  closed_at timestamptz,
  expected_by_method jsonb,
  counted_by_method jsonb,
  variance_pesewas bigint,                            -- signed: counted − expected
  notes text,
  status app.cash_up_status NOT NULL DEFAULT 'open',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX cash_ups_business_date_key ON app.cash_ups (business_date);
CREATE UNIQUE INDEX cash_ups_one_open ON app.cash_ups (status) WHERE status = 'open';

-- enum → text is only STABLE in PostgreSQL; labels of payment_method are never renamed, so this is safe.
CREATE OR REPLACE FUNCTION app.payment_reference_key(m app.payment_method, ref text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ref IS NULL OR btrim(ref) = '' THEN NULL ELSE m::text || ':' || upper(btrim(ref)) END
$$;

CREATE TABLE app.payments (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  receipt_no text NOT NULL UNIQUE,
  student_id uuid NOT NULL REFERENCES app.students(id),
  payer_guardian_id uuid REFERENCES app.guardians(id),
  payer_name text NOT NULL,
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas > 0),
  method app.payment_method NOT NULL,
  reference_no text,
  reference_key text GENERATED ALWAYS AS (app.payment_reference_key(method, reference_no)) STORED,
  bank_name text,
  cheque_no text,
  received_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES app.users(id),
  notes text,
  attachment_file_id uuid REFERENCES app.files(id),
  status app.payment_status NOT NULL DEFAULT 'confirmed',
  source app.payment_source NOT NULL DEFAULT 'manual',
  provider text,                                      -- v2 (gateway name)
  external_reference text,                            -- v2 (gateway transaction id)
  idempotency_key text NOT NULL,
  idempotency_request_hash text,
  duplicate_override_reason text,
  cash_up_id uuid REFERENCES app.cash_ups(id),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES app.users(id),
  reversal_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payments_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT payments_external_reference_key UNIQUE (external_reference),
  CHECK (method <> 'cheque' OR cheque_no IS NOT NULL OR reference_no IS NOT NULL),
  CHECK (status <> 'reversed' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE INDEX payments_reference_key_idx ON app.payments (reference_key) WHERE reference_key IS NOT NULL;
CREATE INDEX payments_student_idx ON app.payments (student_id, received_at DESC);
CREATE INDEX payments_received_at_idx ON app.payments (received_at);
CREATE INDEX payments_cash_up_idx ON app.payments (cash_up_id) WHERE cash_up_id IS NOT NULL;
CREATE INDEX payments_payer_guardian_idx ON app.payments (payer_guardian_id) WHERE payer_guardian_id IS NOT NULL;

-- The only allowed UPDATE on payments: status confirmed → reversed (with reversal metadata).
CREATE OR REPLACE FUNCTION app.guard_payment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- reference_key is a generated column: it is NULL in NEW inside BEFORE triggers, so it is excluded.
  IF OLD.status = 'confirmed' AND NEW.status = 'reversed'
     AND (to_jsonb(NEW) - ARRAY['status','reversed_at','reversed_by','reversal_reason','updated_at','updated_by','version','reference_key'])
       = (to_jsonb(OLD) - ARRAY['status','reversed_at','reversed_by','reversal_reason','updated_at','updated_by','version','reference_key']) THEN
    IF NEW.reversed_at IS NULL THEN NEW.reversed_at := now(); END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payment % cannot be edited; only confirmed → reversed is allowed', OLD.receipt_no
    USING ERRCODE = 'insufficient_privilege', HINT = 'Record a reversal instead.';
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.guard_payment_update();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

CREATE TABLE app.payment_allocations (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  payment_id uuid NOT NULL REFERENCES app.payments(id),
  invoice_line_id uuid REFERENCES app.invoice_lines(id), -- NULL = unallocated credit
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas <> 0),
  allocation_batch_id uuid NOT NULL,
  is_reversal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (is_reversal = (amount_pesewas < 0))
);
CREATE INDEX payment_allocations_payment_idx ON app.payment_allocations (payment_id);
CREATE INDEX payment_allocations_line_idx ON app.payment_allocations (invoice_line_id) WHERE invoice_line_id IS NOT NULL;

CREATE TABLE app.adjustments (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  term_id uuid REFERENCES app.terms(id),
  type app.adjustment_type NOT NULL,
  fee_item_id uuid REFERENCES app.fee_items(id),
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas > 0),
  percent_bp int CHECK (percent_bp IS NULL OR percent_bp BETWEEN 1 AND 10000),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status app.adjustment_status NOT NULL DEFAULT 'pending',
  requested_by uuid NOT NULL REFERENCES app.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES app.users(id),
  approved_at timestamptz,
  rejected_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT adjustments_maker_checker CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status NOT IN ('approved', 'reversed') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX adjustments_student_idx ON app.adjustments (student_id);
CREATE INDEX adjustments_pending_idx ON app.adjustments (status) WHERE status = 'pending';
CREATE TRIGGER adjustments_no_delete BEFORE DELETE ON app.adjustments
  FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete();

CREATE TABLE app.ledger_entries (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  entry_no bigserial NOT NULL UNIQUE,
  student_id uuid NOT NULL REFERENCES app.students(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  term_id uuid REFERENCES app.terms(id),
  entry_type app.ledger_entry_type NOT NULL,
  amount_pesewas bigint NOT NULL CHECK (amount_pesewas <> 0),  -- + owed by family, − paid/credited
  invoice_line_id uuid REFERENCES app.invoice_lines(id),
  payment_id uuid REFERENCES app.payments(id),
  adjustment_id uuid REFERENCES app.adjustments(id),
  reverses_entry_id uuid UNIQUE REFERENCES app.ledger_entries(id),
  description text NOT NULL,
  posted_by uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (entry_type <> 'invoice_charge' OR (invoice_line_id IS NOT NULL AND amount_pesewas > 0)),
  CHECK (entry_type <> 'payment' OR (payment_id IS NOT NULL AND amount_pesewas < 0)),
  CHECK (entry_type <> 'adjustment' OR adjustment_id IS NOT NULL),
  CHECK (entry_type <> 'reversal' OR reverses_entry_id IS NOT NULL),
  CHECK (reverses_entry_id IS NULL OR entry_type = 'reversal')
);
CREATE INDEX ledger_entries_student_idx ON app.ledger_entries (student_id, entry_no);
CREATE INDEX ledger_entries_term_idx ON app.ledger_entries (term_id);
CREATE INDEX ledger_entries_payment_idx ON app.ledger_entries (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX ledger_entries_invoice_line_idx ON app.ledger_entries (invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE INDEX ledger_entries_adjustment_idx ON app.ledger_entries (adjustment_id) WHERE adjustment_id IS NOT NULL;
CREATE INDEX ledger_entries_posted_at_idx ON app.ledger_entries (posted_at);

-- A reversal must exactly negate the entry it reverses and belong to the same student.
CREATE OR REPLACE FUNCTION app.check_ledger_reversal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  orig app.ledger_entries;
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL THEN
    SELECT * INTO orig FROM app.ledger_entries WHERE id = NEW.reverses_entry_id;
    IF orig.entry_type = 'reversal' THEN
      RAISE EXCEPTION 'A reversal entry cannot itself be reversed' USING ERRCODE = 'check_violation';
    END IF;
    IF orig.student_id <> NEW.student_id OR orig.amount_pesewas <> -NEW.amount_pesewas THEN
      RAISE EXCEPTION 'Reversal must negate entry % for the same student', orig.entry_no USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_check_reversal BEFORE INSERT ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.check_ledger_reversal();
