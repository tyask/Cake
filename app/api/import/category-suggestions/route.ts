import { getCurrentUser } from "@/lib/server/auth/current-user";
import { importCategorySuggestionsHandler } from "@/lib/server/handlers/import-category-suggestions-handler";
import { findImportCategorySuggestions } from "@/lib/server/stores/import-category-suggestions-store";

export const runtime = "nodejs";

export const POST = importCategorySuggestionsHandler({ currentUser: getCurrentUser, findSuggestions: findImportCategorySuggestions });
