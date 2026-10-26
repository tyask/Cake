-- Personal recurring settings belong to their payment actor, including before revision checks.
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
    IF supplied_config->>'expenseClass' = 'PERSONAL' AND supplied_config->>'actorUserId' IS DISTINCT FROM actor_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
    END IF;
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
  IF payment.id IS NULL OR (payment.expense_class = 'PERSONAL' AND payment.actor_user_id <> actor_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'NOT_FOUND';
  END IF;
  IF operation = 'update' AND supplied_config->>'expenseClass' = 'PERSONAL'
    AND supplied_config->>'actorUserId' IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
  END IF;
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


-- Manual QA runs have the same visibility boundary as their caller. Recheck
-- after acquiring the workspace/payment locks; Cron keeps the existing runner.
CREATE OR REPLACE FUNCTION cake_generate_visible_recurring_payment(
  target_workspace uuid, target_payment uuid, requester text,
  test_mode boolean DEFAULT false, target_now timestamptz DEFAULT now()
)
RETURNS jsonb AS $cake_generate_visible_recurring$
DECLARE
  payment recurring_payments;
BEGIN
  PERFORM id FROM workspaces WHERE id = target_workspace FOR UPDATE;
  PERFORM cake_recurring_lock_users(target_workspace,ARRAY[requester]);
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = requester)
    OR NOT cake_recurring_user_allowed(requester,test_mode) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0403', MESSAGE = 'FORBIDDEN';
  END IF;
  SELECT * INTO payment FROM recurring_payments
    WHERE id = target_payment AND workspace_id = target_workspace FOR UPDATE;
  IF payment.id IS NULL OR (payment.expense_class = 'PERSONAL' AND payment.actor_user_id <> requester) THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  RETURN cake_generate_recurring_payment(target_workspace,target_payment,test_mode,target_now);
END;
$cake_generate_visible_recurring$ LANGUAGE plpgsql;
