import { getCurrentUser } from "@/lib/server/auth/current-user";
import { analyticsHandler } from "@/lib/server/handlers/analytics-handler";
import { findAnalytics } from "@/lib/server/stores/analytics-store";

export const runtime = "nodejs";

export const GET = analyticsHandler({ currentUser: getCurrentUser, findAnalytics });
