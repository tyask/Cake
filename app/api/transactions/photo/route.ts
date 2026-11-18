import { getCurrentUser } from "@/lib/server/auth/current-user";
import { photoTransactionHandler } from "@/lib/server/handlers/photo-transaction-handler";
import { extractPhotoTransaction } from "@/lib/server/photo-transaction";
import { requireWorkspaceMember } from "@/lib/server/stores/repository";
import { findImportCategorySuggestions } from "@/lib/server/stores/import-category-suggestions-store";

export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = photoTransactionHandler({
  currentUser: getCurrentUser, requireMember: requireWorkspaceMember,
  extract: extractPhotoTransaction, findSuggestions: findImportCategorySuggestions,
});
