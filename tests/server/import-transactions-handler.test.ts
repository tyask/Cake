import assert from "node:assert/strict";
import test from "node:test";
import { importTransactionsHandler } from "../../lib/server/handlers/import-transactions-handler";
import type { ImportTransactionsResponse } from "../../lib/shared/import-history";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const batchId = "00000000-0000-4000-8000-000000000002";
const request = (query: Record<string, string> = { workspaceId, format: "PAYPAY", batchId }) =>
  new Request(`https://cake.example/api/import/transactions?${new URLSearchParams(query)}`);

test("取込明細APIは認証ユーザーで対象batchを照会し、現在の明細・メモ・カテゴリをキャッシュせず返す", async () => {
  const calls: unknown[][] = [];
  const body: ImportTransactionsResponse = {
    transactions: [{
      id: "00000000-0000-4000-8000-000000000003", occurredAt: "2026-10-25T14:32:00.123Z",
      merchant: "編集後の取引先", method: "PayPay", memo: "更新後のメモ", type: "PAYMENT", amountYen: 1200,
      actorUserId: "b", actorName: "花子", expenseClass: "SHARED", splitWeights: { a: 1, b: 2 },
      settledAt: "2026-10-26T05:00:00.456Z", externalId: "PayPay_20261025233200_1234", source: "PAYPAY",
      categoryId: "00000000-0000-4000-8000-000000000004", categoryConfirmed: true, categoryRevision: 3,
    }],
    categories: [{
      id: "00000000-0000-4000-8000-000000000004", revision: 2, parentId: null,
      name: "現在のカテゴリ名", colorHex: "#abcdef", sortOrder: 10, archivedAt: null,
    }],
  };
  const handler = importTransactionsHandler({
    currentUser: async () => ({ id: "a" }),
    findTransactions: async (...args) => { calls.push(args); return body; },
  });
  const response = await handler(request({ workspaceId, format: "PAYPAY", batchId, userId: "untrusted" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), body);
  assert.deepEqual(calls, [[workspaceId, "a", "PAYPAY", batchId]]);
});

test("取込明細APIは未認証と不正な照会をstoreへ渡さず、エラーもキャッシュしない", async () => {
  let calls = 0;
  const dependencies = {
    currentUser: async () => ({ id: "a" }),
    findTransactions: async () => { calls++; return { transactions: [], categories: [] }; },
  };
  const unauthenticated = importTransactionsHandler({ ...dependencies, currentUser: async () => null });
  const rejected = await unauthenticated(request({ workspaceId: "invalid" }));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  assert.deepEqual(await rejected.json(), { error: "ログインが必要です。" });
  const handler = importTransactionsHandler(dependencies);
  const invalidQueries: Record<string, string>[] = [
    { workspaceId: "invalid", format: "PAYPAY", batchId },
    { workspaceId, format: "CSV", batchId },
    { workspaceId, format: "PAYPAY", batchId: "invalid" },
    { workspaceId, format: "PAYPAY" },
    { workspaceId, batchId },
    { format: "PAYPAY", batchId },
  ];
  for (const query of invalidQueries) {
    const response = await handler(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("取込明細APIは存在する0明細batchと見つからないbatchを区別する", async () => {
  const dependencies = { currentUser: async () => ({ id: "a" }) };
  const empty = importTransactionsHandler({ ...dependencies, findTransactions: async () => ({ transactions: [], categories: [] }) });
  const emptyResponse = await empty(request());
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await emptyResponse.json(), { transactions: [], categories: [] });

  const absent = importTransactionsHandler({ ...dependencies, findTransactions: async () => null });
  const absentResponse = await absent(request());
  assert.equal(absentResponse.status, 404);
  assert.equal(absentResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await absentResponse.json(), { error: "取込履歴が見つかりません。" });
});

test("取込明細APIは所属拒否と不明な失敗を既存のJSONエラー形式で返す", async () => {
  const permissionError = new Error("このワークスペースを操作する権限がありません。");
  for (const [error, message] of [
    [permissionError, permissionError.message],
    [null, "取込明細を取得できませんでした。"],
  ] as const) {
    const handler = importTransactionsHandler({
      currentUser: async () => ({ id: "outside" }),
      findTransactions: async () => { throw error; },
    });
    const response = await handler(request());
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: message });
  }
});
