-- All application transaction mutations take this lock before checking live
-- membership and visibility. The caller executes its write in the same transaction.
CREATE FUNCTION cake_assert_transaction_access(
  target_workspace uuid, requester text, target_ids uuid[] DEFAULT NULL,
  proposed_class text DEFAULT NULL, proposed_actor text DEFAULT NULL
)
RETURNS void AS $cake_assert_transaction_access$
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  PERFORM user_id FROM workspace_members WHERE workspace_id = target_workspace
    ORDER BY user_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = target_workspace AND user_id = requester) THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  IF target_ids IS NOT NULL THEN
    PERFORM id FROM transactions WHERE workspace_id = target_workspace AND id = ANY(target_ids)
      ORDER BY id FOR UPDATE;
    IF cardinality(target_ids) <> (SELECT count(*) FROM transactions
      WHERE workspace_id = target_workspace AND id = ANY(target_ids)
        AND (expense_class = 'SHARED' OR actor_user_id = requester)) THEN
      RAISE EXCEPTION '明細が存在しないか、操作する権限がありません。';
    END IF;
  END IF;
  IF proposed_class = 'PERSONAL' AND proposed_actor IS DISTINCT FROM requester THEN
    RAISE EXCEPTION '個人費は本人の明細だけ登録・変更できます。';
  END IF;
  IF proposed_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members
    WHERE workspace_id = target_workspace AND user_id = proposed_actor) THEN
    RAISE EXCEPTION '取引担当者がワークスペースに参加していません。';
  END IF;
END;
$cake_assert_transaction_access$ LANGUAGE plpgsql;

-- Payment rules must never reclassify receipts. Keep the existing function
-- signature and atomic selection validation for older application deployments.
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
    WHERE workspace_id = target_workspace AND id = ANY(target_ids)
      AND (expense_class = 'SHARED' OR actor_user_id = actor_id);
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
    SELECT 1 FROM transactions
    WHERE workspace_id = target_workspace AND id = ANY(target_ids) AND type <> 'PAYMENT'
  ) THEN
    RAISE EXCEPTION 'ルールを適用できるのは支払い明細だけです。収入を選択から外してください。';
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

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item
    JOIN transactions t ON t.id = (item ->> 'id')::uuid AND t.workspace_id = target_workspace
    WHERE item ->> 'expense_class' = 'PERSONAL' AND t.actor_user_id <> actor_id
  ) THEN
    RAISE EXCEPTION '個人費は本人の明細だけ登録・変更できます。';
  END IF;

  -- Validate every proposed ratio before writing. Keep type checks separate
  -- from numeric casts, including malformed legacy rules and all-zero weights.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item
    WHERE jsonb_typeof(item -> 'split_weights') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION '支払いルールの割合が不正です。ルール設定を確認してください。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(resolved_splits) item,
      LATERAL jsonb_each(item -> 'split_weights') part
    WHERE jsonb_typeof(part.value) <> 'number'
  ) THEN
    RAISE EXCEPTION '支払いルールの割合が不正です。ルール設定を確認してください。';
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
    RAISE EXCEPTION '支払いルールの割合が不正です。ルール設定を確認してください。';
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

CREATE OR REPLACE FUNCTION cake_mutate_category(
  target_workspace uuid, actor_id text, operation text,
  target_category uuid DEFAULT NULL, parent_category uuid DEFAULT NULL,
  category_name text DEFAULT NULL, category_color text DEFAULT NULL,
  target_transaction uuid DEFAULT NULL
)
RETURNS jsonb AS $cake_mutate_category$
DECLARE
  saved categories;
  archived_categories jsonb;
  archived_ids jsonb;
  branch_ids uuid[];
  saved_transaction uuid;
  saved_category_revision integer;
