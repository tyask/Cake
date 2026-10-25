import { importHistoryQuerySchema, type ImportFormat, type ImportHistoryResponse } from "../../shared/import-history";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findHistory: (workspaceId: string, userId: string, format: ImportFormat) => Promise<ImportHistoryResponse>;
};

export function importHistoryHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return Response.json({ error: "ログインが必要です。" }, { status: 401 });

      const parameters = new URL(request.url).searchParams;
      const input = importHistoryQuerySchema.parse({
        workspaceId: parameters.get("workspaceId"), format: parameters.get("format"),
      });
      return Response.json(await dependencies.findHistory(input.workspaceId, user.id, input.format),
        { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "取込履歴を取得できませんでした。";
      return Response.json({ error: message }, { status: 400 });
    }
  };
}
