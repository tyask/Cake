import { getCurrentUser } from "@/lib/server/auth/current-user";
import { importTransactionsHandler } from "@/lib/server/handlers/import-transactions-handler";
import { findImportTransactions } from "@/lib/server/stores/import-transactions-store";

export const runtime = "nodejs";

export const GET = importTransactionsHandler({ currentUser: getCurrentUser, findTransactions: findImportTransactions });
