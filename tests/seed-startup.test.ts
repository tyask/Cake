import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const seedPath = fileURLToPath(new URL("../scripts/seed-test-users.ts", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function runSeed(envFile: string, environment: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "cake-seed-startup-"));
  try {
    writeFileSync(join(directory, ".env.local"), envFile);
    return spawnSync(process.execPath, ["--import", tsxLoader, seedPath], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "production", DATABASE_URL: undefined,
        VERCEL: undefined, VERCEL_ENV: undefined, AUTH_MODE: undefined,
        __NEXT_PROCESSED_ENV: undefined,
        ...environment,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertEnvironmentLoaded(result: ReturnType<typeof runSeed>) {
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /段階: DB接続の初期化/);
  assert.match(result.stderr, /DATABASE_URLの形式が不正/);
  assert.doesNotMatch(result.stderr, /種別: TypeError|環境設定の読み込み|isolated-invalid-url/);
}

test("実際の@next/envを使い、ローカルenvファイルの読み込み後にDB初期化へ進む", () => {
  // An invalid URL stops before any network call; no repository env files are loaded.
  assertEnvironmentLoaded(runSeed("DATABASE_URL=isolated-invalid-url\n", {}));
});

test("Vercelの環境変数が渡された実起動でも環境読み込みのTypeErrorを起こさない", () => {
  // Injected variables retain precedence over .env.local, as on the build host.
  assertEnvironmentLoaded(runSeed("DATABASE_URL=\n", {
    VERCEL: "1", VERCEL_ENV: "preview", AUTH_MODE: "test", DATABASE_URL: "isolated-invalid-url",
  }));
});
