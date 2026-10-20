import type { AppActionInput } from "./app-input";
import type { AppStore } from "./app-store";
import type { AppUser } from "./types";
import { workspacesService } from "./app-services/workspaces";
import { transactionsService } from "./app-services/transactions";
import { rulesService } from "./app-services/rules";
import { importsService } from "./app-services/imports";
import { settlementService } from "./app-services/settlement";
import { categoriesService } from "./app-services/categories";

export function createAppService(store: AppStore) {
  return {
    bootstrap: store.bootstrap,
    async execute(user: AppUser, input: AppActionInput) {
      switch (input.action) {
        case "createCategory":
        case "updateCategory":
        case "archiveCategory":
        case "moveCategory":
        case "saveTransactionCategory":
          return categoriesService(store, user, input);
        case "updateProfile":
        case "createWorkspace":
        case "updateWorkspace":
        case "deleteWorkspace":
        case "createInvite":
        case "acceptInvite":
        case "updateWeights":
          return workspacesService(store, user, input);
        case "saveTransactionMemo":
        case "saveTransaction":
        case "deleteTransaction":
        case "deleteTransactions":
        case "applyTransactionRules":
          return transactionsService(store, user, input);
        case "createRule":
        case "updateRule":
        case "reorderRules":
        case "deleteRule":
        case "deleteRules":
          return rulesService(store, user, input);
        case "bulkImport":
          return importsService(store, user, input);
        case "completeSettlement":
          return settlementService(store, user, input);
        default: {
          const unhandled: never = input;
          throw new Error(`未対応の操作です: ${unhandled}`);
        }
      }
    },
  };
}
