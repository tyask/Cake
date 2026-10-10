import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths, configForMonth, isCalendarDate, isDueToday, jstToday, monthOf,
  nextScheduledOn, pendingEffectiveMonth, resumeFromMonth, scheduledDate,
} from "../lib/recurring-payment-calendar";
import type { RecurringPaymentSchedule } from "../lib/recurring-payment-calendar";
import type { RecurringPaymentConfig } from "../lib/recurring-payment-types";

const config: RecurringPaymentConfig = { dayOfMonth: 27, merchant: "家賃", method: "銀行振込", amountYen: 100000,
  actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, memo: "" };
const payment = (overrides: Partial<RecurringPaymentSchedule> = {}): RecurringPaymentSchedule => ({
  state: "ACTIVE", startOn: "2026-10-10", activeFromMonth: "2026-10-01", currentConfig: config,
  pendingConfig: null, pendingEffectiveMonth: null, lastGeneratedMonth: null, ...overrides,
});

test("日本時間の日付はUTCの15時で日付・年を繰り上げる", () => {
  assert.equal(jstToday(new Date("2026-12-31T14:59:59.999Z")), "2026-12-31");
  assert.equal(jstToday(new Date("2026-12-31T15:00:00Z")), "2027-01-01");
  assert.throws(() => jstToday(new Date("invalid")), RangeError);
});

test("開始日は実在する日付だけを受け入れる", () => {
  for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-10-00", "2026-1-01", "0000-01-01"]) {
    assert.equal(isCalendarDate(value), false, value);
  }
  assert.equal(isCalendarDate("2028-02-29"), true);
  assert.equal(isCalendarDate("0001-01-01"), true);
});

test("29〜31日はその月の末日に丸め、閏年にも対応する", () => {
  for (const day of [29, 30, 31]) assert.equal(scheduledDate("2027-02-01", day), "2027-02-28");
  assert.equal(scheduledDate("2028-02-01", 31), "2028-02-29");
  assert.equal(scheduledDate("2026-04-01", 31), "2026-04-30");
  assert.equal(scheduledDate("2026-12-01", 1), "2026-12-01");
  assert.throws(() => scheduledDate("2026-01-01", 0), RangeError);
  assert.throws(() => scheduledDate("2026-01-01", 32), RangeError);
  assert.equal(addMonths("2026-12-31", 1), "2027-01-01");
  assert.equal(monthOf("2028-02-29"), "2028-02-01");
});

test("当日のみ生成し、失敗した翌日に過去予定を補完しない", () => {
  const setting = payment();
  assert.equal(isDueToday(setting, "2026-10-26"), false);
  assert.equal(isDueToday(setting, "2026-10-27"), true);
  assert.equal(isDueToday(setting, "2026-10-28"), false);
  assert.equal(nextScheduledOn(setting, "2026-10-28"), "2026-11-27");
  assert.equal(isDueToday(setting, "2026-11-27"), true);
});

test("開始前の予定を飛ばし、月末丸め後の実際の日付で開始日を判定する", () => {
  assert.equal(nextScheduledOn(payment({ startOn: "2026-10-28" }), "2026-10-10"), "2026-11-27");
  assert.equal(isDueToday(payment({ startOn: "2026-10-28" }), "2026-10-27"), false);
  assert.equal(nextScheduledOn(payment({ startOn: "2027-02-28", activeFromMonth: "2027-02-01",
    currentConfig: { ...config, dayOfMonth: 31 } }), "2027-02-10"), "2027-02-28");
});

test("翌月の変更は候補抽出と次回日付で同じ設定を使う", () => {
  const pending = { ...config, dayOfMonth: 10, amountYen: 110000 };
  const setting = payment({ pendingConfig: pending, pendingEffectiveMonth: "2026-11-01" });
  assert.equal(configForMonth(setting, "2026-10-01"), config);
  assert.equal(configForMonth(setting, "2026-11-01"), pending);
  assert.equal(nextScheduledOn(setting, "2026-10-28"), "2026-11-10");
  assert.equal(isDueToday(setting, "2026-11-10"), true);
  assert.equal(isDueToday(setting, "2026-11-27"), false);
});

test("未来の開始月に設定変更を適用し、開始日前なら次の月の予定を返す", () => {
  assert.equal(pendingEffectiveMonth("2026-12-28", "2026-10-10"), "2026-12-01");
  assert.equal(pendingEffectiveMonth("2026-09-01", "2026-10-10"), "2026-11-01");
  const future = payment({ startOn: "2026-12-28", activeFromMonth: "2026-12-01",
    pendingConfig: { ...config, dayOfMonth: 31 }, pendingEffectiveMonth: "2026-12-01" });
  assert.equal(nextScheduledOn(future, "2026-10-10"), "2026-12-31");
  assert.equal(nextScheduledOn({ ...future, pendingConfig: { ...config, dayOfMonth: 10 } }, "2026-10-10"), "2027-01-10");
});

test("停止中・要確認・削除設定は予定日と生成を返さない", () => {
  for (const state of ["PAUSED", "BLOCKED", "ARCHIVED"] as const) {
    assert.equal(nextScheduledOn(payment({ state }), "2026-10-10"), null);
    assert.equal(isDueToday(payment({ state }), "2026-10-27"), false);
  }
});

test("登録済み年月は明細削除後も同月再生成を防ぎ、再開月も尊重する", () => {
  const saved = payment({ lastGeneratedMonth: "2026-10-01" });
  assert.equal(isDueToday(saved, "2026-10-27"), false);
  assert.equal(nextScheduledOn(saved, "2026-10-27"), "2026-11-27");
  assert.equal(nextScheduledOn(payment({ lastGeneratedMonth: "2026-12-01" }), "2026-10-10"), "2027-01-27");
  assert.equal(resumeFromMonth(payment(), "2026-10-10"), "2026-11-01");
  assert.equal(resumeFromMonth(payment({ activeFromMonth: "2027-01-01" }), "2026-10-10"), "2027-01-01");
  assert.equal(nextScheduledOn(payment({ activeFromMonth: "2026-11-01" }), "2026-10-27"), "2026-11-27");
});
