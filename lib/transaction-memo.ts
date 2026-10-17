import { z } from "zod";
import { workspaceIdSchema } from "./domain-schemas";

export const MAX_TRANSACTION_MEMO_LENGTH = 2000;
export const transactionMemoSchema = z.string().max(MAX_TRANSACTION_MEMO_LENGTH, "メモは2000文字以内で入力してください。");
export const transactionMemoInputSchema = z.object({
  action: z.literal("saveTransactionMemo"),
  workspaceId: workspaceIdSchema,
  transactionId: z.string().uuid(),
  memo: transactionMemoSchema,
}).strict();
