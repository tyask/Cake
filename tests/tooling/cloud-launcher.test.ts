import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCloudPortAvailable, assertCloudStartupAllowed, cloudChildEnvironment } from "../../scripts/cloud/dev-cloud";

test("CloudはVercel・ProductionとNextが読み込む環境ファイルを起動前に拒否する", () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-cloud-guard-"));
  try {
    for (const environment of [{ VERCEL: "1" }, { VERCEL: "" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "" }, { NODE_ENV: "production" }]) {
      assert.throws(() => assertCloudStartupAllowed(environment, directory), /Vercel・Production/);
    }
    writeFileSync(join(directory, ".env.example"), "DATABASE_URL=example-only\n");
    assert.doesNotThrow(() => assertCloudStartupAllowed({}, directory));
    for (const filename of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      const path = join(directory, filename);
      writeFileSync(path, "AUTH_GOOGLE_SECRET=private-canary\n");
      assert.throws(() => assertCloudStartupAllowed({}, directory), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cloud専用worktree/);
        assert.doesNotMatch(error.message, /private-canary/);
        return true;
      });
      rmSync(path);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Next子環境はCA・proxy・cacheを維持し、既存DB・認証・provider資格情報を引き継がない", () => {
  const inherited = Object.freeze({
    PATH: "/tools/bin", HOME: "/home/cloud", TMPDIR: "/tmp/cloud", XDG_CACHE_HOME: "/cache",
    NODE_EXTRA_CA_CERTS: "/certs/cloud.pem", SSL_CERT_DIR: "/certs", HTTPS_PROXY: "http://proxy.local:8080",
    NO_PROXY: "127.0.0.1,localhost", npm_config_cache: "/cache/npm", PLAYWRIGHT_BROWSERS_PATH: "/cache/browsers",
    NODE_USE_SYSTEM_CA: "1", NODE_USE_ENV_PROXY: "1",
    DATABASE_URL: "private-database", CAKE_TEST_DATABASE_URL: "private-test-database", AUTH_SECRET: "private-auth",
    AUTH_GOOGLE_ID: "private-google-id", AUTH_GOOGLE_SECRET: "private-google-secret", GH_TOKEN: "private-gh",
    GITHUB_TOKEN: "private-github", VERCEL_TOKEN: "private-vercel", NEON_API_KEY: "private-neon",
    OPENAI_API_KEY: "private-openai", NEXT_PUBLIC_PRIVATE_VALUE: "private-client", NODE_OPTIONS: "--require private-loader",
  });
  const database = { url: "http://127.0.0.1:34567/sql/" + "a".repeat(48), connectionString: "postgresql://cake:memory@cloud.cake.local/cake" };
  const first = cloudChildEnvironment(inherited, database, 3001);
  const second = cloudChildEnvironment(inherited, database, 3001);
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_DIR", "HTTPS_PROXY", "NO_PROXY", "npm_config_cache", "PLAYWRIGHT_BROWSERS_PATH", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY"] as const) {
    assert.equal(first[key], inherited[key]);
  }
  for (const key of ["CAKE_TEST_DATABASE_URL", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "GH_TOKEN", "GITHUB_TOKEN", "VERCEL_TOKEN", "NEON_API_KEY", "OPENAI_API_KEY", "NEXT_PUBLIC_PRIVATE_VALUE", "NODE_OPTIONS"]) {
    assert.equal(first[key], undefined, key);
  }
  assert.equal(first.DATABASE_URL, database.connectionString);
  assert.equal(first.CAKE_MEMORY_DATABASE_URL, database.url);
  assert.equal(first.CAKE_CLOUD_MODE, "memory");
  assert.equal(first.AUTH_MODE, "test");
  assert.equal(first.AUTH_URL, "http://127.0.0.1:3001");
  assert.match(first.AUTH_SECRET!, /^[a-f0-9]{64}$/);
  assert.notEqual(first.AUTH_SECRET, second.AUTH_SECRET);
  assert.equal(first.NODE_ENV, "development");
  assert.equal(first.DB_QUERY_LOG, "off");
  assert.equal(first.NEXT_TELEMETRY_DISABLED, "1");
  assert.equal(inherited.DATABASE_URL, "private-database");
  assert.equal(inherited.AUTH_SECRET, "private-auth");
});

test("Cloudは占有portを拒否し、確認用のlisten socketを解放する", async () => {
  const occupied = createServer();
  await new Promise<void>(accept => occupied.listen(0, "127.0.0.1", accept));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  try { await assert.rejects(assertCloudPortAvailable(port, "127.0.0.1"), /占有を解消/); }
  finally { await new Promise<void>((accept, reject) => occupied.close(error => error ? reject(error) : accept())); }
  await assertCloudPortAvailable(port, "127.0.0.1");
  await assertCloudPortAvailable(port, "127.0.0.1");
});
