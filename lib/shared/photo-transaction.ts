import { z } from "zod";
import { amountYenSchema, merchantSchema } from "./schemas/domain-schemas";
import { categoryIdSchema } from "./schemas/category-input";
import { transactionMemoSchema } from "./schemas/transaction-memo";
import { transactionDateToIso } from "./transaction-editing";

export const MAX_PHOTO_UPLOAD_BYTES = 3 * 1024 * 1024;
export const MAX_PHOTO_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_PHOTO_DIMENSION = 2048;
export const PHOTO_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMimeType = typeof PHOTO_MIME_TYPES[number];

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { transactionDateToIso(`${value}T00:00`); return true; } catch { return false; }
});
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const photoTransactionExtractionSchema = z.object({
  date: dateSchema.nullable(),
  time: timeSchema.nullable(),
  merchant: merchantSchema.nullable(),
  amountYen: amountYenSchema.nullable(),
  memo: transactionMemoSchema.nullable(),
}).strict();

export const photoTransactionResponseSchema = photoTransactionExtractionSchema.extend({
  categoryId: categoryIdSchema,
  categorySuggestionFailed: z.boolean(),
});

export type PhotoTransactionExtraction = z.infer<typeof photoTransactionExtractionSchema>;
export type PhotoTransactionResponse = z.infer<typeof photoTransactionResponseSchema>;
