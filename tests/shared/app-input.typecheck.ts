import type { AppActionInput, WorkspaceActionDraft } from "../../lib/shared/schemas/app-input";
import type { RecurringPaymentMutation, RecurringPaymentMutationDraft } from "../../lib/shared/schemas/recurring-payment-schemas";
import type { RecurringPayment } from "../../lib/shared/recurring-payment-types";
import type { RecurringPaymentLog } from "../../lib/server/services/recurring-payments";

// Checked by tsc/build; never send these fixtures to an API.
export function checkActionInputContracts(app: (input: AppActionInput) => void, recurring: (input: RecurringPaymentMutation) => void) {
  app({ action: "createInvite", workspaceId: "workspace", email: "a@example.test" });
  // @ts-expect-error 招待actionへ明細削除のpayloadは渡せない。
  app({ action: "createInvite", workspaceId: "workspace", transactionId: "transaction" });
  // @ts-expect-error 知らないactionは送信できない。
  app({ action: "unknown", workspaceId: "workspace" });
  // @ts-expect-error メモ専用actionにはメモが必須。
  app({ action: "saveTransactionMemo", workspaceId: "workspace", transactionId: "transaction" });
  // @ts-expect-error 明細削除に別actionのフィールドは渡せない。
  app({ action: "deleteTransaction", workspaceId: "workspace", transactionId: "transaction", name: "別操作" });
  // @ts-expect-error updateには対象IDとrevisionが必須。
  recurring({ action: "update", workspaceId: "workspace" });
  recurring({ action: "pause", workspaceId: "workspace", paymentId: "payment", expectedRevision: 1 });
  // @ts-expect-error pauseへ設定の金額を送信できない。
  recurring({ action: "pause", workspaceId: "workspace", paymentId: "payment", expectedRevision: 1, amountYen: 100 });
}

export function checkWorkspaceDraftContracts(app: (input: WorkspaceActionDraft<AppActionInput>) => void, recurring: (input: RecurringPaymentMutationDraft) => void) {
  app({ action: "deleteRules", ruleIds: ["rule"] });
  // @ts-expect-error rule削除へtransactionIdsは渡せない。
  app({ action: "deleteRules", transactionIds: ["transaction"] });
  recurring({ action: "pause", paymentId: "payment", expectedRevision: 1 });
  // @ts-expect-error workspace補完前でもupdateのrevisionは必須。
  recurring({ action: "update", paymentId: "payment" });
}

export function checkRecurringFiniteValues(reason: (value: RecurringPayment["blockedReason"]) => void, status: (value: RecurringPaymentLog["status"]) => void, code: (value: RecurringPaymentLog["errorCode"]) => void) {
  reason("ACTOR_UNAVAILABLE");
  // @ts-expect-error 未知のDB文字列は明示的なDTO変換境界を通す。
  reason("FUTURE_REASON");
  // @ts-expect-error ログ状態は有限値だけ。
  status("anything");
  // @ts-expect-error ログへ未知のコードや任意のエラーメッセージは出さない。
  code("private database error");
}
