-- Both HTTP deletion actions use the same transaction and ordering lock.
-- The existing reorder function and older application versions remain valid.
CREATE OR REPLACE FUNCTION cake_delete_default_rules(
  target_workspace uuid, actor_id text, target_ids uuid[], require_all boolean
)
RETURNS integer AS $cake_delete_default_rules$
DECLARE
  target_count integer;
BEGIN
  IF require_all IS NULL OR target_ids IS NULL
    OR cardinality(target_ids) < 1 OR cardinality(target_ids) > 5000
    OR (NOT require_all AND cardinality(target_ids) <> 1)
    OR EXISTS (SELECT 1 FROM unnest(target_ids) supplied(id) WHERE id IS NULL) THEN
    RAISE EXCEPTION '操作するルールを重複せずに選択してください。';
  END IF;
  -- UUID casts also detect duplicates written with different letter cases.
  -- Keep the existing bulk action's missing-selection response in this case.
  IF cardinality(target_ids) <> (SELECT COUNT(DISTINCT id) FROM unnest(target_ids) supplied(id)) THEN
    RAISE EXCEPTION '選択したルールが見つかりません。画面を更新して選び直してください。';
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

  -- Check the entire selection only after acquiring the workspace lock.
  PERFORM id FROM default_rules
    WHERE workspace_id = target_workspace AND id = ANY(target_ids)
    ORDER BY id FOR UPDATE;
  GET DIAGNOSTICS target_count = ROW_COUNT;
  IF require_all AND target_count <> cardinality(target_ids) THEN
    RAISE EXCEPTION '選択したルールが見つかりません。画面を更新して選び直してください。';
  END IF;

  DELETE FROM default_rules WHERE workspace_id = target_workspace AND id = ANY(target_ids);
  GET DIAGNOSTICS target_count = ROW_COUNT;
  WITH ranked AS (
    SELECT id, (row_number() OVER (ORDER BY sort_order, created_at, id) - 1)::integer AS position
    FROM default_rules WHERE workspace_id = target_workspace
  )
  UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id;
  RETURN target_count;
END;
$cake_delete_default_rules$ LANGUAGE plpgsql;
