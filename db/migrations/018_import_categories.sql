-- Category validation is set based for both CSV batches and ordinary INSERTs.
-- Existing UPDATE assignment entry points retain their row-level behavior.
CREATE FUNCTION cake_assert_transaction_categories(targets jsonb)
RETURNS void AS $cake_assert_transaction_categories$
DECLARE
  all_valid boolean;
BEGIN
  -- Lock in the same workspace -> membership -> category order as category
  -- mutations. Take all workspace locks in ID order before updating timestamps.
  WITH required AS MATERIALIZED (
    SELECT DISTINCT "workspaceId" AS workspace_id
    FROM jsonb_to_recordset(targets) AS target("workspaceId" uuid, "userId" text, "categoryId" uuid)
  ), locked AS MATERIALIZED (
    SELECT w.id FROM workspaces w JOIN required r ON r.workspace_id = w.id
      ORDER BY w.id FOR NO KEY UPDATE OF w
  ), updated AS (
    UPDATE workspaces w SET updated_at = now() FROM locked l WHERE w.id = l.id RETURNING w.id
  )
  SELECT (SELECT count(*) FROM required) = (SELECT count(*) FROM updated) INTO all_valid;
  IF NOT all_valid THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;

  WITH required AS MATERIALIZED (
    SELECT DISTINCT "workspaceId" AS workspace_id, "userId" AS user_id
    FROM jsonb_to_recordset(targets) AS target("workspaceId" uuid, "userId" text, "categoryId" uuid)
  ), locked AS MATERIALIZED (
    SELECT wm.workspace_id, wm.user_id FROM workspace_members wm JOIN required r
      ON r.workspace_id = wm.workspace_id AND r.user_id = wm.user_id
      ORDER BY wm.workspace_id, wm.user_id FOR SHARE OF wm
  )
  SELECT (SELECT count(*) FROM required) = (SELECT count(*) FROM locked) INTO all_valid;
  IF NOT all_valid THEN
    RAISE EXCEPTION 'このワークスペースを操作する権限がありません。';
  END IF;

  WITH required AS MATERIALIZED (
    SELECT DISTINCT "workspaceId" AS workspace_id, "categoryId" AS category_id
    FROM jsonb_to_recordset(targets) AS target("workspaceId" uuid, "userId" text, "categoryId" uuid)
    WHERE "categoryId" IS NOT NULL
  ), locked AS MATERIALIZED (
    SELECT c.workspace_id, c.id FROM categories c JOIN required r
      ON r.workspace_id = c.workspace_id AND r.category_id = c.id
      WHERE c.archived_at IS NULL ORDER BY c.workspace_id, c.id FOR SHARE OF c
  )
  SELECT (SELECT count(*) FROM required) = (SELECT count(*) FROM locked) INTO all_valid;
  IF NOT all_valid THEN
    RAISE EXCEPTION 'カテゴリが存在しないか、使用停止されています。';
  END IF;
END;
$cake_assert_transaction_categories$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cake_transaction_category_guard()
RETURNS trigger AS $cake_transaction_category_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.category_revision := OLD.category_revision + 1;
  ELSE
    NEW.category_revision := CASE WHEN NEW.category_id IS NULL THEN 0 ELSE 1 END;
  END IF;
  NEW.category_confirmed := NEW.category_id IS NOT NULL;
  -- INSERT validation runs once over the statement's transition table, after
  -- every row has received the same confirmation/revision normalization.
  IF TG_OP = 'UPDATE' AND NEW.category_id IS NOT NULL THEN
    PERFORM cake_assert_transaction_categories(jsonb_build_array(jsonb_build_object(
      'workspaceId', NEW.workspace_id, 'userId', NEW.updated_by, 'categoryId', NEW.category_id
    )));
  END IF;
  RETURN NEW;
END;
$cake_transaction_category_guard$ LANGUAGE plpgsql;

CREATE FUNCTION cake_inserted_transaction_categories_guard()
RETURNS trigger AS $cake_inserted_transaction_categories_guard$
DECLARE
  targets jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'workspaceId', workspace_id, 'userId', updated_by, 'categoryId', category_id
  )) INTO targets FROM (
    SELECT DISTINCT workspace_id, updated_by, category_id FROM inserted_transactions WHERE category_id IS NOT NULL
  ) requested;
  -- Legacy CSV and recurring INSERTs without categories need no context reads.
  IF targets IS NOT NULL THEN PERFORM cake_assert_transaction_categories(targets); END IF;
  RETURN NULL;
END;
$cake_inserted_transaction_categories_guard$ LANGUAGE plpgsql;
CREATE TRIGGER transactions_inserted_categories_guard
  AFTER INSERT ON transactions REFERENCING NEW TABLE AS inserted_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION cake_inserted_transaction_categories_guard();
