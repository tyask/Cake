import assert from "node:assert/strict";
import test from "node:test";
import { analyticsChangeRate, analyticsToday, createAnalyticsQuerySchema, resolveAnalyticsPeriods } from "../../lib/shared/analytics";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-10-23T02:00:00Z");
const month = (value: string) => ({ workspaceId, period: "month" as const, month: value });
const range = (from: string, to: string) => ({ workspaceId, period: "range" as const, from, to });

test("analytics periods use the Japanese day and compare the current month through the same day", () => {
  assert.equal(analyticsToday(new Date("2026-10-22T15:00:00Z")), "2026-10-23");
  assert.deepEqual(resolveAnalyticsPeriods(month("2026-10"), now), {
    current: { from: "2026-10-01", to: "2026-10-23" },
    comparison: { from: "2026-09-01", to: "2026-09-23" },
    trend: { from: "2026-05-01", to: "2026-10-23" },
  });
});

test("analytics month comparison clamps month ends and preserves leap days", () => {
  assert.deepEqual(resolveAnalyticsPeriods(month("2026-03"), new Date("2026-03-31T00:00:00Z")).comparison,
    { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(resolveAnalyticsPeriods(month("2024-03"), new Date("2024-03-31T00:00:00Z")).comparison,
    { from: "2024-02-01", to: "2024-02-29" });
  assert.deepEqual(resolveAnalyticsPeriods(month("2026-01"), now), {
    current: { from: "2026-01-01", to: "2026-01-31" },
    comparison: { from: "2025-12-01", to: "2025-12-31" },
    trend: { from: "2025-08-01", to: "2026-01-31" },
  });
});

test("custom periods compare with the immediately preceding inclusive range of equal duration", () => {
  assert.deepEqual(resolveAnalyticsPeriods(range("2024-02-28", "2024-03-01"), now), {
    current: { from: "2024-02-28", to: "2024-03-01" },
    comparison: { from: "2024-02-25", to: "2024-02-27" },
    trend: { from: "2023-10-01", to: "2024-03-31" },
  });
  assert.deepEqual(resolveAnalyticsPeriods(range("2026-10-10", "2026-10-10"), now).comparison,
    { from: "2026-10-09", to: "2026-10-09" });
});

test("analytics input rejects invalid dates, future dates, reverse ranges, and more than 24 calendar months", () => {
  const schema = createAnalyticsQuerySchema(now);
  for (const input of [month("2026-00"), month("2026-13"), month("2026-1"), month("2026-11"), month("9999-12"),
    range("2026-02-29", "2026-03-01"), range("2026-04-31", "2026-05-01"),
    range("2026-10-24", "2026-10-24"), range("2026-10-22", "2026-10-21"),
    range("2024-10-31", "2026-10-01"), month("0001-01"), range("0001-01-01", "0001-01-02"),
    { ...month("2026-10"), workspaceId: "other" },
    { ...month("2026-10"), memberIds: ["a"] }, { ...month("2026-10"), basis: "payment" }]) {
    assert.equal(schema.safeParse(input).success, false, JSON.stringify(input));
  }
  assert.equal(schema.safeParse(range("2024-11-01", "2026-10-23")).success, true);
  assert.equal(schema.safeParse(range("2024-02-29", "2024-02-29")).success, true);
  assert.equal(schema.safeParse(month("0001-06")).success, true);
  assert.throws(() => resolveAnalyticsPeriods(month("2026-11"), now));
});

test("analytics change rates preserve large integers and round only the final percentage", () => {
  assert.equal(analyticsChangeRate(BigInt(0), BigInt(0)), null);
  assert.equal(analyticsChangeRate(BigInt(100), BigInt(0)), null);
  assert.equal(analyticsChangeRate(BigInt(0), BigInt(1)), "-100.0%");
  assert.equal(analyticsChangeRate(BigInt(3), BigInt(3)), "0.0%");
  assert.equal(analyticsChangeRate(BigInt(10005), BigInt(10000)), "+0.1%");
  assert.equal(analyticsChangeRate(BigInt(9995), BigInt(10000)), "-0.1%");
  assert.equal(analyticsChangeRate(BigInt(9999), BigInt(10000)), "0.0%");
  assert.equal(analyticsChangeRate(BigInt("112345678901234567890123"), BigInt("100000000000000000000000")), "+12.3%");
});
