import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RECEIPT_MODEL, extractPhotoTransaction, PhotoTransactionError } from "../../lib/server/photo-transaction";

const extraction = { date: "2026-11-17", time: "12:34", merchant: "  お店  ", amountYen: 1234, memo: "パン、牛乳" };
const image = { bytes: new Uint8Array([255, 216, 255, 1]), mimeType: "image/jpeg" as const };
const completed = (value: unknown = extraction) => ({ status: "completed", output: [
  { type: "reasoning", summary: [] },
  { type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] },
] });
const responseFetch = (value: unknown, status = 200): typeof fetch => async () => Response.json(value, { status });
const safeError = async (action: () => Promise<unknown>, status: number) => {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof PhotoTransactionError);
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /secret|sk-test|provider-detail/);
    return true;
  });
};

test("写真の抽出は固定OpenAIエンドポイント・厳密schema・非保存で1回だけ呼び、検証済み項目を返す", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "sk-test", model: DEFAULT_RECEIPT_MODEL,
    fetch: async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(completed()); },
  });
  assert.deepEqual(result, { ...extraction, merchant: "お店" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, "gpt-6.1-terra");
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.equal(body.max_output_tokens, 2048);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.required, ["date", "time", "merchant", "amountYen", "memo"]);
  assert.deepEqual(body.input[0].content[1], { type: "input_image", detail: "high", image_url: "data:image/jpeg;base64,/9j/AQ==" });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("写真の抽出はキー未設定で外部APIを呼ばない", async () => {
  let calls = 0;
  await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "", fetch: async () => { calls++; return Response.json(completed()); },
  }), 503);
  assert.equal(calls, 0);
});

test("写真の抽出は日付だけ・未読取をnullのまま返し、現在日時を補わない", async () => {
  const partial = { ...extraction, time: null, amountYen: null, merchant: null, memo: null };
  assert.deepEqual(await extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: responseFetch(completed(partial)),
  }), partial);
  const empty = { date: null, time: null, merchant: null, amountYen: null, memo: null };
  assert.deepEqual(await extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: responseFetch(completed(empty)),
  }), empty);
});

test("写真の抽出はrefusal・未完了・JSON不正・業務制約違反を安全な解析失敗として返す", async () => {
  const payloads = [
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "provider-detail" }] }] },
    { ...completed(), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "provider-detail" }] }] },
    completed({ ...extraction, date: "2026-02-30" }), completed({ ...extraction, time: "25:00" }),
    completed({ ...extraction, amountYen: -1 }), completed({ ...extraction, amountYen: 1.5 }),
    completed({ ...extraction, memo: "x".repeat(2001) }), completed({ ...extraction, merchant: "" }),
    completed({ ...extraction, categoryId: "secret" }),
  ];
  for (const payload of payloads) await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: responseFetch(payload),
  }), 502);
});

test("写真の抽出は上流HTTP失敗・通信例外・過大/空の応答にproviderの詳細を含めない", async () => {
  for (const status of [400, 401, 403, 500]) await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: responseFetch({ error: { message: "provider-detail secret" } }, status),
  }), 502);
  await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: responseFetch({ error: "secret" }, 429),
  }), 503);
  for (const fakeFetch of [
    async () => { throw new Error("secret sk-test"); },
    async () => new Response("x".repeat(128 * 1024 + 1)),
    async () => new Response(null),
    async () => new Response("{}", { headers: { "Content-Length": String(128 * 1024 + 1) } }),
  ] as typeof fetch[]) await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
    apiKey: "key", fetch: fakeFetch,
  }), 502);
});

test("写真の抽出は既に中断済みなら呼ばず、開始後の中断・タイムアウトを区別する", async () => {
  const canceled = new AbortController(); canceled.abort();
  let calls = 0;
  await safeError(() => extractPhotoTransaction(image, canceled.signal, {
    apiKey: "key", fetch: async () => { calls++; return Response.json(completed()); },
  }), 408);
  assert.equal(calls, 0);
  const waitingFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("provider-detail")), { once: true });
  });
  const during = new AbortController();
  const pending = extractPhotoTransaction(image, during.signal, { apiKey: "key", fetch: waitingFetch });
  during.abort();
  await safeError(() => pending, 408);
  // AbortSignal.timeout is unref'ed; keep the event loop alive until its rejection.
  const keeper = setTimeout(() => {}, 200);
  try {
    await safeError(() => extractPhotoTransaction(image, new AbortController().signal, {
      apiKey: "key", timeoutMs: 5, fetch: waitingFetch,
    }), 504);
  } finally { clearTimeout(keeper); }
});
