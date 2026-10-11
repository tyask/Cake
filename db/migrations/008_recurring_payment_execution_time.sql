-- Generated entries use the job start time. Scheduling uses the next
-- configured date, with a 09:00 JST boundary.
CREATE OR REPLACE FUNCTION cake_recurring_scheduled_on(target_month date, target_day integer)
RETURNS date AS $cake_recurring_date$
  SELECT date_trunc('month',target_month)::date + (least(target_day,
    extract(day FROM (date_trunc('month',target_month) + interval '1 month - 1 day'))::integer)-1);
$cake_recurring_date$ LANGUAGE sql IMMUTABLE;

-- A save before the configured day's 09:00 JST schedules this month. At the
-- boundary and afterwards it schedules next month, without consulting history.
CREATE OR REPLACE FUNCTION cake_recurring_next_scheduled_on(target_day integer, target_now timestamptz)
RETURNS date AS $cake_recurring_next_date$
  WITH candidate AS (
    SELECT cake_recurring_scheduled_on(date_trunc('month',target_now AT TIME ZONE 'Asia/Tokyo')::date,target_day) AS scheduled_on
  )
  SELECT CASE WHEN target_now < ((scheduled_on + TIME '09:00') AT TIME ZONE 'Asia/Tokyo')
    THEN scheduled_on
    ELSE cake_recurring_scheduled_on((date_trunc('month',scheduled_on) + interval '1 month')::date,target_day) END
  FROM candidate;
$cake_recurring_next_date$ LANGUAGE sql IMMUTABLE;

ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS next_scheduled_on date;
UPDATE recurring_payments SET next_scheduled_on = cake_recurring_next_scheduled_on(day_of_month,now())
  WHERE next_scheduled_on IS NULL;
ALTER TABLE recurring_payments ALTER COLUMN next_scheduled_on SET NOT NULL;

CREATE OR REPLACE FUNCTION cake_generate_recurring_payment(
  target_workspace uuid, target_payment uuid, test_mode boolean DEFAULT false, target_now timestamptz DEFAULT now()
)
RETURNS jsonb AS $cake_generate_recurring$
DECLARE
  payment recurring_payments;
  today date := (target_now AT TIME ZONE 'Asia/Tokyo')::date;
  this_month date := date_trunc('month',today)::date;
  config jsonb;
  checked jsonb;
  failure_code text;
  generated_id uuid := gen_random_uuid();
BEGIN
  IF target_now IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID'; END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped'); END IF;
  SELECT * INTO payment FROM recurring_payments WHERE id = target_payment AND workspace_id = target_workspace FOR UPDATE;
  IF NOT FOUND OR payment.state <> 'ACTIVE' OR payment.next_scheduled_on > today THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  config := cake_recurring_current_config(payment);
  IF cake_recurring_scheduled_on(this_month,(config->>'dayOfMonth')::integer) <> today
    OR target_now < ((today + TIME '09:00') AT TIME ZONE 'Asia/Tokyo') THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  PERFORM cake_recurring_lock_users(target_workspace,ARRAY[payment.authorized_by,config->>'actorUserId']);
  -- Separate identities by environment without changing an unrelated setting.
  IF NOT cake_recurring_identity_matches(payment.authorized_by,test_mode) THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = payment.authorized_by)
    OR NOT cake_recurring_user_allowed(payment.authorized_by,test_mode) THEN failure_code := 'AUTHORIZER_UNAVAILABLE';
  ELSE
    checked := cake_recurring_check_members(target_workspace,config,test_mode,true);
    failure_code := checked->>'errorCode';
  END IF;
  IF failure_code IS NOT NULL THEN
    UPDATE recurring_payments SET state = 'BLOCKED', blocked_reason = failure_code, revision = revision + 1,
      updated_at = now() WHERE id = payment.id;
    RETURN jsonb_build_object('status','blocked','errorCode',failure_code);
  END IF;
  -- Insert and next-date advancement are atomic. A saved configuration can
  -- schedule another payment in the same month; each entry has its own ID.
  INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
    expense_class,split_weights,external_id,source,created_by,updated_by,memo)
  VALUES(generated_id,target_workspace,target_now,config->>'merchant',config->>'method','PAYMENT',
    (config->>'amountYen')::integer,config->>'actorUserId',config->>'expenseClass',checked->'splitWeights',
    'recurring_' || payment.id::text || '_' || to_char(today,'YYYYMMDD') || '_' || generated_id::text,'RECURRING',payment.authorized_by,payment.authorized_by,config->>'memo')
  RETURNING id INTO generated_id;
  UPDATE recurring_payments SET next_scheduled_on = cake_recurring_scheduled_on((this_month + interval '1 month')::date,payment.day_of_month),
    updated_at = now() WHERE id = payment.id;
  RETURN jsonb_build_object('status','created','transactionId',generated_id);
END;
$cake_generate_recurring$ LANGUAGE plpgsql;
