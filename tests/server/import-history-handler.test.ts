import assert from "node:assert/strict";
import test from "node:test";
import { importHistoryHandler } from "../../lib/server/handlers/import-history-handler";
import type { ImportHistoryResponse } from "../../lib/shared/import-history";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const request = (query: Record<string, string> = { workspaceId, format: "PAYPAY" }) =>
  new Request(`https://cake.example/api/import/history?${new URLSearchParams(query)}`);

test("取込履歴APIは認証済み利用者・workspace・形式で照会し、履歴をキャッシュせず返す", async () => {
  const calls: unknown[][] = [];
  const body: ImportHistoryResponse = {
    history: [{
      id: "00000000-0000-4000-8000-000000000002", format: "PAYPAY",
      importedBy: "b", importedByName: "花子", fileName: "PayPay貼り付け.csv",
      totalRows: 3, importedRows: 0, skippedRows: 3, createdAt: "2026-10-25T14:32:00.123Z",
    }],
  };
  const handler = importHistoryHandler({
    currentUser: async () => ({ id: "a" }),
    findHistory: async (...args) => { calls.push(args); return body; },
  });
  const response = await handler(request({ workspaceId, format: "PAYPAY", userId: "untrusted" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), body);
  assert.deepEqual(calls, [[workspaceId, "a", "PAYPAY"]]);
});

test("未認証の履歴照会はクエリの検証とDB照会に進まない", async () => {
  let calls = 0;
  const handler = importHistoryHandler({
    currentUser: async () => null,
    findHistory: async () => { calls++; return { history: [] }; },
  });
  const response = await handler(request({ workspaceId: "invalid", format: "UNKNOWN" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "ログインが必要です。" });
  assert.equal(calls, 0);
});

test("不正workspace・未対応形式・必須入力の欠落は履歴storeへ渡さない", async () => {
  let calls = 0;
  const handler = importHistoryHandler({
    currentUser: async () => ({ id: "a" }),
    findHistory: async () => { calls++; return { history: [] }; },
  });
  const invalidQueries: Record<string, string>[] = [
    { workspaceId: "invalid", format: "PAYPAY" },
    { workspaceId, format: "CSV" },
    { workspaceId, format: "" },
    { workspaceId },
    { format: "PAYPAY" },
    {},
  ];
  for (const query of invalidQueries) {
    assert.equal((await handler(request(query))).status, 400);
  }
  assert.equal(calls, 0);
});

test("取込履歴がない家計は空配列を返す", async () => {
  const handler = importHistoryHandler({
    currentUser: async () => ({ id: "a" }),
    findHistory: async () => ({ history: [] }),
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { history: [] });
});

test("取込履歴APIは所属拒否を既存取込APIと同じエラー形式で返す", async () => {
  const message = "このワークスペースを操作する権限がありません。";
  const handler = importHistoryHandler({
    currentUser: async () => ({ id: "outside" }),
    findHistory: async () => { throw new Error(message); },
  });
  const response = await handler(request());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: message });
});

test("取込履歴APIはError以外の失敗でもJSONエラーを返す", async () => {
  const handler = importHistoryHandler({
    currentUser: async () => ({ id: "a" }),
    findHistory: async () => { throw null; },
  });
  const response = await handler(request());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "取込履歴を取得できませんでした。" });
});
