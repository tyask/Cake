import { randomUUID } from "node:crypto";
import { db } from "../database/db";
import { normalizePayPayExternalId } from "../../shared/paypay-id";
import type { ExpenseClass, SplitWeights } from "../../shared/types";

export interface PayPayImportItem {
  occurredAt: string;
  merchant: string;
  method: string;
  amountYen: number;
  externalId: string;
  actorUserId: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  categoryId?: string | null;
  memo?: string;
}

export interface PayPayImportInput {
  workspaceId: string;
  userId: string;
  fileName: string;
  totalRows: number;
  items: PayPayImportItem[];
}

export async function persistPayPayImport(input: PayPayImportInput) {
  if (input.items.some(item => item.expenseClass === "PERSONAL" && item.actorUserId !== input.userId)) {
    throw new Error("個人費は本人の明細だけ登録・変更できます。");
  }
  // Use the same order in concurrent batches while locking duplicate keys.
  const items = input.items.map((item) => ({
    ...item, externalId: normalizePayPayExternalId(item.occurredAt, item.externalId),
  })).sort((first, second) => first.externalId < second.externalId ? -1 : first.externalId > second.externalId ? 1 : 0);
  const firstByExternalId = new Map<string, PayPayImportItem>();
  for (const item of items) {
    const previous = firstByExternalId.get(item.externalId);
    if (previous && (previous.merchant !== item.merchant || previous.amountYen !== item.amountYen)) {
      throw new Error("同じ取引日・取引番号に異なる金額または取引先の明細が登録されています。CSVと登録済み明細を確認してください。");
    }
    if (!previous) firstByExternalId.set(item.externalId, item);
  }
  const sql = db();
  const batchId = randomUUID();
  // Validate every requested category, including rows that will be skipped as
  // duplicates, while holding the same workspace/member/category locks as INSERT.
  const categories = [...new Set(items.map(item => item.categoryId ?? null))];
  const categoryTargets = (categories.length ? categories : [null]).map(categoryId => ({
    workspaceId: input.workspaceId, userId: input.userId, categoryId,
  }));
  const results = await sql.transaction([
    sql`SELECT cake_assert_private_import(${input.workspaceId}::uuid, ${input.userId},
      ${JSON.stringify([...firstByExternalId.values()])}::jsonb,
      ${JSON.stringify(categoryTargets)}::jsonb)`,
    sql`
      INSERT INTO import_batches (id, workspace_id, imported_by, file_name, total_rows, imported_rows, skipped_rows, format)
      VALUES (${batchId}::uuid, ${input.workspaceId}::uuid, ${input.userId}, ${input.fileName}, ${input.totalRows}, 0, ${input.totalRows}, 'PAYPAY')
    `,
    sql`
      INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type, amount_yen, actor_user_id,
        expense_class, split_weights, external_id, source, import_batch_id, created_by, updated_by,
        category_id, category_confirmed, memo)
      SELECT ${input.workspaceId}::uuid, item."occurredAt", item.merchant, item.method, 'PAYMENT',
        item."amountYen", item."actorUserId", item."expenseClass", item."splitWeights",
        item."externalId", 'PAYPAY', ${batchId}::uuid, ${input.userId}, ${input.userId},
        item."categoryId", item."categoryId" IS NOT NULL, COALESCE(item.memo, '')
      FROM jsonb_to_recordset(${JSON.stringify([...firstByExternalId.values()])}::jsonb) AS item(
        "occurredAt" timestamptz, merchant text, method text, "amountYen" integer, "actorUserId" text,
        "expenseClass" text, "splitWeights" jsonb, "externalId" text, "categoryId" uuid, memo text
      ) ORDER BY item."externalId"
      ON CONFLICT (workspace_id, external_id) DO UPDATE
        SET external_id = transactions.external_id
        WHERE cake_assert_visible_paypay_duplicate(transactions.expense_class, transactions.actor_user_id, ${input.userId},
          transactions.source, transactions.merchant, transactions.amount_yen, EXCLUDED.merchant, EXCLUDED.amount_yen)
      RETURNING id
    `,
    sql`
      WITH imported AS (
        SELECT COUNT(*)::integer AS count FROM transactions WHERE import_batch_id = ${batchId}::uuid
      )
      UPDATE import_batches
      SET imported_rows = imported.count, skipped_rows = GREATEST(0, total_rows - imported.count)
      FROM imported WHERE id = ${batchId}::uuid
      RETURNING imported_rows, skipped_rows
    `,
  ]);
  const counts = results[results.length - 1][0];
  return { imported: Number(counts.imported_rows), skipped: Number(counts.skipped_rows) };
}
