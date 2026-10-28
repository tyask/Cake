import assert from "node:assert/strict";
import test from "node:test";
import { homeHandler } from "../../lib/server/handlers/home-handler";
import { UserAccessError } from "../../lib/server/errors";
import type { HomeData } from "../../lib/shared/home-data";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const totals = { paymentTotal: "101", receiptTotal: "1000", balanceYen: "899" };
const dataset: HomeData = {
  workspaceId, month: "2026-10", members: [{ id: "a", name: "A" }],
  monthly: { people: [{ userId: "a", ...totals }], total: totals },
  unsettled: { count: 0, paymentTotal: "0", receiptTotal: "0", balanceYen: "0" },
  settlement: null,
  settlementHistory: [{ id: "settlement", payerName: "A", payeeName: "B", amountYen: 100, completedAt: "2026-10-01T00:00:00.123Z" }],
};
const request = (query = `workspaceId=${workspaceId}&month=2026-10`) =>
  new Request(`https://cake.example/api/home?${query}`);

test("ホームGETは認証本人と対象月をstoreへ渡し、サマリーをno-storeで返す", async () => {
  const calls: unknown[][] = [];
  const get = homeHandler({
    currentUser: async () => ({ id: "a" }),
    findHome: async (...args) => { calls.push(args); return dataset; },
  });
  const response = await get(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dataset);
  assert.deepEqual(calls, [[workspaceId, "a", "2026-10"]]);
});

test("ホームGETは未来月と選択可能な年月の両端をそのまま受け付ける", async () => {
  const calls: unknown[][] = [];
  const get = homeHandler({
    currentUser: async () => ({ id: "a" }),
    findHome: async (...args) => { calls.push(args); return { ...dataset, month: args[2] }; },
  });
  for (const month of ["0001-01", "2099-12", "9999-12"]) {
    const response = await get(request(`workspaceId=${workspaceId}&month=${month}`));
    assert.equal(response.status, 200, month);
    assert.equal((await response.json()).month, month);
  }
  assert.deepEqual(calls, ["0001-01", "2099-12", "9999-12"].map(month => [workspaceId, "a", month]));
});

test("ホームGETは未認証・不正・重複・余分なqueryを拒否し、storeを呼ばない", async () => {
  let calls = 0;
  const dependencies = {
    currentUser: async () => ({ id: "a" }),
    findHome: async () => { calls++; return dataset; },
  };
  const rejected = await homeHandler({ ...dependencies, currentUser: async () => null })(request());
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  const get = homeHandler(dependencies);
  for (const query of ["", `workspaceId=${workspaceId}`, "month=2026-10", "workspaceId=invalid&month=2026-10",
    `workspaceId=${workspaceId}&month=0000-01`, `workspaceId=${workspaceId}&month=2026-00`,
    `workspaceId=${workspaceId}&month=2026-13`, `workspaceId=${workspaceId}&month=2026-1`,
    `workspaceId=${workspaceId}&month=2026-10-01`, `workspaceId=${workspaceId}&month=10000-01`,
    `workspaceId=${workspaceId}&month=2026-10&month=2026-09`,
    `workspaceId=${workspaceId}&workspaceId=${workspaceId}&month=2026-10`,
    `workspaceId=${workspaceId}&month=2026-10&memberId=b`,
    `workspaceId=${workspaceId}&month=2026-10&scope=full`]) {
    const response = await get(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store", query);
  }
  assert.equal(calls, 0);
});

test("ホームGETは利用停止・所属拒否と内部障害を分け、内部情報を公開しない", async () => {
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { logs.push(values); };
  try {
    for (const [error, expectedStatus] of [
      [new UserAccessError("ログインが必要です。", 401), 401],
      [new UserAccessError("このワークスペースを操作する権限がありません。", 403), 403],
      [new Error("postgresql://private-host/private-query"), 500],
    ] as const) {
      const get = homeHandler({ currentUser: async () => ({ id: "a" }), findHome: async () => { throw error; } });
      const response = await get(request());
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      assert.doesNotMatch(text, /private-host|private-query|postgresql/);
      if (expectedStatus !== 500) assert.equal(JSON.parse(text).error, error.message);
    }
    assert.equal(logs.length, 1);
    assert.doesNotMatch(JSON.stringify(logs), /private-host|private-query|postgresql/);
  } finally { console.error = original; }
});
