import { z } from "zod";

export const PROFILE_NAME_MAX_LENGTH = 120;

export const profileNameSchema = z.string().trim()
  .min(1, "ユーザー名を入力してください。")
  .max(PROFILE_NAME_MAX_LENGTH, "ユーザー名は120文字以内で入力してください。");

export const updateProfileInputSchema = z.strictObject({
  action: z.literal("updateProfile"),
  name: profileNameSchema,
});
