-- Existing deployments receive a next scheduled date based solely on their
-- saved day and the migration time. Preserve legacy columns and transaction
-- snapshots for compatibility; last_generated_month no longer controls runs.
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

CREATE OR REPLACE FUNCTION cake_mutate_recurring_payment(
  target_workspace uuid, actor_id text, operation text, target_payment uuid DEFAULT NULL,
  expected_revision integer DEFAULT NULL, supplied_start date DEFAULT NULL, supplied_config jsonb DEFAULT NULL,
  test_mode boolean DEFAULT false, target_now timestamptz DEFAULT now()
)
RETURNS jsonb AS $cake_mutate_recurring$
DECLARE
  payment recurring_payments;
  checked jsonb;
BEGIN
  IF target_now IS NULL OR operation IS NULL OR operation NOT IN ('create','update','pause','resume','archive') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
  END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'FORBIDDEN'; END IF;
  IF operation <> 'create' THEN
    SELECT * INTO payment FROM recurring_payments WHERE id = target_payment AND workspace_id = target_workspace FOR UPDATE;
  END IF;
  PERFORM cake_recurring_lock_users(target_workspace, ARRAY[actor_id,payment.authorized_by,payment.actor_user_id,supplied_config->>'actorUserId']);
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = actor_id)
    OR NOT cake_recurring_user_allowed(actor_id,test_mode) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'FORBIDDEN';
  END IF;
  IF operation = 'create' THEN
    IF NOT cake_recurring_config_valid(supplied_config) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
    END IF;
    checked := cake_recurring_check_members(target_workspace,supplied_config,test_mode,false);
    IF checked ? 'errorCode' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = checked->>'errorCode'; END IF;
    INSERT INTO recurring_payments(workspace_id,next_scheduled_on,day_of_month,merchant,method,amount_yen,
      actor_user_id,expense_class,split_weights,memo,authorized_by,created_by,updated_by)
    VALUES(target_workspace,cake_recurring_next_scheduled_on((supplied_config->>'dayOfMonth')::integer,target_now),
      (supplied_config->>'dayOfMonth')::integer,
      btrim(supplied_config->>'merchant'),btrim(supplied_config->>'method'),(supplied_config->>'amountYen')::integer,
      supplied_config->>'actorUserId',supplied_config->>'expenseClass',supplied_config->'splitWeights',supplied_config->>'memo',
      actor_id,actor_id,actor_id) RETURNING * INTO payment;
    RETURN jsonb_build_object('payment',to_jsonb(payment));
  END IF;
  IF payment.id IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'NOT_FOUND'; END IF;
  IF expected_revision IS NULL OR payment.revision <> expected_revision OR payment.state = 'ARCHIVED'
    OR (operation = 'pause' AND payment.state <> 'ACTIVE')
    OR (operation = 'resume' AND payment.state NOT IN ('PAUSED','BLOCKED')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'CONFLICT';
  END IF;
  IF operation = 'update' THEN
    checked := cake_recurring_check_members(target_workspace,supplied_config,test_mode,false);
    IF checked ? 'errorCode' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = checked->>'errorCode'; END IF;
    UPDATE recurring_payments SET day_of_month = (supplied_config->>'dayOfMonth')::integer,
      merchant = btrim(supplied_config->>'merchant'), method = btrim(supplied_config->>'method'),
      amount_yen = (supplied_config->>'amountYen')::integer, actor_user_id = supplied_config->>'actorUserId',
      expense_class = supplied_config->>'expenseClass', split_weights = supplied_config->'splitWeights', memo = supplied_config->>'memo',
      pending_config = NULL, pending_effective_month = NULL,
      next_scheduled_on = cake_recurring_next_scheduled_on((supplied_config->>'dayOfMonth')::integer,target_now),
      authorized_by = actor_id, revision = revision + 1, updated_by = actor_id, updated_at = now()
      WHERE id = payment.id RETURNING * INTO payment;
  ELSIF operation = 'resume' THEN
    checked := cake_recurring_check_members(target_workspace,cake_recurring_current_config(payment),test_mode,true);
    IF checked ? 'errorCode' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = checked->>'errorCode'; END IF;
    UPDATE recurring_payments SET state = 'ACTIVE', authorized_by = actor_id,
      next_scheduled_on = cake_recurring_next_scheduled_on(payment.day_of_month,target_now),
      blocked_reason = NULL, revision = revision + 1, updated_by = actor_id, updated_at = now()
      WHERE id = payment.id RETURNING * INTO payment;
  ELSE
    UPDATE recurring_payments SET state = CASE WHEN operation = 'pause' THEN 'PAUSED' ELSE 'ARCHIVED' END,
      blocked_reason = NULL, revision = revision + 1, updated_by = actor_id, updated_at = now()
      WHERE id = payment.id RETURNING * INTO payment;
  END IF;
  -- Preserve the old SQL response key for an application still being replaced.
  -- The current API does not expose this compatibility-only value.
  RETURN jsonb_build_object('payment',to_jsonb(payment)) || CASE WHEN operation = 'update'
    THEN jsonb_build_object('effectiveMonth',date_trunc('month',target_now AT TIME ZONE 'Asia/Tokyo')::date) ELSE '{}'::jsonb END;
END;
$cake_mutate_recurring$ LANGUAGE plpgsql;

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
