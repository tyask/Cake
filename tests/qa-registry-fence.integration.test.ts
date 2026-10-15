import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { registryDdlStatements } from "../scripts/qa-registry-ddl";

const legacySql = readFileSync(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8");
const fenceSql = readFileSync(new URL("../db/qa-registry/002_cannele_fence.sql", import.meta.url), "utf8");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const receipt = {
  protocol: "cake-qa-registry-fence/v1", version: 2, revision: "a".repeat(40),
  legacyDdlSha256: sha256(legacySql), fenceDdlSha256: sha256(fenceSql), writerEpoch: 1,
};
const legacyLock = "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cake:qa-registry:v1'))";
const controlLock = "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cannele_registry:control', 0))";
const input = (pr = 1) => ({
  repository: "tyask/Cake", base: "main", pr, branch: `codex/fence-${pr}`,
  headSha: "b".repeat(40), requestId: randomUUID(), leaseId: randomUUID(),
  now: "2026-10-15T00:00:00.000Z", slot: "qa1",
});
const fingerprint = "c".repeat(64);
const databaseUrl = process.env.CAKE_REGISTRY_FENCE_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CAKE_REGISTRY_FENCE_REQUIRE_DATABASE_TESTS === "true") {
  throw new Error("Disposable PostgreSQL fixture is required for Cake QA fence tests.");
}

type Fixture = { admin: pg.Client; connect(): Promise<pg.Client>; close(): Promise<void> };

