import { z } from "zod";
import { merchantSchema, workspaceIdSchema } from "./schemas/domain-schemas";

export const MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS = 2000;
export const CATEGORY_SUGGESTION_HISTORY_LIMIT = 30;

export const importCategorySuggestionsSchema = z.object({
  workspaceId: workspaceIdSchema,
  // Validate with the common merchant rule, preserving the original string as
  // the response key. Only PostgreSQL normalizes merchants for matching.
  merchants: z.array(z.string().refine(value => merchantSchema.safeParse(value).success,
    "取引先の入力内容を確認してください。"))
    .min(1).max(MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS),
});

export interface ImportCategorySuggestion {
  merchant: string;
  categoryId: string | null;
}

export interface ImportCategorySuggestionsResponse {
  suggestions: ImportCategorySuggestion[];
}
