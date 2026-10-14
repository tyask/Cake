import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { QA_NEON_PROJECT_ID, QA_REPOSITORY } from "../lib/qa-pool";
import {
  QA_REGISTRY_PROTOCOL, parseRegistryLease, registryLeaseToPoolRecord, registryPublicSummary,
  validateRegistryReservation, validateRegistryTransition, type QaRegistryLease, type RegistryReservation,
} from "../lib/qa-registry";
import { NeonQaRegistryStore, registryConnectionString, registryRequestFingerprint } from "../scripts/qa-registry-store";

const token = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-14T00:00:00.000Z";
const sha = "a".repeat(40);
const database = { projectId: QA_NEON_PROJECT_ID, branchId: "br-test", endpointId: "ep-test", host: "ep-test.ap-southeast-1.aws.neon.tech" } as const;
const reservation = (n = 1): RegistryReservation => ({ repository: QA_REPOSITORY, base: "main", pr: n,
  branch: `codex/task-${n}`, headSha: sha, leaseId: token(n), requestId: token(n + 100), now });
const lease = (): QaRegistryLease => ({ protocol: QA_REGISTRY_PROTOCOL, slot: "qa1", leaseId: token(1),
  pr: 1, branch: "codex/task-1", headSha: sha, state: "reserved", version: 1, requestId: token(101),
  createdAt: now, updatedAt: now, deployments: [], retiredDatabases: [] });

test("registry pins its explicit separate endpoint and never falls back to an application database", () => {
  const connection = "postgresql://user:private@ep-registry-pooler.ap-southeast-1.aws.neon.tech/registry";
  const env = { CAKE_QA_REGISTRY_DATABASE_URL: connection, CAKE_QA_REGISTRY_DATABASE_HOST: "ep-registry.ap-southeast-1.aws.neon.tech" };
  assert.equal(registryConnectionString(env), connection);
  for (const changed of [
    { ...env, CAKE_QA_REGISTRY_DATABASE_URL: undefined, DATABASE_URL: connection },
    { ...env, CAKE_QA_REGISTRY_DATABASE_HOST: undefined },
    { ...env, CAKE_QA_REGISTRY_DATABASE_HOST: "ep-wrong.ap-southeast-1.aws.neon.tech" },
    ...["DATABASE_URL", "CAKE_TEST_DATABASE_URL", "CAKE_QA_PRODUCTION_DATABASE_HOST", "CAKE_QA_PARENT_DATABASE_HOST", "CAKE_QA_DATABASE_HOST"]
      .map((key) => ({ ...env, [key]: connection })),
  ]) assert.throws(() => registryConnectionString(changed), (error: unknown) => {
    assert.doesNotMatch(String(error), /private|postgresql:|ep-registry/); return true;
  });
});

test("registry requires same repository, main base, UUIDs and a full commit SHA", () => {
  validateRegistryReservation(reservation());
  for (const change of [{ repository: "other/Cake" }, { base: "dev" }, { pr: 0 }, { branch: "main" },
    { headSha: "abcdef" }, { leaseId: "old" }, { requestId: "old" }, { slot: "qa4" }]) {
    assert.throws(() => validateRegistryReservation({ ...reservation(), ...change } as RegistryReservation));
  }
});

test("publication keeps its private alias manifest while the legacy adapter omits the probe-only field", () => {
  const published: QaRegistryLease = { ...lease(), state: "published", database, deployments: [{ id: "dpl_ready", sha, phase: "application", url: "https://cake-test.vercel.app" }],
    readyDeploymentId: "dpl_ready", aliasSha: sha,
    aliasAssignment: { alias: "cake-qa1-fumin.vercel.app", deploymentId: "dpl_ready", sha, state: "assigned" } };
  assert.deepEqual(parseRegistryLease(published), published);
  const legacy = registryLeaseToPoolRecord(published);
  assert.equal(legacy.state, "held"); assert.equal(legacy.aliasAssignment, undefined);
  assert.doesNotMatch(JSON.stringify(registryPublicSummary(published)), /ep-test\.ap|host|postgresql|password/);
  assert.equal(registryPublicSummary(published)?.deployments[0].url, "https://cake-test.vercel.app");
  assert.throws(() => parseRegistryLease({ ...lease(), state: "published" }), /公開済み/);
  assert.throws(() => parseRegistryLease({ ...published, credentials: "forbidden" }), /未知/);
});

test("updates retain cleanup IDs, prohibit stale owners, and preserve existing unresolved deletion intents", () => {
  const first: QaRegistryLease = { ...lease(), database, deployments: [{ id: "dpl_one", sha, phase: "provisioning" }],
    intent: { sha, phase: "application", attemptId: token(9), startedAt: now } };
  const deleting: QaRegistryLease = { ...first, state: "deleting", version: 2, requestId: token(102) };
  validateRegistryTransition(first, deleting);
  validateRegistryTransition(deleting, { ...deleting, version: 3, requestId: token(103) });
  validateRegistryTransition(deleting, { ...deleting, version: 3, requestId: token(103), intent: undefined });
  for (const change of [{ leaseId: token(2) }, { version: 9 }, { deployments: [] }, { database: undefined }, { state: "free" }]) {
    assert.throws(() => validateRegistryTransition(first, { ...deleting, ...change } as QaRegistryLease));
  }
  assert.throws(() => validateRegistryTransition(deleting, { ...deleting, version: 3, requestId: token(103), intent: { ...first.intent!, attemptId: token(10) } }), /削除中/);
  assert.throws(() => validateRegistryTransition(deleting, { ...deleting, state: "free", intent: undefined, version: 3, requestId: token(103) }), /履歴/);
  validateRegistryTransition(deleting, { ...deleting, state: "free", intent: undefined, version: 3, requestId: token(103), retiredDatabases: [database] });
});

