-- Keep the import popup's lookup and ordering within its workspace and batch.
CREATE INDEX transactions_workspace_import_batch_date_idx
  ON transactions (workspace_id, import_batch_id, occurred_at DESC, created_at DESC, id DESC)
  WHERE import_batch_id IS NOT NULL;
