import assert from "node:assert/strict";
import test from "node:test";
import { cloudMemoryDatabaseUrl, CLOUD_DATABASE_CONNECTION_STRING } from "../../lib/server/database/cloud-memory";

const configured = {
  CAKE_CLOUD_MODE: "memory", NODE_ENV: "development", AUTH_MODE: "test",
  CAKE_MEMORY_DATABASE_URL: `http://127.0.0.1:45678/sql/${"a".repeat(48)}`,
  DATABASE_URL: CLOUD_DATABASE_CONNECTION_STRING,
};

test("Cloud DBは明示した開発用loopback接続だけを許可し、通常のDB選択を維持する", () => {
  assert.equal(cloudMemoryDatabaseUrl({}), null);
  assert.equal(cloudMemoryDatabaseUrl({ VERCEL_ENV: "production", DATABASE_URL: "existing" }), null);
  assert.equal(cloudMemoryDatabaseUrl(configured), configured.CAKE_MEMORY_DATABASE_URL);
  for (const changes of [
    { NODE_ENV: "production" }, { NODE_ENV: undefined }, { AUTH_MODE: "google" },
    { VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" },
    { CAKE_CLOUD_MODE: "other" }, { CAKE_CLOUD_MODE: undefined },
    { CAKE_MEMORY_DATABASE_URL: undefined }, { DATABASE_URL: "postgresql://remote.neon.tech/cake" },
    { CAKE_TEST_DATABASE_URL: "configured" }, { CAKE_PREVIEW_PR: "34" },
    ...["https://127.0.0.1:45678", "http://remote.example:45678", "http://127.0.0.1", "http://user:password@127.0.0.1:45678"].map(base => ({ CAKE_MEMORY_DATABASE_URL: `${base}/sql/${"a".repeat(48)}` })),
    { CAKE_MEMORY_DATABASE_URL: configured.CAKE_MEMORY_DATABASE_URL + "?redirect=remote" },
    { CAKE_MEMORY_DATABASE_URL: "http://127.0.0.1:45678/sql" },
  ]) assert.throws(() => cloudMemoryDatabaseUrl({ ...configured, ...changes }), /CloudオンメモリDB/);
});