/** Only the explicitly selected loopback fixture can create/drop random child DBs. */
async function fixture(installReceipt = true): Promise<Fixture> {
  assert.ok(databaseUrl);
  const base = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
  assert.match(base.pathname, /^\/cannele_test$/);
  assert.equal(base.search, "");
  assert.equal(base.hash, "");
  const name = `cannele_test_cake_fence_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^cannele_test_cake_fence_[a-f0-9]{32}$/);
  const creator = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 3000 });
  await creator.connect();
  const clients: pg.Client[] = [];
  let created = false;
  const close = async () => {
    await Promise.allSettled(clients.map(client => client.end()));
    if (created) await creator.query(`DROP DATABASE "${name}"`);
    await creator.end();
  };
  try {
    await creator.query(`CREATE DATABASE "${name}"`);
    created = true;
    const child = new URL(base.href);
    child.pathname = `/${name}`;
    const connect = async () => {
      const client = new pg.Client({ connectionString: child.href, connectionTimeoutMillis: 3000 });
      clients.push(client);
      await client.connect();
      await client.query("SET statement_timeout = '6s'; SET lock_timeout = '4s'");
      return client;
    };
    const admin = await connect();
    assert.equal((await admin.query("SHOW server_version_num")).rows[0].server_version_num.startsWith("17"), true);
    await admin.query(legacySql);
    await admin.query("BEGIN");
    await admin.query("SET LOCAL search_path = pg_catalog");
    for (const statement of registryDdlStatements(fenceSql)) await admin.query(statement);
    if (installReceipt) await admin.query("UPDATE cake_qa_registry.identity SET fence_receipt = $1::jsonb", [JSON.stringify(receipt)]);
    await admin.query("COMMIT");
    return { admin, connect, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function maintenance(client: pg.Client) {
  await client.query("BEGIN");
  try {
    await client.query(legacyLock);
    await client.query(controlLock);
    await client.query("UPDATE cake_qa_registry.identity SET writer_mode = 'maintenance', writer_epoch = 2");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function reserve(client: pg.Client, value = input()) {
  return (await client.query("SELECT cake_qa_registry.reserve($1::jsonb, $2) AS result", [JSON.stringify(value), fingerprint])).rows[0].result;
}

async function write(client: pg.Client, previous: Record<string, unknown>) {
  const next = { ...previous, requestId: randomUUID(), version: Number(previous.version) + 1, state: "published" };
  return {
    next,
    result: (await client.query("SELECT cake_qa_registry.write_snapshot($1, $2::uuid, $3::bigint, $4::jsonb, $5) AS result",
      [previous.slot, previous.leaseId, previous.version, JSON.stringify(next), fingerprint])).rows[0].result,
  };
}

const isFenced = (error: unknown) => {
  assert.equal((error as { code: string }).code, "P0001");
  assert.match((error as Error).message, /Cake QA writer fenced/);
  return true;
};
const isImmutable = (error: unknown) => {
  assert.equal((error as { code: string }).code, "P0001");
  assert.match((error as Error).message, /immutable/);
  return true;
};

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.fail("Expected fixture lock condition did not occur.");
}

test("PostgreSQL fence preserves exact old reserve/write signatures and durable receipts in legacy mode", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  try {
    const request = input();
    const reserved = await reserve(db.admin, request);
    assert.equal(reserved.state, "reserved");
    assert.deepEqual(await reserve(db.admin, request), reserved);
    const { next, result } = await write(db.admin, reserved);
    assert.deepEqual(result, next);
    assert.deepEqual((await db.admin.query("SELECT cake_qa_registry.write_snapshot($1, $2::uuid, $3::bigint, $4::jsonb, $5) AS result",
      [reserved.slot, reserved.leaseId, reserved.version, JSON.stringify(next), fingerprint])).rows[0].result, next);
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.history")).rows[0].count, 2);
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.requests")).rows[0].count, 2);
  } finally { await db.close(); }
});

test("maintenance rejects fresh old mutations and completed reserve/write receipt replay before ledger access", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  try {
    const request = input();
    const reserved = await reserve(db.admin, request);
    const { next } = await write(db.admin, reserved);
    const before = (await db.admin.query("SELECT record FROM cake_qa_registry.slots ORDER BY slot")).rows;
    await maintenance(db.admin);
    await assert.rejects(reserve(db.admin, request), isFenced);
    await assert.rejects(reserve(db.admin, input(2)), isFenced);
    await assert.rejects(db.admin.query("SELECT cake_qa_registry.write_snapshot($1, $2::uuid, $3::bigint, $4::jsonb, $5)",
      [reserved.slot, reserved.leaseId, reserved.version, JSON.stringify(next), fingerprint]), isFenced);
    await assert.rejects(write(db.admin, next), isFenced);
    assert.deepEqual((await db.admin.query("SELECT record FROM cake_qa_registry.slots ORDER BY slot")).rows, before);
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.requests")).rows[0].count, 2);
  } finally { await db.close(); }
});

test("all five legacy data tables fence zero-row INSERT/UPDATE/DELETE and statement TRUNCATE", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  try {
    await maintenance(db.admin);
    const columns: Record<string, string> = {
      slots: "slot", leases: "lease_id", history: "version", resource_owners: "resource_id", requests: "fingerprint",
    };
    for (const [table, column] of Object.entries(columns)) {
      for (const sql of [
        `INSERT INTO cake_qa_registry.${table} SELECT * FROM cake_qa_registry.${table} WHERE false`,
        `UPDATE cake_qa_registry.${table} SET ${column} = ${column} WHERE false`,
        `DELETE FROM cake_qa_registry.${table} WHERE false`,
      ]) await assert.rejects(db.admin.query(sql), isFenced);
    }
    // Include every FK-related legacy table, so PostgreSQL reaches the statement trigger.
    await assert.rejects(db.admin.query("TRUNCATE cake_qa_registry.slots, cake_qa_registry.leases, cake_qa_registry.history, cake_qa_registry.resource_owners, cake_qa_registry.requests"), isFenced);
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.slots")).rows[0].count, 3);
  } finally { await db.close(); }
});

test("missing receipt fails closed and the validated installation receipt/control identity are immutable", { skip: !databaseUrl }, async () => {
  const db = await fixture(false);
  try {
    await assert.rejects(reserve(db.admin), isFenced);
    for (const invalid of [{ ...receipt, version: "2" }, { ...receipt, revision: null }, { ...receipt, extra: true }]) {
      await assert.rejects(db.admin.query("UPDATE cake_qa_registry.identity SET fence_receipt = $1::jsonb", [JSON.stringify(invalid)]),
        (error: unknown) => (error as { code: string }).code === "23514");
    }
    await db.admin.query("UPDATE cake_qa_registry.identity SET fence_receipt = $1::jsonb", [JSON.stringify(receipt)]);
    for (const sql of [
      "UPDATE cake_qa_registry.identity SET fence_receipt = NULL",
      "UPDATE cake_qa_registry.identity SET protocol = 'other'",
      "UPDATE cake_qa_registry.identity SET database_name = 'other'",
      "DELETE FROM cake_qa_registry.identity WHERE false",
      "INSERT INTO cake_qa_registry.identity SELECT * FROM cake_qa_registry.identity WHERE false",
      "TRUNCATE cake_qa_registry.identity",
    ]) await assert.rejects(db.admin.query(sql), isImmutable);
    await maintenance(db.admin);
    await assert.rejects(db.admin.query("UPDATE cake_qa_registry.identity SET writer_mode = 'legacy', writer_epoch = 1"), isImmutable);
    await db.admin.query("UPDATE cake_qa_registry.identity SET writer_epoch = 3");
    await assert.rejects(db.admin.query("UPDATE cake_qa_registry.identity SET writer_epoch = 2"), isImmutable);
    assert.deepEqual((await db.admin.query("SELECT fence_receipt FROM cake_qa_registry.identity")).rows[0].fence_receipt, receipt);
  } finally { await db.close(); }
});

test("FOR SHARE makes a stale REPEATABLE READ authorization snapshot serialize-fail after maintenance", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  const stale = await db.connect();
  try {
    await stale.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    assert.equal((await stale.query("SELECT writer_mode FROM cake_qa_registry.identity")).rows[0].writer_mode, "legacy");
    await maintenance(db.admin);
    await assert.rejects(stale.query("SELECT cake_qa_registry.assert_identity()"),
      (error: unknown) => (error as { code: string }).code === "40001");
    await stale.query("ROLLBACK");
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.leases")).rows[0].count, 0);
  } finally { await db.close(); }
});

test("maintenance waits for the legacy writer before taking control-exclusive, then blocks subsequent old callers", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  const writer = await db.connect();
  const migrator = await db.connect();
  const observer = await db.connect();
  try {
    await writer.query("BEGIN");
    await reserve(writer);
    const pid = (await migrator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending = maintenance(migrator).then(() => undefined, error => error as Error);
    await waitFor(async () => (await observer.query("SELECT 1 FROM pg_catalog.pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid])).rowCount === 1);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM pg_catalog.pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted", [pid])).rows[0].count, 0);
    // A Cannele-only shared control reader can still progress; the blocked migrator does not hold control first.
    await observer.query("SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('cannele_registry:control', 0))");
    await writer.query("COMMIT");
    assert.equal(await pending, undefined);
    await assert.rejects(reserve(writer, input(2)), isFenced);
  } finally { await db.close(); }
});

test("data and control statement guards wait on legacy before locking a target row", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  const mutation = await db.connect();
  const observer = await db.connect();
  try {
    const request = input();
    await reserve(db.admin, request);
    for (const [sql, row] of [
      ["UPDATE cake_qa_registry.requests SET fingerprint = fingerprint WHERE request_id = $1::uuid", request.requestId],
      ["UPDATE cake_qa_registry.identity SET writer_epoch = writer_epoch WHERE singleton = $1::boolean", true],
    ] as const) {
      await db.admin.query("BEGIN");
      await db.admin.query(legacyLock);
      const pid = (await mutation.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = mutation.query(sql, [row]).then(() => undefined, error => error as Error);
      await waitFor(async () => (await observer.query("SELECT 1 FROM pg_catalog.pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid])).rowCount === 1);
      await observer.query("BEGIN");
      // NOWAIT would fail if the mutation acquired the row before its statement guard.
      if (typeof row === "boolean") await observer.query("SELECT 1 FROM cake_qa_registry.identity WHERE singleton FOR UPDATE NOWAIT");
      else await observer.query("SELECT 1 FROM cake_qa_registry.requests WHERE request_id = $1::uuid FOR UPDATE NOWAIT", [row]);
      await observer.query("COMMIT");
      await db.admin.query("COMMIT");
      assert.equal(await pending, undefined);
    }
  } finally { await db.close(); }
});

test("a paused old reserve frame that passed the unfenced old guard cannot insert after maintenance", { skip: !databaseUrl }, async () => {
  const db = await fixture();
  const old = await db.connect();
  const observer = await db.connect();
  const pauseKey = 41293071;
  try {
    // Copy the immutable 001 bodies, with only a test pause after the old guard.
    // This represents a stored routine frame which already passed old authorization.
    await db.admin.query("CREATE SCHEMA fence_test");
    const statements = registryDdlStatements(legacySql);
    const oldGuard = statements.find(sql => sql.startsWith("CREATE FUNCTION cake_qa_registry.assert_identity"));
    const oldReserve = statements.find(sql => sql.startsWith("CREATE FUNCTION cake_qa_registry.reserve"));
    assert.ok(oldGuard && oldReserve);
    await db.admin.query(oldGuard.replace("cake_qa_registry.assert_identity()", "fence_test.old_assert_identity()"));
    await db.admin.query(oldReserve.replace("cake_qa_registry.reserve(", "fence_test.old_frame_reserve(")
      .replace("PERFORM cake_qa_registry.assert_identity();", `PERFORM fence_test.old_assert_identity(); PERFORM pg_catalog.pg_advisory_xact_lock(${pauseKey});`));
    await db.admin.query("SELECT pg_catalog.pg_advisory_lock($1)", [pauseKey]);
    const pid = (await old.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const request = input();
    const pending = old.query("SELECT fence_test.old_frame_reserve($1::jsonb, $2)", [JSON.stringify(request), fingerprint])
      .then(() => undefined, error => error as { code: string; message: string });
    await waitFor(async () => (await observer.query("SELECT 1 FROM pg_catalog.pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [pid])).rowCount === 1);
    await maintenance(db.admin);
    await db.admin.query("SELECT pg_catalog.pg_advisory_unlock($1)", [pauseKey]);
    assert.equal(isFenced(await pending), true);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM cake_qa_registry.leases")).rows[0].count, 0);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM cake_qa_registry.requests")).rows[0].count, 0);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM cake_qa_registry.slots WHERE state = 'free'")).rows[0].count, 3);
  } finally { await db.close(); }
});
