import { z } from "zod";
import {
  expenseClassSchema, ruleMerchantSchema, splitWeightsSchema, transactionFields, userIdSchema,
  weightSchema, workspaceIdSchema, workspaceNameSchema, workspaceTypeSchema,
} from "./domain-schemas";
import { MAX_PAYPAY_EXTERNAL_ID_LENGTH } from "../paypay-id";
import { transactionMemoInputSchema, transactionMemoSchema } from "./transaction-memo";
import { updateProfileInputSchema } from "./user-profile";
import { archiveCategoryInputSchema, categoryIdSchema, createCategoryInputSchema, deleteCategoryInputSchema, moveCategoryInputSchema, saveTransactionCategoryInputSchema, updateCategoryInputSchema } from "./category-input";

const workspaceShape = { workspaceId: workspaceIdSchema };
const transactionIdsSchema = z.array(z.string().uuid()).min(1).max(5000)
  .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "同じ明細が重複しています。");
const ruleShape = {
  ...workspaceShape, merchantContains: ruleMerchantSchema, expenseClass: expenseClassSchema,
  splitWeights: splitWeightsSchema.nullable().optional(), enabled: z.boolean().optional(),
};
const optionalSplitShape = { expenseClass: expenseClassSchema.optional(), splitWeights: splitWeightsSchema.optional() };
export const saveTransactionInputSchema = z.object({
  action: z.literal("saveTransaction"), ...workspaceShape, transactionId: z.string().uuid().optional(),
  ...transactionFields, ...optionalSplitShape, memo: transactionMemoSchema.optional(), categoryId: categoryIdSchema.optional(),
}).refine(input => !input.transactionId || input.memo === undefined, "メモの更新は専用の保存処理を使用してください。")
  .refine(input => !input.transactionId || input.categoryId === undefined, "カテゴリの更新は専用の保存処理を使用してください。");
// CSV imports are always PAYMENT; retain the existing policy of stripping type.
export const payPayImportItemSchema = z.object(transactionFields).omit({ type: true }).extend({
  externalId: z.string().trim().min(1).max(MAX_PAYPAY_EXTERNAL_ID_LENGTH), ...optionalSplitShape,
  categoryId: categoryIdSchema.optional(),
});

// Keep the existing strip/strict policy of each action. Do not strictify the app API.
export const appActionInputSchema = z.discriminatedUnion("action", [
  updateProfileInputSchema,
  z.object({ action: z.literal("createWorkspace"), name: workspaceNameSchema, type: workspaceTypeSchema }),
  z.object({ action: z.literal("updateWorkspace"), ...workspaceShape, name: workspaceNameSchema }),
  z.object({ action: z.literal("deleteWorkspace"), ...workspaceShape, confirmationName: z.string() }),
  z.object({ action: z.literal("createInvite"), ...workspaceShape, email: z.string().email() }),
  z.object({ action: z.literal("acceptInvite"), token: z.string().length(64) }),
  z.object({ action: z.literal("updateWeights"), ...workspaceShape,
    weights: z.array(z.object({ userId: userIdSchema, weight: weightSchema })).min(1).max(2) }),
  transactionMemoInputSchema,
  createCategoryInputSchema,
  updateCategoryInputSchema,
  archiveCategoryInputSchema,
  deleteCategoryInputSchema,
  moveCategoryInputSchema,
  saveTransactionCategoryInputSchema,
  saveTransactionInputSchema,
  z.object({ action: z.literal("deleteTransaction"), ...workspaceShape, transactionId: z.string().uuid() }),
  z.object({ action: z.literal("deleteTransactions"), ...workspaceShape, transactionIds: transactionIdsSchema }),
  z.object({ action: z.literal("applyTransactionRules"), ...workspaceShape, transactionIds: transactionIdsSchema }),
  z.object({ action: z.literal("createRule"), ...ruleShape }),
  z.object({ action: z.literal("updateRule"), ...ruleShape, ruleId: z.string().uuid() }),
  z.object({ action: z.literal("reorderRules"), ...workspaceShape, ruleIds: z.array(z.string().uuid()).max(5000) }),
  z.object({ action: z.literal("deleteRule"), ...workspaceShape, ruleId: z.string().uuid() }),
  z.object({ action: z.literal("deleteRules"), ...workspaceShape,
    ruleIds: z.array(z.string().uuid()).min(1).max(5000)
      .refine(ids => new Set(ids).size === ids.length, "同じルールが重複しています。") }),
  z.object({ action: z.literal("bulkImport"), ...workspaceShape, fileName: z.string().min(1).max(240),
    totalRows: z.number().int().nonnegative(), items: z.array(payPayImportItemSchema).max(2000) }),
  z.object({ action: z.literal("completeSettlement"), ...workspaceShape }),
]);

export type AppActionInput = z.input<typeof appActionInputSchema>;
export type RunAppAction = (payload: AppActionInput, success: string, workspaceId?: string) => Promise<unknown>;
export type WorkspaceActionDraft<Input> = Input extends { workspaceId: string } ? Omit<Input, "workspaceId"> : never;

const supportedActions: ReadonlySet<string> = new Set(appActionInputSchema.options.map(option => option.shape.action.value));

/** Preserve the app API's existing message for unknown action names. */
export function parseAppActionInput(body: unknown): AppActionInput {
  if (body && typeof body === "object" && "action" in body && typeof body.action === "string"
    && !supportedActions.has(body.action)) {
    throw new Error(`未対応の操作です: ${body.action}`);
  }
  return appActionInputSchema.parse(body);
}
