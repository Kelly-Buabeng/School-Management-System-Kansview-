-- 0002 core tables: users/security, configuration, files, students & safety, enrolment, staff,
-- attendance, academics, welfare. created_by/updated_by/archived_by are plain uuids (user ids) without
-- FKs so system jobs and imports can write them; business actor columns (recorded_by, approved_by…) have FKs.
SET LOCAL search_path = app, public;

-- ===========================================================================
-- Security
-- ===========================================================================
CREATE TABLE app.users (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  username text NOT NULL,
  email text,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  user_type app.user_type NOT NULL DEFAULT 'staff',
  roles text[] NOT NULL DEFAULT '{}',
  status app.user_status NOT NULL DEFAULT 'active',
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_enc bytea,
  mfa_recovery_codes_hash text[],
  failed_login_count int NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  password_changed_at timestamptz,
  must_change_password boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  staff_id uuid,                                   -- FK added after app.staff exists
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text,
  CONSTRAINT users_roles_valid CHECK (roles <@ ARRAY['ADMIN','BURSAR','HEADTEACHER','REGISTRAR','TEACHER']::text[]),
  CONSTRAINT users_username_format CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 64)
);
CREATE UNIQUE INDEX users_username_key ON app.users (username);
CREATE UNIQUE INDEX users_email_key ON app.users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE app.user_sessions (
  id text PRIMARY KEY,                             -- SHA-256 (hex) of the random 256-bit session id
  user_id uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  mfa_verified_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX user_sessions_user_idx ON app.user_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE app.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id uuid NOT NULL REFERENCES app.users(id),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX password_reset_tokens_user_idx ON app.password_reset_tokens (user_id);

CREATE TABLE app.login_attempts (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  username_tried text NOT NULL,
  ip inet,
  succeeded boolean NOT NULL,
  reason text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_username_at_idx ON app.login_attempts (lower(username_tried), at DESC);
CREATE INDEX login_attempts_ip_at_idx ON app.login_attempts (ip, at DESC);

CREATE TABLE app.idempotency_records (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  key text NOT NULL,
  user_id uuid NOT NULL REFERENCES app.users(id),
  route text NOT NULL,
  request_hash text NOT NULL,
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_key UNIQUE (user_id, route, key)
);
CREATE INDEX idempotency_records_created_idx ON app.idempotency_records (created_at);

-- ===========================================================================
-- Files
-- ===========================================================================
CREATE TABLE app.files (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  scan_status app.file_scan_status NOT NULL DEFAULT 'pending',
  scanned_at timestamptz,
  uploaded_by uuid REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX files_sha256_idx ON app.files (sha256);

-- ===========================================================================
-- Configuration
-- ===========================================================================
CREATE TABLE app.school_profile (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL,
  school_code text NOT NULL CHECK (school_code ~ '^[A-Z]{3}$'),
  motto text,
  address text,
  phone text,
  email text,
  logo_file_id uuid REFERENCES app.files(id),
  timezone text NOT NULL DEFAULT 'Africa/Accra',
  currency text NOT NULL DEFAULT 'GHS' CHECK (currency ~ '^[A-Z]{3}$'),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE app.settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  value jsonb NOT NULL,
  description text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE app.academic_years (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  name text NOT NULL UNIQUE CHECK (name ~ '^[0-9]{4}/[0-9]{4}$'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status app.period_status NOT NULL DEFAULT 'planned',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (end_date > start_date),
  CONSTRAINT academic_years_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);
CREATE UNIQUE INDEX academic_years_one_current ON app.academic_years (status) WHERE status = 'current';

CREATE TABLE app.terms (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  number int NOT NULL CHECK (number BETWEEN 1 AND 3),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status app.period_status NOT NULL DEFAULT 'planned',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (end_date > start_date),
  CONSTRAINT terms_year_number_key UNIQUE (academic_year_id, number),
  CONSTRAINT terms_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&)
);
CREATE UNIQUE INDEX terms_one_current ON app.terms (status) WHERE status = 'current';

CREATE TABLE app.levels (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{1,10}$'),
  name text NOT NULL,
  sort_order int NOT NULL,
  is_final_level boolean NOT NULL DEFAULT false,
  next_level_id uuid REFERENCES app.levels(id),
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (next_level_id IS NULL OR next_level_id <> id),
  CHECK (NOT (is_final_level AND next_level_id IS NOT NULL))
);
CREATE UNIQUE INDEX levels_sort_order_key ON app.levels (sort_order);

-- ===========================================================================
-- Staff (before classes: class teacher FK)
-- ===========================================================================
CREATE TABLE app.staff (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  staff_code text NOT NULL UNIQUE,
  first_name text NOT NULL,
  middle_names text,
  last_name text NOT NULL,
  title text,
  gender app.gender,
  date_of_birth date,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  address text,
  staff_type app.staff_type NOT NULL,
  job_title text,
  employment_date date,
  status app.staff_status NOT NULL DEFAULT 'active',
  ghana_card_enc bytea,
  ssnit_no_enc bytea,
  user_id uuid UNIQUE REFERENCES app.users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX staff_name_trgm ON app.staff USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);
CREATE INDEX staff_phone_idx ON app.staff (phone) WHERE phone IS NOT NULL;

ALTER TABLE app.users ADD CONSTRAINT users_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES app.staff(id);
CREATE UNIQUE INDEX users_staff_id_key ON app.users (staff_id) WHERE staff_id IS NOT NULL;

CREATE TABLE app.staff_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  staff_id uuid NOT NULL REFERENCES app.staff(id),
  priority int NOT NULL CHECK (priority >= 1),
  name text NOT NULL,
  relationship text,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT staff_emergency_contacts_priority_key UNIQUE (staff_id, priority) DEFERRABLE INITIALLY IMMEDIATE
);

-- ===========================================================================
-- Classes, subjects, grading
-- ===========================================================================
CREATE TABLE app.classes (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  level_id uuid NOT NULL REFERENCES app.levels(id),
  stream text CHECK (stream IS NULL OR stream ~ '^[A-Z]{1,3}$'),
  display_name text NOT NULL,
  capacity int CHECK (capacity IS NULL OR capacity > 0),
  class_teacher_staff_id uuid REFERENCES app.staff(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text,
  CONSTRAINT classes_year_level_stream_key UNIQUE NULLS NOT DISTINCT (academic_year_id, level_id, stream)
);
CREATE INDEX classes_level_idx ON app.classes (level_id);

CREATE TABLE app.subjects (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CREATE TABLE app.level_subjects (
  level_id uuid NOT NULL REFERENCES app.levels(id),
  subject_id uuid NOT NULL REFERENCES app.subjects(id),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (level_id, subject_id)
);

CREATE TABLE app.grading_scales (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  name text NOT NULL UNIQUE,
  applies_to_level_ids uuid[] NOT NULL DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE UNIQUE INDEX grading_scales_one_default ON app.grading_scales (is_default) WHERE is_default;

CREATE TABLE app.grading_bands (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  grading_scale_id uuid NOT NULL REFERENCES app.grading_scales(id) ON DELETE CASCADE,
  min_score int NOT NULL CHECK (min_score BETWEEN 0 AND 100),
  max_score int NOT NULL CHECK (max_score BETWEEN 0 AND 100),
  grade text NOT NULL,
  remark text,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (max_score >= min_score),
  CONSTRAINT grading_bands_grade_key UNIQUE (grading_scale_id, grade),
  CONSTRAINT grading_bands_no_overlap EXCLUDE USING gist (
    grading_scale_id WITH =, int4range(min_score, max_score, '[]') WITH &&)
);

CREATE TABLE app.assessment_config (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  level_id uuid UNIQUE REFERENCES app.levels(id),   -- NULL row = school default
  class_score_weight int NOT NULL CHECK (class_score_weight BETWEEN 0 AND 100),
  exam_score_weight int NOT NULL CHECK (exam_score_weight BETWEEN 0 AND 100),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (class_score_weight + exam_score_weight = 100)
);
CREATE UNIQUE INDEX assessment_config_one_default ON app.assessment_config ((true)) WHERE level_id IS NULL;

CREATE TABLE app.id_counters (
  scope text PRIMARY KEY,                           -- e.g. 'student:26'
  last_value int NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.doc_counters (
  doc_type text PRIMARY KEY,                        -- receipt, reversal, invoice, transfer_letter
  prefix text NOT NULL CHECK (prefix ~ '^[A-Z]{2,5}$'),
  pad_width int NOT NULL DEFAULT 6 CHECK (pad_width BETWEEN 3 AND 12),
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Students and safety
-- ===========================================================================
CREATE TABLE app.students (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_code text NOT NULL,
  admission_year int NOT NULL CHECK (admission_year BETWEEN 1990 AND 2200),
  admission_seq int NOT NULL CHECK (admission_seq BETWEEN 1 AND 99999),
  first_name text NOT NULL,
  middle_names text,
  last_name text NOT NULL,
  preferred_name text,
  date_of_birth date NOT NULL,
  gender app.gender NOT NULL,
  nationality text DEFAULT 'Ghanaian',
  home_address text,
  previous_school text,
  admission_date date NOT NULL DEFAULT current_date,
  admission_class_id uuid REFERENCES app.classes(id),
  photo_file_id uuid REFERENCES app.files(id),
  birth_cert_no text,
  religion text,
  languages text[] NOT NULL DEFAULT '{}',
  status app.student_status NOT NULL DEFAULT 'active',
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig,
      coalesce(first_name, '') || ' ' || coalesce(middle_names, '') || ' ' || coalesce(last_name, '') || ' ' ||
      coalesce(preferred_name, '') || ' ' || coalesce(student_code, '') || ' ' || replace(coalesce(student_code, ''), '-', ''))
  ) STORED,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text,
  CONSTRAINT students_student_code_key UNIQUE (student_code),
  CONSTRAINT students_admission_year_seq_key UNIQUE (admission_year, admission_seq),
  CONSTRAINT students_student_code_valid CHECK (app.is_valid_student_code(student_code)),
  CONSTRAINT students_code_matches_seq CHECK (
    substr(student_code, 5, 2) = lpad((admission_year % 100)::text, 2, '0')
    AND substr(student_code, 8, 5)::int = admission_seq)
);
CREATE INDEX students_search_vector_idx ON app.students USING gin (search_vector);
CREATE INDEX students_full_name_trgm ON app.students USING gin (
  (lower(first_name || ' ' || coalesce(middle_names || ' ', '') || last_name)) gin_trgm_ops);
CREATE INDEX students_last_name_trgm ON app.students USING gin (lower(last_name) gin_trgm_ops);
CREATE INDEX students_code_trgm ON app.students USING gin (student_code gin_trgm_ops);
CREATE INDEX students_dob_idx ON app.students (date_of_birth);
CREATE INDEX students_status_idx ON app.students (status) WHERE archived_at IS NULL;

CREATE TABLE app.student_medical (
  student_id uuid PRIMARY KEY REFERENCES app.students(id),
  blood_group text CHECK (blood_group IS NULL OR blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  allergies_enc bytea,
  chronic_conditions_enc bytea,
  medication_notes_enc bytea,
  special_needs_enc bytea,
  doctor_name text,
  clinic_name text,
  clinic_phone text,
  alert_summary text CHECK (alert_summary IS NULL OR length(alert_summary) <= 200),
  has_alert boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (NOT has_alert OR alert_summary IS NOT NULL)
);

CREATE TABLE app.student_documents (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  file_id uuid NOT NULL REFERENCES app.files(id),
  doc_type app.student_document_type NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX student_documents_student_idx ON app.student_documents (student_id) WHERE archived_at IS NULL;

CREATE TABLE app.guardians (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  first_name text NOT NULL,
  last_name text NOT NULL,
  title text,
  phone_primary text NOT NULL CHECK (phone_primary ~ '^\+[1-9][0-9]{7,14}$'),
  phone_secondary text CHECK (phone_secondary IS NULL OR phone_secondary ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_number text CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  occupation text,
  workplace text,
  home_address text,
  work_address text,
  ghana_card_enc bytea,
  ghana_card_bidx bytea,
  ghana_card_last4 text CHECK (ghana_card_last4 IS NULL OR ghana_card_last4 ~ '^[0-9A-Z]{4}$'),
  user_id uuid UNIQUE REFERENCES app.users(id),     -- v2 parent portal
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX guardians_phone_primary_idx ON app.guardians (phone_primary);
CREATE INDEX guardians_phone_secondary_idx ON app.guardians (phone_secondary) WHERE phone_secondary IS NOT NULL;
CREATE INDEX guardians_whatsapp_idx ON app.guardians (whatsapp_number) WHERE whatsapp_number IS NOT NULL;
CREATE INDEX guardians_ghana_card_bidx_idx ON app.guardians (ghana_card_bidx) WHERE ghana_card_bidx IS NOT NULL;
CREATE INDEX guardians_name_trgm ON app.guardians USING gin ((lower(first_name || ' ' || last_name)) gin_trgm_ops);

CREATE TABLE app.student_guardians (
  student_id uuid NOT NULL REFERENCES app.students(id),
  guardian_id uuid NOT NULL REFERENCES app.guardians(id),
  relationship app.guardian_relationship NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  is_fee_payer boolean NOT NULL DEFAULT false,
  can_pick_up boolean NOT NULL DEFAULT true,
  lives_with_student boolean NOT NULL DEFAULT true,
  receives_sms boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (student_id, guardian_id)
);
CREATE UNIQUE INDEX student_guardians_one_primary ON app.student_guardians (student_id) WHERE is_primary;
CREATE INDEX student_guardians_guardian_idx ON app.student_guardians (guardian_id);

CREATE TABLE app.emergency_contacts (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  priority int NOT NULL CHECK (priority >= 1),
  guardian_id uuid REFERENCES app.guardians(id),
  name text,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  relationship text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT emergency_contacts_guardian_or_person CHECK (
    guardian_id IS NOT NULL OR (name IS NOT NULL AND phone IS NOT NULL)),
  CONSTRAINT emergency_contacts_student_priority_key UNIQUE (student_id, priority) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE TABLE app.authorised_pickups (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  guardian_id uuid REFERENCES app.guardians(id),
  name text,
  relationship text,
  phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  photo_file_id uuid REFERENCES app.files(id),
  id_type text,
  id_number_last4 text,
  verification_notes text,
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text,
  CHECK (guardian_id IS NOT NULL OR name IS NOT NULL),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX authorised_pickups_student_idx ON app.authorised_pickups (student_id) WHERE archived_at IS NULL;

CREATE TABLE app.emergency_contact_logs (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  contact_ref text,                                 -- emergency_contacts.id / guardian id / free text
  phone_called text NOT NULL,
  outcome app.contact_outcome NOT NULL,
  notes text,
  contacted_by uuid NOT NULL REFERENCES app.users(id),
  contacted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emergency_contact_logs_student_idx ON app.emergency_contact_logs (student_id, contacted_at DESC);

CREATE TABLE app.student_status_history (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  from_status app.student_status,
  to_status app.student_status NOT NULL,
  effective_date date NOT NULL DEFAULT current_date,
  reason text,
  source app.status_change_source NOT NULL,
  source_ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX student_status_history_student_idx ON app.student_status_history (student_id, created_at);

-- ===========================================================================
-- Enrolment and promotion
-- ===========================================================================
CREATE TABLE app.promotion_runs (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  from_academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  to_academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  scope uuid[] NOT NULL DEFAULT '{}',               -- class ids
  status app.promotion_run_status NOT NULL DEFAULT 'draft',
  committed_at timestamptz,
  committed_by uuid REFERENCES app.users(id),
  undo_deadline timestamptz,
  undone_at timestamptz,
  undone_by uuid REFERENCES app.users(id),
  arrears_policy_snapshot text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (from_academic_year_id <> to_academic_year_id),
  CHECK (status <> 'committed' OR committed_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION app.promotion_runs_default_deadline() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.committed_at IS NOT NULL AND NEW.undo_deadline IS NULL THEN
    NEW.undo_deadline := NEW.committed_at + interval '14 days';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER promotion_runs_default_deadline BEFORE INSERT OR UPDATE ON app.promotion_runs
  FOR EACH ROW EXECUTE FUNCTION app.promotion_runs_default_deadline();

CREATE TABLE app.enrolments (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  class_id uuid NOT NULL REFERENCES app.classes(id),
  academic_year_id uuid NOT NULL REFERENCES app.academic_years(id),
  roll_number int CHECK (roll_number IS NULL OR roll_number > 0),
  start_date date NOT NULL,
  end_date date,
  status app.enrolment_status NOT NULL DEFAULT 'active',
  reason text,
  promotion_run_id uuid REFERENCES app.promotion_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK ((end_date IS NULL) = (status = 'active'))
);
CREATE UNIQUE INDEX enrolments_one_open_per_student ON app.enrolments (student_id) WHERE end_date IS NULL;
CREATE UNIQUE INDEX enrolments_open_roll_number ON app.enrolments (class_id, roll_number)
  WHERE end_date IS NULL AND roll_number IS NOT NULL;
CREATE INDEX enrolments_class_idx ON app.enrolments (class_id) WHERE end_date IS NULL;
CREATE INDEX enrolments_student_idx ON app.enrolments (student_id, start_date);
CREATE INDEX enrolments_year_idx ON app.enrolments (academic_year_id);

CREATE TABLE app.promotion_run_items (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  run_id uuid NOT NULL REFERENCES app.promotion_runs(id),
  student_id uuid NOT NULL REFERENCES app.students(id),
  from_enrolment_id uuid REFERENCES app.enrolments(id),
  action app.promotion_action NOT NULL,
  target_class_id uuid REFERENCES app.classes(id),
  outstanding_pesewas_snapshot bigint,
  arrears_flag boolean NOT NULL DEFAULT false,
  override_reason text,
  created_enrolment_id uuid REFERENCES app.enrolments(id),
  previous_status app.student_status,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT promotion_run_items_run_student_key UNIQUE (run_id, student_id),
  CHECK (action NOT IN ('promote', 'repeat') OR target_class_id IS NOT NULL)
);

CREATE TABLE app.staff_class_assignments (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  staff_id uuid NOT NULL REFERENCES app.staff(id),
  class_id uuid NOT NULL REFERENCES app.classes(id),
  subject_id uuid REFERENCES app.subjects(id),
  role app.staff_assignment_role NOT NULL,
  start_date date NOT NULL DEFAULT current_date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (role <> 'subject_teacher' OR subject_id IS NOT NULL)
);
CREATE INDEX staff_class_assignments_staff_idx ON app.staff_class_assignments (staff_id) WHERE end_date IS NULL;
CREATE INDEX staff_class_assignments_class_idx ON app.staff_class_assignments (class_id) WHERE end_date IS NULL;
CREATE UNIQUE INDEX staff_class_assignments_one_class_teacher ON app.staff_class_assignments (class_id)
  WHERE role = 'class_teacher' AND end_date IS NULL;

-- ===========================================================================
-- Attendance, academics, welfare
-- ===========================================================================
CREATE TABLE app.attendance_sessions (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  class_id uuid NOT NULL REFERENCES app.classes(id),
  date date NOT NULL,
  session app.attendance_session_kind NOT NULL DEFAULT 'am',
  taken_by uuid REFERENCES app.users(id),
  taken_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT attendance_sessions_class_date_session_key UNIQUE (class_id, date, session)
);
CREATE INDEX attendance_sessions_date_idx ON app.attendance_sessions (date);

CREATE TABLE app.attendance_records (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  session_id uuid NOT NULL REFERENCES app.attendance_sessions(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES app.students(id),
  status app.attendance_status NOT NULL,
  reason_code text,
  note text,
  sms_message_id uuid,                               -- FK added in 0004 (message_recipients)
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT attendance_records_session_student_key UNIQUE (session_id, student_id)
);
CREATE INDEX attendance_records_student_idx ON app.attendance_records (student_id);

CREATE TABLE app.term_scores (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  term_id uuid NOT NULL REFERENCES app.terms(id),
  class_id uuid NOT NULL REFERENCES app.classes(id),
  subject_id uuid NOT NULL REFERENCES app.subjects(id),
  student_id uuid NOT NULL REFERENCES app.students(id),
  class_score numeric(5,2) CHECK (class_score IS NULL OR class_score BETWEEN 0 AND 100),
  exam_score numeric(5,2) CHECK (exam_score IS NULL OR exam_score BETWEEN 0 AND 100),
  total numeric(5,2) GENERATED ALWAYS AS (
    CASE WHEN class_score IS NULL AND exam_score IS NULL THEN NULL
         ELSE coalesce(class_score, 0) + coalesce(exam_score, 0) END) STORED,
  grade text,
  subject_remark text,
  entered_by uuid REFERENCES app.users(id),
  locked_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT term_scores_term_subject_student_key UNIQUE (term_id, subject_id, student_id),
  CHECK (coalesce(class_score, 0) + coalesce(exam_score, 0) <= 100)
);
CREATE INDEX term_scores_class_term_idx ON app.term_scores (class_id, term_id);
CREATE INDEX term_scores_student_idx ON app.term_scores (student_id);

CREATE TABLE app.report_cards (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  term_id uuid NOT NULL REFERENCES app.terms(id),
  student_id uuid NOT NULL REFERENCES app.students(id),
  class_id uuid NOT NULL REFERENCES app.classes(id),
  overall_total numeric(7,2),
  average numeric(5,2),
  position int CHECK (position IS NULL OR position > 0),
  position_tied boolean NOT NULL DEFAULT false,
  class_size int,
  attendance_present int,
  attendance_total int,
  conduct text,
  interest text,
  class_teacher_remark text,
  head_remark text,
  next_term_begins date,
  status app.report_card_status NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  pdf_file_id uuid REFERENCES app.files(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT report_cards_term_student_key UNIQUE (term_id, student_id)
);
CREATE INDEX report_cards_class_term_idx ON app.report_cards (class_id, term_id);

CREATE TABLE app.incidents (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  occurred_at timestamptz NOT NULL,
  category text NOT NULL,
  severity app.incident_severity NOT NULL DEFAULT 'low',
  description text NOT NULL,
  action_taken text,
  reported_by uuid NOT NULL REFERENCES app.users(id),
  guardian_informed_at timestamptz,
  follow_up text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX incidents_student_idx ON app.incidents (student_id, occurred_at DESC);

CREATE TABLE app.health_visits (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  visited_at timestamptz NOT NULL DEFAULT now(),
  complaint text NOT NULL,
  treatment_given text,
  medication_given text,
  sent_home boolean NOT NULL DEFAULT false,
  guardian_informed_at timestamptz,
  attended_by uuid REFERENCES app.users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  archived_at timestamptz,
  archived_by uuid,
  archive_reason text
);
CREATE INDEX health_visits_student_idx ON app.health_visits (student_id, visited_at DESC);

CREATE TABLE app.withdrawals (
  id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
  student_id uuid NOT NULL REFERENCES app.students(id),
  type app.withdrawal_type NOT NULL,
  reason text NOT NULL,
  effective_date date NOT NULL,
  destination_school text,
  clearance jsonb NOT NULL DEFAULT '{}'::jsonb,
  status app.withdrawal_status NOT NULL DEFAULT 'pending_clearance',
  transfer_letter_file_id uuid REFERENCES app.files(id),
  letter_no text UNIQUE,
  completed_at timestamptz,
  completed_by uuid REFERENCES app.users(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE UNIQUE INDEX withdrawals_one_pending_per_student ON app.withdrawals (student_id) WHERE status = 'pending_clearance';
