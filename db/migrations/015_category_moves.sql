-- Keep the original category operations callable by deployments using migration 014.
-- Parent changes retain category IDs and are serialized with every category write.
CREATE OR REPLACE FUNCTION cake_category_structure_guard()
RETURNS trigger AS $cake_category_structure_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'カテゴリの所属は変更できません。';
    END IF;
    IF NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
      RETURN NEW;
    END IF;
    UPDATE workspaces SET updated_at = now() WHERE id = NEW.workspace_id;
    PERFORM user_id FROM workspace_members
      WHERE workspace_id = NEW.workspace_id AND user_id = NEW.updated_by FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
    END IF;
    IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION '使用停止済みのカテゴリは移動できません。';
    END IF;
    IF EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM categories WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
        UNION
        SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON c.id = a.parent_id
          WHERE c.workspace_id = NEW.workspace_id
      ) SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION '自分自身または子孫のカテゴリには移動できません。';
    END IF;
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION '移動先または追加先のカテゴリが存在しないか、使用停止されています。';
  END IF;
  RETURN NEW;
END;
$cake_category_structure_guard$ LANGUAGE plpgsql;

CREATE FUNCTION cake_move_category(
  target_workspace uuid, actor_id text, target_category uuid,
  parent_category uuid, before_category uuid
)
RETURNS jsonb AS $cake_move_category$
DECLARE
  saved categories;
  moved_categories jsonb;
  changed_count integer;
BEGIN
  PERFORM id FROM workspaces WHERE id = target_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  PERFORM user_id FROM workspace_members
    WHERE workspace_id = target_workspace AND user_id = actor_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  SELECT * INTO saved FROM categories
    WHERE workspace_id = target_workspace AND id = target_category AND archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'カテゴリが存在しないか、使用停止されています。';
  END IF;
  IF parent_category IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id = parent_category AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION '移動先のカテゴリが存在しないか、使用停止されています。';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM categories WHERE workspace_id = target_workspace AND id = parent_category
      UNION
      SELECT c.id, c.parent_id FROM categories c JOIN ancestors a ON c.id = a.parent_id
        WHERE c.workspace_id = target_workspace
    ) SELECT 1 FROM ancestors WHERE id = target_category
  ) THEN
    RAISE EXCEPTION '自分自身または子孫のカテゴリには移動できません。';
  END IF;
  IF before_category IS NOT NULL AND (before_category = target_category OR NOT EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id = before_category
      AND parent_id IS NOT DISTINCT FROM parent_category AND archived_at IS NULL
  )) THEN
    RAISE EXCEPTION '挿入位置のカテゴリが存在しないか、移動先の階層と一致しません。';
  END IF;
  IF EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = target_workspace AND id <> target_category
      AND parent_id IS NOT DISTINCT FROM parent_category AND archived_at IS NULL AND name = saved.name
  ) THEN
    RAISE EXCEPTION '同じ階層に同じ名前のカテゴリがあります。';
  END IF;

  -- Dense sibling positions are derived once, then old/new sibling sets are
  -- written together. Archived siblings retain a stable position in that order.
  WITH destination AS MATERIALIZED (
    SELECT id, row_number() OVER (ORDER BY sort_order, id)::integer AS position
      FROM categories WHERE workspace_id = target_workspace
        AND parent_id IS NOT DISTINCT FROM parent_category AND id <> target_category
  ), insertion AS (
    SELECT COALESCE((SELECT position FROM destination WHERE id = before_category),
      (SELECT count(*)::integer + 1 FROM destination)) AS position
  ), positions AS (
    SELECT d.id, parent_category AS parent_id,
      CASE WHEN d.position >= i.position THEN d.position ELSE d.position - 1 END AS sort_order
      FROM destination d CROSS JOIN insertion i
    UNION ALL
    SELECT target_category, parent_category, position - 1 FROM insertion
    UNION ALL
    SELECT id, saved.parent_id, row_number() OVER (ORDER BY sort_order, id)::integer - 1
      FROM categories WHERE workspace_id = target_workspace AND id <> target_category
        AND parent_id IS NOT DISTINCT FROM saved.parent_id AND saved.parent_id IS DISTINCT FROM parent_category
  ), changed AS (
    UPDATE categories c SET parent_id = p.parent_id, sort_order = p.sort_order,
      revision = c.revision + 1, updated_by = actor_id, updated_at = now()
      FROM positions p WHERE c.workspace_id = target_workspace AND c.id = p.id
        AND (c.parent_id IS DISTINCT FROM p.parent_id OR c.sort_order <> p.sort_order)
      RETURNING c.id
  ) SELECT count(*) INTO changed_count FROM changed;
  IF changed_count > 0 THEN
    UPDATE workspaces SET updated_at = now() WHERE id = target_workspace;
  END IF;

  -- Include unchanged and previously unseen siblings as well. Revisions let
  -- clients merge this acknowledgement after newer rename/archive/move replies.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'parentId', parent_id, 'name', name, 'colorHex', color_hex,
    'sortOrder', sort_order, 'archivedAt', archived_at, 'revision', revision
  ) ORDER BY id), '[]'::jsonb) INTO moved_categories FROM categories
    WHERE workspace_id = target_workspace AND (parent_id IS NOT DISTINCT FROM saved.parent_id
      OR parent_id IS NOT DISTINCT FROM parent_category);
  RETURN jsonb_build_object('movedCategories', moved_categories);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION '同じ階層に同じ名前のカテゴリがあります。';
END;
$cake_move_category$ LANGUAGE plpgsql;
