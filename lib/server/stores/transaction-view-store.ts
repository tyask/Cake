import { transactionViewQuerySchema, type TransactionViewDataset, type TransactionViewQuery } from "../../shared/transaction-view";
import { transactionRecord } from "../../shared/transaction-record";
import { db } from "../database/db";
import { UserAccessError } from "../errors";

type Row = Record<string, unknown>;

/** Read only the requested rows, checking current membership in the same snapshot. */
export async function findTransactionView(
  workspaceId: string, userId: string, selection: Pick<TransactionViewQuery, "mode" | "month">,
): Promise<TransactionViewDataset> {
  const input = transactionViewQuerySchema.parse({ ...selection, workspaceId });
  const month = input.mode === "month" ? input.month : null;
  const [row] = await db()`
    WITH enabled_user AS MATERIALIZED (
      SELECT id FROM app_users WHERE id = ${userId} AND is_enabled
    ), authorized AS MATERIALIZED (
      SELECT w.id FROM workspaces w
      JOIN workspace_members mine ON mine.workspace_id = w.id
      JOIN enabled_user u ON u.id = mine.user_id
      WHERE w.id = ${workspaceId}::uuid
    ), month_bounds AS MATERIALIZED (
      -- Match the home's fixed UTC+09:00 month, including years before 1888.
      -- SQL can form January 10000 as the exclusive end of December 9999.
      SELECT ${month ? `${month}-01` : null}::date::timestamp AT TIME ZONE INTERVAL '+09:00' AS start_at,
        (${month ? `${month}-01` : null}::date + INTERVAL '1 month') AT TIME ZONE INTERVAL '+09:00' AS end_at
    )
    SELECT EXISTS(SELECT 1 FROM enabled_user) AS enabled,
      EXISTS(SELECT 1 FROM authorized) AS authorized,
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
        WHERE CASE WHEN ${input.mode} = 'unsettled'
          THEN t.expense_class = 'SHARED' AND t.settled_at IS NULL
          ELSE t.occurred_at >= (SELECT start_at FROM month_bounds)
            AND t.occurred_at < (SELECT end_at FROM month_bounds)
          END
      ), '[]'::jsonb) AS transactions
  `;
  if (!row || row.enabled !== true) throw new UserAccessError("ログインが必要です。", 401);
  if (row.authorized !== true) throw new UserAccessError("このワークスペースを操作する権限がありません。", 403);
  return { workspaceId, mode: input.mode, month,
    transactions: (row.transactions as Row[]).map(item => transactionRecord(item)),
  };
}
