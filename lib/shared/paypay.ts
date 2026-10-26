import Papa from "papaparse";
import { MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH } from "./domain-values";
import { amountYenSchema, merchantSchema, methodSchema } from "./schemas/domain-schemas";
import { transactionMemoSchema } from "./schemas/transaction-memo";
import { prepareDefaultRuleMatcher, transactionDefaults } from "./expense-splits";
import { applyPayPayDuplicateChecks } from "./import-duplicates";
import { payPayDateToIso, payPayExternalId } from "./paypay-id";
import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceMember } from "./types";

export { payPayDateToIso } from "./paypay-id";

export interface PayPayPreviewRow {
  key: string;
  selected: boolean;
  occurredAt: string;
  merchant: string;
  memo: string;
  method: string;
  amountYen: number;
  externalId: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  categoryId: string | null;
  duplicate: boolean;
  error: string | null;
}

export function isPayPayRowImportable(row: PayPayPreviewRow): boolean {
  return !row.error && !row.duplicate;
}

export function payPayPreviewEditError(row: Pick<PayPayPreviewRow, "merchant" | "memo">): string | null {
  if (!merchantSchema.safeParse(row.merchant).success) return `取引先は1〜${MAX_MERCHANT_LENGTH}文字で入力してください。`;
  const memo = transactionMemoSchema.safeParse(row.memo);
  return memo.success ? null : memo.error.issues[0].message;
}

const REQUIRED_HEADERS = [
  "取引日",
  "出金金額（円）",
  "取引内容",
  "取引先",
  "取引方法",
  "取引番号",
];

function parseAmount(value: string | undefined) {
  const normalized = (value ?? "").replaceAll(",", "").trim();
  if (!/^\d+$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

export function defaultExpenseClass(merchant: string, rules: DefaultRule[]): ExpenseClass {
  return prepareDefaultRuleMatcher(rules)(merchant)?.expenseClass ?? "SHARED";
}

export function parsePayPayCsv(
  text: string,
  rules: DefaultRule[],
  existingExternalIds: Set<string>,
  members: WorkspaceMember[] = [],
  actorUserId = "",
) {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  const headers = parsed.meta.fields ?? [];
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`必要な列がありません: ${missingHeaders.join("、")}`);
  }

  const matchRule = prepareDefaultRuleMatcher(rules);
  const rows = parsed.data
    .filter((row) => row["取引内容"]?.trim() === "支払い")
    .map((row, index): PayPayPreviewRow => {
      const occurredAt = row["取引日"]?.trim() ?? "";
      const transactionNumber = row["取引番号"]?.trim() ?? "";
      let externalId = "";
      let identityError: string | null = null;
      if (occurredAt && transactionNumber) {
        try {
          externalId = payPayExternalId(payPayDateToIso(occurredAt), transactionNumber);
        } catch (failure) {
          identityError = failure instanceof Error ? failure.message : "取引IDを作成できません";
        }
      }
      const merchant = row["取引先"]?.trim() ?? "";
      const amountYen = parseAmount(row["出金金額（円）"]);
      const method = row["取引方法"]?.trim() || "PayPay";
      const duplicate = existingExternalIds.has(externalId);
      const error = !occurredAt
        ? "取引日がありません"
        : !merchant
          ? "取引先がありません"
          : !transactionNumber
            ? "取引番号がありません"
            : identityError ?? (!amountYenSchema.safeParse(amountYen).success ? "出金金額が不正です"
              : !merchantSchema.safeParse(merchant).success ? `取引先は${MAX_MERCHANT_LENGTH}文字以内で入力してください`
              : !methodSchema.safeParse(method).success ? `取引方法は${MAX_METHOD_LENGTH}文字以内で入力してください` : null);
      return {
        key: `${externalId || "row"}-${index}`,
        selected: false,
        occurredAt,
        merchant,
        memo: "",
        method,
        amountYen,
        externalId,
        ...transactionDefaults(merchant, matchRule, members, actorUserId, "SHARED"),
        categoryId: null,
        duplicate,
        error,
      };
    });
  return applyPayPayDuplicateChecks(rows);
}
