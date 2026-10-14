import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPreviewDeployment } from "../scripts/deploy-preview";

test("旧Preview入口は環境変数・flagsで再有効化できず、deploy/alias/linkを実行しない", async () => {
  let calls = 0;
  const logs: string[] = [];
  for (const args of [[], ["--force"], ["--prod"], ["--target", "preview"]]) {
    await assert.rejects(() => runPreviewDeployment({
      args, environment: { CAKE_QA_POOL_ENABLED: "true", CAKE_QA_SLOT: "qa1", VERCEL_TOKEN: "private-token" },
      execute: async () => { calls += 1; return { status: 0, signal: null, stdout: "https://unused.vercel.app" }; },
      log: (message) => { logs.push(message); },
    }), /直接のPreviewデプロイは停止/);
  }
  assert.equal(calls, 0);
  assert.deepEqual(logs, []);
});

test("旧スクリプトを直接起動しても固定枠writerを迂回しない", () => {
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const script = fileURLToPath(new URL("../scripts/deploy-preview.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", loader, script, "--force"], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, VERCEL_TOKEN: "private-token" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /直接のPreviewデプロイは停止/);
  assert.doesNotMatch(result.stderr + result.stdout, /private-token/);
});
