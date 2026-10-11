-- A single settings table stores the current monthly configuration and durable
-- success marker. Reserved legacy fields do not control scheduling.
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('MANUAL', 'PAYPAY', 'RECURRING'));

CREATE OR REPLACE FUNCTION cake_recurring_config_valid(config jsonb)
RETURNS boolean AS $cake_recurring_config$
DECLARE
  part record;
BEGIN
  IF config IS NULL OR jsonb_typeof(config) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(config)) <> 8
    OR NOT config ?& ARRAY['dayOfMonth','merchant','method','amountYen','actorUserId','expenseClass','splitWeights','memo']
    OR jsonb_typeof(config->'dayOfMonth') <> 'number'
    OR jsonb_typeof(config->'amountYen') <> 'number'
    OR jsonb_typeof(config->'merchant') <> 'string'
    OR jsonb_typeof(config->'method') <> 'string'
    OR jsonb_typeof(config->'actorUserId') <> 'string'
    OR jsonb_typeof(config->'expenseClass') <> 'string'
    OR jsonb_typeof(config->'memo') <> 'string'
    OR jsonb_typeof(config->'splitWeights') <> 'object' THEN RETURN false; END IF;
  IF (config->>'dayOfMonth')::numeric NOT BETWEEN 1 AND 31
    OR mod((config->>'dayOfMonth')::numeric,1) <> 0
    OR (config->>'amountYen')::numeric NOT BETWEEN 1 AND 2147483647
    OR mod((config->>'amountYen')::numeric,1) <> 0
    OR char_length(btrim(config->>'merchant')) NOT BETWEEN 1 AND 240
    OR char_length(btrim(config->>'method')) NOT BETWEEN 1 AND 120
    OR char_length(config->>'actorUserId') < 1
    OR config->>'expenseClass' NOT IN ('PERSONAL','SHARED')
    OR char_length(config->>'memo') > 2000 THEN RETURN false; END IF;
  FOR part IN SELECT * FROM jsonb_each(config->'splitWeights') LOOP
    IF char_length(part.key) < 1 OR jsonb_typeof(part.value) <> 'number' THEN RETURN false; END IF;
    IF part.value::text::numeric NOT BETWEEN 0 AND 2147483647
      OR mod(part.value::text::numeric,1) <> 0 THEN RETURN false; END IF;
  END LOOP;
  RETURN EXISTS (SELECT 1 FROM jsonb_each(config->'splitWeights') p WHERE p.value::text::numeric > 0);
END;
$cake_recurring_config$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE recurring_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','BLOCKED','ARCHIVED')),
  active_from_month date NOT NULL DEFAULT DATE '0001-01-01',
  day_of_month integer NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  merchant text NOT NULL CHECK (char_length(btrim(merchant)) BETWEEN 1 AND 240),
  method text NOT NULL CHECK (char_length(btrim(method)) BETWEEN 1 AND 120),
  amount_yen integer NOT NULL CHECK (amount_yen > 0),
  actor_user_id text NOT NULL REFERENCES app_users(id),
  expense_class text NOT NULL CHECK (expense_class IN ('PERSONAL','SHARED')),
  split_weights jsonb NOT NULL CHECK (jsonb_typeof(split_weights) = 'object'),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 2000),
  pending_config jsonb,
  pending_effective_month date,
  last_generated_month date,
  authorized_by text NOT NULL REFERENCES app_users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  blocked_reason text CHECK (blocked_reason IN ('AUTHORIZER_UNAVAILABLE','ACTOR_UNAVAILABLE','SPLIT_MEMBERS_INVALID','SPLIT_USER_UNAVAILABLE','CONFIG_INVALID')),
  created_by text NOT NULL REFERENCES app_users(id),
  updated_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_payments_active_from_month_month_start_check
    CHECK (active_from_month = date_trunc('month',active_from_month)::date),
  CHECK ((pending_config IS NULL) = (pending_effective_month IS NULL)),
  CHECK (pending_config IS NULL OR cake_recurring_config_valid(pending_config)),
  CONSTRAINT recurring_payments_pending_effective_month_month_start_check
    CHECK (pending_effective_month IS NULL OR pending_effective_month = date_trunc('month',pending_effective_month)::date),
  CONSTRAINT recurring_payments_last_generated_month_month_start_check
    CHECK (last_generated_month IS NULL OR last_generated_month = date_trunc('month',last_generated_month)::date),
  CHECK (cake_recurring_config_valid(jsonb_build_object('dayOfMonth',day_of_month,'merchant',merchant,'method',method,
    'amountYen',amount_yen,'actorUserId',actor_user_id,'expenseClass',expense_class,'splitWeights',split_weights,'memo',memo)))
);
CREATE INDEX recurring_payments_workspace_state_idx ON recurring_payments (workspace_id,state);
CREATE INDEX recurring_payments_active_idx ON recurring_payments (id) WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION cake_recurring_workspace_immutable()
RETURNS trigger AS $cake_recurring_workspace$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
  END IF;
  RETURN NEW;
