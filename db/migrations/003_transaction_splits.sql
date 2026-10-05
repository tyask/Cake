-- Freeze the ratio used by each transaction, including existing history.
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_weight_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_weight_check CHECK (weight >= 0);

ALTER TABLE transactions ADD COLUMN split_weights jsonb;

UPDATE transactions t
SET split_weights = CASE
  WHEN t.expense_class = 'PERSONAL' THEN
    COALESCE((
      SELECT jsonb_object_agg(wm.user_id, CASE WHEN wm.user_id = t.actor_user_id THEN 1 ELSE 0 END)
      FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id
    ), '{}'::jsonb) || jsonb_build_object(t.actor_user_id, 1)
  ELSE COALESCE(
    (
      SELECT jsonb_object_agg(person->>'userId', (person->>'weight')::integer)
      FROM settlement_transactions st
      JOIN settlements s ON s.id = st.settlement_id
      CROSS JOIN LATERAL jsonb_array_elements(s.weight_snapshot) person
      WHERE st.transaction_id = t.id
    ),
    (SELECT jsonb_object_agg(wm.user_id, wm.weight)
      FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id),
    jsonb_build_object(t.actor_user_id, 1)
  )
END;

ALTER TABLE transactions ALTER COLUMN split_weights SET NOT NULL;
ALTER TABLE transactions ADD CONSTRAINT transactions_split_weights_object
  CHECK (jsonb_typeof(split_weights) = 'object');

-- Keep priority readable while an earlier Preview deployment is still serving.
ALTER TABLE default_rules ADD COLUMN sort_order integer;
WITH ranked AS (
  SELECT id, (row_number() OVER (PARTITION BY workspace_id ORDER BY priority, created_at, id) - 1)::integer AS position
  FROM default_rules
)
UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id;
ALTER TABLE default_rules ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE default_rules ADD CONSTRAINT default_rules_sort_order_check CHECK (sort_order >= 0);
ALTER TABLE default_rules ADD COLUMN split_weights jsonb;
ALTER TABLE default_rules ADD CONSTRAINT default_rules_split_weights_object
  CHECK (split_weights IS NULL OR jsonb_typeof(split_weights) = 'object');
CREATE INDEX default_rules_workspace_order_idx ON default_rules (workspace_id, sort_order, created_at);

CREATE OR REPLACE FUNCTION cake_sync_default_rule_order()
RETURNS trigger AS $cake_rule_compat$
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = NEW.workspace_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.sort_order IS NULL THEN
      SELECT COALESCE(MAX(sort_order), -1) + 1 INTO NEW.sort_order
        FROM default_rules WHERE workspace_id = NEW.workspace_id;
    END IF;
    NEW.priority := NEW.sort_order;
  ELSIF NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
    NEW.priority := NEW.sort_order;
  ELSIF NEW.priority IS DISTINCT FROM OLD.priority THEN
    NEW.sort_order := NEW.priority;
  END IF;
  RETURN NEW;
END;
$cake_rule_compat$ LANGUAGE plpgsql;
CREATE TRIGGER default_rules_begin_order_sync
BEFORE INSERT OR UPDATE OF sort_order, priority ON default_rules
FOR EACH ROW EXECUTE FUNCTION cake_sync_default_rule_order();

-- A newly invited participant has no share of an older saved transaction or
-- explicit rule. Add a zero entry rather than changing the recorded ratio.
CREATE OR REPLACE FUNCTION cake_complete_split_weights(target_workspace uuid, saved_weights jsonb)
RETURNS jsonb AS $cake_complete_split$
  SELECT CASE WHEN saved_weights IS NULL THEN NULL ELSE
    COALESCE((SELECT jsonb_object_agg(user_id, 0) FROM workspace_members WHERE workspace_id = target_workspace), '{}'::jsonb)
      || saved_weights END;
