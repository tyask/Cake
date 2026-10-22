import { db } from "../db";
import type { AppUser, SettlementResult, SplitWeights } from "../../shared/types";
import type { SettlementContext } from "../../shared/settlement";
import type { Action, SettlementTransaction } from "../services/types";

type Row = Record<string, unknown>;

export function createSettlementStore(connect: typeof db = db) {
  return {
    async settlementContext(workspaceId: string, userId: string): Promise<SettlementContext> {
      const sql = connect();
      const rows = await sql`
        WITH authorized AS (
          SELECT w.id, w.type FROM workspaces w
          JOIN workspace_members mine ON mine.workspace_id = w.id
          WHERE w.id = ${workspaceId}::uuid AND mine.user_id = ${userId}
        )
        SELECT EXISTS(SELECT 1 FROM authorized) AS authorized,
          (SELECT type FROM authorized) AS workspace_type,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', m.user_id, 'name', u.name, 'weight', m.weight)
              ORDER BY m.joined_at, m.user_id)
            FROM workspace_members m JOIN authorized a ON a.id = m.workspace_id
            JOIN app_users u ON u.id = m.user_id
          ), '[]'::jsonb) AS members,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', t.id, 'actorUserId', t.actor_user_id, 'type', t.type,
              'amountYen', t.amount_yen, 'expenseClass', t.expense_class, 'splitWeights', t.split_weights
            ) ORDER BY t.occurred_at DESC, t.created_at DESC)
            FROM transactions t JOIN authorized a ON a.id = t.workspace_id
            WHERE t.expense_class = 'SHARED' AND t.settled_at IS NULL
          ), '[]'::jsonb) AS transactions
      `;
      const row = rows[0];
      if (!row || row.authorized !== true) throw new Error("このワークスペースを操作する権限がありません。");
      return {
        workspaceType: row.workspace_type as SettlementContext["workspaceType"],
        members: (row.members as Row[]).map(member => ({ id: String(member.id), name: String(member.name), weight: Number(member.weight) })),
        transactions: (row.transactions as Row[]).map(transaction => ({
          id: String(transaction.id), actorUserId: String(transaction.actorUserId), type: transaction.type as SettlementContext["transactions"][number]["type"],
          amountYen: Number(transaction.amountYen), expenseClass: transaction.expenseClass as SettlementContext["transactions"][number]["expenseClass"],
          splitWeights: transaction.splitWeights as SplitWeights, settledAt: null,
        })),
      };
    },
    async completeSettlement(input: Action<"completeSettlement">, user: AppUser, settlementId: string, result: SettlementResult, expectedTransactions: SettlementTransaction[], calculationSnapshot: SettlementResult & { transactions: SettlementTransaction[] }) {
      const sql = connect();
      // The first statement keeps the workspace lock and snapshot/permission recheck.
      // All four statements commit or roll back together, regardless of target count.
      const transactionIds = JSON.stringify(result.transactionIds);
      await sql.transaction([
        sql`SELECT cake_assert_settlement_snapshot(${input.workspaceId}::uuid, ${user.id}, ${JSON.stringify(expectedTransactions)}::jsonb)`,
        sql`
          INSERT INTO settlements (id, workspace_id, payer_user_id, payee_user_id, amount_yen,
            weight_snapshot, calculation_snapshot, completed_by)
          VALUES (${settlementId}::uuid, ${input.workspaceId}::uuid, ${result.payerUserId}, ${result.payeeUserId},
            ${result.amountYen}, ${JSON.stringify(result.people.map(person => ({ userId: person.userId, weight: person.weight })))}::jsonb,
            ${JSON.stringify(calculationSnapshot)}::jsonb, ${user.id})
        `,
        sql`
          INSERT INTO settlement_transactions (settlement_id, transaction_id)
          SELECT ${settlementId}::uuid, value::uuid FROM jsonb_array_elements_text(${transactionIds}::jsonb)
        `,
        sql`
          UPDATE transactions SET settled_at = now(), updated_by = ${user.id}, updated_at = now()
          WHERE workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
            AND id = ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${transactionIds}::jsonb)))
        `,
      ]);
    },
  };
}
