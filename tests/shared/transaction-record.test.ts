import assert from "node:assert/strict";
import test from "node:test";
import { transactionRecord } from "../../lib/shared/transaction-record";

for (const representation of ["Date", "JSON"] as const) {
  test(`${representation}のDB日時をUTCへ変換し、取引・清算のミリ秒とnullを保持する`, () => {
    const occurredAt = "2026-12-31T15:00:42.123Z", settledAt = "2027-01-01T00:00:01.456Z";
    const row = {
      occurred_at: representation === "Date" ? new Date(occurredAt) : "2027-01-01T00:00:42.123+09:00",
      settled_at: representation === "Date" ? new Date(settledAt) : "2027-01-01T09:00:01.456+09:00",
    };
    const result = transactionRecord(row);
    assert.equal(result.occurredAt, occurredAt);
    assert.equal(result.settledAt, settledAt);
    assert.equal(transactionRecord({ ...row, settled_at: null }).settledAt, null);
    if (row.occurred_at instanceof Date) assert.equal(row.occurred_at.toISOString(), occurredAt);
    if (row.settled_at instanceof Date) assert.equal(row.settled_at.toISOString(), settledAt);
  });
}
