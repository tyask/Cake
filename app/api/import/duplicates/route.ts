import { getCurrentUser } from "@/lib/server/auth/current-user";
import { importDuplicateCheckSchema } from "@/lib/shared/import-duplicates";
import { findImportDuplicates } from "@/lib/server/stores/import-duplicates-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "ログインが必要です。" }, { status: 401 });

    const input = importDuplicateCheckSchema.parse(await request.json());
    return Response.json(await findImportDuplicates(input.workspaceId, user.id, input.externalIds));
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました。";
    return Response.json({ error: message }, { status: 400 });
  }
}