END;
$cake_recurring_workspace$ LANGUAGE plpgsql;
CREATE TRIGGER recurring_payments_immutable_workspace BEFORE UPDATE OF workspace_id ON recurring_payments
  FOR EACH ROW EXECUTE FUNCTION cake_recurring_workspace_immutable();

CREATE OR REPLACE FUNCTION cake_recurring_identity_matches(target_user text, test_mode boolean)
RETURNS boolean AS $cake_recurring_identity$
  SELECT COALESCE((SELECT CASE WHEN test_mode THEN
    (id = 'test-user-a' AND lower(email) = 'test-a@cake.local') OR (id = 'test-user-b' AND lower(email) = 'test-b@cake.local')
    ELSE id NOT IN ('test-user-a','test-user-b') AND lower(email) NOT IN ('test-a@cake.local','test-b@cake.local') END
  FROM app_users WHERE id = target_user),false);
$cake_recurring_identity$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION cake_recurring_user_allowed(target_user text, test_mode boolean)
RETURNS boolean AS $cake_recurring_user$
  SELECT COALESCE((SELECT is_enabled AND cake_recurring_identity_matches(id,test_mode)
    FROM app_users WHERE id = target_user),false);
$cake_recurring_user$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION cake_recurring_current_config(payment recurring_payments)
RETURNS jsonb AS $cake_recurring_current$
  SELECT jsonb_build_object('dayOfMonth',payment.day_of_month,'merchant',payment.merchant,'method',payment.method,
    'amountYen',payment.amount_yen,'actorUserId',payment.actor_user_id,'expenseClass',payment.expense_class,
    'splitWeights',payment.split_weights,'memo',payment.memo);
$cake_recurring_current$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION cake_recurring_scheduled_on(target_month date, target_day integer)
RETURNS date AS $cake_recurring_date$
  SELECT date_trunc('month',target_month)::date + (least(target_day,
    extract(day FROM (date_trunc('month',target_month) + interval '1 month - 1 day'))::integer)-1);
$cake_recurring_date$ LANGUAGE sql IMMUTABLE;

-- Caller already holds workspace -> setting locks. Taking users in a stable
-- order ensures disabled users cannot pass validation and change before commit.
CREATE OR REPLACE FUNCTION cake_recurring_lock_users(target_workspace uuid, extra_ids text[])
RETURNS void AS $cake_recurring_locks$
BEGIN
  PERFORM id FROM app_users WHERE id IN (SELECT user_id FROM workspace_members WHERE workspace_id = target_workspace)
    OR id = ANY(extra_ids) ORDER BY id FOR SHARE;
  PERFORM user_id FROM workspace_members WHERE workspace_id = target_workspace ORDER BY user_id FOR SHARE;
END;
$cake_recurring_locks$ LANGUAGE plpgsql;

-- Never drop unknown users or redistribute a saved share. A participant who
-- joined after saving gets zero only when processing an existing setting.
CREATE OR REPLACE FUNCTION cake_recurring_check_members(target_workspace uuid, config jsonb, test_mode boolean, complete_missing boolean)
RETURNS jsonb AS $cake_recurring_members$
DECLARE
  completed_weights jsonb;
