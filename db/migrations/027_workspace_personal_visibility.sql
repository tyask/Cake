-- All workspace members can read personal transactions. Return every detached
-- reference so category deletion updates each visible row in the same response.
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
      RETURNING id, category_revision
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'transactionId', id, 'categoryId', NULL, 'categoryConfirmed', false,
    'categoryRevision', category_revision
  ) ORDER BY id), '[]'::jsonb) INTO detached_transactions FROM detached;

  -- One statement removes parents and children before the NO ACTION FK check.
  DELETE FROM categories WHERE workspace_id = target_workspace AND id = ANY(branch_ids);
  RETURN jsonb_build_object('deletedCategoryIds', to_jsonb(branch_ids),
    'detachedTransactions', detached_transactions);
END;
$cake_delete_category$ LANGUAGE plpgsql;
