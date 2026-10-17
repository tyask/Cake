import { db } from "./db";
import { getBootstrap, requireWorkspaceMember } from "./repository";
import { updateDisplayName } from "./user-access";
import { persistPayPayImport } from "./paypay-import";
import { defaultRuleRecord } from "./default-rule-record";
import type { AppUser, DefaultRule, SettlementResult, SplitWeights } from "./types";
import type { Action, SettlementTransaction, TransactionSplit } from "./app-services/types";

type Row = Record<string, unknown>;

/** SQL adapter. Each method retains the statement order and transaction boundary of its operation. */
export function createAppStore() {
  return {
    bootstrap: getBootstrap,
    requireWorkspaceMember,
    updateDisplayName,
    persistPayPayImport,
    async splitContext(workspaceId: string) {
      const sql = db();
      const [memberRows, ruleRows] = await Promise.all([
        sql`SELECT wm.user_id, wm.weight, u.name FROM workspace_members wm JOIN app_users u ON u.id = wm.user_id WHERE wm.workspace_id = ${workspaceId}::uuid ORDER BY wm.joined_at, wm.user_id`,
        sql`SELECT id, merchant_contains, expense_class, sort_order, split_weights, enabled FROM default_rules WHERE workspace_id = ${workspaceId}::uuid ORDER BY sort_order, created_at, id`,
      ]);
      return {
        members: memberRows.map((row) => ({ id: String(row.user_id), weight: Number(row.weight), name: String(row.name) })),
        rules: ruleRows.map(defaultRuleRecord),
      };
    },
    async createWorkspace(workspaceId: string, input: Action<"createWorkspace">, user: AppUser) {
      const sql = db();
      await sql.transaction([
        sql`INSERT INTO workspaces (id, name, type, owner_user_id) VALUES (${workspaceId}::uuid, ${input.name}, ${input.type}, ${user.id})`,
        sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight) VALUES (${workspaceId}::uuid, ${user.id}, 'OWNER', 1)`,
      ]);
    },
    async updateWorkspace(input: Action<"updateWorkspace">) {
      const sql = db();
      await sql`UPDATE workspaces SET name = ${input.name}, updated_at = now() WHERE id = ${input.workspaceId}::uuid`;
    },
    // Consume the CTE output before cascading into transactions, whose history FK is NO ACTION.
    async deleteWorkspace(input: Action<"deleteWorkspace">) {
      const sql = db();
      await sql`
        WITH removed_links AS (
          DELETE FROM settlement_transactions
          WHERE settlement_id IN (SELECT id FROM settlements WHERE workspace_id = ${input.workspaceId}::uuid)
          RETURNING settlement_id
        )
        DELETE FROM workspaces WHERE id = ${input.workspaceId}::uuid
          AND (SELECT COUNT(*) FROM removed_links) >= 0
      `;
    },
    async memberCount(workspaceId: string) {
      const sql = db();
      return await sql`SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = ${workspaceId}::uuid`;
    },
    async createInvite(input: Action<"createInvite">, user: AppUser, tokenHash: string) {
      const sql = db();
      await sql`
        INSERT INTO invitations (workspace_id, email, token_hash, invited_by, expires_at)
        VALUES (${input.workspaceId}::uuid, ${input.email.toLowerCase()}, ${tokenHash}, ${user.id}, now() + interval '7 days')
        ON CONFLICT (workspace_id, email) DO UPDATE SET
          token_hash = EXCLUDED.token_hash, status = 'PENDING', invited_by = EXCLUDED.invited_by,
          expires_at = EXCLUDED.expires_at, created_at = now()
      `;
    },
    async findInvite(tokenHash: string) {
      const sql = db();
      return await sql`
        SELECT id, workspace_id, email FROM invitations
        WHERE token_hash = ${tokenHash} AND status = 'PENDING' AND expires_at > now()
        LIMIT 1
      `;
    },
    async acceptInvite(invite: Row, user: AppUser) {
      const sql = db();
      await sql.transaction([
        sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight) VALUES (${String(invite.workspace_id)}::uuid, ${user.id}, 'MEMBER', 1) ON CONFLICT DO NOTHING`,
        sql`UPDATE invitations SET status = 'ACCEPTED' WHERE id = ${String(invite.id)}::uuid AND status = 'PENDING'`,
      ]);
    },
    async memberIds(workspaceId: string) {
      const sql = db();
      return await sql`SELECT user_id FROM workspace_members WHERE workspace_id = ${workspaceId}::uuid`;
    },
    async updateWeights(input: Action<"updateWeights">) {
      const sql = db();
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        ...input.weights.map((item) => sql`UPDATE workspace_members SET weight = ${item.weight} WHERE workspace_id = ${input.workspaceId}::uuid AND user_id = ${item.userId}`),
      ]);
    },
    async saveTransactionMemo(input: Action<"saveTransactionMemo">, user: AppUser) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`
          UPDATE transactions SET memo = ${input.memo}, updated_by = ${user.id}, updated_at = now()
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid
          RETURNING id, memo
        `,
      ]);
      return results[1][0] as Row | undefined;
    },
    async previousTransaction(input: Action<"saveTransaction">): Promise<Row | undefined> {
      const sql = db();
      return (await sql`SELECT expense_class, actor_user_id, split_weights FROM transactions WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL`)[0];
    },
    async updateTransaction(input: Action<"saveTransaction">, user: AppUser, split: TransactionSplit) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`
          UPDATE transactions SET occurred_at = ${input.occurredAt}::timestamptz, merchant = ${input.merchant},
            method = ${input.method}, type = ${input.type}, amount_yen = ${input.amountYen},
            actor_user_id = ${input.actorUserId}, expense_class = ${split.expenseClass}, split_weights = ${JSON.stringify(split.splitWeights)}::jsonb,
            updated_by = ${user.id}, updated_at = now()
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
          RETURNING *
          `,
      ]);
      return results[1][0] as Row | undefined;
    },
    async insertTransaction(input: Action<"saveTransaction">, user: AppUser, split: TransactionSplit, id: string) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`
          INSERT INTO transactions (id, workspace_id, occurred_at, merchant, method, type, amount_yen,
            actor_user_id, expense_class, split_weights, external_id, source, created_by, updated_by, memo)
          VALUES (${id}::uuid, ${input.workspaceId}::uuid, ${input.occurredAt}::timestamptz, ${input.merchant},
            ${input.method}, ${input.type}, ${input.amountYen}, ${input.actorUserId}, ${split.expenseClass}, ${JSON.stringify(split.splitWeights)}::jsonb,
            ${`manual_${id}`}, 'MANUAL', ${user.id}, ${user.id}, ${input.memo ?? ""})
          RETURNING *
          `,
      ]);
      return results[1][0] as Row;
    },
    async deleteTransaction(input: Action<"deleteTransaction">) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM transactions
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
          RETURNING id`,
      ]);
      return results[1].length > 0;
    },
    async bulkTransactions(input: Action<"deleteTransactions" | "applyTransactionRules">, user: AppUser) {
      const sql = db();
      return await sql`
        SELECT cake_bulk_transactions(
          ${input.workspaceId}::uuid, ${user.id},
          ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.transactionIds)}::jsonb)),
          ${input.action === "deleteTransactions" ? "DELETE" : "APPLY_RULES"}
        ) AS result
      `;
    },
    async createRule(input: Action<"createRule">, user: AppUser, splitWeights: SplitWeights | null) {
      const sql = db();
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`INSERT INTO default_rules (workspace_id, merchant_contains, expense_class, sort_order, split_weights, enabled, created_by)
          SELECT ${input.workspaceId}::uuid, ${input.merchantContains}, ${input.expenseClass}, COALESCE(MAX(sort_order), -1) + 1, ${splitWeights === null ? null : JSON.stringify(splitWeights)}::jsonb, ${input.enabled ?? true}, ${user.id}
          FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid`,
      ]);
    },
    async updateRule(input: Action<"updateRule">, splitWeights: SplitWeights | null, previous: DefaultRule) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`UPDATE default_rules SET merchant_contains = ${input.merchantContains}, expense_class = ${input.expenseClass}, split_weights = ${splitWeights === null ? null : JSON.stringify(splitWeights)}::jsonb, enabled = ${input.enabled ?? previous.enabled}
          WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.ruleId}::uuid RETURNING id`,
      ]);
      return results[1].length > 0;
    },
    async reorderRules(input: Action<"reorderRules">, user: AppUser) {
      const sql = db();
      await sql`SELECT cake_reorder_default_rules(${input.workspaceId}::uuid, ${user.id}, ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.ruleIds)}::jsonb)))`;
    },
    async deleteRule(input: Action<"deleteRule">) {
      const sql = db();
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM default_rules WHERE id = ${input.ruleId}::uuid AND workspace_id = ${input.workspaceId}::uuid`,
        sql`WITH ranked AS (SELECT id, (row_number() OVER (ORDER BY sort_order, created_at, id) - 1)::integer AS position FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid)
          UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id`,
      ]);
    },
    async ruleTargets(input: Action<"deleteRules">, requestedIds: string) {
      const sql = db();
      return await sql`
        SELECT id FROM default_rules
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND id = ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${requestedIds}::jsonb)))
      `;
    },
    async deleteRules(input: Action<"deleteRules">, requestedIds: string) {
      const sql = db();
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM default_rules
          WHERE workspace_id = ${input.workspaceId}::uuid
            AND id = ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${requestedIds}::jsonb)))
          RETURNING id`,
        sql`WITH ranked AS (SELECT id, (row_number() OVER (ORDER BY sort_order, created_at, id) - 1)::integer AS position FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid)
          UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id`,
      ]);
      return results[1].length;
    },
    async completeSettlement(input: Action<"completeSettlement">, user: AppUser, settlementId: string, result: SettlementResult, expectedTransactions: SettlementTransaction[], calculationSnapshot: SettlementResult & { transactions: SettlementTransaction[] }) {
      const sql = db();
      const queries = [
        sql`SELECT cake_assert_settlement_snapshot(${input.workspaceId}::uuid, ${user.id}, ${JSON.stringify(expectedTransactions)}::jsonb)`,
        sql`
          INSERT INTO settlements (id, workspace_id, payer_user_id, payee_user_id, amount_yen,
            weight_snapshot, calculation_snapshot, completed_by)
          VALUES (${settlementId}::uuid, ${input.workspaceId}::uuid, ${result.payerUserId}, ${result.payeeUserId},
            ${result.amountYen}, ${JSON.stringify(result.people.map((person) => ({ userId: person.userId, weight: person.weight })))}::jsonb,
            ${JSON.stringify(calculationSnapshot)}::jsonb, ${user.id})
        `,
        ...result.transactionIds.map((transactionId) => sql`
          INSERT INTO settlement_transactions (settlement_id, transaction_id)
          VALUES (${settlementId}::uuid, ${transactionId}::uuid)
        `),
        ...result.transactionIds.map((transactionId) => sql`
          UPDATE transactions SET settled_at = now(), updated_by = ${user.id}, updated_at = now()
          WHERE id = ${transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
        `),
      ];
      await sql.transaction(queries);
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;
