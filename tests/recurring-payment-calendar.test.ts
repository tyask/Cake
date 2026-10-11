import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths, isCalendarDate, isDueToday, jstToday, monthOf, nextScheduledOn, scheduledDate,
} from "../lib/recurring-payment-calendar";
import type { RecurringPaymentSchedule } from "../lib/recurring-payment-calendar";
import type { RecurringPaymentConfig } from "../lib/recurring-payment-types";

const config: RecurringPaymentConfig = { dayOfMonth: 27, merchant: "家賃", method: "銀行振込", amountYen: 100000,
  actorUserId: "a", expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, memo: "" };
const payment = (overrides: Partial<RecurringPaymentSchedule> = {}): RecurringPaymentSchedule => ({
  state: "ACTIVE", currentConfig: config, ...overrides,
});
const beforeDeadline = (date: string) => new Date(`${date}T08:59:59.999+09:00`);

test("日本時間の日付はUTCの15時で日付・年を繰り上げる", () => {
  assert.equal(jstToday(new Date("2026-12-31T14:59:59.999Z")), "2026-12-31");
  assert.equal(jstToday(new Date("2026-12-31T15:00:00Z")), "2027-01-01");
  assert.throws(() => jstToday(new Date("invalid")), RangeError);
});

test("予定日の計算は実在する日付だけを受け入れる", () => {
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
  assert.equal(nextScheduledOn(setting, beforeDeadline("2026-10-28")), "2026-11-27");
  assert.equal(isDueToday(setting, "2026-11-27"), true);
});

test("月末の予定は開始条件なしで当日に対象となる", () => {
  const endOfMonth = payment({ currentConfig: { ...config, dayOfMonth: 31 } });
  assert.equal(nextScheduledOn(endOfMonth, beforeDeadline("2027-02-10")), "2027-02-28");
  assert.equal(isDueToday(endOfMonth, "2027-02-28"), true);
  assert.equal(nextScheduledOn(endOfMonth, beforeDeadline("2027-03-01")), "2027-03-31");
});

test("未生成の設定編集は当月の日付と金額に即時反映する", () => {
  const edited = payment({ currentConfig: { ...config, dayOfMonth: 10, amountYen: 110000 } });
  assert.equal(nextScheduledOn(edited, beforeDeadline("2026-10-10")), "2026-10-10");
  assert.equal(isDueToday(edited, "2026-10-10"), true);
  assert.equal(isDueToday(edited, "2026-10-27"), false);
  const futureDay = { ...edited, currentConfig: { ...edited.currentConfig, dayOfMonth: 31 } };
  assert.equal(nextScheduledOn(futureDay, beforeDeadline("2026-10-10")), "2026-10-31");
  assert.equal(isDueToday(futureDay, "2026-10-31"), true);
});

test("編集した日がすでに過ぎていれば当月分を補完せず翌月を返す", () => {
  const edited = payment({ currentConfig: { ...config, dayOfMonth: 1 } });
  assert.equal(nextScheduledOn(edited, beforeDeadline("2026-10-10")), "2026-11-01");
  assert.equal(isDueToday(edited, "2026-10-10"), false);
  assert.equal(isDueToday(edited, "2026-11-01"), true);
});

test("停止中・要確認・削除設定は予定日と生成を返さない", () => {
  for (const state of ["PAUSED", "BLOCKED", "ARCHIVED"] as const) {
    assert.equal(nextScheduledOn(payment({ state }), beforeDeadline("2026-10-10")), null);
    assert.equal(isDueToday(payment({ state }), "2026-10-27"), false);
  }
});

test("指定日の日本時間09:00より前は今月、09:00以降は翌月を返す", () => {
  const setting = payment({ currentConfig: { ...config, dayOfMonth: 9 } });
  assert.equal(nextScheduledOn(setting, beforeDeadline("2026-10-09")), "2026-10-09");
  for (const time of ["2026-10-09T09:00:00+09:00", "2026-10-09T09:00:00.001+09:00", "2026-10-09T23:59:59+09:00"]) {
    assert.equal(nextScheduledOn(setting, new Date(time)), "2026-11-09", time);
  }
  const laterDay = payment({ currentConfig: { ...config, dayOfMonth: 10 } });
  assert.equal(nextScheduledOn(laterDay, new Date("2026-10-09T23:59:59+09:00")), "2026-10-10");
  assert.throws(() => nextScheduledOn(setting, new Date("invalid")), RangeError);
});

test("月末・閏日・年末も09:00ちょうどに翌月の設定日へ進める", () => {
  const setting = payment({ currentConfig: { ...config, dayOfMonth: 31 } });
  for (const [date, following] of [["2027-02-28", "2027-03-31"], ["2028-02-29", "2028-03-31"],
    ["2026-04-30", "2026-05-31"], ["2026-12-31", "2027-01-31"]]) {
    assert.equal(nextScheduledOn(setting, beforeDeadline(date)), date);
    assert.equal(nextScheduledOn(setting, new Date(`${date}T09:00:00+09:00`)), following);
  }
});

test("日時の入力タイムゾーンに依存せず日本時間09:00で切り替える", () => {
  const setting = payment({ currentConfig: { ...config, dayOfMonth: 9 } });
  assert.equal(nextScheduledOn(setting, new Date("2026-10-08T23:59:59.999Z")), "2026-10-09");
  assert.equal(nextScheduledOn(setting, new Date("2026-10-09T00:00:00Z")), "2026-11-09");
  assert.equal(nextScheduledOn(setting, new Date("2026-10-08T17:00:00-07:00")), "2026-11-09");
});

test("再開の予定日は履歴を参照せず設定日と09:00の境界だけで決める", () => {
  for (const state of ["PAUSED", "BLOCKED"] as const) {
    const stopped = payment({ state });
    const resumed = { ...stopped, state: "ACTIVE" as const };
    assert.equal(isDueToday(resumed, "2026-10-27"), true);
    assert.equal(nextScheduledOn(resumed, beforeDeadline("2026-10-27")), "2026-10-27");
    assert.equal(nextScheduledOn(resumed, new Date("2026-10-27T09:00:00+09:00")), "2026-11-27");
    assert.equal(nextScheduledOn(resumed, beforeDeadline("2026-10-28")), "2026-11-27");
  }
});
