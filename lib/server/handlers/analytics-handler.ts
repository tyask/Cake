import { z } from "zod";
import { createAnalyticsQuerySchema, resolveAnalyticsPeriods, type AnalyticsDataset, type AnalyticsRange, type AnalyticsScope } from "../../shared/analytics";
import { UserAccessError } from "../errors";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findAnalytics: (workspaceId: string, userId: string, periods: Record<AnalyticsScope, AnalyticsRange>) => Promise<AnalyticsDataset>;
  now?: () => Date;
};

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export function analyticsHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return response({ error: "ログインが必要です。" }, 401);
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => query.getAll(key).length !== 1)) {
        return response({ error: "入力内容を確認してください。" }, 400);
      }
      const now = dependencies.now?.() ?? new Date();
      const input = createAnalyticsQuerySchema(now).parse(Object.fromEntries(query));
      const periods = resolveAnalyticsPeriods(input, now);
      return response(await dependencies.findAnalytics(input.workspaceId, user.id, periods));
    } catch (error) {
      if (error instanceof UserAccessError) return response({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return response({ error: "入力内容を確認してください。" }, 400);
      console.error(JSON.stringify({ event: "analytics.request_failed" }));
      return response({ error: "集計を取得できませんでした。時間をおいて再度お試しください。" }, 500);
    }
  };
}
