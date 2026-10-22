import { getCurrentUser } from "@/lib/server/auth/current-user";
import { appHandlers } from "@/lib/server/handlers/app-handlers";
import { createAppService } from "@/lib/server/services/app-service";
import { createAppStore } from "@/lib/server/stores/app-store";

export const runtime = "nodejs";

const handlers = appHandlers({ currentUser: getCurrentUser, ...createAppService(createAppStore()) });
export const GET = handlers.GET;
export const POST = handlers.POST;
