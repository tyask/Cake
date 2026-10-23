import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { appTables } from '../scripts/production-db-migration-inventory';
import { productionSchemaPostconditions, productionSchemaSetupRace, productionSchemaSnapshot,
  verifyProductionSchemaScenarios, type ProductionSchemaMigration } from '../scripts/production-db-schema-scenarios';
import type { MerchantMigrationDatabase } from '../scripts/merchant-normalization-migration-scenario';

const migrationDirectory = new URL('../db/migrations/', import.meta.url);
const migrationName = '019_merchant_normalization.sql';
async function migration(): Promise<ProductionSchemaMigration> {
  const sql = await readFile(new URL(migrationName, migrationDirectory), 'utf8');
  return { name: migrationName, sql, sha256: createHash('sha256').update(sql).digest('hex') };
}
async function previousNames() {
  return (await readdir(migrationDirectory)).filter(name => /^0(?:0[1-9]|1[0-8])_/.test(name)).sort();
}
function database(db: PGlite): MerchantMigrationDatabase {
  return { async query(text, params) {
    if (params) return db.query(text, params);
    const result = await db.exec(text); return { rows: result.at(-1)?.rows as Record<string, unknown>[] ?? [] };
  } };
}

async function fixtures(db: PGlite) {
  for (const name of appTables) {
    if (name === 'schema_migrations') {
      await db.exec('CREATE TABLE public.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of await previousNames()) await db.query(`INSERT INTO public.schema_migrations VALUES ($1,'2026-10-01 01:02:03.123456+00')`, [name]);
    } else if (name === 'transactions') {
      await db.exec(`CREATE TABLE public.transactions(id int PRIMARY KEY,workspace_id uuid NOT NULL,merchant text NOT NULL,
        memo text NOT NULL,created_at timestamptz NOT NULL);
        INSERT INTO public.transactions VALUES(1,'00000000-0000-4000-8000-000000000001','  ＡＢＣ　Café  ','保存済み監査値','2026-10-01 01:02:03.654321+00')`);
    } else await db.exec(`CREATE TABLE public.${name}(id int PRIMARY KEY,value text,created_at timestamptz NOT NULL);
      INSERT INTO public.${name} VALUES(1,'非公開の既存値','2026-10-01 01:02:03.987654+00')`);
  }
}

test('原019追加以外の13表全既存列・台帳のmicrosecond・schema/ACL/Index ownerを保持する', async t => {
  const db = new PGlite(); t.after(() => db.close()); await fixtures(db);
  const sql = database(db), source = await migration(), before = await productionSchemaSnapshot(sql);
  await db.exec(source.sql);
  await db.query('INSERT INTO public.schema_migrations(name) VALUES($1)', [source.name]);
  assert.equal(await productionSchemaPostconditions(sql), 0);
  assert.deepEqual(await productionSchemaSnapshot(sql), before);
  assert.deepEqual(before.counts, appTables.map(name => name === 'schema_migrations' ? 18 : 1));
  assert.ok(!JSON.stringify(before).includes('非公開'));
  assert.ok(Buffer.byteLength(JSON.stringify(before)) < 1000);
  await db.exec("UPDATE public.transactions SET memo='変更';");
  const changed = await productionSchemaSnapshot(sql);
  assert.notEqual(changed.hashes.data, before.hashes.data); assert.equal(changed.hashes.schema, before.hashes.schema);
  await db.exec("UPDATE public.transactions SET memo='保存済み監査値'");
  await db.query("UPDATE public.schema_migrations SET applied_at=applied_at+interval '1 microsecond' WHERE name=$1", [(await previousNames())[0]]);
  assert.notEqual((await productionSchemaSnapshot(sql)).hashes.ledger, before.hashes.ledger);
  await db.exec('CREATE INDEX existing_extra_idx ON public.transactions(memo)');
  assert.notEqual((await productionSchemaSnapshot(sql)).hashes.schema, before.hashes.schema);
  await db.exec('GRANT SELECT ON public.transactions TO PUBLIC');
  assert.notEqual((await productionSchemaSnapshot(sql)).hashes.acl, before.hashes.acl);
});

test('019のIndex列順・live/ready・関数の属性が不一致ならcommit後検査を失敗させる', async t => {
  const db = new PGlite(); t.after(() => db.close()); await fixtures(db);
  const source = await migration(), sql = database(db);
  await db.exec(source.sql); await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [source.name]);
  await db.exec(`DROP INDEX transactions_workspace_merchant_normalized_idx;
    CREATE INDEX transactions_workspace_merchant_normalized_idx ON transactions(merchant_normalized,workspace_id)`);
  await assert.rejects(productionSchemaPostconditions(sql));
  await db.exec(`DROP INDEX transactions_workspace_merchant_normalized_idx;
    CREATE INDEX transactions_workspace_merchant_normalized_idx ON transactions(workspace_id,merchant_normalized);
    ALTER FUNCTION cake_normalize_merchant(text) PARALLEL UNSAFE`);
  await assert.rejects(productionSchemaPostconditions(sql));
});

