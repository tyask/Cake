import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RecurringPaymentError, recurringPaymentMutationSchema } from "./recurring-payments";
import type { AppUser } from "./types";
import type { listRecurringPayments, mutateRecurringPayment, runRecurringPayments } from "./recurring-payments";

type Dependencies = {
  currentUser: () => Promise<AppUser | null>;
  list: typeof listRecurringPayments;
  mutate: typeof mutateRecurringPayment;
  run: typeof runRecurringPayments;
  environment: () => Readonly<Record<string, string | undefined>>;
};

const workspaceQuery = z.object({ workspaceId: z.string().uuid() }).strict();
const manualRunInput = z.object({ workspaceId: z.string().uuid() }).strict();
const noStore = { "Cache-Control": "no-store" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

function failure(error: unknown) {
  if (error instanceof RecurringPaymentError) return response({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return response({ error: "入力内容を確認してください。", code: "INPUT_INVALID" }, 400);
  }
  console.error(JSON.stringify({ event: "recurring.request_failed", errorCode: "DATABASE_UNAVAILABLE" }));
  return response({ error: "処理できませんでした。時間をおいて再度お試しください。", code: "DATABASE_UNAVAILABLE" }, 503);
}

function authorizedCron(request: Request, secret: string | undefined) {
  if (!secret?.trim()) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** HTTP checks are separate from database operations so failed authorization never reaches them. */
export function recurringPaymentHandlers(dependencies: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        const user = await dependencies.currentUser();
        if (!user) return response({ error: "ログインが必要です。", code: "UNAUTHENTICATED" }, 401);
        const query = new URL(request.url).searchParams;
        const input = workspaceQuery.parse(Object.fromEntries(query));
        if (query.getAll("workspaceId").length !== 1) return response({ error: "入力内容を確認してください。", code: "INPUT_INVALID" }, 400);
        return response(await dependencies.list(input.workspaceId, user.id));
      } catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        const user = await dependencies.currentUser();
        if (!user) return response({ error: "ログインが必要です。", code: "UNAUTHENTICATED" }, 401);
        const input = recurringPaymentMutationSchema.parse(await request.json());
        return response(await dependencies.mutate(user.id, input), input.action === "create" ? 201 : 200);
      } catch (error) { return failure(error); }
    },
    async cron(request: Request) {
      const environment = dependencies.environment();
      if (!authorizedCron(request, environment.CRON_SECRET)) {
        return response({ error: "認証に失敗しました。", code: "UNAUTHENTICATED" }, 401);
      }
      if (new URL(request.url).searchParams.size) return response({ error: "入力内容を確認してください。", code: "INPUT_INVALID" }, 400);
      try {
        const result = await dependencies.run({});
        return response(result, result.failed || result.unprocessed ? 503 : 200);
      } catch (error) { return failure(error); }
    },
    async manualRun(request: Request) {
      const environment = dependencies.environment();
      if (environment.VERCEL_ENV === "production" || environment.AUTH_MODE !== "test") {
        return response({ error: "ページが見つかりません。", code: "NOT_FOUND" }, 404);
      }
      try {
        const user = await dependencies.currentUser();
        if (!user) return response({ error: "ログインが必要です。", code: "UNAUTHENTICATED" }, 401);
        const input = manualRunInput.parse(await request.json());
        const result = await dependencies.run({ workspaceId: input.workspaceId, authorizedUserId: user.id });
        return response(result, result.failed || result.unprocessed ? 503 : 200);
      } catch (error) { return failure(error); }
    },
  };
}
