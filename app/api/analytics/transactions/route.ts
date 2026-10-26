import { getCurrentUser } from "@/lib/server/auth/current-user";
import { analyticsTransactionsHandler } from "@/lib/server/handlers/analytics-transactions-handler";
import { findAnalyticsTransactions } from "@/lib/server/stores/analytics-transactions-store";

export const runtime = "nodejs";

export const GET = analyticsTransactionsHandler({ currentUser: getCurrentUser, findAnalyticsTransactions });
