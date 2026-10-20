-- Category IDs remain stable when names/colors change. Parent/workspace are
-- immutable in this first version, so arbitrary-depth paths cannot form cycles.
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id uuid,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40 AND name = btrim(name)),
  color_hex text NOT NULL CHECK (color_hex ~ '^#[0-9a-fA-F]{6}$'),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  archived_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL REFERENCES app_users(id),
  updated_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES categories(workspace_id, id),
  CHECK (parent_id IS DISTINCT FROM id)
);

-- Separate root/child indexes give NULL roots the same sibling-name rule.
CREATE UNIQUE INDEX categories_active_root_name_idx ON categories(workspace_id, name)
  WHERE parent_id IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX categories_active_child_name_idx ON categories(workspace_id, parent_id, name)
  WHERE parent_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX categories_workspace_parent_order_idx ON categories(workspace_id, parent_id, sort_order, id);

ALTER TABLE transactions
  ADD COLUMN category_id uuid,
  ADD COLUMN category_confirmed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT transactions_category_workspace_fk
    FOREIGN KEY (workspace_id, category_id) REFERENCES categories(workspace_id, id),
  ADD CONSTRAINT transactions_category_confirmation_check
    CHECK (category_id IS NOT NULL OR NOT category_confirmed);
CREATE INDEX transactions_workspace_category_idx ON transactions(workspace_id, category_id)
  WHERE category_id IS NOT NULL;

CREATE FUNCTION cake_category_structure_guard()
RETURNS trigger AS $cake_category_structure_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      RAISE EXCEPTION 'カテゴリの所属と親は変更できません。';
    END IF;
  ELSIF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION '追加先のカテゴリが存在しないか、使用停止されています。';
  END IF;
  RETURN NEW;
END;
$cake_category_structure_guard$ LANGUAGE plpgsql;
CREATE TRIGGER categories_structure_guard
  BEFORE INSERT OR UPDATE OF workspace_id, parent_id ON categories
  FOR EACH ROW EXECUTE FUNCTION cake_category_structure_guard();

-- All assignment entry points share the same live membership/category checks.
-- Unrelated edits retain an archived category without reassigning it.
CREATE FUNCTION cake_transaction_category_guard()
RETURNS trigger AS $cake_transaction_category_guard$
BEGIN
  -- Uncategorized legacy CSV/recurring inserts need no extra context queries.
  -- Dedicated clear operations already lock/check membership in the function.
  IF NEW.category_id IS NULL THEN
    NEW.category_confirmed := false;
    RETURN NEW;
  END IF;
  UPDATE workspaces SET updated_at = now() WHERE id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  PERFORM user_id FROM workspace_members
    WHERE workspace_id = NEW.workspace_id AND user_id = NEW.updated_by FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM categories WHERE workspace_id = NEW.workspace_id AND id = NEW.category_id AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'カテゴリが存在しないか、使用停止されています。';
  END IF;
  NEW.category_confirmed := NEW.category_id IS NOT NULL;
  RETURN NEW;
END;
$cake_transaction_category_guard$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_category_guard
  BEFORE INSERT OR UPDATE OF category_id, category_confirmed ON transactions
  FOR EACH ROW EXECUTE FUNCTION cake_transaction_category_guard();

-- One call owns validation, locks, mutation and the acknowledged response.
CREATE FUNCTION cake_mutate_category(
  target_workspace uuid, actor_id text, operation text,
  target_category uuid DEFAULT NULL, parent_category uuid DEFAULT NULL,
  category_name text DEFAULT NULL, category_color text DEFAULT NULL,
  target_transaction uuid DEFAULT NULL
)
RETURNS jsonb AS $cake_mutate_category$
DECLARE
  saved categories;
  archived_revisions jsonb;
  saved_transaction uuid;
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
      RETURNING id INTO saved_transaction;
    IF NOT FOUND THEN RAISE EXCEPTION '明細が存在しません。'; END IF;
    RETURN jsonb_build_object('transactionId', saved_transaction, 'categoryId', target_category,
      'categoryConfirmed', target_category IS NOT NULL);
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
    ), archived AS (
      UPDATE categories SET archived_at = now(), revision = revision + 1, updated_by = actor_id, updated_at = now()
        WHERE workspace_id = target_workspace AND id IN (SELECT id FROM branch) AND archived_at IS NULL
        RETURNING id, revision
    ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'revision', revision) ORDER BY id), '[]'::jsonb) INTO archived_revisions FROM archived;
    RETURN jsonb_build_object('archivedCategoryIds', (SELECT COALESCE(jsonb_agg(value->'id'), '[]'::jsonb) FROM jsonb_array_elements(archived_revisions)),
      'archivedCategoryRevisions', archived_revisions, 'archivedAt', now());
  END IF;
  RETURN jsonb_build_object('category', jsonb_build_object(
    'id', saved.id, 'parentId', saved.parent_id, 'name', saved.name, 'colorHex', saved.color_hex,
    'sortOrder', saved.sort_order, 'archivedAt', saved.archived_at, 'revision', saved.revision
  ));
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION '同じ階層に同じ名前のカテゴリがあります。';
END;
$cake_mutate_category$ LANGUAGE plpgsql;
