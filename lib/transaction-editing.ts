import { defaultSplitWeights, personalSplitWeights, validateSplitWeights } from "./expense-splits";
import type { ExpenseClass, TransactionRecord, WorkspaceMember } from "./types";

export type TransactionValues = Pick<TransactionRecord,
  "occurredAt" | "merchant" | "method" | "type" | "amountYen" | "actorUserId" | "expenseClass" | "splitWeights"
>;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function transactionValues(record: TransactionRecord): TransactionValues {
  return {
    occurredAt: record.occurredAt, merchant: record.merchant, method: record.method,
    type: record.type, amountYen: record.amountYen, actorUserId: record.actorUserId,
    expenseClass: record.expenseClass, splitWeights: { ...record.splitWeights },
  };
}

/** Show Japanese time without dropping seconds or milliseconds from a saved row. */
export function transactionDateInput(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("取引日時を正しく入力してください。");
  const local = new Date(date.getTime() + JST_OFFSET_MS).toISOString();
  return date.getUTCMilliseconds() === 0 ? local.slice(0, 19) : local.slice(0, -1);
}

export function transactionDateToIso(input: string): string {
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) throw new Error("取引日時を正しく入力してください。");
  const [, year, month, day, hour, minute, second = "00", fraction = ""] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}`;
  const date = new Date(`${local}+09:00`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999
    || new Date(date.getTime() + JST_OFFSET_MS).toISOString() !== `${local}Z`) {
    throw new Error("存在する日付と時刻を入力してください。");
  }
  return date.toISOString();
}

export function validateTransactionValues(values: TransactionValues, members: readonly WorkspaceMember[]): TransactionValues {
  const date = new Date(values.occurredAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(values.occurredAt)
    || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1
    || date.toISOString().slice(0, 19) !== values.occurredAt.slice(0, 19)) {
    throw new Error("取引日時を正しく入力してください。");
  }
  const merchant = values.merchant.trim();
  const method = values.method.trim();
  if (!merchant || merchant.length > 240) throw new Error("取引先を1〜240文字で入力してください。");
  if (!method || method.length > 120) throw new Error("取引方法を1〜120文字で入力してください。");
  if (!Number.isInteger(values.amountYen) || values.amountYen < 1 || values.amountYen > 2_147_483_647) {
    throw new Error("金額は1〜2147483647円の整数で入力してください。");
  }
  if (values.type !== "PAYMENT" && values.type !== "RECEIPT") throw new Error("取引種別が不正です。");
  if (values.expenseClass !== "PERSONAL" && values.expenseClass !== "SHARED") throw new Error("費用区分が不正です。");
  if (!members.some((member) => member.id === values.actorUserId)) throw new Error("担当者が参加者に含まれていません。");
  return {
    ...values, merchant, method,
    splitWeights: validateSplitWeights(values.splitWeights, members, values.expenseClass, values.actorUserId),
  };
}

export function transactionExpensePatch(values: TransactionValues, expenseClass: ExpenseClass, members: readonly WorkspaceMember[]): Pick<TransactionValues, "expenseClass" | "splitWeights"> {
  return {
    expenseClass,
    splitWeights: expenseClass === values.expenseClass ? { ...values.splitWeights }
      : expenseClass === "PERSONAL" ? personalSplitWeights(members, values.actorUserId) : defaultSplitWeights(members),
  };
}

export function transactionActorPatch(values: TransactionValues, actorUserId: string, members: readonly WorkspaceMember[]): Pick<TransactionValues, "actorUserId" | "splitWeights"> {
  if (!members.some((member) => member.id === actorUserId)) throw new Error("担当者が参加者に含まれていません。");
  return {
    actorUserId,
    splitWeights: values.expenseClass === "PERSONAL" ? personalSplitWeights(members, actorUserId) : { ...values.splitWeights },
  };
}
