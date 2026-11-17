-- 0007 reference rows every install needs. All values are editable by the admin afterwards.
SET LOCAL search_path = app, public;

INSERT INTO app.school_profile (id, name, school_code, timezone, currency)
VALUES (1, 'Kansview School (set the school name in Settings)', 'KSV', 'Africa/Accra', 'GHS');

-- Levels: Creche → JHS3
WITH v(code, name, sort_order, is_final_level) AS (VALUES
  ('CRECHE',  'Creche',    10, false),
  ('NURSERY', 'Nursery',   20, false),
  ('KG1',     'KG 1',      30, false),
  ('KG2',     'KG 2',      40, false),
  ('P1',      'Primary 1', 50, false),
  ('P2',      'Primary 2', 60, false),
  ('P3',      'Primary 3', 70, false),
  ('P4',      'Primary 4', 80, false),
  ('P5',      'Primary 5', 90, false),
  ('P6',      'Primary 6', 100, false),
  ('JHS1',    'JHS 1',     110, false),
  ('JHS2',    'JHS 2',     120, false),
  ('JHS3',    'JHS 3',     130, true))
INSERT INTO app.levels (code, name, sort_order, is_final_level) SELECT code, name, sort_order, is_final_level FROM v;

UPDATE app.levels l SET next_level_id = n.id
  FROM (SELECT id, lead(id) OVER (ORDER BY sort_order) AS next_id FROM app.levels) x
  JOIN app.levels n ON n.id = x.next_id
 WHERE l.id = x.id AND NOT l.is_final_level;

-- Gap-free document counters
INSERT INTO app.doc_counters (doc_type, prefix, pad_width) VALUES
  ('receipt', 'RCP', 6),
  ('reversal', 'REV', 6),
  ('invoice', 'INV', 6),
  ('transfer_letter', 'TL', 6);

-- Policy settings (validated by a Zod schema per key in the API)
INSERT INTO app.settings (key, value, description) VALUES
  ('promotion.block_on_arrears', '"warn"', 'off | warn | block: what promotion does for students with unpaid fees'),
  ('promotion.undo_window_days', '14', 'Days after commit during which a promotion run can be undone'),
  ('attendance.sms_on_absence', 'true', 'Send an SMS to the primary guardian when a student is marked absent (once per day)'),
  ('attendance.pm_session_enabled', 'false', 'Take a second (afternoon) register'),
  ('finance.allocation_order', '"oldest_first_by_priority"', 'How payments are allocated to invoice lines'),
  ('finance.reversal_after_cashup_requires_admin', 'true', 'Reversing a payment after the day is closed needs ADMIN approval'),
  ('finance.duplicate_reference_warning', 'true', 'Warn when a MoMo/bank reference was already used'),
  ('messaging.bulk_approval_threshold', '50', 'Bulk messages to more recipients than this need ADMIN approval'),
  ('messaging.default_channel', '"sms"', 'sms | whatsapp'),
  ('security.session_idle_minutes', '30', 'Sign out after this many idle minutes'),
  ('security.session_absolute_hours', '12', 'Maximum session length in hours'),
  ('security.lockout_threshold', '5', 'Failed sign-ins before an account is locked'),
  ('security.lockout_minutes', '15', 'Minutes an account stays locked'),
  ('dpa.request_response_days', '21', 'Days to answer a data subject request (confirm with counsel)'),
  ('retention.student_records_years_after_leaving', '7', 'Years after leaving before student personal data is anonymised (student code and finance totals kept)'),
  ('retention.finance_records_years', '7', 'Years finance records are kept'),
  ('retention.audit_events_years', '7', 'Years audit events are kept'),
  ('retention.login_attempts_days', '90', 'Days login attempts are kept'),
  ('retention.idempotency_records_days', '7', 'Days idempotency records are kept'),
  ('retention.message_bodies_days', '365', 'Days SMS bodies are kept before being blanked');

-- Default grading scale (common basic-school 9-band scale; configurable per level)
WITH s AS (
  INSERT INTO app.grading_scales (name, is_default) VALUES ('Basic school (A1–F9)', true) RETURNING id
)
INSERT INTO app.grading_bands (grading_scale_id, min_score, max_score, grade, remark, sort_order)
SELECT s.id, v.min_score, v.max_score, v.grade, v.remark, v.sort_order FROM s, (VALUES
  (80, 100, 'A1', 'Excellent', 1),
  (70, 79,  'B2', 'Very good', 2),
  (65, 69,  'B3', 'Good', 3),
  (60, 64,  'C4', 'Credit', 4),
  (55, 59,  'C5', 'Credit', 5),
  (50, 54,  'C6', 'Credit', 6),
  (45, 49,  'D7', 'Pass', 7),
  (40, 44,  'E8', 'Pass', 8),
  (0,  39,  'F9', 'Fail', 9)) AS v(min_score, max_score, grade, remark, sort_order);

-- Default assessment weights (school-wide row: level_id NULL)
INSERT INTO app.assessment_config (level_id, class_score_weight, exam_score_weight) VALUES (NULL, 30, 70);

-- Default SMS templates. Placeholders are validated against an allow-list per template code.
INSERT INTO app.message_templates (code, channel, name, body) VALUES
  ('fee_reminder', 'sms', 'Fee reminder',
   'Dear {{guardianName}}, {{studentName}} ({{studentCode}}) has an outstanding balance of {{balance}} for {{termName}}. Kindly pay by {{dueDate}}. Thank you. {{schoolName}}'),
  ('absence_alert', 'sms', 'Absence alert',
   'Dear {{guardianName}}, {{studentName}} was marked absent from school today, {{date}}. Please call {{schoolPhone}} if you were not aware. {{schoolName}}'),
  ('announcement', 'sms', 'General announcement',
   '{{schoolName}}: {{message}}'),
  ('closure_notice', 'sms', 'School closure notice',
   '{{schoolName}}: The school will be closed on {{date}}. {{message}}'),
  ('emergency', 'sms', 'Emergency message',
   'URGENT from {{schoolName}}: {{message}} Please call {{schoolPhone}}.');
