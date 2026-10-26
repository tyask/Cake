import { db } from "../database/db";
import { requireWorkspaceMember } from "./repository";

export async function findImportDuplicates(workspaceId: string, userId: string, requestedExternalIds: readonly string[]) {
  await requireWorkspaceMember(workspaceId, userId);
  const sql = db();
  const externalIds = [...new Set(requestedExternalIds)];
  const rows = await sql`
    SELECT external_id, merchant, amount_yen, source FROM transactions
    WHERE workspace_id = ${workspaceId}::uuid
      AND (expense_class = 'SHARED' OR actor_user_id = ${userId})
      AND EXISTS (SELECT 1 FROM workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId})
      AND external_id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(externalIds)}::jsonb)))
  `;
  return {
    externalIds: rows.map(row => String(row.external_id)),
    transactions: rows.map(row => ({
      externalId: String(row.external_id), merchant: String(row.merchant),
      amountYen: Number(row.amount_yen), source: String(row.source),
    })),
  };
}
