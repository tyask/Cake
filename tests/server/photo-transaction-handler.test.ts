import assert from "node:assert/strict";
import test from "node:test";
import { photoTransactionHandler } from "../../lib/server/handlers/photo-transaction-handler";
import { PhotoTransactionError } from "../../lib/server/photo-transaction";
import { MAX_PHOTO_UPLOAD_BYTES } from "../../lib/shared/photo-transaction";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const categoryId = "00000000-0000-4000-8000-000000000002";
const extraction = { date: "2026-11-17", time: "09:12", merchant: "店", amountYen: 4321, memo: "食料品" };
const jpeg = new Uint8Array([255, 216, 255, 1]);
const formRequest = (options: { workspace?: string; image?: Blob; body?: FormData; signal?: AbortSignal } = {}) => {
  const form = options.body ?? new FormData();
  if (!options.body) {
    form.set("workspaceId", options.workspace ?? workspaceId);
    form.set("image", options.image ?? new Blob([jpeg], { type: "image/jpeg" }), "receipt.jpg");
  }
  return new Request("https://cake.example/api/transactions/photo", { method: "POST", body: form, signal: options.signal });
};
const defaults = () => ({
  currentUser: async () => ({ id: "a" }), requireMember: async () => undefined,
  extract: async () => extraction,
  findSuggestions: async () => ({ suggestions: [{ merchant: "店", categoryId }] }),
});

test("写真APIは認証・所属確認後に解析し、既存カテゴリ候補を添えて返すだけで登録しない", async () => {
  const calls: unknown[] = [];
  const dependencies = defaults();
  const handler = photoTransactionHandler({
    ...dependencies,
    currentUser: async () => { calls.push("auth"); return { id: "a" }; },
    requireMember: async (...args) => { calls.push(["member", ...args]); },
    extract: async (image, signal) => {
      calls.push("extract"); assert.deepEqual(image.bytes, jpeg); assert.equal(image.mimeType, "image/jpeg");
      assert.ok(signal instanceof AbortSignal); return extraction;
    },
    findSuggestions: async (...args) => { calls.push(["suggest", ...args]); return dependencies.findSuggestions(); },
  });
  const response = await handler(formRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ...extraction, categoryId, categorySuggestionFailed: false });
  assert.deepEqual(calls, ["auth", ["member", workspaceId, "a"], "extract", ["suggest", workspaceId, "a", ["店"]]]);
});

test("写真APIは未認証・他家計・不正入力をOpenAIへ送らない", async () => {
  let calls = 0;
  const dependencies = { ...defaults(), extract: async () => { calls++; return extraction; } };
  assert.equal((await photoTransactionHandler({ ...dependencies, currentUser: async () => null })(formRequest())).status, 401);
  const forbidden = await photoTransactionHandler({ ...dependencies, requireMember: async () => { throw new Error("DB secret"); } })(formRequest());
  assert.equal(forbidden.status, 403);
  assert.doesNotMatch(JSON.stringify(await forbidden.json()), /secret/);
  const handler = photoTransactionHandler(dependencies);
  assert.equal((await handler(formRequest({ workspace: "invalid" }))).status, 400);
  assert.equal((await handler(new Request("https://cake.example/api/transactions/photo", { method: "POST", body: "not multipart" }))).status, 400);
  assert.equal((await handler(new Request("https://cake.example/api/transactions/photo", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=a" }, body: "broken",
  }))).status, 400);
  for (const body of [new FormData(), (() => { const form = new FormData(); form.set("workspaceId", workspaceId); form.set("image", "text"); return form; })(),
    (() => { const form = new FormData(); form.set("workspaceId", workspaceId); form.append("workspaceId", workspaceId); form.set("image", new Blob([jpeg], { type: "image/jpeg" })); return form; })(),
    (() => { const form = new FormData(); form.set("workspaceId", workspaceId); form.set("extra", "value"); form.set("image", new Blob([jpeg], { type: "image/jpeg" })); return form; })()]) {
    assert.equal((await handler(formRequest({ body }))).status, 400);
  }
  assert.equal(calls, 0);
});

