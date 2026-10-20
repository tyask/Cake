import { db } from "./db";
import type { AppUser, Category } from "./types";
import type { Action } from "./app-services/types";

type CategoryAction = Action<"createCategory" | "updateCategory" | "archiveCategory" | "saveTransactionCategory">;
type CategoryMutationResult = { category: Category } | { archivedCategoryIds: string[]; archivedCategoryRevisions: { id: string; revision: number }[]; archivedAt: string }
  | { transactionId: string; categoryId: string | null; categoryConfirmed: boolean };

export function createCategoryStore() {
  return {
    async mutateCategory(input: CategoryAction, user: AppUser): Promise<CategoryMutationResult> {
      const operation = {
        createCategory: "CREATE", updateCategory: "UPDATE", archiveCategory: "ARCHIVE", saveTransactionCategory: "ASSIGN",
      }[input.action];
      const sql = db();
      const [row] = await sql`
        SELECT cake_mutate_category(
          ${input.workspaceId}::uuid, ${user.id}, ${operation},
          ${"categoryId" in input ? input.categoryId : null}::uuid,
          ${"parentId" in input ? input.parentId : null}::uuid,
          ${"name" in input ? input.name : null}, ${"colorHex" in input ? input.colorHex : null},
          ${"transactionId" in input ? input.transactionId : null}::uuid
        ) AS result
      `;
      return row.result as CategoryMutationResult;
    },
  };
}
