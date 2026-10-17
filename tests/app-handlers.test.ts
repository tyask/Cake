import assert from "node:assert/strict";
import test from "node:test";
import { appHandlers } from "../lib/app-handlers";
import { parseAppActionInput } from "../lib/app-input";
import { UserAccessError } from "../lib/user-access";
import type { AppUser } from "../lib/types";

const user: AppUser = { id: "a", email: "a@example.com", name: "A", imageUrl: null };
const workspaceId = "00000000-0000-4000-8000-000000000001";
const post = (body: unknown) => new Request("https://cake.example/api/app", { method: "POST", body: JSON.stringify(body) });

function fixture() {
  const calls: unknown[][] = [];
  const dependencies = {
    currentUser: async (): Promise<AppUser | null> => user,
    bootstrap: async (...args: unknown[]) => { calls.push(["bootstrap", ...args]); return { selected: null }; },
    execute: async (...args: unknown[]) => { calls.push(["execute", ...args]); return { ok: true, workspaceId }; },
  };
  return { dependencies, calls, handlers: appHandlers(dependencies) };
}

test("アプリGETは既定full/metadataとworkspaceを一度だけサービスへ渡す", async () => {
  const f = fixture();
  for (const scope of [undefined, "metadata"]) {
    const response = await f.handlers.GET(new Request(`https://cake.example/api/app?workspaceId=${workspaceId}${scope ? `&scope=${scope}` : ""}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { selected: null });
  }
  assert.deepEqual(f.calls, [["bootstrap", user, workspaceId, "full"], ["bootstrap", user, workspaceId, "metadata"]]);
});

test("アプリPOSTは従来の余分キー除去・正規化と成功JSONを維持する", async () => {
  const f = fixture();
  const response = await f.handlers.POST(post({ action: "createWorkspace", name: " 家計 ", type: "SHARED", extra: 1 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, workspaceId });
  assert.deepEqual(f.calls, [["execute", user, { action: "createWorkspace", name: "家計", type: "SHARED" }]]);
});

test("未認証のGETは401、POSTは400で従来のエラーJSONを返しサービスを呼ばない", async () => {
  const f = fixture();
  const handlers = appHandlers({ ...f.dependencies, currentUser: async () => null });
  const responses = [await handlers.GET(new Request("https://cake.example/api/app")), await handlers.POST(post({ action: "completeSettlement", workspaceId }))];
  assert.deepEqual(responses.map(response => response.status), [401, 400]);
  for (const response of responses) assert.deepEqual(await response.json(), { error: "ログインが必要です。" });
  assert.deepEqual(f.calls, []);
});

test("入力不正・未対応action・JSON不正は400で業務処理を呼ばない", async () => {
  const f = fixture();
  const invalid = { action: "createWorkspace", name: "", type: "SHARED" };
  let message = "";
  try { parseAppActionInput(invalid); } catch (error) { message = (error as Error).message; }
  const response = await f.handlers.POST(post(invalid));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: message });
  const unsupported = await f.handlers.POST(post({ action: "unknown" }));
  assert.equal(unsupported.status, 400);
  assert.deepEqual(await unsupported.json(), { error: "未対応の操作です: unknown" });
  const malformed = await f.handlers.POST(new Request("https://cake.example/api/app", { method: "POST", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, "string");
  assert.deepEqual(f.calls, []);
});

test("所属拒否・DB失敗・UserAccessErrorの従来ステータスとメッセージを維持する", async () => {
  const f = fixture();
  for (const [error, status, message] of [
    [new Error("このワークスペースを操作する権限がありません。"), 400, "このワークスペースを操作する権限がありません。"],
    [new Error("database failed"), 400, "database failed"],
    [new UserAccessError("利用不可", 403), 403, "利用不可"],
    [null, 400, "処理に失敗しました。"],
  ] as const) {
    const handlers = appHandlers({ ...f.dependencies, execute: async () => { throw error; } });
    const response = await handlers.POST(post({ action: "completeSettlement", workspaceId }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: message });
  }
  const failedGet = appHandlers({ ...f.dependencies, bootstrap: async () => { throw new Error("read failed"); } });
  const response = await failedGet.GET(new Request("https://cake.example/api/app"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "read failed" });
});