type RaceMode = 'ok' | 'wrong-lock' | 'observer-failure' | 'history-failure' | 'migration-failure';
function raceDatabase(names: string[], mode: RaceMode = 'ok') {
  const statements: string[][] = [[], [], []], seen = [false, false], settled = [false, false];
  let share = false, writer = -1, waiter = -1, applied = 0, rollbacks = 0;
  const completions: (() => void)[] = [];
  const finish = () => {
    for (const complete of completions) complete();
    completions.length = 0;
  };
  const clients = [0, 1, 2].map(index => ({ async query(text: string) {
    statements[index].push(text);
    if (index === 2) {
      if (text === 'BEGIN') return { rows: [] };
      if (text.startsWith('LOCK TABLE')) {
        if (mode === 'observer-failure') throw { code: '42501', message: 'private role and SQL' };
        share = true; return { rows: [] };
      }
      if (text === 'COMMIT' || text === 'ROLLBACK') { share = false; if (text === 'ROLLBACK') rollbacks++; finish(); return { rows: [] }; }
      if (text.startsWith('SELECT holder.pid')) {
        return { rows: writer >= 0 && waiter >= 0 ? [{ writer: 101 + writer, waiter: 101 + waiter,
          observer_blocks: true, writer_blocks: true, ddl: true, share: mode !== 'wrong-lock', advisory: true }] : [] };
      }
      return { rows: [] };
    }
    if (text === 'SELECT name FROM schema_migrations ORDER BY name') {
      seen[index] = true;
      if (mode === 'history-failure' && index === 1) throw { code: '08006', query: 'private data' };
      return { rows: names.map(name => ({ name })) };
    }
    if (text.includes('019_merchant_normalization.sql')) {
      assert.deepEqual(seen, [true, true], 'both histories must finish before either migration starts');
      assert.equal(share, true, 'the observer must hold its table lock before setup is released');
      if (writer < 0) writer = index; else waiter = index;
      await new Promise<void>((resolve, reject) => completions.push(() => {
        settled[index] = true;
        if (mode === 'migration-failure' && index === writer) reject({ code: '53100', message: 'private SQL' });
        else { if (applied === 0) applied++; resolve(); }
      }));
    }
    return { rows: [] };
  } }));
  return { clients, statements, settled, state: () => ({ share, writer, waiter, applied, rollbacks }) };
}

test('実setupDatabase原文を2回呼び、両018履歴barrier→SHARE→DDL/advisory競合→1回適用を検証する', async () => {
  const names = await previousNames(), source = await migration(), db = raceDatabase(names);
  const [first, second, observer] = db.clients;
  const report = await productionSchemaSetupRace(first, second, observer, source, [101, 102, 103], { names, observeMs: 1000 });
  assert.deepEqual(report.queries, [3, 3]); assert.deepEqual(report.reads, [1, 1]);
  assert.equal(report.ddl, true); assert.equal(report.advisory, true); assert.deepEqual(db.settled, [true, true]);
  assert.equal(db.state().share, false); assert.equal(db.state().applied, 1);
  for (const calls of db.statements.slice(0, 2)) assert.ok(calls[2].includes(source.sql), 'raw 019 is embedded without rewriting');
});

for (const mode of ['wrong-lock', 'observer-failure', 'history-failure', 'migration-failure'] as const) {
  test(`競合検証の${mode}でもbarrier/observer lockを解放し全pendingをsettleする`, async () => {
    const names = await previousNames(), db = raceDatabase(names, mode), [first, second, observer] = db.clients;
    await assert.rejects(productionSchemaSetupRace(first, second, observer, await migration(), [101, 102, 103], { names, observeMs: 50 }));
    assert.equal(db.state().share, false);
    if (mode === 'wrong-lock' || mode === 'migration-failure') assert.deepEqual(db.settled, [true, true]);
    else {
      assert.equal(db.state().applied, 0);
      assert.ok(db.statements.slice(0, 2).every(calls => !calls.some(text => text.includes('019_merchant_normalization.sql'))));
    }
  });
}

test('不正migration/sessionはSQL前に拒否し、SQLSTATE以外の例外・原文・接続値を出力しない', async () => {
  const source = await migration(); let calls = 0;
  const client = (): MerchantMigrationDatabase => ({ async query() { calls++; throw { code: '28P01', message: 'private password and values', query: source.sql }; } });
  const [first, second, observer] = [client(), client(), client()];
  for (const invalid of [{ ...source, name: '020_unknown.sql' }, { ...source, sql: `${source.sql}\n-- changed` }, { ...source, sha256: 'bad' }]) {
    const report = await verifyProductionSchemaScenarios(first, second, observer, invalid);
    assert.equal(report.success, false); assert.deepEqual(report.failures, [{ stage: 'pre', sqlstate: null }]);
  }
  assert.equal(calls, 0);
  assert.equal((await verifyProductionSchemaScenarios(first, first, observer, source)).success, false);
  assert.equal(calls, 0);
  const report = await verifyProductionSchemaScenarios(first, second, observer, source);
  assert.deepEqual(report.failures, [{ stage: 'pre', sqlstate: '28P01' }]);
  assert.equal(report.success, false); assert.equal(report.restored, false); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(report).includes('private')); assert.ok(!JSON.stringify(report).includes(source.sql));
});
