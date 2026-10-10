import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import { importDuplicateCheckSchema } from "@/lib/import-duplicates";
import { requireWorkspaceMember } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "ログインが必要です。" }, { status: 401 });

    const input = importDuplicateCheckSchema.parse(await request.json());
    await requireWorkspaceMember(input.workspaceId, user.id);
    const sql = db();
    const externalIds = [...new Set(input.externalIds)];
    const rows = await sql`
      SELECT external_id, merchant, amount_yen, source FROM transactions
      WHERE workspace_id = ${input.workspaceId}::uuid
        AND external_id = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(externalIds)}::jsonb)))
    `;
    return Response.json({
      externalIds: rows.map(row => String(row.external_id)),
      transactions: rows.map(row => ({
        externalId: String(row.external_id), merchant: String(row.merchant),
        amountYen: Number(row.amount_yen), source: String(row.source),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました。";
    return Response.json({ error: message }, { status: 400 });
  }
}
