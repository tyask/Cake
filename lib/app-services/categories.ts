import type { AppStore } from "../app-store";
import type { AppUser } from "../types";
import type { Action } from "./types";

export async function categoriesService(store: AppStore, user: AppUser,
  input: Action<"createCategory" | "updateCategory" | "archiveCategory" | "moveCategory" | "saveTransactionCategory">) {
  // The SQL operation rechecks current membership inside its workspace lock.
  const result = await store.mutateCategory(input, user);
  return { ok: true, ...result };
}
