import { bootstrapScopeSchema } from "./domain-schemas";
import { parseAppActionInput, type AppActionInput } from "./app-input";
import { UserAccessError } from "./user-access";
import type { AppUser, BootstrapScope } from "./types";

type Dependencies = {
  currentUser: () => Promise<AppUser | null>;
  bootstrap: (user: AppUser, workspaceId: string | null, scope: BootstrapScope) => Promise<unknown>;
  execute: (user: AppUser, input: AppActionInput) => Promise<unknown>;
};

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "処理に失敗しました。";
  return Response.json({ error: message }, { status: error instanceof UserAccessError ? error.status : status });
}

export function appHandlers(dependencies: Dependencies) {
  async function currentUser() {
    const user = await dependencies.currentUser();
    if (!user) throw new Error("ログインが必要です。");
    return user;
  }
  return {
    async GET(request: Request) {
      try {
        const user = await currentUser();
        const params = new URL(request.url).searchParams;
        const workspaceId = params.get("workspaceId");
        const scope = bootstrapScopeSchema.parse(params.get("scope") ?? "full");
        return Response.json(await dependencies.bootstrap(user, workspaceId, scope));
      } catch (error) { return errorResponse(error, 401); }
    },
    async POST(request: Request) {
      try {
        const user = await currentUser();
        const body: unknown = await request.json();
        const input = parseAppActionInput(body);
        return Response.json(await dependencies.execute(user, input));
      } catch (error) { return errorResponse(error); }
    },
  };
}
