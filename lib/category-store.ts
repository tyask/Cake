import { db } from "./db";
import type { AppUser, Category } from "./types";
import type { Action } from "./app-services/types";
import type { CategoryDeletion } from "./category-updates";

type CategoryAction = Action<"createCategory" | "updateCategory" | "archiveCategory" | "deleteCategory" | "moveCategory" | "saveTransactionCategory">;
type CategoryMutationResult = ({ category: Category } | { archivedCategoryIds: string[]; archivedCategories: Category[] }
  | { movedCategories: Category[] }
  | CategoryDeletion
  | { transactionId: string; categoryId: string | null; categoryConfirmed: boolean; categoryRevision: number })
  & { ancestorCategories?: Category[] };

export function createCategoryStore() {
  return {
    async mutateCategory(input: CategoryAction, user: AppUser): Promise<CategoryMutationResult> {
      const sql = db();
      if (input.action === "deleteCategory") {
        const [row] = await sql`
          SELECT cake_delete_category(${input.workspaceId}::uuid, ${user.id}, ${input.categoryId}::uuid) AS result
        `;
        return row.result as CategoryMutationResult;
      }
      if (input.action === "moveCategory") {
        const [row] = await sql`
          SELECT cake_move_category(${input.workspaceId}::uuid, ${user.id}, ${input.categoryId}::uuid,
            ${input.parentId}::uuid, ${input.beforeCategoryId}::uuid) AS result
        `;
        return row.result as CategoryMutationResult;
      }
      const operation = {
        createCategory: "CREATE", updateCategory: "UPDATE", archiveCategory: "ARCHIVE", saveTransactionCategory: "ASSIGN",
      }[input.action];
      const [row] = await sql`
        SELECT cake_mutate_category_with_ancestors(
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
