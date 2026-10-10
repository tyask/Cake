import Papa from "papaparse";
import { matchingDefaultRule, transactionDefaults } from "./expense-splits";
import { applyPayPayDuplicateChecks } from "./import-duplicates";
import { payPayDateToIso, payPayExternalId } from "./paypay-id";
import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceMember } from "./types";

export { payPayDateToIso } from "./paypay-id";

export interface PayPayPreviewRow {
  key: string;
  selected: boolean;
  occurredAt: string;
  merchant: string;
  method: string;
  amountYen: number;
  externalId: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  duplicate: boolean;
  error: string | null;
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
  return matchingDefaultRule(merchant, rules)?.expenseClass ?? "PERSONAL";
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
      const duplicate = existingExternalIds.has(externalId);
      const error = !occurredAt
        ? "取引日がありません"
        : !merchant
          ? "取引先がありません"
          : !transactionNumber
            ? "取引番号がありません"
            : identityError ?? (!Number.isInteger(amountYen) || amountYen <= 0 ? "出金金額が不正です" : null);
      return {
        key: `${externalId || "row"}-${index}`,
        selected: !duplicate && !error,
        occurredAt,
        merchant,
        method: row["取引方法"]?.trim() || "PayPay",
        amountYen,
        externalId,
        ...transactionDefaults(merchant, rules, members, actorUserId),
        duplicate,
        error,
      };
    });
  return applyPayPayDuplicateChecks(rows);
}
