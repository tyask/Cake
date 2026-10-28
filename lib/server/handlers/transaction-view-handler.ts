import { z } from "zod";
import { transactionViewQuerySchema, type TransactionViewDataset, type TransactionViewQuery } from "../../shared/transaction-view";
import { UserAccessError } from "../errors";

type Dependencies = {
  currentUser: () => Promise<{ id: string } | null>;
  findTransactionView: (workspaceId: string, userId: string, selection: Pick<TransactionViewQuery, "mode" | "month">) => Promise<TransactionViewDataset>;
};

const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export function transactionViewHandler(dependencies: Dependencies) {
  return async function GET(request: Request) {
    try {
      const user = await dependencies.currentUser();
      if (!user) return response({ error: "ログインが必要です。" }, 401);
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => query.getAll(key).length !== 1)) {
        return response({ error: "入力内容を確認してください。" }, 400);
      }
      const input = transactionViewQuerySchema.parse(Object.fromEntries(query));
      const selection = input.mode === "month" ? { mode: input.mode, month: input.month } : { mode: input.mode };
      return response(await dependencies.findTransactionView(input.workspaceId, user.id, selection));
    } catch (error) {
      if (error instanceof UserAccessError) return response({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return response({ error: "入力内容を確認してください。" }, 400);
      console.error(JSON.stringify({ event: "transactions.view_request_failed" }));
      return response({ error: "明細を取得できませんでした。時間をおいて再度お試しください。" }, 500);
    }
  };
}
