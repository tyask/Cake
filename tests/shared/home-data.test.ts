import assert from "node:assert/strict";
import test from "node:test";
import { homeQuerySchema } from "../../lib/shared/home-data";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("ホームqueryは実在する4桁年月の全範囲と未来月を許可する", () => {
  for (const month of ["0001-01", "0099-12", "2026-02", "2026-10", "2099-12", "9999-12"]) {
    assert.deepEqual(homeQuerySchema.parse({ workspaceId, month }), { workspaceId, month });
  }
});

test("ホームqueryは月でない値・必須項目欠落・不正workspace・余分なキーを拒否する", () => {
  for (const month of ["", "0000-01", "2026-00", "2026-13", "2026-1", "26-10", "10000-01", "2026-10-01", " 2026-10", "2026-10 "]) {
    assert.equal(homeQuerySchema.safeParse({ workspaceId, month }).success, false, month);
  }
  for (const input of [{}, { workspaceId }, { month: "2026-10" }, { workspaceId: "invalid", month: "2026-10" },
    { workspaceId, month: "2026-10", userId: "other" }, { workspaceId, month: "2026-10", scope: "full" }]) {
    assert.equal(homeQuerySchema.safeParse(input).success, false, JSON.stringify(input));
  }
});
