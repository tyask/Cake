import { importCategorySuggestionsSchema, type ImportCategorySuggestionsResponse } from "../../shared/import-category-suggestions";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findSuggestions: (workspaceId: string, userId: string, merchants: readonly string[]) => Promise<ImportCategorySuggestionsResponse>;
};

export function importCategorySuggestionsHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return Response.json({ error: "ログインが必要です。" }, { status: 401 });

      const input = importCategorySuggestionsSchema.parse(await request.json());
      return Response.json(await dependencies.findSuggestions(input.workspaceId, user.id, input.merchants),
        { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "処理に失敗しました。";
      return Response.json({ error: message }, { status: 400 });
    }
  };
}
