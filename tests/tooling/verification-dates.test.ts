import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verificationDate, verificationTimestamp } from "../../scripts/qa/db/verification-dates";

const cwd = fileURLToPath(new URL("../..", import.meta.url));

for (const TZ of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
  test(`実DB検証の日付とミリ秒をNeonの返却型にかかわらず保持する (${TZ})`, () => {
    // A child process isolates TZ and uses the installed driver's actual parsers.
    // No database connection, network request, or verification-script run occurs.
    const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", `
      const assert = require("node:assert/strict");
      const { types } = require("@neondatabase/serverless");
      const { verificationDate, verificationTimestamp } = require("./scripts/qa/db/verification-dates.ts");
      const { transactionDateInput } = require("./lib/shared/transaction-editing.ts");
      const parseDate = types.getTypeParser(1082, "text");
      const parseJson = types.getTypeParser(3802, "text");
      const parseTimestamp = types.getTypeParser(1184, "text");
      for (const expected of ["0001-01-01", "2026-02-28", "2026-10-10", "2026-11-27",
        "2027-01-10", "2028-02-29", "2199-01-01"]) {
        const selectedDate = parseDate(expected);
        assert.ok(selectedDate instanceof Date);
        assert.equal(verificationDate(selectedDate), expected);
        const json = parseJson(JSON.stringify({ payment: { next_scheduled_on: expected } }));
        assert.equal(typeof json.payment.next_scheduled_on, "string");
        assert.equal(verificationDate(json.payment.next_scheduled_on), expected);
      }
      for (const raw of ["2026-10-27 00:23:45.678+00", "2026-10-27 09:23:45.678+09"]) {
        const selectedTimestamp = parseTimestamp(raw);
        assert.ok(selectedTimestamp instanceof Date);
        const iso = verificationTimestamp(selectedTimestamp);
        assert.equal(iso, "2026-10-27T00:23:45.678Z");
        assert.equal(verificationTimestamp("2026-10-27T09:23:45.678+09:00"), iso);
        assert.equal(transactionDateInput(iso), "2026-10-27T09:23:45.678");
      }
      for (const raw of ["2026-12-31 15:00:00.001+00", "2027-01-01 00:00:00.001+09"]) {
        const iso = verificationTimestamp(parseTimestamp(raw));
        assert.equal(iso, "2026-12-31T15:00:00.001Z");
        assert.equal(transactionDateInput(iso), "2027-01-01T00:00:00.001");
      }
    `], { cwd, encoding: "utf8", env: { ...process.env, TZ }, timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}

test("検証対象の不正な日付・日時を成功として扱わない", () => {
  for (const value of [null, undefined, "invalid", "2026-02-30", new Date("invalid")]) {
    assert.throws(() => verificationDate(value), RangeError);
  }
  assert.throws(() => verificationTimestamp(new Date("invalid")), RangeError);
  assert.throws(() => verificationTimestamp("invalid"), RangeError);
});
