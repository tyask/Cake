import { z } from "zod";

export const MAX_DUPLICATE_CHECK_IDS = 2000;

export const importDuplicateCheckSchema = z.object({
  workspaceId: z.string().uuid(),
  externalIds: z.array(z.string().trim().min(1).max(160)).min(1).max(MAX_DUPLICATE_CHECK_IDS),
});