BEGIN
  IF NOT cake_recurring_config_valid(config) THEN RETURN jsonb_build_object('errorCode','CONFIG_INVALID'); END IF;
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = config->>'actorUserId')
    OR NOT cake_recurring_user_allowed(config->>'actorUserId',test_mode) THEN
    RETURN jsonb_build_object('errorCode','ACTOR_UNAVAILABLE');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(config->'splitWeights') p(id) WHERE NOT EXISTS (
    SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace AND m.user_id = p.id))
    OR (NOT complete_missing AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = target_workspace
      AND NOT (config->'splitWeights') ? m.user_id)) THEN
    RETURN jsonb_build_object('errorCode','SPLIT_MEMBERS_INVALID');
  END IF;
  SELECT jsonb_object_agg(user_id,COALESCE((config->'splitWeights')->user_id,'0'::jsonb)) INTO completed_weights
    FROM workspace_members WHERE workspace_id = target_workspace;
  IF config->>'expenseClass' = 'PERSONAL' AND EXISTS (SELECT 1 FROM jsonb_each(completed_weights) p
    WHERE p.value::text::numeric <> CASE WHEN p.key = config->>'actorUserId' THEN 1 ELSE 0 END) THEN
    RETURN jsonb_build_object('errorCode','SPLIT_MEMBERS_INVALID');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(completed_weights) p WHERE p.value::text::numeric > 0
    AND NOT cake_recurring_user_allowed(p.key,test_mode)) THEN
    RETURN jsonb_build_object('errorCode','SPLIT_USER_UNAVAILABLE');
  END IF;
  RETURN jsonb_build_object('splitWeights',completed_weights);
END;
$cake_recurring_members$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION cake_recurring_apply_pending(target_payment uuid, target_month date)
RETURNS recurring_payments AS $cake_recurring_pending$
DECLARE
  payment recurring_payments;
BEGIN
  UPDATE recurring_payments SET day_of_month = (pending_config->>'dayOfMonth')::integer,
    merchant = pending_config->>'merchant', method = pending_config->>'method', amount_yen = (pending_config->>'amountYen')::integer,
    actor_user_id = pending_config->>'actorUserId', expense_class = pending_config->>'expenseClass',
    split_weights = pending_config->'splitWeights', memo = pending_config->>'memo', pending_config = NULL,
    pending_effective_month = NULL, updated_at = now()
    WHERE id = target_payment AND pending_effective_month <= target_month;
  SELECT * INTO payment FROM recurring_payments WHERE id = target_payment;
  RETURN payment;
END;
$cake_recurring_pending$ LANGUAGE plpgsql;

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
    INSERT INTO recurring_payments(workspace_id,day_of_month,merchant,method,amount_yen,
      actor_user_id,expense_class,split_weights,memo,authorized_by,created_by,updated_by)
    VALUES(target_workspace,(supplied_config->>'dayOfMonth')::integer,
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
      authorized_by = actor_id, revision = revision + 1, updated_by = actor_id, updated_at = now()
      WHERE id = payment.id RETURNING * INTO payment;
  ELSIF operation = 'resume' THEN
    checked := cake_recurring_check_members(target_workspace,cake_recurring_current_config(payment),test_mode,true);
    IF checked ? 'errorCode' THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = checked->>'errorCode'; END IF;
    UPDATE recurring_payments SET state = 'ACTIVE', authorized_by = actor_id,
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
  generated_id uuid;
BEGIN
  IF target_now IS NULL THEN RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID'; END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped'); END IF;
  SELECT * INTO payment FROM recurring_payments WHERE id = target_payment AND workspace_id = target_workspace FOR UPDATE;
  IF NOT FOUND OR payment.state <> 'ACTIVE' OR payment.last_generated_month >= this_month THEN
    RETURN jsonb_build_object('status','skipped');
  END IF;
  config := cake_recurring_current_config(payment);
  IF cake_recurring_scheduled_on(this_month,(config->>'dayOfMonth')::integer) <> today THEN
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
  -- An external_id collision must roll back the insert and the success marker.
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
