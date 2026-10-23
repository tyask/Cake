import { isCalendarDate } from "../../../lib/shared/recurring-payment-calendar";

/** Normalize SQL date values and dates inside JSONB without a UTC conversion. */
export function verificationDate(value: unknown): string {
  if (value instanceof Date) {
    // Neon's date parser creates local midnight; UTC conversion can move it a day.
    value = `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value !== "string" || !isCalendarDate(value)) {
    throw new RangeError("検証対象の日付が不正です。");
  }
  return value;
}

/** Preserve milliseconds when Neon returns a Date rather than an ISO string. */
export function verificationTimestamp(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}
