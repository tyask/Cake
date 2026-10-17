import { z } from "zod";
import { amountYenSchema, expenseClassSchema, merchantSchema, methodSchema, positiveSplitWeightsSchema, userIdSchema, workspaceIdSchema } from "./domain-schemas";
import { transactionMemoSchema } from "./transaction-memo";

const configShape = {
  dayOfMonth: z.number().int().min(1).max(31), merchant: merchantSchema, method: methodSchema,
  amountYen: amountYenSchema, actorUserId: userIdSchema, expenseClass: expenseClassSchema,
  splitWeights: positiveSplitWeightsSchema, memo: transactionMemoSchema,
};
export const recurringPaymentConfigSchema = z.object(configShape).strict();
const identityShape = { workspaceId: workspaceIdSchema, paymentId: z.uuid(), expectedRevision: z.number().int().positive().max(2_147_483_647) };
export const recurringPaymentMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), workspaceId: workspaceIdSchema, ...configShape }).strict(),
  z.object({ action: z.literal("update"), ...identityShape, ...configShape }).strict(),
  z.object({ action: z.literal("pause"), ...identityShape }).strict(),
  z.object({ action: z.literal("resume"), ...identityShape }).strict(),
  z.object({ action: z.literal("archive"), ...identityShape }).strict(),
]);
export type RecurringPaymentConfig = z.infer<typeof recurringPaymentConfigSchema>;
export type RecurringPaymentMutation = z.input<typeof recurringPaymentMutationSchema>;
export type RecurringPaymentMutationDraft<Input = RecurringPaymentMutation> = Input extends { workspaceId: string } ? Omit<Input, "workspaceId"> : never;
