import { getCurrentUser } from "@/lib/server/auth/current-user";
import { importHistoryHandler } from "@/lib/server/handlers/import-history-handler";
import { findImportHistory } from "@/lib/server/stores/import-history-store";

export const runtime = "nodejs";

export const GET = importHistoryHandler({ currentUser: getCurrentUser, findHistory: findImportHistory });
