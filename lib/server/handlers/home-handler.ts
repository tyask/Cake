import { z } from "zod";
import { homeQuerySchema, type HomeData } from "../../shared/home-data";
import { UserAccessError } from "../errors";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findHome: (workspaceId: string, userId: string, month: string) => Promise<HomeData>;
};

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export function homeHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return response({ error: "ログインが必要です。" }, 401);
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => query.getAll(key).length !== 1)) {
        return response({ error: "入力内容を確認してください。" }, 400);
      }
      const input = homeQuerySchema.parse(Object.fromEntries(query));
      return response(await dependencies.findHome(input.workspaceId, user.id, input.month));
    } catch (error) {
      if (error instanceof UserAccessError) return response({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return response({ error: "入力内容を確認してください。" }, 400);
      console.error(JSON.stringify({ event: "home.request_failed" }));
      return response({ error: "ホームの集計を取得できませんでした。時間をおいて再度お試しください。" }, 500);
    }
  };
}
