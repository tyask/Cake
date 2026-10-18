-- Apply a complete selection with one member context and one set-based UPDATE.
-- Keep the existing signature, locks, validation, DELETE branch and result DTO.
CREATE OR REPLACE FUNCTION cake_bulk_transactions(
  target_workspace uuid, actor_id text, target_ids uuid[], operation text
)
RETURNS jsonb AS $cake_bulk_transactions$
DECLARE
  target_count integer;
  has_settled boolean;
  member_weights jsonb;
  member_zeros jsonb;
  resolved_splits jsonb;
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

  -- Read the participant/default context once per batch, while member locks
  -- remain held. JSON projection below normalizes each distinct matched rule.
  SELECT jsonb_object_agg(user_id, weight), jsonb_object_agg(user_id, 0)
    INTO member_weights, member_zeros
    FROM workspace_members WHERE workspace_id = target_workspace;

  WITH matched AS MATERIALIZED (
    SELECT t.id, t.actor_user_id, r.id AS rule_id, r.split_weights AS rule_weights,
      COALESCE(r.expense_class, 'PERSONAL') AS expense_class
    FROM transactions t
    LEFT JOIN LATERAL (
      SELECT id, expense_class, split_weights FROM default_rules
      WHERE workspace_id = target_workspace AND enabled
        AND strpos(t.merchant, merchant_contains) > 0
      ORDER BY sort_order, created_at, id LIMIT 1
    ) r ON true
    WHERE t.workspace_id = target_workspace AND t.id = ANY(target_ids)
  ), shared_defaults AS MATERIALIZED (
    SELECT rule_id, CASE WHEN rule_weights IS NULL THEN member_weights ELSE (
      SELECT jsonb_object_agg(part.key, COALESCE(NULLIF(rule_weights -> part.key, 'null'::jsonb), '0'::jsonb))
      FROM jsonb_each(member_weights) part
    ) END AS split_weights
    FROM (SELECT DISTINCT rule_id, rule_weights FROM matched WHERE expense_class = 'SHARED') selected_rules
  )
  SELECT jsonb_agg(jsonb_build_object(
    'id', m.id, 'expense_class', m.expense_class,
    'split_weights', CASE WHEN m.expense_class = 'PERSONAL'
      THEN member_zeros || jsonb_build_object(m.actor_user_id, 1)
      ELSE d.split_weights END
  ) ORDER BY m.id) INTO resolved_splits
  FROM matched m LEFT JOIN shared_defaults d ON d.rule_id = m.rule_id;

  -- Validate every proposed ratio before writing. Keep type checks separate
  -- from numeric casts, including malformed legacy rules and all-zero weights.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item
    WHERE jsonb_typeof(item -> 'split_weights') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION '共有費ルールの割合が不正です。ルール設定を確認してください。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item,
      LATERAL jsonb_each(item -> 'split_weights') part
    WHERE jsonb_typeof(part.value) <> 'number'
  ) THEN
    RAISE EXCEPTION '共有費ルールの割合が不正です。ルール設定を確認してください。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item,
      LATERAL jsonb_each(item -> 'split_weights') part
    WHERE (part.value::text)::numeric < 0 OR (part.value::text)::numeric > 2147483647
      OR mod((part.value::text)::numeric, 1) <> 0
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_each(item -> 'split_weights') part
      WHERE (part.value::text)::numeric > 0)
  ) THEN
    RAISE EXCEPTION '共有費ルールの割合が不正です。ルール設定を確認してください。';
  END IF;

  UPDATE transactions t SET expense_class = applied.expense_class, split_weights = applied.split_weights,
    updated_by = actor_id, updated_at = now()
  FROM jsonb_to_recordset(resolved_splits) AS applied(id uuid, expense_class text, split_weights jsonb)
  WHERE t.workspace_id = target_workspace AND t.id = applied.id;
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
