-- Record the runner's execution time for newly generated transactions. Keep
-- the function contract and existing transaction history unchanged.
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
  generated_id uuid;
BEGIN
  IF target_now IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID'; END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped'); END IF;
  SELECT * INTO payment FROM recurring_payments WHERE id = target_payment AND workspace_id = target_workspace FOR UPDATE;
  IF NOT FOUND OR payment.state <> 'ACTIVE' OR today < payment.start_on OR this_month < payment.active_from_month
    OR payment.last_generated_month >= this_month THEN RETURN jsonb_build_object('status','skipped'); END IF;
  config := CASE WHEN payment.pending_effective_month <= this_month THEN payment.pending_config
    ELSE cake_recurring_current_config(payment) END;
  IF cake_recurring_scheduled_on(this_month,(config->>'dayOfMonth')::integer) <> today THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  PERFORM cake_recurring_lock_users(target_workspace,ARRAY[payment.authorized_by,config->>'actorUserId']);
  -- Separate identities by environment without changing an unrelated setting.
  IF NOT cake_recurring_identity_matches(payment.authorized_by,test_mode) THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  payment := cake_recurring_apply_pending(payment.id,this_month);
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
  -- Deliberately fail on external_id collision; do not silently acknowledge an
  -- inconsistent row. Any failure rolls back pending promotion and the marker.
  INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,actor_user_id,
    expense_class,split_weights,external_id,source,created_by,updated_by,memo)
  VALUES(target_workspace,target_now,config->>'merchant',config->>'method','PAYMENT',
    (config->>'amountYen')::integer,config->>'actorUserId',config->>'expenseClass',checked->'splitWeights',
    'recurring_' || payment.id::text || '_' || to_char(this_month,'YYYYMM'),'RECURRING',payment.authorized_by,payment.authorized_by,config->>'memo')
  RETURNING id INTO generated_id;
  UPDATE recurring_payments SET last_generated_month = this_month, updated_at = now() WHERE id = payment.id;
  RETURN jsonb_build_object('status','created','transactionId',generated_id);
END;
$cake_generate_recurring$ LANGUAGE plpgsql;
