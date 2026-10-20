import { z } from "zod";
import { workspaceIdSchema } from "./domain-schemas";
import { CATEGORY_NAME_MAX_LENGTH } from "./categories";

export const categoryNameSchema = z.string().trim().min(1, "カテゴリ名を入力してください。")
  .max(CATEGORY_NAME_MAX_LENGTH, `カテゴリ名は${CATEGORY_NAME_MAX_LENGTH}文字以内で入力してください。`);
export const categoryColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "色は#に続く6桁のカラーコードで指定してください。")
  .transform(value => value.toLowerCase());
export const categoryIdSchema = z.string().uuid().nullable();
const workspace = { workspaceId: workspaceIdSchema };
const category = { categoryId: z.string().uuid() };
const fields = { name: categoryNameSchema, colorHex: categoryColorSchema };
export const createCategoryInputSchema = z.object({ action: z.literal("createCategory"), ...workspace, parentId: categoryIdSchema, ...fields });
export const updateCategoryInputSchema = z.object({ action: z.literal("updateCategory"), ...workspace, ...category, ...fields });
export const archiveCategoryInputSchema = z.object({ action: z.literal("archiveCategory"), ...workspace, ...category });
export const moveCategoryInputSchema = z.object({ action: z.literal("moveCategory"), ...workspace, ...category,
  parentId: categoryIdSchema, beforeCategoryId: categoryIdSchema });
export const saveTransactionCategoryInputSchema = z.object({ action: z.literal("saveTransactionCategory"), ...workspace,
  transactionId: z.string().uuid(), categoryId: categoryIdSchema });
