import assert from "node:assert/strict";
import test from "node:test";
import { recurringPaymentHandlers } from "../lib/recurring-payment-handlers";
import { RecurringPaymentError } from "../lib/recurring-payments";
import type { RecurringPayment } from "../lib/recurring-payment-types";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const paymentId = "00000000-0000-4000-8000-000000000002";
const config = { dayOfMonth: 27, merchant: "家賃", method: "銀行振込", amountYen: 100000,
  actorUserId: "test-user-a", expenseClass: "PERSONAL" as const, splitWeights: { "test-user-a": 1 }, memo: "定期料金" };
const payment: RecurringPayment = { id: paymentId, workspaceId, state: "ACTIVE", revision: 1, authorizedById: "test-user-a", currentConfig: config,
  nextScheduledOn: "2026-10-27", blockedReason: null, lastGeneratedMonth: null };
const summary = { runId: "run", candidates: 1, created: 1, skipped: 0, failed: 0, unprocessed: 0 };

function fixture(environment: Record<string, string | undefined> = {}) {
  const calls: unknown[][] = [];
  const dependencies = {
    currentUser: async () => ({ id: "test-user-a", name: "A", email: "test-a@cake.local", imageUrl: null }),
    list: async (...args: unknown[]) => { calls.push(["list", ...args]); return { payments: [payment], eligibleActorUserIds: ["test-user-a"], today: "2026-10-10" }; },
    mutate: async (...args: unknown[]) => { calls.push(["mutate", ...args]); return { payment }; },
    run: async (...args: unknown[]) => { calls.push(["run", ...args]); return summary; },
    environment: () => environment,
  };
  return { dependencies, calls, handlers: recurringPaymentHandlers(dependencies) };
}

function request(body: unknown, path = "/api/recurring-payments") {
  return new Request(`https://cake.example${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("一覧APIは認証済み利用者とworkspaceのみをサービスへ渡す", async () => {
  const f = fixture();
  const result = await f.handlers.GET(new Request(`https://cake.example/api/recurring-payments?workspaceId=${workspaceId}`));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.calls, [["list", workspaceId, "test-user-a"]]);
  assert.equal((await result.json()).payments[0].id, paymentId);
});

test("未認証の一覧と保存はサービスへ到達しない", async () => {
  const f = fixture();
  const handlers = recurringPaymentHandlers({ ...f.dependencies, currentUser: async () => null });
  assert.equal((await handlers.GET(new Request(`https://cake.example/api/recurring-payments?workspaceId=${workspaceId}`))).status, 401);
  assert.equal((await handlers.POST(request({ action: "create", workspaceId, ...config }))).status, 401);
  assert.deepEqual(f.calls, []);
});

