import type { AppActionInput } from "../../shared/schemas/app-input";
import type { AppStore } from "../stores/app-store";
import type { AppUser } from "../../shared/types";
import { workspacesService } from "./workspaces";
import { transactionsService } from "./transactions";
import { rulesService } from "./rules";
import { importsService } from "./imports";
import { settlementService } from "./settlement";
import { categoriesService } from "./categories";

export function createAppService(store: AppStore) {
  return {
    bootstrap: store.bootstrap,
    async execute(user: AppUser, input: AppActionInput) {
      switch (input.action) {
        case "createCategory":
        case "updateCategory":
        case "archiveCategory":
        case "deleteCategory":
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
