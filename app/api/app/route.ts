import { getCurrentUser } from "@/lib/current-user";
import { appHandlers } from "@/lib/app-handlers";
import { createAppService } from "@/lib/app-service";
import { createAppStore } from "@/lib/app-store";

export const runtime = "nodejs";

const handlers = appHandlers({ currentUser: getCurrentUser, ...createAppService(createAppStore()) });
export const GET = handlers.GET;
export const POST = handlers.POST;
