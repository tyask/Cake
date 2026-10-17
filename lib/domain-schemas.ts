import { z } from "zod";
import { MAX_AMOUNT_YEN, MAX_SPLIT_WEIGHT, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH, MAX_RULE_MERCHANT_LENGTH, MAX_WORKSPACE_NAME_LENGTH, bootstrapScopes, expenseClasses, transactionSources, transactionTypes, workspaceRoles, workspaceTypes } from "./domain-values";

export { MAX_AMOUNT_YEN, MAX_SPLIT_WEIGHT, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH, MAX_RULE_MERCHANT_LENGTH, MAX_WORKSPACE_NAME_LENGTH } from "./domain-values";

export const workspaceTypeSchema = z.enum(workspaceTypes);
export const expenseClassSchema = z.enum(expenseClasses);
export const transactionTypeSchema = z.enum(transactionTypes);
export const transactionSourceSchema = z.enum(transactionSources);
export const workspaceRoleSchema = z.enum(workspaceRoles);
export const bootstrapScopeSchema = z.enum(bootstrapScopes);
export const workspaceIdSchema = z.string().uuid();
export const userIdSchema = z.string().min(1);
export const merchantSchema = z.string().trim().min(1).max(MAX_MERCHANT_LENGTH);
export const methodSchema = z.string().trim().min(1).max(MAX_METHOD_LENGTH);
export const amountYenSchema = z.number().int().positive().max(MAX_AMOUNT_YEN);
export const weightSchema = z.number().int().min(0).max(MAX_SPLIT_WEIGHT);
export const splitWeightsSchema = z.record(userIdSchema, weightSchema);
export const positiveSplitWeightsSchema = splitWeightsSchema.refine(
  weights => Object.values(weights).some(weight => weight > 0), "割合は少なくとも一人を1以上にしてください。",
);
export const workspaceNameSchema = z.string().trim().min(1).max(MAX_WORKSPACE_NAME_LENGTH);
export const ruleMerchantSchema = z.string().trim().min(1).max(MAX_RULE_MERCHANT_LENGTH);
export const transactionFields = {
  occurredAt: z.string().datetime(), merchant: merchantSchema, method: methodSchema,
  type: transactionTypeSchema, amountYen: amountYenSchema, actorUserId: userIdSchema,
};