BEGIN
  IF operation IS NULL OR operation NOT IN ('CREATE', 'UPDATE', 'ARCHIVE', 'ASSIGN') THEN
    RAISE EXCEPTION '未対応のカテゴリ操作です。';
  END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  PERFORM user_id FROM workspace_members
    WHERE workspace_id = target_workspace AND user_id = actor_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;

  IF operation = 'ASSIGN' THEN
    IF target_category IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id = target_category AND archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'カテゴリが存在しないか、使用停止されています。';
    END IF;
    UPDATE transactions SET category_id = target_category, category_confirmed = target_category IS NOT NULL,
      updated_by = actor_id, updated_at = now()
      WHERE workspace_id = target_workspace AND id = target_transaction
        AND (expense_class = 'SHARED' OR actor_user_id = actor_id)
      RETURNING id, category_revision INTO saved_transaction, saved_category_revision;
    IF NOT FOUND THEN RAISE EXCEPTION '明細が存在しません。'; END IF;
    RETURN jsonb_build_object('transactionId', saved_transaction, 'categoryId', target_category,
      'categoryConfirmed', target_category IS NOT NULL, 'categoryRevision', saved_category_revision);
  END IF;

  IF operation IN ('CREATE', 'UPDATE') AND (
    category_name IS NULL OR char_length(category_name) NOT BETWEEN 1 AND 40
    OR category_name <> btrim(category_name)
    OR category_color IS NULL OR category_color !~ '^#[0-9a-fA-F]{6}$'
  ) THEN
    RAISE EXCEPTION 'カテゴリ名または色の指定が不正です。';
  END IF;

  IF operation = 'CREATE' THEN
    IF parent_category IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id = parent_category AND archived_at IS NULL
    ) THEN
      RAISE EXCEPTION '追加先のカテゴリが存在しないか、使用停止されています。';
    END IF;
    INSERT INTO categories(workspace_id, parent_id, name, color_hex, sort_order, created_by, updated_by)
    SELECT target_workspace, parent_category, category_name, lower(category_color), COALESCE(MAX(sort_order), -1) + 1,
      actor_id, actor_id FROM categories
      WHERE workspace_id = target_workspace AND parent_id IS NOT DISTINCT FROM parent_category
    RETURNING * INTO saved;
  ELSIF operation = 'UPDATE' THEN
    UPDATE categories SET name = category_name, color_hex = lower(category_color), revision = revision + 1, updated_by = actor_id, updated_at = now()
      WHERE workspace_id = target_workspace AND id = target_category AND archived_at IS NULL
      RETURNING * INTO saved;
    IF NOT FOUND THEN RAISE EXCEPTION 'カテゴリが存在しないか、使用停止されています。'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id = target_category) THEN
      RAISE EXCEPTION 'カテゴリが存在しません。';
    END IF;
    WITH RECURSIVE branch AS (
      SELECT id FROM categories WHERE workspace_id = target_workspace AND id = target_category
      UNION
      SELECT c.id FROM categories c JOIN branch b ON c.parent_id = b.id WHERE c.workspace_id = target_workspace
    ) SELECT array_agg(id) INTO branch_ids FROM branch;
    WITH archived AS (
      UPDATE categories SET archived_at = now(), revision = revision + 1, updated_by = actor_id, updated_at = now()
        WHERE workspace_id = target_workspace AND id = ANY(branch_ids) AND archived_at IS NULL
        RETURNING id
    ) SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb) INTO archived_ids FROM archived;
    -- Acknowledge the entire branch, including already archived rows and children
    -- whose CREATE response has not reached this browser yet.
    SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'parentId', parent_id, 'name', name, 'colorHex', color_hex,
      'sortOrder', sort_order, 'archivedAt', archived_at, 'revision', revision
    ) ORDER BY id) INTO archived_categories
      FROM categories WHERE workspace_id = target_workspace AND id = ANY(branch_ids);
    RETURN jsonb_build_object('archivedCategoryIds', archived_ids, 'archivedCategories', archived_categories);
  END IF;
  RETURN jsonb_build_object('category', jsonb_build_object(
    'id', saved.id, 'parentId', saved.parent_id, 'name', saved.name, 'colorHex', saved.color_hex,
    'sortOrder', saved.sort_order, 'archivedAt', saved.archived_at, 'revision', saved.revision
  ));
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION '同じ階層に同じ名前のカテゴリがあります。';
END;
$cake_mutate_category$ LANGUAGE plpgsql;

-- Keep the original archive API/columns for deployments still using them.
-- New deletions detach every transaction, including settled/archived references.
CREATE OR REPLACE FUNCTION cake_delete_category(target_workspace uuid, actor_id text, target_category uuid)
RETURNS jsonb AS $cake_delete_category$
DECLARE
  branch_ids uuid[];
  detached_transactions jsonb;
BEGIN
  UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  PERFORM user_id FROM workspace_members
    WHERE workspace_id = target_workspace AND user_id = actor_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;

  -- The workspace lock serializes creates, moves, assignments and deletions.
  -- Composite foreign keys keep the entire branch and its references in scope.
  WITH RECURSIVE branch AS (
    SELECT id FROM categories WHERE workspace_id = target_workspace AND id = target_category
    UNION
    SELECT c.id FROM categories c JOIN branch b ON c.parent_id = b.id
      WHERE c.workspace_id = target_workspace
  ) SELECT array_agg(id ORDER BY id) INTO branch_ids FROM branch;
  IF branch_ids IS NULL THEN
    RAISE EXCEPTION 'カテゴリが存在しません。';
  END IF;
  PERFORM id FROM categories WHERE workspace_id = target_workspace AND id = ANY(branch_ids)
    ORDER BY id FOR UPDATE;
  PERFORM id FROM transactions WHERE workspace_id = target_workspace AND category_id = ANY(branch_ids)
    ORDER BY id FOR UPDATE;

  -- The existing category trigger advances category_revision and clears the
  -- confirmation. Other business fields and settlement/history stay unchanged.
  WITH detached AS (
    UPDATE transactions SET category_id = NULL, category_confirmed = false,
      updated_by = actor_id, updated_at = now()
      WHERE workspace_id = target_workspace AND category_id = ANY(branch_ids)
      RETURNING id, category_revision, expense_class, actor_user_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'transactionId', id, 'categoryId', NULL, 'categoryConfirmed', false,
    'categoryRevision', category_revision
  ) ORDER BY id), '[]'::jsonb) INTO detached_transactions FROM detached
    WHERE expense_class = 'SHARED' OR actor_user_id = actor_id;

  -- One statement removes parents and children before the NO ACTION FK check.
  DELETE FROM categories WHERE workspace_id = target_workspace AND id = ANY(branch_ids);
  RETURN jsonb_build_object('deletedCategoryIds', to_jsonb(branch_ids),
    'detachedTransactions', detached_transactions);
END;
$cake_delete_category$ LANGUAGE plpgsql;
