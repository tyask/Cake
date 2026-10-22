import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PayPayImportInput, PayPayImportItem } from "../lib/paypay-import";

/** Already connected, dedicated sessions. The caller owns connection/identity validation and close. */
export type CsvCategoryDatabase = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};
type Statement = { query: string; params: unknown[] };
type CapturedImport = { queries: Statement[]; batchId: string; queryHashes: string[] };
type Counts = { workspaces: number; workspace_members: number; categories: number; transactions: number; import_batches: number };
type ImportCounts = { imported: number; skipped: number };
type Stage = "preflight" | "capture" | "setup" | "holder" | "wait-observation" | "queued-operation" | "assertions" | "rollback" | "cleanup" | "report-callback" | "complete";
type Failure = { stage: Stage; code: string };
type WaitObservation = { observed: boolean; holderPid: number; waiterPid: number; active: boolean; waitEventType: string | null; seconds: number };
export type CsvCategoryCaseReport = {
  name: string; status: "running" | "passed" | "failed"; seconds: number;
  workspaceId: string | null;
  wait: WaitObservation | null; rowCounts: Counts | null; cleanup: Counts | null;
  importResults: ImportCounts[]; failures: Failure[];
};
export type CsvCategoryConcurrencyReport = {
  success: boolean; head: string; sourceSha256: string; migrationSha256: string;
  seedUsersUnchanged: boolean | null;
  ownedWorkspaceIds: string[];
  backendPids: number[]; sqlContract: { queryCount: number; queryHashes: string[]; captures: number; replays: number };
  cases: CsvCategoryCaseReport[]; failures: Failure[]; cleanup: Counts | null; seconds: number;
};
export type CsvCategoryConcurrencyOptions = {
  prefix: string; expectedHead: string; observer?: CsvCategoryDatabase;
  observeTimeoutMs?: number; lockTimeoutMs?: number; statementTimeoutMs?: number;
  /** Called after each case and again after all cleanup, including failures. Receives no SQL/error text/URLs. */
  onProgress?: (report: CsvCategoryConcurrencyReport) => void | Promise<void>;
};
type Fixture = { workspaceId: string; categoryIds: [string, string, string]; name: string };
type Settled<T> = { ok: true; value: T } | { ok: false; code: string };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const safeCode = (error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code
    : code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "SCENARIO_FAILED";
};
const settle = <T>(work: Promise<T>): Promise<Settled<T>> => work.then(value => ({ ok: true, value }), error => ({ ok: false, code: safeCode(error) }));
const emptyCounts = (): Counts => ({ workspaces: 0, workspace_members: 0, categories: 0, transactions: 0, import_batches: 0 });

/**
 * Build the actual application function in memory. Only its db() provider is replaced,
 * using a fixed fake URL and a bundle-local Neon fetch hook. No environment variables,
 * parent Neon configuration, application db cache, HTTP requests or output files are used.
 * The returned statements/parameters are the exact four queries emitted by persistPayPayImport.
 */
