import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { getBootstrap, requireWorkspaceMember } from "@/lib/repository";
import { defaultSplitWeights, personalSplitWeights, transactionDefaults, validateSplitWeights } from "@/lib/expense-splits";
import type { DefaultRule, ExpenseClass, SplitWeights } from "@/lib/types";
import { z } from "zod";
import { transactionMemoInputSchema, transactionMemoSchema } from "@/lib/transaction-memo";
import { transactionRecord } from "@/lib/transaction-record";

export const runtime = "nodejs";

async function currentUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ログインが必要です。");
  return user;
}

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "処理に失敗しました。";
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const user = await currentUser();
    const workspaceId = new URL(request.url).searchParams.get("workspaceId");
    return Response.json(await getBootstrap(user, workspaceId));
  } catch (error) {
    return errorResponse(error, 401);
  }
}

const workspaceIdSchema = z.string().uuid();
const expenseClassSchema = z.enum(["PERSONAL", "SHARED"]);
const transactionTypeSchema = z.enum(["PAYMENT", "RECEIPT"]);
const weightSchema = z.number().int().min(0).max(2_147_483_647);
const splitWeightsSchema = z.record(z.string().min(1), weightSchema);
const selectedTransactionsSchema = z.object({
  workspaceId: workspaceIdSchema,
  transactionIds: z.array(z.string().uuid()).min(1).max(5000)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "同じ明細が重複しています。"),
});

async function splitContext(workspaceId: string) {
  const sql = db();
  const [memberRows, ruleRows] = await Promise.all([
    sql`SELECT wm.user_id, wm.weight, u.name FROM workspace_members wm JOIN app_users u ON u.id = wm.user_id WHERE wm.workspace_id = ${workspaceId}::uuid ORDER BY wm.joined_at, wm.user_id`,
    sql`SELECT id, merchant_contains, expense_class, sort_order, split_weights, enabled FROM default_rules WHERE workspace_id = ${workspaceId}::uuid ORDER BY sort_order, created_at, id`,
  ]);
  return {
    members: memberRows.map((row) => ({ id: String(row.user_id), weight: Number(row.weight), name: String(row.name) })),
    rules: ruleRows.map((row): DefaultRule => ({
      id: String(row.id), merchantContains: String(row.merchant_contains),
      expenseClass: String(row.expense_class) as ExpenseClass, sortOrder: Number(row.sort_order),
      splitWeights: row.split_weights as SplitWeights | null, enabled: Boolean(row.enabled),
    })),
  };
}

function resolveTransactionSplit(
  input: { merchant: string; actorUserId: string; expenseClass?: ExpenseClass; splitWeights?: SplitWeights },
  context: Awaited<ReturnType<typeof splitContext>>,
) {
  if (!context.members.some((member) => member.id === input.actorUserId)) throw new Error("取引担当者がワークスペースに参加していません。");
  const defaults = transactionDefaults(input.merchant, context.rules, context.members, input.actorUserId);
  const expenseClass = input.expenseClass ?? defaults.expenseClass;
  const splitWeights = input.splitWeights === undefined
    ? expenseClass === "PERSONAL"
      ? personalSplitWeights(context.members, input.actorUserId)
      : defaults.expenseClass === "SHARED" ? defaults.splitWeights : defaultSplitWeights(context.members)
    : validateSplitWeights(input.splitWeights, context.members, expenseClass, input.actorUserId);
  return { expenseClass, splitWeights };
}

function resolveRuleSplit(expenseClass: ExpenseClass, splitWeights: SplitWeights | null | undefined, members: { id: string }[]) {
  if (expenseClass === "PERSONAL") {
    if (splitWeights != null) throw new Error("個人費ルールの割合は、取引担当者が1、ほかの参加者が0です。");
    return null;
  }
  return splitWeights == null ? null : validateSplitWeights(splitWeights, members);
}

