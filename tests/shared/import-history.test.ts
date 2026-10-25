import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_FORMATS, IMPORT_HISTORY_PER_USER_LIMIT, importHistoryQuerySchema } from "../../lib/shared/import-history";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("取込履歴の照会はworkspace UUIDと対応するファイル形式を受け入れる", () => {
  assert.equal(IMPORT_HISTORY_PER_USER_LIMIT, 5);
  assert.deepEqual(IMPORT_FORMATS, { PAYPAY: { label: "PayPay" } });
  assert.deepEqual(importHistoryQuerySchema.parse({ workspaceId, format: "PAYPAY" }), { workspaceId, format: "PAYPAY" });
});

test("取込履歴の照会は不正workspace・未対応形式・形式の省略を拒否する", () => {
  for (const input of [
    { workspaceId: "invalid", format: "PAYPAY" },
    { format: "PAYPAY" },
    { workspaceId },
    { workspaceId, format: "CSV" },
    { workspaceId, format: "paypay" },
    { workspaceId, format: "" },
    { workspaceId, format: null },
    { workspaceId, format: ["PAYPAY"] },
  ]) {
    assert.equal(importHistoryQuerySchema.safeParse(input).success, false);
  }
});
