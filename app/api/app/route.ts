import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/current-user";
import { getBootstrap, requireWorkspaceMember } from "@/lib/repository";
import { z } from "zod";

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
      const input = z.object({ workspaceId: workspaceIdSchema, weights: z.array(z.object({ userId: z.string().min(1), weight: z.number().int().positive() })).length(2) }).parse(body);
      const workspace = await requireWorkspaceMember(input.workspaceId, user.id);
      if (workspace.type !== "SHARED") throw new Error("共有ワークスペースのみ重みを設定できます。");
      const memberRows = await sql`SELECT user_id FROM workspace_members WHERE workspace_id = ${input.workspaceId}::uuid`;
      const memberIds = new Set(memberRows.map((row) => String(row.user_id)));
      if (memberIds.size !== 2 || input.weights.some((item) => !memberIds.has(item.userId))) throw new Error("参加者情報が一致しません。");
      await sql.transaction(input.weights.map((item) => sql`UPDATE workspace_members SET weight = ${item.weight} WHERE workspace_id = ${input.workspaceId}::uuid AND user_id = ${item.userId}`));
      return Response.json({ ok: true });
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
        expenseClass: expenseClassSchema,
      }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const actor = await sql`SELECT 1 FROM workspace_members WHERE workspace_id = ${input.workspaceId}::uuid AND user_id = ${input.actorUserId}`;
      if (!actor[0]) throw new Error("取引担当者がワークスペースに参加していません。");
      if (input.transactionId) {
        const changed = await sql`
          UPDATE transactions SET occurred_at = ${input.occurredAt}::timestamptz, merchant = ${input.merchant},
            method = ${input.method}, type = ${input.type}, amount_yen = ${input.amountYen},
            actor_user_id = ${input.actorUserId}, expense_class = ${input.expenseClass},
            updated_by = ${user.id}, updated_at = now()
          WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
          RETURNING id
        `;
        if (!changed[0]) throw new Error("清算済み、または存在しない明細は編集できません。");
      } else {
        const id = randomUUID();
        await sql`
          INSERT INTO transactions (id, workspace_id, occurred_at, merchant, method, type, amount_yen,
            actor_user_id, expense_class, external_id, source, created_by, updated_by)
          VALUES (${id}::uuid, ${input.workspaceId}::uuid, ${input.occurredAt}::timestamptz, ${input.merchant},
            ${input.method}, ${input.type}, ${input.amountYen}, ${input.actorUserId}, ${input.expenseClass},
            ${`manual_${id}`}, 'MANUAL', ${user.id}, ${user.id})
        `;
      }
      return Response.json({ ok: true });
    }

    if (action === "deleteTransaction") {
      const input = z.object({ workspaceId: workspaceIdSchema, transactionId: z.string().uuid() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const deleted = await sql`
        DELETE FROM transactions
        WHERE id = ${input.transactionId}::uuid AND workspace_id = ${input.workspaceId}::uuid AND settled_at IS NULL
        RETURNING id
      `;
      if (!deleted[0]) throw new Error("清算済み、または存在しない明細は削除できません。");
      return Response.json({ ok: true });
    }

    if (action === "createRule") {
      const input = z.object({ workspaceId: workspaceIdSchema, merchantContains: z.string().trim().min(1).max(120), expenseClass: expenseClassSchema, priority: z.number().int().min(0).max(9999) }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      await sql`INSERT INTO default_rules (workspace_id, merchant_contains, expense_class, priority, created_by) VALUES (${input.workspaceId}::uuid, ${input.merchantContains}, ${input.expenseClass}, ${input.priority}, ${user.id})`;
      return Response.json({ ok: true });
    }

    if (action === "deleteRule") {
      const input = z.object({ workspaceId: workspaceIdSchema, ruleId: z.string().uuid() }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      await sql`DELETE FROM default_rules WHERE id = ${input.ruleId}::uuid AND workspace_id = ${input.workspaceId}::uuid`;
      return Response.json({ ok: true });
    }

    if (action === "bulkImport") {
      const itemSchema = z.object({
        occurredAt: z.string().datetime(), merchant: z.string().trim().min(1).max(240),
        method: z.string().trim().min(1).max(120), amountYen: z.number().int().positive(),
        externalId: z.string().trim().min(1).max(160), actorUserId: z.string().min(1),
        expenseClass: expenseClassSchema,
      });
      const input = z.object({ workspaceId: workspaceIdSchema, fileName: z.string().min(1).max(240), totalRows: z.number().int().nonnegative(), items: z.array(itemSchema).max(2000) }).parse(body);
      await requireWorkspaceMember(input.workspaceId, user.id);
      const memberRows = await sql`SELECT user_id FROM workspace_members WHERE workspace_id = ${input.workspaceId}::uuid`;
      const memberIds = new Set(memberRows.map((row) => String(row.user_id)));
      if (input.items.some((item) => !memberIds.has(item.actorUserId))) throw new Error("取引担当者が不正です。");
      const batchId = randomUUID();
      const queries = [
        sql`INSERT INTO import_batches (id, workspace_id, imported_by, file_name, total_rows, imported_rows, skipped_rows) VALUES (${batchId}::uuid, ${input.workspaceId}::uuid, ${user.id}, ${input.fileName}, ${input.totalRows}, ${input.items.length}, ${Math.max(0, input.totalRows - input.items.length)})`,
        ...input.items.map((item) => sql`
          INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type, amount_yen, actor_user_id,
            expense_class, external_id, source, import_batch_id, created_by, updated_by)
          VALUES (${input.workspaceId}::uuid, ${item.occurredAt}::timestamptz, ${item.merchant}, ${item.method}, 'PAYMENT',
            ${item.amountYen}, ${item.actorUserId}, ${item.expenseClass}, ${item.externalId}, 'PAYPAY', ${batchId}::uuid, ${user.id}, ${user.id})
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
      const queries = [
        sql`
          INSERT INTO settlements (id, workspace_id, payer_user_id, payee_user_id, amount_yen,
            weight_snapshot, calculation_snapshot, completed_by)
          VALUES (${settlementId}::uuid, ${input.workspaceId}::uuid, ${result.payerUserId}, ${result.payeeUserId},
            ${result.amountYen}, ${JSON.stringify(result.people.map((person) => ({ userId: person.userId, weight: person.weight })))}::jsonb,
            ${JSON.stringify(result)}::jsonb, ${user.id})
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
