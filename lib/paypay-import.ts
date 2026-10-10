import { randomUUID } from "node:crypto";
import { db } from "./db";
import { normalizePayPayExternalId } from "./paypay-id";
import type { ExpenseClass, SplitWeights } from "./types";

export interface PayPayImportItem {
  occurredAt: string;
  merchant: string;
  method: string;
  amountYen: number;
  externalId: string;
  actorUserId: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
}

export interface PayPayImportInput {
  workspaceId: string;
  userId: string;
  fileName: string;
  totalRows: number;
  items: PayPayImportItem[];
}

export async function persistPayPayImport(input: PayPayImportInput) {
  // Use the same order in concurrent batches while locking duplicate keys.
  const items = input.items.map((item) => ({
    ...item, externalId: normalizePayPayExternalId(item.occurredAt, item.externalId),
  })).sort((first, second) => first.externalId < second.externalId ? -1 : first.externalId > second.externalId ? 1 : 0);
  const sql = db();
  const batchId = randomUUID();
  const results = await sql.transaction([
    sql`UPDATE workspaces SET updated_at = now() WHERE id = ${input.workspaceId}::uuid`,
    sql`
      INSERT INTO import_batches (id, workspace_id, imported_by, file_name, total_rows, imported_rows, skipped_rows)
      VALUES (${batchId}::uuid, ${input.workspaceId}::uuid, ${input.userId}, ${input.fileName}, ${input.totalRows}, 0, ${input.totalRows})
    `,
    ...items.map((item) => sql`
      INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type, amount_yen, actor_user_id,
        expense_class, split_weights, external_id, source, import_batch_id, created_by, updated_by)
      VALUES (${input.workspaceId}::uuid, ${item.occurredAt}::timestamptz, ${item.merchant}, ${item.method}, 'PAYMENT',
        ${item.amountYen}, ${item.actorUserId}, ${item.expenseClass}, ${JSON.stringify(item.splitWeights)}::jsonb,
        ${item.externalId}, 'PAYPAY', ${batchId}::uuid, ${input.userId}, ${input.userId})
      ON CONFLICT (workspace_id, external_id) DO UPDATE
        SET external_id = transactions.external_id
        WHERE cake_assert_paypay_duplicate(transactions.source, transactions.merchant, transactions.amount_yen,
          EXCLUDED.merchant, EXCLUDED.amount_yen)
      RETURNING id
    `),
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
