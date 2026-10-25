import { importTransactionsQuerySchema, type ImportFormat, type ImportTransactionsResponse } from "../../shared/import-history";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findTransactions: (workspaceId: string, userId: string, format: ImportFormat, batchId: string) => Promise<ImportTransactionsResponse | null>;
};

const headers = { "Cache-Control": "no-store" };

export function importTransactionsHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return Response.json({ error: "ログインが必要です。" }, { status: 401, headers });

      const parameters = new URL(request.url).searchParams;
      const input = importTransactionsQuerySchema.parse({
        workspaceId: parameters.get("workspaceId"), format: parameters.get("format"), batchId: parameters.get("batchId"),
      });
      const result = await dependencies.findTransactions(input.workspaceId, user.id, input.format, input.batchId);
      if (!result) return Response.json({ error: "取込履歴が見つかりません。" }, { status: 404, headers });
      return Response.json(result, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "取込明細を取得できませんでした。";
      return Response.json({ error: message }, { status: 400, headers });
    }
  };
}
