import { z } from "zod";
import { createAnalyticsQuerySchema, resolveAnalyticsPeriods, type AnalyticsRange } from "../../shared/analytics";
import type { AnalyticsTransactionsDataset } from "../../shared/analytics-transactions";
import { UserAccessError } from "../errors";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findAnalyticsTransactions: (workspaceId: string, userId: string, period: AnalyticsRange) => Promise<AnalyticsTransactionsDataset>;
  now?: () => Date;
};

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export function analyticsTransactionsHandler(dependencies: Dependencies) {
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
      const period = resolveAnalyticsPeriods(input, now).current;
      return response(await dependencies.findAnalyticsTransactions(input.workspaceId, user.id, period));
    } catch (error) {
      if (error instanceof UserAccessError) return response({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return response({ error: "入力内容を確認してください。" }, 400);
      console.error(JSON.stringify({ event: "analytics.transactions_request_failed" }));
      return response({ error: "明細を取得できませんでした。時間をおいて再度お試しください。" }, 500);
    }
  };
}
