import assert from "node:assert/strict";
import test from "node:test";
import { analyticsTransactionsHandler } from "../../lib/server/handlers/analytics-transactions-handler";
import { UserAccessError } from "../../lib/server/errors";
import { resolveAnalyticsPeriods } from "../../lib/shared/analytics";
import type { AnalyticsTransactionsDataset } from "../../lib/shared/analytics-transactions";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-23T00:00:00Z");
const period = resolveAnalyticsPeriods({ workspaceId, period: "month", month: "2026-10" }, now).current;
const dataset: AnalyticsTransactionsDataset = {
  workspaceId, snapshotAt: "2026-10-23T00:00:00.123456Z", period,
  members: [{ id: "a", name: "A" }], categories: [], transactions: [],
};
const request = (query = `workspaceId=${workspaceId}&period=month&month=2026-10`) =>
  new Request(`https://cake.example/api/analytics/transactions?${query}`);

test("集計明細GETは認証本人と対象期間だけをstoreへ渡し、no-storeでDTOを返す", async () => {
  const calls: unknown[][] = [];
  let clockCalls = 0;
  const get = analyticsTransactionsHandler({
    currentUser: async () => ({ id: "a" }), now: () => { clockCalls++; return now; },
    findAnalyticsTransactions: async (...args) => { calls.push(args); return dataset; },
  });
  const response = await get(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dataset);
  assert.deepEqual(calls, [[workspaceId, "a", period]]);
  assert.equal(clockCalls, 1, "入力検証と期間計算で同じ現在日時を使う");
  await get(request(`workspaceId=${workspaceId}&period=range&from=2026-08-20&to=2026-09-20`));
  assert.deepEqual(calls[1], [workspaceId, "a", { from: "2026-08-20", to: "2026-09-20" }]);
});

test("集計明細GETは未認証・不正・重複・表示フィルタを拒否し、storeを呼ばない", async () => {
  let calls = 0;
  const dependencies = {
    currentUser: async () => ({ id: "a" }), now: () => now,
    findAnalyticsTransactions: async () => { calls++; return dataset; },
  };
  const rejected = await analyticsTransactionsHandler({ ...dependencies, currentUser: async () => null })(request());
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("cache-control"), "no-store");
  for (const query of ["", "workspaceId=invalid&period=month&month=2026-10",
    `workspaceId=${workspaceId}&period=month&month=2026-13`,
    `workspaceId=${workspaceId}&period=month&month=2026-11`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&month=2026-09`,
    `workspaceId=${workspaceId}&workspaceId=${workspaceId}&period=month&month=2026-10`,
    `workspaceId=${workspaceId}&period=range&from=2026-10-02&to=2026-10-01`,
    `workspaceId=${workspaceId}&period=range&from=2020-01-01&to=2026-10-01`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&memberId=b`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&categoryId=unclassified`]) {
    const response = await analyticsTransactionsHandler(dependencies)(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("集計明細GETは利用停止・所属拒否と内部障害を分け、内部情報を公開しない", async () => {
  for (const [error, expectedStatus] of [
    [new UserAccessError("ログインが必要です。", 401), 401],
    [new UserAccessError("権限がありません。", 403), 403],
    [new Error("postgresql://private-host/private-query"), 500],
  ] as const) {
    const get = analyticsTransactionsHandler({
      currentUser: async () => ({ id: "a" }), now: () => now,
      findAnalyticsTransactions: async () => { throw error; },
    });
    const response = await get(request());
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.doesNotMatch(text, /private-host|private-query|postgresql/);
    if (expectedStatus !== 500) assert.equal(JSON.parse(text).error, error.message);
  }
});
