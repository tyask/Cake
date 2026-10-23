import assert from "node:assert/strict";
import test from "node:test";
import { importCategorySuggestionsHandler } from "../../lib/server/handlers/import-category-suggestions-handler";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const request = (body: unknown) => new Request("https://cake.example/api/import/category-suggestions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("カテゴリ補完APIは認証済み利用者と検証済み入力だけをstoreへ渡し、候補を返す", async () => {
  const calls: unknown[][] = [];
  const body = { suggestions: [{ merchant: "  店  ", categoryId: null }] };
  const handler = importCategorySuggestionsHandler({
    currentUser: async () => ({ id: "a" }),
    findSuggestions: async (...args) => { calls.push(args); return body; },
  });
  const result = await handler(request({ workspaceId, merchants: ["  店  "] }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), body);
  assert.deepEqual(calls, [[workspaceId, "a", ["  店  "]]]);
});

test("未認証・不正JSON・不正入力の補完要求はstoreへ到達しない", async () => {
  let calls = 0;
  const dependencies = {
    currentUser: async () => ({ id: "a" }),
    findSuggestions: async () => { calls++; return { suggestions: [] }; },
  };
  const unauthenticated = importCategorySuggestionsHandler({ ...dependencies, currentUser: async () => null });
  assert.equal((await unauthenticated(request({ workspaceId, merchants: ["店"] }))).status, 401);
  const handler = importCategorySuggestionsHandler(dependencies);
  assert.equal((await handler(new Request("https://cake.example/api/import/category-suggestions", { method: "POST", body: "{" }))).status, 400);
  for (const body of [{ workspaceId: "invalid", merchants: ["店"] }, { workspaceId, merchants: [] },
    { workspaceId, merchants: [" "] }, { workspaceId, merchants: Array(2001).fill("店") }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal(calls, 0);
});

test("カテゴリ補完APIは所属確認の拒否を既存取込照合APIと同じ形式で返す", async () => {
  const message = "このワークスペースを操作する権限がありません。";
  const handler = importCategorySuggestionsHandler({
    currentUser: async () => ({ id: "outside" }), findSuggestions: async () => { throw new Error(message); },
  });
  const response = await handler(request({ workspaceId, merchants: ["店"] }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: message });
});