test("写真APIは空画像・容量超過・MIMEと署名の不一致を拒否しJPEG/PNG/WebPだけを解析する", async () => {
  let calls = 0;
  const handler = photoTransactionHandler({ ...defaults(), extract: async () => { calls++; return extraction; } });
  assert.equal((await handler(formRequest({ image: new Blob([], { type: "image/jpeg" }) }))).status, 400);
  assert.equal((await handler(formRequest({ image: new Blob([new Uint8Array(MAX_PHOTO_UPLOAD_BYTES + 1)], { type: "image/jpeg" }) }))).status, 413);
  for (const image of [new Blob([jpeg], { type: "image/heic" }), new Blob([jpeg], { type: "image/png" }),
    new Blob(["not a photo"], { type: "image/jpeg" })]) {
    assert.equal((await handler(formRequest({ image }))).status, 415);
  }
  assert.equal(calls, 0);
  const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
  const webp = new Blob(["RIFF1234WEBP"], { type: "image/webp" });
  for (const image of [png, webp]) assert.equal((await handler(formRequest({ image }))).status, 200);
  assert.equal(calls, 2);
});

test("写真APIはContent-Lengthなしの過大chunked要求も上限を超えて読み込まない", async () => {
  let extracts = 0;
  let canceled = false;
  const handler = photoTransactionHandler({ ...defaults(), extract: async () => { extracts++; return extraction; } });
  const request = new Request("https://cake.example/api/transactions/photo", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_PHOTO_UPLOAD_BYTES + 64 * 1024 + 1)); },
      cancel() { canceled = true; },
    }), duplex: "half",
  } as RequestInit);
  assert.equal((await handler(request)).status, 413);
  assert.equal(canceled, true);
  assert.equal(extracts, 0);
  const declared = formRequest();
  declared.headers.set("Content-Length", String(MAX_PHOTO_UPLOAD_BYTES + 64 * 1024 + 1));
  assert.equal((await handler(declared)).status, 413);
});

test("写真APIはカテゴリ候補なし・照会失敗・取引先未読取でも写真の読取結果を保持する", async () => {
  const noSuggestion = await photoTransactionHandler({ ...defaults(), findSuggestions: async () => ({ suggestions: [] }) })(formRequest());
  assert.deepEqual(await noSuggestion.json(), { ...extraction, categoryId: null, categorySuggestionFailed: false });
  const failed = await photoTransactionHandler({ ...defaults(), findSuggestions: async () => { throw new Error("secret"); } })(formRequest());
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { ...extraction, categoryId: null, categorySuggestionFailed: true });
  let suggestions = 0;
  const unknownMerchant = await photoTransactionHandler({
    ...defaults(), extract: async () => ({ ...extraction, merchant: null }),
    findSuggestions: async () => { suggestions++; return { suggestions: [] }; },
  })(formRequest());
  assert.deepEqual(await unknownMerchant.json(), { ...extraction, merchant: null, categoryId: null, categorySuggestionFailed: false });
  assert.equal(suggestions, 0);
});

test("写真APIは解析失敗・キー未設定・中止時の詳細を公開せず、後続のカテゴリ照会を行わない", async () => {
  let suggestions = 0;
  const dependencies = { ...defaults(), findSuggestions: async () => { suggestions++; return { suggestions: [] }; } };
  for (const failure of [new Error("secret"), new PhotoTransactionError("写真からの入力はまだ設定されていません。", 503)]) {
    const result = await photoTransactionHandler({ ...dependencies, extract: async () => { throw failure; } })(formRequest());
    assert.equal(result.status, failure instanceof PhotoTransactionError ? 503 : 502);
    assert.doesNotMatch(JSON.stringify(await result.json()), /secret/);
  }
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await photoTransactionHandler(dependencies)(formRequest({ signal: aborted.signal }))).status, 408);
  const during = new AbortController();
  const response = await photoTransactionHandler({ ...dependencies, extract: async () => { during.abort(); return extraction; } })(formRequest({ signal: during.signal }));
  assert.equal(response.status, 408);
  assert.equal(suggestions, 0);
});
