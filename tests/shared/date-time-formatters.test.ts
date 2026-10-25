import assert from "node:assert/strict";
import test from "node:test";
import { DateTimePrecision, formatJstDateTime, formatJstShortDateTime } from "../../lib/shared/display-formatters";

test("取込日時の完全表示と省略表示はブラウザのtimezoneによらず日本時間に揃う", () => {
  for (const [instant, full, compact] of [
    ["2026-10-25T05:32:42.123Z", "2026/10/25 14:32", "10/25 14:32"],
    ["2026-12-31T15:00:00.000Z", "2027/01/01 00:00", "01/01 00:00"],
  ]) {
    assert.equal(formatJstDateTime(instant, DateTimePrecision.Minute), full);
    assert.equal(formatJstShortDateTime(instant), compact);
  }
});
