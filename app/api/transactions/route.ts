import { getCurrentUser } from "@/lib/server/auth/current-user";
import { transactionViewHandler } from "@/lib/server/handlers/transaction-view-handler";
import { findTransactionView } from "@/lib/server/stores/transaction-view-store";

export const runtime = "nodejs";

export const GET = transactionViewHandler({ currentUser: getCurrentUser, findTransactionView });
