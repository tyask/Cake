import type { TransactionType } from "./domain-values";

export const DateTimePrecision = { Minute: "minute", Second: "second" } as const;
export type DateTimePrecision = typeof DateTimePrecision[keyof typeof DateTimePrecision];

const yenFormatter = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });
const dateTimeOptions: Intl.DateTimeFormatOptions = {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
};
const minuteFormatter = new Intl.DateTimeFormat("ja-JP", dateTimeOptions);
const shortMinuteFormatter = new Intl.DateTimeFormat("ja-JP", { ...dateTimeOptions, year: undefined });
const secondFormatter = new Intl.DateTimeFormat("ja-JP", { ...dateTimeOptions, second: "2-digit" });

export function formatYen(value: number | bigint): string {
  return yenFormatter.format(value);
}

/** Cash flow display: receipts are positive, payments are negative; zero has no sign. */
export function formatCashflow(value: number | bigint): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return sign + formatYen(value < 0 ? -value : value > 0 ? value : 0);
}

export function formatTransactionAmount(type: TransactionType, amountYen: number): string {
  return formatCashflow(type === "PAYMENT" ? -amountYen : amountYen);
}

export function cashflowClass(value: number | bigint): "positive" | "negative" | "" {
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

/** Display only. datetime-local values must use the input conversion functions. */
export function formatJstDateTime(value: string, precision: DateTimePrecision = DateTimePrecision.Second): string {
  return (precision === DateTimePrecision.Minute ? minuteFormatter : secondFormatter).format(new Date(value));
}

/** Compact display; retain the complete date in the accessible label or detail. */
export function formatJstShortDateTime(value: string): string {
  return shortMinuteFormatter.format(new Date(value));
}
