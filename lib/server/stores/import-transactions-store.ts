import type { ImportFormat, ImportTransactionsResponse } from "../../shared/import-history";
import { categoryRecord } from "../../shared/category-record";
import { transactionRecord } from "../../shared/transaction-record";
import { db } from "../database/db";
import { requireWorkspaceMember } from "./repository";

export async function findImportTransactions(
  workspaceId: string, userId: string, format: ImportFormat, batchId: string,
): Promise<ImportTransactionsResponse | null> {
  await requireWorkspaceMember(workspaceId, userId);
  const sql = db();
  // Batch presence, its current transactions, and the category paths are read
  // from one snapshot. An existing batch with no remaining rows is still valid.
  const rows = await sql`
    WITH selected_batch AS MATERIALIZED (
      SELECT id, workspace_id FROM import_batches
      WHERE id = ${batchId}::uuid AND workspace_id = ${workspaceId}::uuid AND format = ${format}
        AND imported_by = ${userId}
        AND EXISTS (
          SELECT 1 FROM workspace_members
          WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}
        )
    )
    SELECT COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'occurred_at', t.occurred_at, 'merchant', t.merchant,
        'method', t.method, 'type', t.type, 'amount_yen', t.amount_yen,
        'actor_user_id', t.actor_user_id, 'actor_name', u.name,
        'expense_class', t.expense_class, 'settled_at', t.settled_at,
        'external_id', t.external_id, 'source', t.source,
        'split_weights', t.split_weights, 'memo', t.memo,
        'category_id', t.category_id, 'category_confirmed', t.category_confirmed,
        'category_revision', t.category_revision
      ) ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC)
      FROM transactions t
      JOIN selected_batch b ON t.workspace_id = b.workspace_id AND t.import_batch_id = b.id
      JOIN app_users u ON u.id = t.actor_user_id
      WHERE t.expense_class = 'SHARED' OR t.actor_user_id = ${userId}
    ), '[]'::jsonb) AS transactions,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'parent_id', c.parent_id, 'name', c.name, 'color_hex', c.color_hex,
        'sort_order', c.sort_order, 'archived_at', c.archived_at, 'revision', c.revision
      ) ORDER BY c.sort_order, c.created_at, c.id)
      FROM categories c JOIN selected_batch b ON c.workspace_id = b.workspace_id
    ), '[]'::jsonb) AS categories
    FROM selected_batch
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    transactions: (row.transactions as Record<string, unknown>[]).map(item => transactionRecord(item)),
    categories: (row.categories as Record<string, unknown>[]).map(categoryRecord),
  };
}
