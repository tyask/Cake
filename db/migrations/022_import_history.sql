-- Existing imports are all PayPay. The default also preserves compatibility
-- with application deployments that still omit the format column on INSERT.
ALTER TABLE import_batches
  ADD COLUMN format text NOT NULL DEFAULT 'PAYPAY'
    CONSTRAINT import_batches_format_check CHECK (format IN ('PAYPAY'));

CREATE INDEX import_batches_workspace_format_importer_history_idx
  ON import_batches (workspace_id, format, imported_by, created_at DESC, id DESC);