export async function POST(request: Request) {
  try {
    const user = await currentUser();
    const body = (await request.json()) as Record<string, unknown>;
    const action = z.string().parse(body.action);
    const sql = db();

    if (action === "createWorkspace") {
      const input = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(["PERSONAL", "SHARED"]) }).parse(body);
      const workspaceId = randomUUID();
      await sql.transaction([
        sql`INSERT INTO workspaces (id, name, type, owner_user_id) VALUES (${workspaceId}::uuid, ${input.name}, ${input.type}, ${user.id})`,
        sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight) VALUES (${workspaceId}::uuid, ${user.id}, 'OWNER', 1)`,
      ]);
      return Response.json({ ok: true, workspaceId });
    }

    if (action === "updateWorkspace") {
      const input = z.object({ workspaceId: workspaceIdSchema, name: z.string().trim().min(1).max(80) }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      await sql`UPDATE workspaces SET name = ${input.name}, updated_at = now() WHERE id = ${input.workspaceId}::uuid`;
      return Response.json({ ok: true });
    }

    if (action === "deleteWorkspace") {
      const input = z.object({ workspaceId: workspaceIdSchema, confirmationName: z.string() }).parse(body);
      const workspace = await requireWorkspaceMember(input.workspaceId, user.id);
      if (String(workspace.name) !== input.confirmationName) throw new Error("ワークスペース名が一致しません。");
      await sql`DELETE FROM workspaces WHERE id = ${input.workspaceId}::uuid`;
      return Response.json({ ok: true });
    }

    if (action === "createInvite") {
      const input = z.object({ workspaceId: workspaceIdSchema, email: z.string().email() }).parse(body);
      const workspace = await requireWorkspaceMember(input.workspaceId, user.id);
      if (workspace.type !== "SHARED") throw new Error("共有ワークスペースでのみ招待できます。");
      if (input.email.toLowerCase() === user.email.toLowerCase()) throw new Error("自分自身は招待できません。");
      const countRows = await sql`SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = ${input.workspaceId}::uuid`;
      if (Number(countRows[0].count) >= 2) throw new Error("共有ワークスペースは二人までです。");
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await sql`
        INSERT INTO invitations (workspace_id, email, token_hash, invited_by, expires_at)
        VALUES (${input.workspaceId}::uuid, ${input.email.toLowerCase()}, ${tokenHash}, ${user.id}, now() + interval '7 days')
        ON CONFLICT (workspace_id, email) DO UPDATE SET
          token_hash = EXCLUDED.token_hash, status = 'PENDING', invited_by = EXCLUDED.invited_by,
          expires_at = EXCLUDED.expires_at, created_at = now()
      `;
      return Response.json({ ok: true, invitePath: `/invite/${token}` });
    }

    if (action === "acceptInvite") {
      const input = z.object({ token: z.string().length(64) }).parse(body);
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const invites = await sql`
        SELECT id, workspace_id, email FROM invitations
        WHERE token_hash = ${tokenHash} AND status = 'PENDING' AND expires_at > now()
        LIMIT 1
      `;
      const invite = invites[0];
      if (!invite || String(invite.email).toLowerCase() !== user.email.toLowerCase()) {
        throw new Error("この招待は無効、期限切れ、または別のメールアドレス宛てです。");
      }
      const countRows = await sql`SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = ${String(invite.workspace_id)}::uuid`;
      if (Number(countRows[0].count) >= 2) throw new Error("このワークスペースにはすでに二人参加しています。");
      await sql.transaction([
        sql`INSERT INTO workspace_members (workspace_id, user_id, role, weight) VALUES (${String(invite.workspace_id)}::uuid, ${user.id}, 'MEMBER', 1) ON CONFLICT DO NOTHING`,
        sql`UPDATE invitations SET status = 'ACCEPTED' WHERE id = ${String(invite.id)}::uuid AND status = 'PENDING'`,
      ]);
      return Response.json({ ok: true, workspaceId: String(invite.workspace_id) });
    }

    if (action === "updateWeights") {
      const input = z.object({ workspaceId: workspaceIdSchema, weights: z.array(z.object({ userId: z.string().min(1), weight: weightSchema })).min(1).max(2) }).parse(body);
      const workspace = await requireWorkspaceMember(input.workspaceId, user.id);
      if (workspace.type !== "SHARED") throw new Error("共有ワークスペースのみデフォルト割合を設定できます。");
      const memberRows = await sql`SELECT user_id FROM workspace_members WHERE workspace_id = ${input.workspaceId}::uuid`;
      const memberIds = memberRows.map((row) => String(row.user_id));
      if (new Set(input.weights.map((item) => item.userId)).size !== input.weights.length) throw new Error("参加者が重複しています。");
      validateSplitWeights(Object.fromEntries(input.weights.map((item) => [item.userId, item.weight])), memberIds);
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        ...input.weights.map((item) => sql`UPDATE workspace_members SET weight = ${item.weight} WHERE workspace_id = ${input.workspaceId}::uuid AND user_id = ${item.userId}`),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "saveTransactionMemo") {
      const input = transactionMemoInputSchema.parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`
          UPDATE transactions SET memo = ${input.memo}, updated_by = ${user.id}, updated_at = now()
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid
          RETURNING id, memo
        `,
      ]);
      if (!results[1][0]) throw new Error("明細が存在しません。");
      return Response.json({ ok: true, transactionId: String(results[1][0].id), memo: String(results[1][0].memo) });
    }

    if (action === "saveTransaction") {
      const input = z.object({
        workspaceId: workspaceIdSchema,
        transactionId: z.string().uuid().optional(),
        occurredAt: z.string().datetime(),
        merchant: z.string().trim().min(1).max(240),
        method: z.string().trim().min(1).max(120),
        type: transactionTypeSchema,
        amountYen: z.number().int().positive(),
        actorUserId: z.string().min(1),
        expenseClass: expenseClassSchema.optional(),
        splitWeights: splitWeightsSchema.optional(),
        memo: transactionMemoSchema.optional(),
      }).refine(input => !input.transactionId || input.memo === undefined, "メモの更新は専用の保存処理を使用してください。").parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const context = await splitContext(input.workspaceId);
      const previous = input.transactionId && input.splitWeights === undefined
        ? (await sql`SELECT expense_class, actor_user_id, split_weights FROM transactions WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL`)[0]
        : null;
      const split = resolveTransactionSplit({
        ...input,
        expenseClass: input.expenseClass ?? (previous ? String(previous.expense_class) as ExpenseClass : undefined),
        splitWeights: previous && (input.expenseClass === undefined || input.expenseClass === previous.expense_class)
          && (previous.expense_class === "SHARED" || input.actorUserId === previous.actor_user_id)
          ? previous.split_weights as SplitWeights : input.splitWeights,
      }, context);
      let saved: Record<string, unknown>;
      if (input.transactionId) {
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
        if (!results[1][0]) throw new Error("清算済み、または存在しない明細は編集できません。");
        saved = results[1][0];
      } else {
        const id = randomUUID();
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
        saved = results[1][0];
      }
      return Response.json({ ok: true, transaction: transactionRecord(saved, context.members.find(member => member.id === input.actorUserId)!.name) });
    }

    if (action === "deleteTransaction") {
      const input = z.object({ workspaceId: workspaceIdSchema, transactionId: z.string().uuid() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM transactions
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
          RETURNING id`,
      ]);
      if (!results[1][0]) throw new Error("清算済み、または存在しない明細は削除できません。");
      return Response.json({ ok: true });
    }

    if (action === "deleteTransactions" || action === "applyTransactionRules") {
      const input = selectedTransactionsSchema.parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const rows = await sql`
        SELECT cake_bulk_transactions(
          ${input.workspaceId}::uuid, ${user.id},
          ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.transactionIds)}::jsonb)),
          ${action === "deleteTransactions" ? "DELETE" : "APPLY_RULES"}
        ) AS result
      `;
      const result = rows[0].result as { affected: number; transactions?: Array<Record<string, unknown> & { occurredAt: string }> };
      return Response.json(action === "deleteTransactions"
        ? { ok: true, deleted: Number(result.affected) }
        : {
          ok: true, applied: Number(result.affected),
          appliedTransactions: (result.transactions ?? []).map((transaction) => ({
            ...transaction, occurredAt: new Date(transaction.occurredAt).toISOString(),
          })),
        });
    }

    if (action === "createRule") {
      const input = z.object({ workspaceId: workspaceIdSchema, merchantContains: z.string().trim().min(1).max(120), expenseClass: expenseClassSchema, splitWeights: splitWeightsSchema.nullable().optional(), enabled: z.boolean().optional() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const context = await splitContext(input.workspaceId);
      const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights, context.members);
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`INSERT INTO default_rules (workspace_id, merchant_contains, expense_class, sort_order, split_weights, enabled, created_by)
          SELECT ${input.workspaceId}::uuid, ${input.merchantContains}, ${input.expenseClass}, COALESCE(MAX(sort_order), -1) + 1, ${splitWeights === null ? null : JSON.stringify(splitWeights)}::jsonb, ${input.enabled ?? true}, ${user.id}
          FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid`,
      ]);
      return Response.json({ ok: true });
    }

    if (action === "updateRule") {
      const input = z.object({ workspaceId: workspaceIdSchema, ruleId: z.string().uuid(), merchantContains: z.string().trim().min(1).max(120), expenseClass: expenseClassSchema, splitWeights: splitWeightsSchema.nullable().optional(), enabled: z.boolean().optional() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const context = await splitContext(input.workspaceId);
      const previous = context.rules.find((rule) => rule.id === input.ruleId);
      if (!previous) throw new Error("このワークスペースにルールがありません。");
      const splitWeights = resolveRuleSplit(input.expenseClass, input.splitWeights === undefined && input.expenseClass === previous.expenseClass ? previous.splitWeights : input.splitWeights, context.members);
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`UPDATE default_rules SET merchant_contains = ${input.merchantContains}, expense_class = ${input.expenseClass}, split_weights = ${splitWeights === null ? null : JSON.stringify(splitWeights)}::jsonb, enabled = ${input.enabled ?? previous.enabled}
          WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.ruleId}::uuid RETURNING id`,
      ]);
      if (!results[1][0]) throw new Error("このワークスペースにルールがありません。");
      return Response.json({ ok: true });
    }

    if (action === "reorderRules") {
      const input = z.object({ workspaceId: workspaceIdSchema, ruleIds: z.array(z.string().uuid()).max(5000) }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      await sql`SELECT cake_reorder_default_rules(${input.workspaceId}::uuid, ${user.id}, ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.ruleIds)}::jsonb)))`;
      return Response.json({ ok: true });
    }

    if (action === "deleteRule") {
      const input = z.object({ workspaceId: workspaceIdSchema, ruleId: z.string().uuid() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM default_rules WHERE id = ${input.ruleId}::uuid AND workspace_id = ${input.workspaceId}::uuid`,
        sql`WITH ranked AS (SELECT id, (row_number() OVER (ORDER BY sort_order, created_at, id) - 1)::integer AS position FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid)
          UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id`,
      ]);
      return Response.json({ ok: true });
    }

    if (action === "deleteRules") {
      const input = z.object({
        workspaceId: workspaceIdSchema,
        ruleIds: z.array(z.string().uuid()).min(1).max(5000)
          .refine((ids) => new Set(ids).size === ids.length, "同じルールが重複しています。"),
      }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const requestedIds = JSON.stringify(input.ruleIds);
      const targets = await sql`
        SELECT id FROM default_rules
        WHERE workspace_id = ${input.workspaceId}::uuid
          AND id = ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${requestedIds}::jsonb)))
      `;
      if (targets.length !== input.ruleIds.length) {
        throw new Error("選択したルールが見つかりません。画面を更新して選び直してください。");
      }
      const results = await sql.transaction([
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`DELETE FROM default_rules
          WHERE workspace_id = ${input.workspaceId}::uuid
            AND id = ANY(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${requestedIds}::jsonb)))
          RETURNING id`,
        sql`WITH ranked AS (SELECT id, (row_number() OVER (ORDER BY sort_order, created_at, id) - 1)::integer AS position FROM default_rules WHERE workspace_id = ${input.workspaceId}::uuid)
          UPDATE default_rules r SET sort_order = ranked.position FROM ranked WHERE r.id = ranked.id`,
      ]);
      return Response.json({ ok: true, deleted: results[1].length });
    }

    if (action === "bulkImport") {
      const itemSchema = z.object({
        occurredAt: z.string().datetime(), merchant: z.string().trim().min(1).max(240),
        method: z.string().trim().min(1).max(120), amountYen: z.number().int().positive(),
        externalId: z.string().trim().min(1).max(160), actorUserId: z.string().min(1),
        expenseClass: expenseClassSchema.optional(), splitWeights: splitWeightsSchema.optional(),
      });
      const input = z.object({ workspaceId: workspaceIdSchema, fileName: z.string().min(1).max(240), totalRows: z.number().int().nonnegative(), items: z.array(itemSchema).max(2000) }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const context = await splitContext(input.workspaceId);
      const items = input.items.map((item) => ({ ...item, ...resolveTransactionSplit(item, context) }));
      const batchId = randomUUID();
      const queries = [
        sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
        sql`INSERT INTO import_batches (id, workspace_id, imported_by, file_name, total_rows, imported_rows, skipped_rows) VALUES (${batchId}::uuid, ${input.workspaceId}::uuid, ${user.id}, ${input.fileName}, ${input.totalRows}, ${input.items.length}, ${Math.max(0, input.totalRows - input.items.length)})`,
        ...items.map((item) => sql`
          INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type, amount_yen, actor_user_id,
            expense_class, split_weights, external_id, source, import_batch_id, created_by, updated_by)
          VALUES (${input.workspaceId}::uuid, ${item.occurredAt}::timestamptz, ${item.merchant}, ${item.method}, 'PAYMENT',
            ${item.amountYen}, ${item.actorUserId}, ${item.expenseClass}, ${JSON.stringify(item.splitWeights)}::jsonb, ${item.externalId}, 'PAYPAY', ${batchId}::uuid, ${user.id}, ${user.id})
          ON CONFLICT (workspace_id, external_id) DO NOTHING
        `),
      ];
      await sql.transaction(queries);
      return Response.json({ ok: true, imported: input.items.length });
    }

    if (action === "completeSettlement") {
      const input = z.object({ workspaceId: workspaceIdSchema }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const latest = await getBootstrap(user, input.workspaceId);
      const result = latest.selected?.settlement;
      if (!result || result.transactionIds.length === 0) throw new Error("清算対象の明細がありません。");
      const settlementId = randomUUID();
      const expectedTransactions = latest.selected!.transactions
        .filter((transaction) => result.transactionIds.includes(transaction.id))
        .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
        .map((transaction) => ({
          id: transaction.id, actorUserId: transaction.actorUserId, type: transaction.type,
          amountYen: transaction.amountYen, expenseClass: transaction.expenseClass, splitWeights: transaction.splitWeights,
        }));
      const calculationSnapshot = {
        ...result,
        transactions: expectedTransactions,
      };
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
      return Response.json({ ok: true });
    }

    throw new Error(`未対応の操作です: ${action}`);
  } catch (error) {
    return errorResponse(error);
  }
}
