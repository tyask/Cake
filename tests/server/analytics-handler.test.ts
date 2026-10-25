import assert from "node:assert/strict";
import test from "node:test";
import { analyticsHandler } from "../../lib/server/handlers/analytics-handler";
import { UserAccessError } from "../../lib/server/errors";
import { resolveAnalyticsPeriods, type AnalyticsDataset } from "../../lib/shared/analytics";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-10-23T00:00:00Z");
const periods = resolveAnalyticsPeriods({ workspaceId, period: "month", month: "2026-10" }, now);
const dataset: AnalyticsDataset = {
  workspaceId, snapshotAt: "2026-10-23T00:00:00.123456Z", timeZone: "Asia/Tokyo", periods,
  members: [{ id: "a", name: "A" }], categories: [], buckets: [], receiptBuckets: [],
};
const request = (query = `workspaceId=${workspaceId}&period=month&month=2026-10`) => new Request(`https://cake.example/api/analytics?${query}`);

test("集計GETは認証と期間入力を確認し、集約DTOをno-storeで返す", async () => {
  const calls: unknown[][] = [];
  const get = analyticsHandler({
    currentUser: async () => ({ id: "a" }), now: () => now,
    findAnalytics: async (...args) => { calls.push(args); return dataset; },
  });
  const response = await get(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), dataset);
  assert.deepEqual(calls, [[workspaceId, "a", periods]]);
  await get(request(`workspaceId=${workspaceId}&period=range&from=2026-08-20&to=2026-09-20`));
  assert.deepEqual(calls[1], [workspaceId, "a", resolveAnalyticsPeriods({ workspaceId, period: "range", from: "2026-08-20", to: "2026-09-20" }, now)]);
});

test("集計GETは一度取得した現在日時を入力検証と期間計算で共有する", async () => {
  const futureNow = new Date("2030-01-01T00:00:00Z");
  let clockCalls = 0;
  const calls: unknown[][] = [];
  const get = analyticsHandler({
    currentUser: async () => ({ id: "a" }), now: () => { clockCalls++; return futureNow; },
    findAnalytics: async (...args) => { calls.push(args); return dataset; },
  });
  assert.equal((await get(request(`workspaceId=${workspaceId}&period=month&month=2029-12`))).status, 200);
  assert.equal(clockCalls, 1);
  assert.deepEqual(calls, [[workspaceId, "a", resolveAnalyticsPeriods({ workspaceId, period: "month", month: "2029-12" }, futureNow)]]);
});

test("未認証と不正・重複query、送信不要な表示フィルタは集計storeへ渡さない", async () => {
  let calls = 0;
  const dependencies = {
    currentUser: async () => ({ id: "a" }), now: () => now,
    findAnalytics: async () => { calls++; return dataset; },
  };
  const unauthenticated = await analyticsHandler({ ...dependencies, currentUser: async () => null })(request());
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
  const get = analyticsHandler(dependencies);
  for (const query of ["", "workspaceId=invalid&period=month&month=2026-10",
    `workspaceId=${workspaceId}&period=month&month=2026-02-30`,
    `workspaceId=${workspaceId}&period=month&month=9999-12`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&month=2026-09`,
    `workspaceId=${workspaceId}&workspaceId=${workspaceId}&period=month&month=2026-10`,
    `workspaceId=${workspaceId}&period=range&from=2026-10-02&to=2026-10-01`,
    `workspaceId=${workspaceId}&period=range&from=2020-01-01&to=2026-10-01`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&memberId=a`,
    `workspaceId=${workspaceId}&period=month&month=2026-10&basis=payment`]) {
    const response = await get(request(query));
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls, 0);
});

test("集計GETは現在の利用停止・所属拒否とサーバー障害を分け、内部情報を公開しない", async () => {
  for (const [error, expectedStatus] of [
    [new UserAccessError("ログインが必要です。", 401), 401],
    [new UserAccessError("権限がありません。", 403), 403],
    [new Error("postgresql://private-host/private-query"), 500],
  ] as const) {
    const get = analyticsHandler({ currentUser: async () => ({ id: "a" }), now: () => now, findAnalytics: async () => { throw error; } });
    const response = await get(request());
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.doesNotMatch(text, /private-host|private-query|postgresql/);
    if (expectedStatus !== 500) assert.equal(JSON.parse(text).error, error.message);
  }
});
