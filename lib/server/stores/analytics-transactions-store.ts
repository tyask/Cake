import type { AnalyticsRange } from "../../shared/analytics";
import type { AnalyticsTransactionsDataset } from "../../shared/analytics-transactions";
import { categoryRecord } from "../../shared/category-record";
import { transactionRecord } from "../../shared/transaction-record";
import { db } from "../database/db";
import { UserAccessError } from "../errors";

type Row = Record<string, unknown>;

/** Read current payments and their display metadata from one authorized snapshot. */
export async function findAnalyticsTransactions(
  workspaceId: string, userId: string, period: AnalyticsRange,
): Promise<AnalyticsTransactionsDataset> {
  const [row] = await db()`
    WITH enabled_user AS MATERIALIZED (
      SELECT id FROM app_users WHERE id = ${userId} AND is_enabled
    ), authorized AS MATERIALIZED (
      SELECT w.id FROM workspaces w
      JOIN workspace_members mine ON mine.workspace_id = w.id
      JOIN enabled_user u ON u.id = mine.user_id
      WHERE w.id = ${workspaceId}::uuid
    ), members AS MATERIALIZED (
      SELECT m.user_id, m.joined_at, u.name
      FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
      JOIN app_users u ON u.id = m.user_id
    )
    SELECT EXISTS(SELECT 1 FROM enabled_user) AS enabled,
      EXISTS(SELECT 1 FROM authorized) AS authorized,
      to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', user_id, 'name', name)
        ORDER BY joined_at, user_id) FROM members), '[]'::jsonb) AS members,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'parent_id', c.parent_id, 'name', c.name, 'color_hex', c.color_hex,
        'sort_order', c.sort_order, 'archived_at', c.archived_at, 'revision', c.revision
      ) ORDER BY c.sort_order, c.created_at, c.id)
        FROM categories c JOIN authorized a ON a.id = c.workspace_id), '[]'::jsonb) AS categories,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'occurred_at', t.occurred_at, 'merchant', t.merchant,
        'method', t.method, 'type', t.type, 'amount_yen', t.amount_yen,
        'actor_user_id', t.actor_user_id, 'actor_name', u.name,
        'expense_class', t.expense_class, 'settled_at', t.settled_at,
        'external_id', t.external_id, 'source', t.source,
        'split_weights', t.split_weights, 'memo', t.memo,
        'category_id', t.category_id, 'category_confirmed', t.category_confirmed,
        'category_revision', t.category_revision
      ) ORDER BY t.occurred_at DESC, t.created_at DESC, t.id DESC)
        FROM transactions t JOIN authorized a ON a.id = t.workspace_id
        JOIN app_users u ON u.id = t.actor_user_id
        WHERE t.type = 'PAYMENT'
          AND (t.expense_class = 'SHARED' OR t.actor_user_id = ${userId})
          AND t.occurred_at >= ${period.from}::date::timestamp AT TIME ZONE 'Asia/Tokyo'
          AND t.occurred_at < (${period.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo'
      ), '[]'::jsonb) AS transactions
  `;
  if (!row || row.enabled !== true) throw new UserAccessError("ログインが必要です。", 401);
  if (row.authorized !== true) throw new UserAccessError("このワークスペースを操作する権限がありません。", 403);
  return {
    workspaceId, period, snapshotAt: String(row.snapshot_at),
    members: (row.members as Row[]).map(member => ({ id: String(member.id), name: String(member.name) })),
    categories: (row.categories as Row[]).map(categoryRecord),
    transactions: (row.transactions as Row[]).map(item => transactionRecord(item)),
  };
}
