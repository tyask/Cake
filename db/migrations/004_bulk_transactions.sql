-- Validate and mutate the entire selection inside one database transaction. The
-- workspace lock is shared with direct edits, rules, and settlement completion.
CREATE OR REPLACE FUNCTION cake_bulk_transactions(
  target_workspace uuid, actor_id text, target_ids uuid[], operation text
)
RETURNS jsonb AS $cake_bulk_transactions$
DECLARE
  target_count integer;
  has_settled boolean;
  target_row record;
  next_class text;
  rule_weights jsonb;
  next_weights jsonb;
  applied_transactions jsonb;
BEGIN
  IF operation IS NULL OR operation NOT IN ('DELETE', 'APPLY_RULES') THEN
    RAISE EXCEPTION '未対応の明細操作です。';
  END IF;
  IF target_ids IS NULL OR cardinality(target_ids) < 1 OR cardinality(target_ids) > 5000
    OR EXISTS (SELECT 1 FROM unnest(target_ids) supplied(id) WHERE id IS NULL)
    OR cardinality(target_ids) <> (SELECT COUNT(DISTINCT id) FROM unnest(target_ids) supplied(id)) THEN
    RAISE EXCEPTION '操作する明細を重複せずに選択してください。';
  END IF;

  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  -- Membership and its weights stay valid throughout either operation.
  PERFORM user_id FROM workspace_members WHERE workspace_id = target_workspace
    ORDER BY user_id FOR SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = actor_id
  ) THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;

  -- Hold the full selection before checking it, so an old selection cannot
  -- partially delete or change rows after a concurrent settlement or deletion.
  PERFORM id FROM transactions
    WHERE workspace_id = target_workspace AND id = ANY(target_ids)
    ORDER BY id FOR UPDATE;
  SELECT COUNT(*)::integer, COALESCE(bool_or(settled_at IS NOT NULL), false)
    INTO target_count, has_settled FROM transactions
    WHERE workspace_id = target_workspace AND id = ANY(target_ids);
  IF target_count <> cardinality(target_ids) THEN
    RAISE EXCEPTION '選択した明細が見つかりません。画面を更新して選び直してください。';
  END IF;
  IF has_settled THEN
    RAISE EXCEPTION '清算済みの明細は一括操作できません。未清算の明細を選び直してください。';
  END IF;

  IF operation = 'DELETE' THEN
    DELETE FROM transactions WHERE workspace_id = target_workspace AND id = ANY(target_ids);
    RETURN jsonb_build_object('affected', target_count);
  END IF;

  IF EXISTS (
    SELECT 1 FROM transactions t WHERE t.workspace_id = target_workspace AND t.id = ANY(target_ids)
      AND NOT EXISTS (SELECT 1 FROM workspace_members m
        WHERE m.workspace_id = target_workspace AND m.user_id = t.actor_user_id)
  ) THEN
    RAISE EXCEPTION '取引担当者がワークスペースに参加していません。';
  END IF;

  FOR target_row IN
    SELECT id, merchant, actor_user_id FROM transactions
    WHERE workspace_id = target_workspace AND id = ANY(target_ids) ORDER BY id
  LOOP
    SELECT expense_class, split_weights INTO next_class, rule_weights
      FROM default_rules WHERE workspace_id = target_workspace AND enabled
        AND strpos(target_row.merchant, merchant_contains) > 0
      ORDER BY sort_order, created_at, id LIMIT 1;
    -- Keep the same unmatched-merchant behavior as transactionDefaults.
    next_class := COALESCE(next_class, 'PERSONAL');
    SELECT jsonb_object_agg(user_id,
      CASE WHEN next_class = 'PERSONAL'
        THEN to_jsonb(CASE WHEN user_id = target_row.actor_user_id THEN 1 ELSE 0 END)
        WHEN rule_weights IS NULL THEN to_jsonb(weight)
        ELSE COALESCE(NULLIF(rule_weights -> user_id, 'null'::jsonb), '0'::jsonb)
      END
    ) INTO next_weights FROM workspace_members WHERE workspace_id = target_workspace;

    IF next_weights IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_each(next_weights) part WHERE jsonb_typeof(part.value) <> 'number'
    ) THEN
      RAISE EXCEPTION '共有費ルールの割合が不正です。ルール設定を確認してください。';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_each(next_weights) part WHERE (part.value::text)::numeric < 0
        OR (part.value::text)::numeric > 2147483647 OR mod((part.value::text)::numeric, 1) <> 0
    ) OR NOT EXISTS (
      SELECT 1 FROM jsonb_each(next_weights) part WHERE (part.value::text)::numeric > 0
    ) THEN
      RAISE EXCEPTION '共有費ルールの割合が不正です。ルール設定を確認してください。';
    END IF;
    UPDATE transactions SET expense_class = next_class, split_weights = next_weights,
      updated_by = actor_id, updated_at = now() WHERE id = target_row.id AND workspace_id = target_workspace;
  END LOOP;
  -- Return the exact acknowledged rows while their locks are still held, rather
  -- than recomputing rules or reading a later concurrent edit in the application.
  SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'occurredAt', occurred_at, 'merchant', merchant, 'method', method,
    'type', type, 'amountYen', amount_yen, 'actorUserId', actor_user_id,
    'expenseClass', expense_class, 'splitWeights', split_weights
  ) ORDER BY id) INTO applied_transactions FROM transactions
    WHERE workspace_id = target_workspace AND id = ANY(target_ids);
  RETURN jsonb_build_object('affected', target_count, 'transactions', applied_transactions);
END;
$cake_bulk_transactions$ LANGUAGE plpgsql;