$cake_complete_split$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION cake_complete_saved_split()
RETURNS trigger AS $cake_saved_split$
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    UPDATE workspaces SET updated_at = now() WHERE id = NEW.workspace_id;
    IF NEW.expense_class = 'PERSONAL' THEN
      NEW.split_weights := COALESCE((
        SELECT jsonb_object_agg(user_id, CASE WHEN user_id = NEW.actor_user_id THEN 1 ELSE 0 END)
          FROM workspace_members WHERE workspace_id = NEW.workspace_id
      ), '{}'::jsonb) || jsonb_build_object(NEW.actor_user_id, 1);
    ELSIF NEW.split_weights IS NULL THEN
      -- Older app versions do not send the new column when inserting a row.
      SELECT jsonb_object_agg(user_id, weight) INTO NEW.split_weights
        FROM workspace_members WHERE workspace_id = NEW.workspace_id;
    END IF;
  END IF;
  NEW.split_weights := cake_complete_split_weights(NEW.workspace_id, NEW.split_weights);
  RETURN NEW;
END;
$cake_saved_split$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_complete_split
BEFORE INSERT OR UPDATE OF split_weights, expense_class, actor_user_id ON transactions
FOR EACH ROW EXECUTE FUNCTION cake_complete_saved_split();
CREATE TRIGGER default_rules_complete_split
BEFORE INSERT OR UPDATE OF split_weights ON default_rules
FOR EACH ROW EXECUTE FUNCTION cake_complete_saved_split();

CREATE OR REPLACE FUNCTION cake_extend_saved_splits_for_member()
RETURNS trigger AS $cake_member_splits$
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = NEW.workspace_id;
  UPDATE transactions SET split_weights = split_weights || jsonb_build_object(NEW.user_id, 0)
    WHERE workspace_id = NEW.workspace_id AND NOT split_weights ? NEW.user_id;
  UPDATE default_rules SET split_weights = split_weights || jsonb_build_object(NEW.user_id, 0)
    WHERE workspace_id = NEW.workspace_id AND split_weights IS NOT NULL AND NOT split_weights ? NEW.user_id;
  RETURN NEW;
END;
$cake_member_splits$ LANGUAGE plpgsql;
CREATE TRIGGER workspace_members_extend_splits
AFTER INSERT ON workspace_members
FOR EACH ROW EXECUTE FUNCTION cake_extend_saved_splits_for_member();

-- Serialize ordering with create/update/delete through the workspace row. This
-- also validates the complete order inside the same transaction as its update.
CREATE OR REPLACE FUNCTION cake_reorder_default_rules(target_workspace uuid, actor_id text, ordered_ids uuid[])
RETURNS void AS $cake_rule_order$
DECLARE
  existing_ids uuid[];
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO existing_ids
    FROM default_rules WHERE workspace_id = target_workspace;
  IF ordered_ids IS NULL
    OR cardinality(ordered_ids) <> cardinality(existing_ids)
    OR cardinality(ordered_ids) <> (SELECT COUNT(DISTINCT id) FROM unnest(ordered_ids) AS supplied(id))
    OR existing_ids <> COALESCE((SELECT array_agg(id ORDER BY id) FROM unnest(ordered_ids) AS supplied(id)), ARRAY[]::uuid[]) THEN
    RAISE EXCEPTION 'ルールの一覧が変わりました。画面を更新してもう一度並べ替えてください。';
  END IF;
  UPDATE default_rules r SET sort_order = ordered.position::integer - 1
  FROM unnest(ordered_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE r.workspace_id = target_workspace AND r.id = ordered.id;
END;
$cake_rule_order$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cake_assert_settlement_snapshot(target_workspace uuid, actor_id text, expected_transactions jsonb)
RETURNS void AS $cake_settlement_snapshot$
DECLARE
  current_transactions jsonb;
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'actorUserId', actor_user_id, 'type', type,
    'amountYen', amount_yen, 'expenseClass', expense_class, 'splitWeights', split_weights
  ) ORDER BY id), '[]'::jsonb) INTO current_transactions
  FROM transactions WHERE workspace_id = target_workspace AND expense_class = 'SHARED' AND settled_at IS NULL;
  IF expected_transactions IS NULL OR expected_transactions = '[]'::jsonb
    OR current_transactions IS DISTINCT FROM expected_transactions THEN
    RAISE EXCEPTION '清算対象の明細が変わりました。画面を更新して、金額と割合を確認してからもう一度清算してください。';
  END IF;
END;
$cake_settlement_snapshot$ LANGUAGE plpgsql;