export async function createCsvCategoryImportCapture(): Promise<(input: PayPayImportInput) => Promise<CapturedImport>> {
  const bundled = await build({
    stdin: { resolveDir: root, sourcefile: "csv-category-capture.ts", contents: `
      import { neonConfig } from "@neondatabase/serverless";
      import { persistPayPayImport } from "./lib/paypay-import";
      let busy = false;
      export async function capture(input) {
        if (busy) throw new Error("CAPTURE_BUSY");
        busy = true;
        const previous = neonConfig.fetchFunction, batches = [];
        neonConfig.fetchFunction = async (_url, init) => {
          const body = JSON.parse(String(init.body));
          if (!Array.isArray(body.queries)) throw new Error("CAPTURE_TRANSACTION_REQUIRED");
          batches.push(body.queries);
          return new Response(JSON.stringify({ results: body.queries.map((_, index) => ({
            fields: index === body.queries.length - 1 ? [{ name: "imported_rows", dataTypeID: 23 }, { name: "skipped_rows", dataTypeID: 23 }] : [],
            rows: index === body.queries.length - 1 ? [["0", "0"]] : [], rowCount: index === body.queries.length - 1 ? 1 : 0, command: "SELECT"
          })) }), { status: 200, headers: { "Content-Type": "application/json" } });
        };
        try { await persistPayPayImport(input); if (batches.length !== 1) throw new Error("CAPTURE_SINGLE_TRANSACTION_REQUIRED"); return batches[0]; }
        finally { neonConfig.fetchFunction = previous; busy = false; }
      }
    ` },
    bundle: true, write: false, platform: "node", format: "cjs", target: "node24",
    plugins: [{ name: "offline-import-capture", setup(plugin) {
      plugin.onResolve({ filter: /^\.\/db$/ }, args => args.importer === resolve(root, "lib/paypay-import.ts")
        ? { path: "offline-db", namespace: "offline-db" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "offline-db" }, () => ({ loader: "js", resolveDir: root,
        contents: `import { neon } from "@neondatabase/serverless"; const client = neon("postgresql://qa:qa@ep-capture.neon.tech/offline"); export function db() { return client; }` }));
    } }],
  });
  const compiled = { exports: {} as { capture?: (input: PayPayImportInput) => Promise<Statement[]> } };
  new Function("module", "exports", "require", bundled.outputFiles[0].text)(compiled, compiled.exports, createRequire(import.meta.url));
  assert.equal(typeof compiled.exports.capture, "function");
  return async input => {
    const queries = await compiled.exports.capture!(input);
    assert.equal(queries.length, 4);
    assert.match(queries[0].query, /SELECT cake_assert_transaction_categories\(/);
    assert.match(queries[1].query, /INSERT INTO import_batches/);
    assert.match(queries[2].query, /INSERT INTO transactions/);
    assert.match(queries[2].query, /ON CONFLICT \(workspace_id, external_id\) DO UPDATE/);
    assert.match(queries[2].query, /cake_assert_paypay_duplicate/);
    assert.match(queries[3].query, /UPDATE import_batches/);
    const batchId = String(queries[1].params[0]);
    assert.match(batchId, /^[0-9a-f-]{36}$/);
    assert.equal(String(queries[1].params[1]), input.workspaceId);
    assert.equal(String(queries[1].params[2]), input.userId);
    assert.ok(queries[3].params.every(value => value === batchId));
    return { queries, batchId, queryHashes: queries.map(({ query }) => digest(query)) };
  };
}

/**
 * No connection is acquired here. Run only after the caller verifies the dedicated Preview DB,
 * commits its ownership check, and releases the identity advisory lock. Do not run concurrently
 * with other work on these sessions. Returns sanitized evidence even on assertion/SQL failure.
 */
export async function verifyCsvCategoryConcurrency(first: CsvCategoryDatabase, second: CsvCategoryDatabase,
  actorA: string, actorB: string, options: CsvCategoryConcurrencyOptions): Promise<CsvCategoryConcurrencyReport> {
  const started = performance.now(), report: CsvCategoryConcurrencyReport = {
    success: false, head: "", sourceSha256: "", migrationSha256: "", seedUsersUnchanged: null, ownedWorkspaceIds: [], backendPids: [],
    sqlContract: { queryCount: 4, queryHashes: [], captures: 0, replays: 0 }, cases: [], failures: [], cleanup: null, seconds: 0,
  };
  const fixtures: Fixture[] = [], observer = options.observer ?? first;
  let stage: Stage = "preflight", current: CsvCategoryCaseReport | null = null;
  let usersBefore: Record<string, unknown>[] | undefined;
  const active = new Set<CsvCategoryDatabase>();
  const pending = new Set<Promise<unknown>>();
  const sessionSettings: { client: CsvCategoryDatabase; statement: string; lock: string }[] = [];
  const observeMs = options.observeTimeoutMs ?? 8000, lockMs = options.lockTimeoutMs ?? 12000, statementMs = options.statementTimeoutMs ?? 20000;
  const recordFailure = (target: { failures: Failure[] }, at: Stage, error: unknown) => target.failures.push({ stage: at, code: safeCode(error) });
  async function publish() {
    if (!options.onProgress) return;
    try { await options.onProgress(structuredClone(report)); }
    catch { report.failures.push({ stage: "report-callback", code: "CALLBACK_FAILED" }); }
  }
  async function rollback(client: CsvCategoryDatabase) {
    if (!active.has(client)) return;
    try { await client.query("ROLLBACK"); active.delete(client); }
    catch (error) { recordFailure(report, "rollback", error); }
  }
  async function begin(client: CsvCategoryDatabase) {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED"); active.add(client);
    const index = client === first ? 0 : 1;
    assert.equal(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid), report.backendPids[index], "BACKEND_PID_CHANGED");
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
      [`${statementMs}ms`, `${lockMs}ms`, `${statementMs + 5000}ms`]);
  }
  async function commit(client: CsvCategoryDatabase) { await client.query("COMMIT"); active.delete(client); }
  async function atomic<T>(client: CsvCategoryDatabase, run: () => Promise<T>) {
    try { await begin(client); const value = await run(); await commit(client); return value; }
    finally { await rollback(client); }
  }
  async function counts(client: CsvCategoryDatabase, ids: string[]): Promise<Counts> {
    const result = emptyCounts();
    for (const table of Object.keys(result) as (keyof Counts)[]) {
      const key = table === "workspaces" ? "id" : "workspace_id";
      result[table] = Number((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${key}=ANY($1::uuid[])`, [ids])).rows[0].count);
    }
    return result;
  }
  async function cleanup(fixture: Fixture) {
    await atomic(first, async () => {
      await first.query("DELETE FROM workspaces WHERE id=$1::uuid AND name=$2 AND owner_user_id=$3", [fixture.workspaceId, fixture.name, actorA]);
    });
    const remaining = await counts(first, [fixture.workspaceId]);
    assert.deepEqual(remaining, emptyCounts());
    return remaining;
  }
  async function state(fixture: Fixture, client = first) {
    return (await client.query(`SELECT jsonb_build_object(
      'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1::uuid),
      'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id) FROM workspace_members m WHERE workspace_id=$1::uuid),
      'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM categories c WHERE workspace_id=$1::uuid),
      'transactions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY external_id) FROM transactions t WHERE workspace_id=$1::uuid),
      'batches',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM import_batches b WHERE workspace_id=$1::uuid)
    ) AS snapshot`, [fixture.workspaceId])).rows[0].snapshot;
  }
  async function transactionRows(fixture: Fixture, client = first) {
    return (await client.query("SELECT to_jsonb(t) AS snapshot FROM transactions t WHERE workspace_id=$1::uuid ORDER BY external_id", [fixture.workspaceId]))
      .rows.map(row => row.snapshot as Record<string, unknown>);
  }
  async function setup(index: number): Promise<Fixture> {
    const fixture: Fixture = { workspaceId: randomUUID(), categoryIds: [randomUUID(), randomUUID(), randomUUID()], name: `${options.prefix}-${index}` };
    fixtures.push(fixture); report.ownedWorkspaceIds.push(fixture.workspaceId);
    await atomic(first, async () => {
      await first.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES($1::uuid,$2,'SHARED',$3)", [fixture.workspaceId, fixture.name, actorA]);
      await first.query("INSERT INTO workspace_members(workspace_id,user_id,role,weight) VALUES($1::uuid,$2,'OWNER',6),($1::uuid,$3,'MEMBER',4)", [fixture.workspaceId, actorA, actorB]);
      for (const [index, id] of fixture.categoryIds.entries()) await first.query(`INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by)
        VALUES($1::uuid,$2::uuid,$3,'#f97316',$4,$5,$5)`, [id, fixture.workspaceId, `並行QAカテゴリ${index + 1}`, index, actorA]);
    });
    return fixture;
  }
  function item(fixture: Fixture, suffix = "same", categoryId: string | null = fixture.categoryIds[0]): PayPayImportItem {
    return { occurredAt: "2026-10-22T03:00:42.000Z", merchant: `${options.prefix}-${suffix}`, method: "PayPay残高", amountYen: 1201,
      externalId: suffix, actorUserId: actorB, expenseClass: "SHARED", splitWeights: { [actorA]: 6, [actorB]: 4 }, categoryId };
  }
  let capture: Awaited<ReturnType<typeof createCsvCategoryImportCapture>>;
  async function prepare(fixture: Fixture, items: PayPayImportItem[], userId = actorB) {
    stage = "capture";
    const captured = await capture({ workspaceId: fixture.workspaceId, userId, fileName: `${options.prefix}.csv`, totalRows: items.length, items });
    report.sqlContract.captures++;
    if (!report.sqlContract.queryHashes.length) report.sqlContract.queryHashes = captured.queryHashes;
    else assert.deepEqual(captured.queryHashes, report.sqlContract.queryHashes);
    return captured;
  }
  async function replay(client: CsvCategoryDatabase, captured: CapturedImport): Promise<ImportCounts> {
    report.sqlContract.replays++;
    let rows: Record<string, unknown>[] = [];
    for (const statement of captured.queries) rows = (await client.query(statement.query, statement.params)).rows;
    assert.equal(rows.length, 1);
    return { imported: Number(rows[0].imported_rows), skipped: Number(rows[0].skipped_rows) };
  }
  async function mutate(client: CsvCategoryDatabase, fixture: Fixture, operation: "delete" | "archive" | "membership") {
    if (operation === "delete") await client.query("SELECT cake_delete_category($1::uuid,$2,$3::uuid)", [fixture.workspaceId, actorA, fixture.categoryIds[0]]);
    else if (operation === "archive") await client.query("SELECT cake_mutate_category_with_ancestors($1::uuid,$2,'ARCHIVE',$3::uuid,NULL::uuid,NULL,NULL,NULL::uuid)", [fixture.workspaceId, actorA, fixture.categoryIds[0]]);
    else {
      // Membership has no current application removal endpoint. Use the same workspace-first
      // lock order as category operations, then remove only this fixture's B membership.
      await client.query("UPDATE workspaces SET updated_at=now() WHERE id=$1::uuid", [fixture.workspaceId]);
      assert.equal((await client.query("DELETE FROM workspace_members WHERE workspace_id=$1::uuid AND user_id=$2 RETURNING user_id", [fixture.workspaceId, actorB])).rows.length, 1);
    }
  }
  async function observe(holderPid: number, waiterPid: number): Promise<WaitObservation> {
    const at = performance.now(); stage = "wait-observation";
    do {
      await observer.query("SELECT pg_stat_clear_snapshot()");
      const row = (await observer.query(`SELECT state,wait_event_type,$1::int=ANY(pg_blocking_pids(pid)) AS blocked
        FROM pg_stat_activity WHERE pid=$2::int`, [holderPid, waiterPid])).rows[0];
      if (row?.blocked === true && row.state === "active" && row.wait_event_type === "Lock") {
        return { observed: true, holderPid, waiterPid, active: true, waitEventType: "Lock", seconds: (performance.now() - at) / 1000 };
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (performance.now() - at < observeMs);
    assert.fail("LOCK_WAIT_NOT_OBSERVED");
  }
  async function competing<T>(runQueued: () => Promise<T>): Promise<Settled<T>> {
    const outcome = settle(atomic(second, runQueued)); pending.add(outcome);
    const at = performance.now();
    current!.wait = { observed: false, holderPid: report.backendPids[0], waiterPid: report.backendPids[1], active: false, waitEventType: null, seconds: 0 };
    try {
      current!.wait = await observe(report.backendPids[0], report.backendPids[1]);
      await commit(first); stage = "queued-operation";
      return await outcome;
    } finally {
      if (!current!.wait.observed) current!.wait.seconds = (performance.now() - at) / 1000;
      await rollback(first);
      await outcome;
      pending.delete(outcome);
    }
  }
  async function check(name: string, run: (fixture: Fixture) => Promise<void>) {
    const at = performance.now();
    const entry: CsvCategoryCaseReport = { name, status: "running", seconds: 0, workspaceId: null, wait: null, rowCounts: null, cleanup: null, importResults: [], failures: [] };
    report.cases.push(entry); current = entry;
    let fixture: Fixture | undefined;
    try {
      stage = "setup"; fixture = await setup(report.cases.length);
      await run(fixture); stage = "assertions";
      entry.rowCounts = await counts(first, [fixture.workspaceId]);
      entry.status = "passed";
    } catch (error) { entry.status = "failed"; recordFailure(entry, stage, error); throw new Error("CASE_FAILED"); }
    finally {
      await rollback(first); await rollback(second);
      fixture ??= fixtures[fixtures.length - 1];
      if (fixture) entry.workspaceId = fixture.workspaceId;
      if (fixture && !entry.rowCounts) try { entry.rowCounts = await counts(first, [fixture.workspaceId]); }
      catch (error) { recordFailure(entry, "assertions", error); }
      if (fixture) try { stage = "cleanup"; entry.cleanup = await cleanup(fixture); }
      catch (error) { entry.status = "failed"; recordFailure(entry, "cleanup", error); }
      entry.seconds = (performance.now() - at) / 1000; current = null;
      await publish();
    }
    assert.equal(entry.status, "passed");
  }
  try {
    assert.match(options.prefix, /^verify-csv-category-[a-zA-Z0-9-]{1,40}$/);
    assert.match(options.expectedHead, /^[a-f0-9]{40}$/);
    report.head = options.expectedHead;
    assert.ok(actorA && actorB && actorA !== actorB);
    assert.ok(observeMs >= 1000 && observeMs < lockMs && lockMs < statementMs && statementMs <= 60000);
    const source = await readFile(resolve(root, "lib/paypay-import.ts"), "utf8"), migration = await readFile(resolve(root, "db/migrations/018_import_categories.sql"), "utf8");
    report.sourceSha256 = digest(source); report.migrationSha256 = digest(migration);
    const clients = options.observer ? [first, second, observer] : [first, second];
    for (const client of clients) report.backendPids.push(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    assert.equal(new Set(report.backendPids).size, clients.length);
    // Check every session from another backend: its own observation SELECT would hide
    // an already-open caller transaction behind state=active.
    for (const [index, client] of clients.entries()) {
      const monitor = client === first ? second : first;
      const connectionState = (await monitor.query("SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1::int", [report.backendPids[index]])).rows[0];
      assert.equal(connectionState.state, "idle", "CALLER_SESSIONS_MUST_BE_IDLE");
      assert.equal(connectionState.xact_start, null, "CALLER_TRANSACTIONS_MUST_BE_CLOSED");
    }
    assert.equal((await observer.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND granted) AS held", [report.backendPids])).rows[0].held, false);
    for (const client of clients) {
      const settings = (await client.query("SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock")).rows[0];
      sessionSettings.push({ client, statement: String(settings.statement), lock: String(settings.lock) });
      await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)", [`${statementMs}ms`, `${lockMs}ms`]);
    }
    usersBefore = (await first.query("SELECT to_jsonb(u) AS snapshot FROM app_users u WHERE id=ANY($1::text[]) ORDER BY id", [[actorA, actorB]])).rows;
    assert.equal(usersBefore.length, 2);
    stage = "capture"; capture = await createCsvCategoryImportCapture();

    for (const [operation, label] of [["delete", "カテゴリ削除"], ["archive", "カテゴリ停止"], ["membership", "所属解除"]] as const) {
      await check(`${label}先行: 待機した取込を拒否しbatch・全明細をrollbackする`, async fixture => {
        const captured = await prepare(fixture, [item(fixture, "a-first", fixture.categoryIds[1]), item(fixture, "z-target")]);
        stage = "holder"; await begin(first); await mutate(first, fixture, operation);
        const expected = await state(fixture);
        const outcome = await competing(() => replay(second, captured));
        stage = "assertions"; assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.equal(outcome.code, "P0001");
        assert.deepEqual(await state(fixture), expected, "FAILED_IMPORT_MUST_ROLLBACK_ALL_WRITES");
        const rowCounts = await counts(first, [fixture.workspaceId]);
        assert.equal(rowCounts.transactions, 0); assert.equal(rowCounts.import_batches, 0);
      });
      await check(`取込先行: ${label}を待機させ保存後の整合した値を維持する`, async fixture => {
        const captured = await prepare(fixture, [item(fixture)]);
        stage = "holder"; await begin(first);
        const imported = await replay(first, captured); current!.importResults.push(imported);
        assert.deepEqual(imported, { imported: 1, skipped: 0 });
        const before = await transactionRows(fixture);
        assert.equal(before[0].category_id, fixture.categoryIds[0]); assert.equal(before[0].category_confirmed, true); assert.equal(before[0].category_revision, 1);
        const outcome = await competing(() => mutate(second, fixture, operation));
        stage = "assertions"; assert.equal(outcome.ok, true);
        const after = await transactionRows(fixture);
        if (operation === "delete") {
          assert.equal(after[0].category_id, null); assert.equal(after[0].category_confirmed, false); assert.equal(after[0].category_revision, 2);
          const business = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["category_id", "category_confirmed", "category_revision", "updated_by", "updated_at"].includes(key)));
          assert.deepEqual(after.map(business), before.map(business));
        } else assert.deepEqual(after, before, "ARCHIVE_OR_MEMBERSHIP_CHANGE_MUST_KEEP_ALL_TRANSACTION_COLUMNS");
        const rowCounts = await counts(first, [fixture.workspaceId]);
        assert.equal(rowCounts.transactions, 1); assert.equal(rowCounts.import_batches, 1);
        if (operation === "membership") assert.equal(rowCounts.workspace_members, 1);
        if (operation === "archive") assert.equal((await first.query("SELECT archived_at IS NOT NULL AS archived FROM categories WHERE workspace_id=$1::uuid AND id=$2::uuid", [fixture.workspaceId, fixture.categoryIds[0]])).rows[0].archived, true);
      });
    }
    await check("同一外部IDの同時取込: 先行1件・後続skip1件で全保存列を維持する", async fixture => {
      const original = item(fixture), firstBatch = await prepare(fixture, [original]);
      const duplicate = await prepare(fixture, [{ ...original, method: "後続の別方法", actorUserId: actorA, splitWeights: { [actorA]: 1, [actorB]: 1 }, categoryId: fixture.categoryIds[1] }], actorA);
      stage = "holder"; await begin(first);
      const firstResult = await replay(first, firstBatch); current!.importResults.push(firstResult);
      assert.deepEqual(firstResult, { imported: 1, skipped: 0 });
      const before = await transactionRows(fixture);
      const outcome = await competing(() => replay(second, duplicate)); stage = "assertions";
      assert.equal(outcome.ok, true);
      if (outcome.ok) { assert.deepEqual(outcome.value, { imported: 0, skipped: 1 }); current!.importResults.push(outcome.value); }
      assert.deepEqual(await transactionRows(fixture), before);
      assert.equal((await counts(first, [fixture.workspaceId])).import_batches, 2);
    });
    await check("同一外部IDの金額衝突: 後続batchと先にINSERTした別明細も全rollbackする", async fixture => {
      const original = item(fixture, "z-collision"), firstBatch = await prepare(fixture, [original]);
      const conflict = await prepare(fixture, [{ ...original, amountYen: original.amountYen + 1 }, item(fixture, "a-before-collision", fixture.categoryIds[1])]);
      stage = "holder"; await begin(first);
      current!.importResults.push(await replay(first, firstBatch)); const expected = await state(fixture);
      const outcome = await competing(() => replay(second, conflict)); stage = "assertions";
      assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.code, "P0001");
      assert.deepEqual(await state(fixture), expected);
      const rowCounts = await counts(first, [fixture.workspaceId]); assert.equal(rowCounts.transactions, 1); assert.equal(rowCounts.import_batches, 1);
    });
    await check("逆順入力の複数カテゴリbatch: 同じキー順で待機し後続を全件skipする", async fixture => {
      const items = [item(fixture, "a", fixture.categoryIds[2]), item(fixture, "b", null), item(fixture, "c", fixture.categoryIds[0])];
      const firstBatch = await prepare(fixture, [...items].reverse()), secondBatch = await prepare(fixture, items);
      const keys = (captured: CapturedImport) => (JSON.parse(String(captured.queries[2].params[4])) as PayPayImportItem[]).map(row => row.externalId);
      assert.deepEqual(keys(firstBatch), keys(secondBatch));
      stage = "holder"; await begin(first);
      const imported = await replay(first, firstBatch); current!.importResults.push(imported); assert.deepEqual(imported, { imported: 3, skipped: 0 });
      const before = await transactionRows(fixture);
      const outcome = await competing(() => replay(second, secondBatch)); stage = "assertions";
      assert.equal(outcome.ok, true); if (outcome.ok) { assert.deepEqual(outcome.value, { imported: 0, skipped: 3 }); current!.importResults.push(outcome.value); }
      assert.deepEqual(await transactionRows(fixture), before);
      assert.deepEqual(before.map(row => [row.category_id, row.category_confirmed, row.category_revision]), [[fixture.categoryIds[2], true, 1], [null, false, 0], [fixture.categoryIds[0], true, 1]]);
    });
    stage = "assertions";
    assert.equal(digest(await readFile(resolve(root, "lib/paypay-import.ts"), "utf8")), report.sourceSha256);
    assert.equal(digest(await readFile(resolve(root, "db/migrations/018_import_categories.sql"), "utf8")), report.migrationSha256);
    stage = "complete";
  } catch (error) {
    const caseFailure = report.cases.at(-1)?.failures[0];
    if (caseFailure) report.failures.push({ ...caseFailure }); else recordFailure(report, stage, error);
  }
  finally {
    await rollback(first); await rollback(second);
    await Promise.allSettled([...pending]);
    for (const fixture of fixtures) try { await cleanup(fixture); } catch (error) { recordFailure(report, "cleanup", error); }
    try { report.cleanup = fixtures.length ? await counts(first, fixtures.map(fixture => fixture.workspaceId)) : emptyCounts(); assert.deepEqual(report.cleanup, emptyCounts()); }
    catch (error) { recordFailure(report, "cleanup", error); }
    if (usersBefore) try {
      assert.deepEqual((await first.query("SELECT to_jsonb(u) AS snapshot FROM app_users u WHERE id=ANY($1::text[]) ORDER BY id", [[actorA, actorB]])).rows, usersBefore);
      report.seedUsersUnchanged = true;
    } catch (error) { report.seedUsersUnchanged = false; recordFailure(report, "cleanup", error); }
    for (const settings of sessionSettings) try {
      await settings.client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)", [settings.statement, settings.lock]);
    } catch (error) { recordFailure(report, "cleanup", error); }
    report.seconds = (performance.now() - started) / 1000;
    report.success = stage === "complete" && report.failures.length === 0 && report.cases.length === 9 && report.cases.every(entry => entry.status === "passed");
    await publish();
    // A final reporting failure must not leave success=true in the returned value.
    if (report.failures.length) report.success = false;
  }
  return report;
}
