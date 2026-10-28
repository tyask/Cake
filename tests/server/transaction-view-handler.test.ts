import assert from "node:assert/strict";
import test from "node:test";
import { transactionViewHandler } from "../../lib/server/handlers/transaction-view-handler";
import { UserAccessError } from "../../lib/server/errors";
import type { TransactionViewDataset } from "../../lib/shared/transaction-view";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const dataset: TransactionViewDataset = { workspaceId, mode: "month", month: "2026-10", transactions: [] };
const request = (query = `workspaceId=${workspaceId}&mode=month&month=2026-10`) =>
  new Request(`https://cake.example/api/transactions?${query}`);

test("明細GETは認証本人と月・未精算条件をstoreへ渡し、no-storeで返す", async () => {
  const calls: unknown[][] = [];
  const get = transactionViewHandler({ currentUser: async () => ({ id: "a" }),
    findTransactionView: async (...args) => { calls.push(args); return dataset; } });
  const response = await get(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dataset);
  assert.equal(calls[0][0], workspaceId);
  assert.equal(calls[0][1], "a");
  assert.equal((calls[0][2] as { mode: string }).mode, "month");
  assert.equal((calls[0][2] as { month: string }).month, "2026-10");
  await get(request(`workspaceId=${workspaceId}&mode=unsettled`));
  assert.equal(calls[1][0], workspaceId);
  assert.equal(calls[1][1], "a");
  assert.equal((calls[1][2] as { mode: string }).mode, "unsettled");
  await get(request(`workspaceId=${workspaceId}&mode=unsettled&month=ignored`));
  assert.deepEqual(calls[2][2], { mode: "unsettled" }, "未精算では保持された月を取得条件に渡さない");
  for (const month of ["0001-01", "2099-01", "9999-12"]) {
    assert.equal((await get(request(`workspaceId=${workspaceId}&mode=month&month=${month}`))).status, 200);
  }
});

test("明細GETは未認証・不正条件・重複条件を拒否してstoreを呼ばない", async () => {
  let calls = 0;
  const dependencies = { currentUser: async () => ({ id: "a" }),
    findTransactionView: async () => { calls++; return dataset; } };
  const rejected = await transactionViewHandler({ ...dependencies, currentUser: async () => null })(request());
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  for (const query of ["", "workspaceId=invalid&mode=unsettled", `workspaceId=${workspaceId}&mode=month`,
    `workspaceId=${workspaceId}&mode=month&month=2026-13`, `workspaceId=${workspaceId}&mode=month&month=0000-01`,
    `workspaceId=${workspaceId}&mode=month&month=2026-10&month=2026-09`,
    `workspaceId=${workspaceId}&workspaceId=${workspaceId}&mode=unsettled`,
    `workspaceId=${workspaceId}&mode=unsettled&mode=month`, `workspaceId=${workspaceId}&mode=all`,
    `workspaceId=${workspaceId}&mode=unsettled&userId=b`, `workspaceId=${workspaceId}&mode=unsettled&categoryId=other`]) {
    const response = await transactionViewHandler(dependencies)(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("明細GETは認可拒否と内部障害を区別し、内部の接続情報を公開しない", async () => {
  for (const [error, status] of [[new UserAccessError("ログインが必要です。", 401), 401],
    [new UserAccessError("権限がありません。", 403), 403], [new Error("postgresql://private-host/private-query"), 500]] as const) {
    const response = await transactionViewHandler({ currentUser: async () => ({ id: "a" }),
      findTransactionView: async () => { throw error; } })(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.doesNotMatch(text, /private-host|private-query|postgresql/);
    if (status !== 500) assert.equal(JSON.parse(text).error, error.message);
  }
});
