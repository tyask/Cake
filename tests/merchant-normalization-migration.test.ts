import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createMerchantNormalizationMigrationFixture, verifyMerchantNormalizationMigration,
  type MerchantMigrationDatabase } from "../scripts/merchant-normalization-migration-scenario";

const migration = () => readFile(new URL("../db/migrations/019_merchant_normalization.sql", import.meta.url), "utf8");
const prefix = "verify-merchant-migration-local";
const zero = { schemas: 0, tables: 0, functions: 0, indexes: 0 };
const database = (sql: PGlite): MerchantMigrationDatabase => ({
  async query(text, params) {
    if (params) return sql.query(text, params);
    const results = await sql.exec(text); return { rows: results.at(-1)?.rows ?? [] };
  },
});

test("実019のscratch適用でbackfill・既存列保持・旧UPDATEとIndexを検証しpublicとsession設定を維持する", async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  await sql.exec(`CREATE TABLE public.transactions(marker text PRIMARY KEY);
    INSERT INTO public.transactions VALUES ('既存publicの保持');
    CREATE FUNCTION public.cake_normalize_merchant(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT ''public-sentinel''::text';
    CREATE INDEX transactions_workspace_merchant_normalized_idx ON public.transactions(marker)`);
  const publicBefore = await sql.query("SELECT oid,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid");
  const searchBefore = await sql.query("SHOW search_path");
  const client = database(sql), fixture = createMerchantNormalizationMigrationFixture(client, { prefix });
  try {
    await fixture.setup();
    assert.deepEqual(await fixture.remaining(), { schemas: 1, tables: 1, functions: 0, indexes: 1 });
    await fixture.beginMigration(await migration());
    await fixture.verifyBackfill();
    await fixture.commit();
    assert.deepEqual(await fixture.remaining(), { schemas: 1, tables: 1, functions: 1, indexes: 2 });
    await fixture.update(client);
    await fixture.verifyUpdated();
  } finally { assert.deepEqual(await fixture.cleanup(), zero); }
  assert.deepEqual(await fixture.cleanup(), zero, "cleanupを繰り返しても他schemaへ触れない");
  assert.deepEqual(await sql.query("SHOW search_path"), searchBefore);
  assert.deepEqual(await sql.query("SELECT oid,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid"), publicBefore);
  assert.deepEqual((await sql.query("SELECT * FROM public.transactions")).rows, [{ marker: "既存publicの保持" }]);
  assert.deepEqual((await sql.query("SELECT public.cake_normalize_merchant('ＡＢＣ') AS value")).rows, [{ value: "public-sentinel" }]);
  assert.equal((await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'qa_merchant_%'")).rows[0].count, 0);
});

test("019適用中のSQL失敗はrollbackでき、関数・生成列・Indexを残さず所有schemaだけcleanupする", async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  const client = database(sql), fixture = createMerchantNormalizationMigrationFixture(client, { prefix });
  const searchBefore = await sql.query("SHOW search_path");
  try {
    await fixture.setup();
    const table = `"${fixture.relationIdentity.schema}".transactions`;
    const before = (await sql.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)).rows;
    await fixture.beginMigration(await migration());
    await fixture.verifyBackfill();
    await assert.rejects(sql.query("SELECT 1/0"), { code: "22012" });
    await fixture.rollback();
    await fixture.verifyRolledBack();
    assert.deepEqual((await sql.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)).rows, before);
    assert.deepEqual(await fixture.remaining(), { schemas: 1, tables: 1, functions: 0, indexes: 1 });
    assert.deepEqual(await sql.query("SHOW search_path"), searchBefore);
    await fixture.beginMigration(await migration()); await fixture.verifyBackfill(); await fixture.commit();
  } finally { assert.deepEqual(await fixture.cleanup(), zero); }
});

test("fixture作成途中の失敗でも作成schemaをrollbackしpublicの既存tableを保持する", async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  await sql.exec("CREATE TABLE public.keep_fixture(id int); INSERT INTO public.keep_fixture VALUES (42)");
  const client = database(sql);
  const failing: MerchantMigrationDatabase = { query: async (text, params) => {
    if (text.startsWith("CREATE TABLE")) throw { code: "53100", message: "sensitive-connection-and-SQL" };
    return client.query(text, params);
  } };
  const fixture = createMerchantNormalizationMigrationFixture(failing, { prefix });
  await assert.rejects(fixture.setup(), { code: "53100" });
  assert.deepEqual(await fixture.cleanup(), zero);
  assert.deepEqual((await sql.query("SELECT * FROM public.keep_fixture")).rows, [{ id: 42 }]);
});

test("cleanupは作成時OIDが変わった同名schemaを削除せず残存件数を確認できる", async t => {
  const sql = new PGlite(); t.after(() => sql.close());
  const client = database(sql), fixture = createMerchantNormalizationMigrationFixture(client, { prefix });
  await fixture.setup();
  const schema = fixture.relationIdentity.schema;
  await sql.exec(`DROP SCHEMA "${schema}" CASCADE; CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".keep_fixture(id int)`);
  await assert.rejects(fixture.cleanup(), { code: "ERR_ASSERTION" });
  assert.deepEqual(await fixture.remaining(), { schemas: 1, tables: 1, functions: 0, indexes: 0 });
  assert.equal((await sql.query<{ count: number }>("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name='keep_fixture'", [schema])).rows[0].count, 1);
  // The replacement is this test's own object, outside the migration fixture's ownership.
  await sql.exec(`DROP SCHEMA "${schema}" CASCADE`);
});

test("不正prefixと同じsessionではSQLを発行せず、接続失敗はSQLSTATEだけ報告する", async () => {
  let calls = 0;
  const fail = (code: string): MerchantMigrationDatabase => ({ async query() {
    calls++; throw { code, message: "sensitive-connection-and-SQL", query: "sensitive-connection-and-SQL" };
  } });
  const first = fail("28P01"), second = fail("28P01"), observer = fail("28P01");
  for (const invalid of ["public", "verify-merchant-x;DROP SCHEMA public", "verify-merchant-", `verify-merchant-${"a".repeat(41)}`]) {
    assert.throws(() => createMerchantNormalizationMigrationFixture(first, { prefix: invalid }));
    const report = await verifyMerchantNormalizationMigration(first, second, observer, "reviewed migration", { prefix: invalid });
    assert.equal(report.success, false); assert.deepEqual(report.failures, [{ stage: "preflight", sqlstate: null }]);
    assert.deepEqual(report.cleanup, zero);
  }
  const shared = await verifyMerchantNormalizationMigration(first, first, observer, "reviewed migration", { prefix });
  assert.equal(shared.success, false); assert.deepEqual(shared.backendPids, []); assert.equal(calls, 0);
  const failed = await verifyMerchantNormalizationMigration(first, second, observer, "reviewed migration", { prefix });
  assert.equal(calls, 1); assert.equal(failed.success, false);
  assert.deepEqual(failed.failures, [{ stage: "preflight", sqlstate: "28P01" }]);
  assert.deepEqual(failed.cleanup, zero); assert.deepEqual(failed.cases, []);
  assert.ok(!JSON.stringify(failed).includes("sensitive"));
});
