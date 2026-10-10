import type { RecurringPaymentConfig, RecurringPaymentState } from "./recurring-payment-types";

export interface RecurringPaymentSchedule {
  state: RecurringPaymentState;
  startOn: string;
  activeFromMonth: string;
  currentConfig: RecurringPaymentConfig;
  pendingConfig: RecurringPaymentConfig | null;
  pendingEffectiveMonth: string | null;
  lastGeneratedMonth: string | null;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function jstToday(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError("日時が不正です。");
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function monthOf(date: string): string {
  if (!isCalendarDate(date)) throw new RangeError("日付が不正です。");
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(month: string, count: number): string {
  if (!Number.isInteger(count)) throw new RangeError("月数が不正です。");
  const first = monthOf(month);
  const date = new Date(`${first}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  const value = date.toISOString().slice(0, 10);
  if (!isCalendarDate(value)) throw new RangeError("日付が範囲外です。");
  return value;
}

export function scheduledDate(month: string, dayOfMonth: number): string {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new RangeError("毎月の日が不正です。");
  const first = monthOf(month);
  const date = new Date(`${first}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return `${first.slice(0, 7)}-${String(Math.min(dayOfMonth, date.getUTCDate())).padStart(2, "0")}`;
}

export function configForMonth(payment: Pick<RecurringPaymentSchedule, "currentConfig" | "pendingConfig" | "pendingEffectiveMonth">, month: string): RecurringPaymentConfig {
  return payment.pendingConfig && payment.pendingEffectiveMonth && monthOf(month) >= payment.pendingEffectiveMonth
    ? payment.pendingConfig : payment.currentConfig;
}

export function pendingEffectiveMonth(startOn: string, today: string): string {
  return [addMonths(monthOf(today), 1), monthOf(startOn)].sort().at(-1)!;
}

export function resumeFromMonth(payment: Pick<RecurringPaymentSchedule, "startOn" | "activeFromMonth">, today: string): string {
  return [payment.activeFromMonth, pendingEffectiveMonth(payment.startOn, today)].sort().at(-1)!;
}

/** Past scheduled days are never returned as recovery work. */
export function nextScheduledOn(payment: RecurringPaymentSchedule, today: string): string | null {
  if (payment.state !== "ACTIVE") return null;
  let month = [monthOf(today), monthOf(payment.startOn), payment.activeFromMonth,
    ...(payment.lastGeneratedMonth ? [addMonths(payment.lastGeneratedMonth, 1)] : [])].sort().at(-1)!;
  // At most the current candidate and the following month are needed: the first
  // might precede today/startOn, and a pending day may change the second.
  for (let attempt = 0; attempt < 2; attempt++) {
    const date = scheduledDate(month, configForMonth(payment, month).dayOfMonth);
    if (date >= today && date >= payment.startOn) return date;
    month = addMonths(month, 1);
  }
  throw new RangeError("次回予定日を計算できませんでした。");
}

export function isDueToday(payment: RecurringPaymentSchedule, today: string): boolean {
  return payment.state === "ACTIVE" && today >= payment.startOn && monthOf(today) >= payment.activeFromMonth
    && (!payment.lastGeneratedMonth || payment.lastGeneratedMonth < monthOf(today))
    && scheduledDate(monthOf(today), configForMonth(payment, monthOf(today)).dayOfMonth) === today;
}