test("DB transport failures do not expose a connection URL or private SQL error", async () => {
  const store = new NeonQaRegistryStore(async () => { throw new Error("postgresql://user:private@ep-registry/db private SQL"); });
  await assert.rejects(store.read(), (error: unknown) => {
    assert.doesNotMatch(String(error), /postgresql|private SQL|ep-registry/); return true;
  });
  assert.equal(registryRequestFingerprint({ a: 1, b: 2 }), registryRequestFingerprint({ b: 2, a: 1 }));
});

const pgliteModule = process.env.CAKE_LOCAL_PGLITE_MODULE;
const loadPGlite = () => pgliteModule ? import(pathToFileURL(pgliteModule).href) : import("@electric-sql/pglite");
test("registry SQL: atomic reservation, idempotency, version CAS, retained history, and resource isolation", async () => {
  const { PGlite } = await loadPGlite();
  const db = new PGlite() as { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; exec: (sql: string) => Promise<unknown>; close: () => Promise<void> };
  try {
    await db.exec(readFileSync(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8"));
    const store = new NeonQaRegistryStore(async (sql, params) => (await db.query(sql, params)).rows);
    assert.deepEqual((await store.read()).slots, { qa1: null, qa2: null, qa3: null });
    const first = (await store.reserve(reservation()))!;
    assert.equal(first.slot, "qa1");
    assert.deepEqual(await store.reserve({ ...reservation(), now: "2026-10-15T00:00:00Z" }), first);
    assert.deepEqual(await store.reserve({ ...reservation(), leaseId: token(50), requestId: token(150) }), first);
    await assert.rejects(store.reserve({ ...reservation(), pr: 99 }), /QA管理DB/);
    await Promise.all([store.reserve(reservation(2)), store.reserve(reservation(3))]);
    assert.equal(await store.reserve(reservation(4)), null);
    assert.equal(new Set(Object.values((await store.read()).slots).map((record) => record?.pr)).size, 3);

    const attached: QaRegistryLease = { ...first, version: 2, requestId: token(200), database,
      deployments: [{ id: "dpl_one", sha, phase: "application" }] };
    await store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 1 }, attached);
    assert.deepEqual(await store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 1 }, attached), attached);
    await assert.rejects(store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 1 }, { ...attached, requestId: token(201) }), /QA管理DB/);
    const deleting: QaRegistryLease = { ...attached, state: "deleting", version: 3, requestId: token(202) };
    await store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 2 }, deleting);
    const free: QaRegistryLease = { ...deleting, state: "free", version: 4, requestId: token(203), retiredDatabases: [database] };
    await store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 3 }, free);
    assert.deepEqual((await store.read()).retiredDatabases, [database]);
    const newLease = (await store.reserve({ ...reservation(4), requestId: token(304) }))!;
    assert.equal(newLease.slot, "qa1"); assert.equal(newLease.version, 5);
    assert.deepEqual(newLease.retiredDatabases, [database]);
    await assert.rejects(store.writeSnapshot("qa1", { leaseId: first.leaseId, version: 4 }, { ...free, version: 5, requestId: token(204) }));
    await assert.rejects(store.writeSnapshot("qa1", { leaseId: newLease.leaseId, version: 5 }, {
      ...newLease, version: 6, requestId: token(205), deployments: attached.deployments,
    }), /QA管理DB/);
    await assert.rejects(store.reserve({ ...reservation(9), leaseId: first.leaseId }), /QA管理DB/);
    const history = (await db.query("SELECT count(*)::int AS count FROM cake_qa_registry.history WHERE lease_id=$1::uuid", [first.leaseId])).rows;
    assert.equal(history[0].count, 4);
    assert.equal((await store.read()).slots.qa1?.leaseId, newLease.leaseId);
  } finally { await db.close(); }
});

test("registry initialization rejects an application or Preview database without changing its data", async () => {
  const { PGlite } = await loadPGlite();
  for (const table of ["app_users", "cake_preview_database_identity"]) {
    const db = new PGlite() as { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>; exec: (sql: string) => Promise<unknown>; close: () => Promise<void> };
    try {
      await db.exec(`CREATE TABLE ${table} (id integer PRIMARY KEY); INSERT INTO ${table} VALUES (1)`);
      await assert.rejects(db.exec(readFileSync(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8")), /separate empty management database/);
      await db.exec("ROLLBACK");
      assert.deepEqual((await db.query(`SELECT * FROM ${table}`)).rows, [{ id: 1 }]);
      assert.equal((await db.query("SELECT to_regnamespace('cake_qa_registry') IS NULL AS absent")).rows[0].absent, true);
    } finally { await db.close(); }
  }
});
