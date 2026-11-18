-- 0009 CR-0005: attach payment evidence (MoMo screenshot, bank slip) after the payment is recorded.
-- Exactly one change of payments.attachment_file_id from NULL to a value, only through
-- app.attach_payment_evidence(), and only while the payment's cash-up is open (or, with no cash-up,
-- on the day it was received, Africa/Accra). Everything else on payments stays immutable.
SET LOCAL search_path = app, public;

CREATE OR REPLACE FUNCTION app.guard_payment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- reference_key is a generated column: it is NULL in NEW inside BEFORE triggers, so it is excluded.
  meta text[] := ARRAY['updated_at','updated_by','version','reference_key'];
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status = 'reversed'
     AND (to_jsonb(NEW) - (meta || ARRAY['status','reversed_at','reversed_by','reversal_reason']))
       = (to_jsonb(OLD) - (meta || ARRAY['status','reversed_at','reversed_by','reversal_reason'])) THEN
    IF NEW.reversed_at IS NULL THEN NEW.reversed_at := now(); END IF;
    RETURN NEW;
  END IF;
  IF current_setting('app.attach_payment_evidence', true) = 'on'
     AND OLD.attachment_file_id IS NULL AND NEW.attachment_file_id IS NOT NULL
     AND (to_jsonb(NEW) - (meta || ARRAY['attachment_file_id'])) = (to_jsonb(OLD) - (meta || ARRAY['attachment_file_id'])) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payment % cannot be edited; only confirmed → reversed is allowed', OLD.receipt_no
    USING ERRCODE = 'insufficient_privilege', HINT = 'Record a reversal instead.';
END $$;

CREATE OR REPLACE FUNCTION app.attach_payment_evidence(p_payment_id uuid, p_file_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog AS $$
DECLARE
  p app.payments;
  cu_status app.cash_up_status;
BEGIN
  IF p_file_id IS NULL THEN
    RAISE EXCEPTION 'A file is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM app.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % does not exist', p_payment_id USING ERRCODE = 'no_data_found';
  END IF;
  IF p.attachment_file_id IS NOT NULL THEN
    RAISE EXCEPTION 'Receipt % already has evidence attached', p.receipt_no USING ERRCODE = 'unique_violation';
  END IF;
  IF p.cash_up_id IS NOT NULL THEN
    SELECT status INTO cu_status FROM app.cash_ups WHERE id = p.cash_up_id;
    IF cu_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'Evidence can only be attached while the day''s cash-up is open (receipt %)', p.receipt_no
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  ELSIF (p.received_at AT TIME ZONE 'Africa/Accra')::date <> (now() AT TIME ZONE 'Africa/Accra')::date THEN
    RAISE EXCEPTION 'Evidence can only be attached on the day the payment was received (receipt %)', p.receipt_no
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM set_config('app.attach_payment_evidence', 'on', true);
  UPDATE app.payments SET attachment_file_id = p_file_id, updated_by = coalesce(p_user_id, updated_by) WHERE id = p_payment_id;
  PERFORM set_config('app.attach_payment_evidence', 'off', true);
END $$;

REVOKE ALL ON FUNCTION app.attach_payment_evidence(uuid, uuid, uuid) FROM PUBLIC;
SELECT app.apply_grants();
