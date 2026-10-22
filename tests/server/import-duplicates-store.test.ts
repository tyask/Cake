import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { findImportDuplicates } from "../../lib/server/stores/import-duplicates-store";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const userId = "member-a";
type Query = { query: string; params: unknown[] };

function databaseFixture(t: TestContext, member: boolean) {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:password@mock.neon.tech/test";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });
  const queries: Query[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new URL(String(url)).pathname, "/sql");
    const request = JSON.parse(String(init?.body)) as Query;
    queries.push(request);
    if (/JOIN workspace_members/.test(request.query)) {
      assert.deepEqual(request.params, [workspaceId, userId]);
      return Response.json({ fields: [{ name: "id", dataTypeID: 25 }], rows: member ? [[workspaceId]] : [] });
    }
    assert.equal(member, true, "所属を確認できるまで明細を取得しない");
    assert.match(request.query, /WHERE workspace_id = \$1::uuid/);
    assert.deepEqual(request.params, [workspaceId, JSON.stringify(["external-a", "external-b"])]);
    return Response.json({
      fields: ["external_id", "merchant", "amount_yen", "source"].map(name => ({ name, dataTypeID: 25 })),
      rows: [["external-a", "店舗", "500", "PAYPAY"]],
    });
  });
  return queries;
}

test("重複照合は所属確認後、対象workspaceと重複を除いた外部IDだけで取得する", async t => {
  const queries = databaseFixture(t, true);
  const result = await findImportDuplicates(workspaceId, userId, ["external-a", "external-a", "external-b"]);
  assert.deepEqual(result, {
    externalIds: ["external-a"],
    transactions: [{ externalId: "external-a", merchant: "店舗", amountYen: 500, source: "PAYPAY" }],
  });
  assert.equal(queries.length, 2);
});

test("所属のないworkspaceの重複照合は明細を取得せず拒否する", async t => {
  const queries = databaseFixture(t, false);
  await assert.rejects(findImportDuplicates(workspaceId, userId, ["external-a"]), /権限がありません/);
  assert.equal(queries.length, 1);
});