test("一覧の不正workspace・日時上書き・重複workspaceを拒否する", async () => {
  const f = fixture();
  for (const query of ["", "workspaceId=invalid", `workspaceId=${workspaceId}&today=2026-10-27`, `workspaceId=${workspaceId}&workspaceId=${workspaceId}`]) {
    assert.equal((await f.handlers.GET(new Request(`https://cake.example/api/recurring-payments?${query}`))).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test("開始日なしの設定作成は201、通常の設定更新・状態変更は200", async () => {
  const f = fixture();
  const created = await f.handlers.POST(request({ action: "create", workspaceId, ...config }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).payment.id, paymentId);
  assert.deepEqual(f.calls, [["mutate", "test-user-a", { action: "create", workspaceId, ...config }]]);
  const updated = await f.handlers.POST(request({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config }));
  assert.equal(updated.status, 200);
  assert.deepEqual(Object.keys(await updated.json()), ["payment"]);
  for (const action of ["pause", "resume", "archive"]) {
    assert.equal((await f.handlers.POST(request({ action, workspaceId, paymentId, expectedRevision: 1 }))).status, 200);
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(call => call[1] === "test-user-a"));
});

test("設定作成でクライアントの開始日指定を拒否する", async () => {
  const f = fixture();
  for (const startOn of ["2026-10-09", "2026-10-10", "2026-12-28"]) {
    const result = await f.handlers.POST(request({ action: "create", workspaceId, ...config, startOn }));
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: "入力内容を確認してください。", code: "INPUT_INVALID" });
  }
  assert.deepEqual(f.calls, []);
});

test("更新で開始日・適用月・変更予定・状態・成功月・承認者を指定できない", async () => {
  const f = fixture();
  for (const extra of [{ startOn: "2026-10-10" }, { activeFromMonth: "2026-11-01" }, { pendingConfig: config },
    { pendingEffectiveMonth: "2026-11-01" }, { effectiveMonth: "2026-11-01" },
    { state: "ACTIVE" }, { lastGeneratedMonth: "2026-10-01" }, { authorizedById: "other" }]) {
    assert.equal((await f.handlers.POST(request({ action: "update", workspaceId, paymentId, expectedRevision: 1, ...config, ...extra }))).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test("JSON不正と入力検証の失敗は固定エラーで入力値を漏らさない", async () => {
  const f = fixture();
  const malformed = new Request("https://cake.example/api/recurring-payments", { method: "POST", body: "{" });
  const result = await f.handlers.POST(malformed);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: "入力内容を確認してください。", code: "INPUT_INVALID" });
  assert.equal((await f.handlers.POST(request({ action: "create", workspaceId, ...config, amountYen: 0 }))).status, 400);
  assert.deepEqual(f.calls, []);
});

test("所属拒否、競合、対象なしはサービスの固定ステータスを返す", async () => {
  const f = fixture();
  for (const [status, code] of [[403, "FORBIDDEN"], [409, "REVISION_CONFLICT"], [404, "NOT_FOUND"]] as const) {
    const handlers = recurringPaymentHandlers({ ...f.dependencies, list: async () => { throw new RecurringPaymentError("操作できません。", status, code); } });
    const result = await handlers.GET(new Request(`https://cake.example/api/recurring-payments?workspaceId=${workspaceId}`));
    assert.equal(result.status, status);
    assert.deepEqual(await result.json(), { error: "操作できません。", code });
  }
});

test("予期しないDB失敗を503へ変換し、生のエラーを応答・ログへ出さない", async (t) => {
  const f = fixture();
  const logs: string[] = [];
  t.mock.method(console, "error", (value: string) => { logs.push(value); });
  const handlers = recurringPaymentHandlers({ ...f.dependencies, list: async () => { throw new Error("secret database connection and SQL"); } });
  const result = await handlers.GET(new Request(`https://cake.example/api/recurring-payments?workspaceId=${workspaceId}`));
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(await result.json()).includes("secret"), false);
  assert.deepEqual(logs.map(line => JSON.parse(line)), [{ event: "recurring.request_failed", errorCode: "DATABASE_UNAVAILABLE" }]);
});

test("Cronは秘密鍵欠落・空白・不一致を拒否しDBもセッションも呼ばない", async () => {
  for (const secret of [undefined, "", " ", "expected"]) {
    const f = fixture({ CRON_SECRET: secret });
    let authenticated = false;
    const handlers = recurringPaymentHandlers({ ...f.dependencies, currentUser: async () => { authenticated = true; return null; } });
    for (const header of [undefined, "Bearer undefined", "Bearer wrong", "expected"]) {
      const req = new Request("https://cake.example/api/cron/recurring-payments", { headers: header ? { authorization: header } : {} });
      assert.equal((await handlers.cron(req)).status, 401);
    }
    assert.equal(authenticated, false);
    assert.deepEqual(f.calls, []);
  }
});

test("正しいCron認証で当日全体を実行し、任意日時・workspace指定を拒否", async () => {
  const f = fixture({ CRON_SECRET: "expected" });
  const req = (query = "") => new Request(`https://cake.example/api/cron/recurring-payments${query}`, { headers: { authorization: "Bearer expected" } });
  assert.equal((await f.handlers.cron(req())).status, 200);
  assert.deepEqual(f.calls, [["run", {}]]);
  for (const query of ["?today=2026-10-27", `?workspaceId=${workspaceId}`]) {
    assert.equal((await f.handlers.cron(req(query))).status, 400);
  }
  assert.equal(f.calls.length, 1);
});

test("登録失敗・時間制限で未処理が残ればCronは503", async () => {
  for (const result of [{ ...summary, failed: 1 }, { ...summary, unprocessed: 1 }]) {
    const f = fixture({ CRON_SECRET: "expected" });
    const handlers = recurringPaymentHandlers({ ...f.dependencies, run: async () => result });
    const response = await handlers.cron(new Request("https://cake.example/api/cron/recurring-payments", { headers: { authorization: "Bearer expected" } }));
    assert.equal(response.status, 503);
  }
});

test("手動実行はProductionまたはgoogleモードでは認証・DBの前に404", async () => {
  for (const environment of [{ VERCEL_ENV: "production", AUTH_MODE: "test" }, { VERCEL_ENV: "preview", AUTH_MODE: "google" }, {}]) {
    const f = fixture(environment);
    let authenticated = false;
    const handlers = recurringPaymentHandlers({ ...f.dependencies, currentUser: async () => { authenticated = true; return null; } });
    assert.equal((await handlers.manualRun(request({ workspaceId }, "/api/recurring-payments/run"))).status, 404);
    assert.equal(authenticated, false);
    assert.deepEqual(f.calls, []);
  }
});

test("テスト手動実行はセッション利用者と指定workspaceに制限し、日時を受け付けない", async () => {
  const f = fixture({ VERCEL_ENV: "preview", AUTH_MODE: "test" });
  assert.equal((await f.handlers.manualRun(request({ workspaceId }, "/api/recurring-payments/run"))).status, 200);
  assert.deepEqual(f.calls, [["run", { workspaceId, authorizedUserId: "test-user-a" }]]);
  assert.equal((await f.handlers.manualRun(request({ workspaceId, today: "2026-10-27" }, "/api/recurring-payments/run"))).status, 400);
  assert.equal(f.calls.length, 1);
});
