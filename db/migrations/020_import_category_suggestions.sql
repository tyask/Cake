-- Bound each merchant's history lookup by the requested newest eligible rows.
-- Active categories are checked at query time because their state may change.
CREATE INDEX transactions_workspace_merchant_category_history_idx
  ON transactions (workspace_id, merchant_normalized, occurred_at DESC, created_at DESC, id DESC)
  INCLUDE (category_id)
  WHERE type = 'PAYMENT' AND category_confirmed AND category_id IS NOT NULL;
