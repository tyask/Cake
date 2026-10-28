import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findHome } from "../../lib/server/stores/home-store";
import { UserAccessError } from "../../lib/server/errors";
import { transactionsInMonth, workspaceCashflowSummary } from "../../lib/shared/home-summary";
import { calculateSettlement } from "../../lib/shared/settlement";
import type { TransactionRecord } from "../../lib/shared/types";
import { analyticsAllocationCases } from "../shared/fixtures/analytics-allocation-cases";

test("ホームの実SQLは月次収支と全期間清算を一つの認可済snapshotから小さな応答にする", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const migrations = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  const a = "test-user-a", b = "test-user-b", outside = "home-outside";
  await memory.query(`INSERT INTO app_users(id,email,name,is_enabled) VALUES
    ($1,'test-a@cake.local','A',true),($2,'test-b@cake.local','B',true),($3,'home-outside@example.test','Outside',true)`, [a, b, outside]);
  const workspaceId = randomUUID(), personalId = randomUUID(), otherId = randomUUID();
  await memory.query(`INSERT INTO workspaces(id,name,type,owner_user_id) VALUES
    ($1,'ホーム対象','SHARED',$4),($2,'個人','PERSONAL',$4),($3,'他人','PERSONAL',$5)`, [workspaceId, personalId, otherId, a, outside]);
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES
    ($1,$4,'OWNER','2026-01-01T00:00Z'),($1,$5,'MEMBER','2026-01-02T00:00Z'),
    ($2,$4,'OWNER','2026-01-01T00:00Z'),($3,$6,'OWNER','2026-01-01T00:00Z')`, [workspaceId, personalId, otherId, a, b, outside]);

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/home";
  process.env.DB_QUERY_LOG = "off";
  t.after(() => {
    neonConfig.fetchFunction = previous.fetch;
    if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url;
    if (previous.logging === undefined) delete process.env.DB_QUERY_LOG; else process.env.DB_QUERY_LOG = previous.logging;
  });
  const queries: { query: string; params: string[] }[] = [];
  neonConfig.fetchFunction = async (_url: RequestInfo | URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; params: string[] };
    queries.push(body);
    const result = await memory.query<Record<string, unknown>>(body.query, body.params);
    return Response.json({ fields: result.fields, rows: result.rows.map(row => result.fields.map(field => {
      const value = row[field.name];
      return value == null ? null : typeof value === "object" ? JSON.stringify(value) : String(value);
    })) });
  };
  const members = [{ id: a, name: "A", weight: 1 }, { id: b, name: "B", weight: 1 }];
  const read = async (workspace = workspaceId, user = a, month = "2026-10") => {
    const count = queries.length;
    const result = await findHome(workspace, user, month);
    assert.equal(queries.length - count, 1, "認可・月次・清算・履歴は固定1SQL");
    return result;
  };
  type Options = { date?: string; actor?: string; type?: "PAYMENT" | "RECEIPT"; personal?: boolean; settled?: boolean; workspace?: string };
  const insert = async (amountYen: number, splitWeights: Record<string, number>, options: Options = {}): Promise<TransactionRecord> => {
    const id = randomUUID(), actor = options.actor ?? a, date = options.date ?? "2026-10-15T00:00:00Z";
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,settled_at)
      VALUES($1::uuid,$2,$3,'応答に含めない取引先','現金',$4,$5,$6,$7,$8::jsonb,$1::text,'MANUAL',$6,$6,$9)`,
    [id, options.workspace ?? workspaceId, date, options.type ?? "PAYMENT", amountYen, actor,
      options.personal ? "PERSONAL" : "SHARED", JSON.stringify(splitWeights), options.settled ? "2026-10-20T00:00Z" : null]);
    return { id, occurredAt: date, merchant: "応答に含めない取引先", method: "現金", type: options.type ?? "PAYMENT", amountYen,
      actorUserId: actor, actorName: actor === a ? "A" : "B", expenseClass: options.personal ? "PERSONAL" : "SHARED", splitWeights,
      settledAt: options.settled ? "2026-10-20T00:00:00Z" : null, memo: "", externalId: id, source: "MANUAL",
      categoryId: null, categoryConfirmed: false, categoryRevision: 0 };
  };
  const totals = (value: { paymentTotal: bigint; receiptTotal: bigint; balanceYen: bigint }) =>
    Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, String(amount)]));

  await t.test("清算済み・未来日付・JST月境界と個人収支を従来のホーム計算と一致させる", async () => {
    const entries = await Promise.all([
      insert(1, { [a]: 1, [b]: 1 }, { date: "2026-09-30T14:59:59.999999Z", settled: true }),
      insert(101, { [a]: 1, [b]: 1 }, { date: "2026-09-30T15:00:00Z", settled: true }),
      insert(100, { [a]: 1, [b]: 2 }, { date: "2026-10-31T14:59:59.999999Z", type: "RECEIPT", actor: b }),
      insert(700, { [a]: 1, [b]: 1 }, { date: "2026-10-31T15:00:00Z" }),
      insert(55, { [a]: 0, [b]: 1 }, { actor: b, personal: true }),
      insert(200, { [a]: 1, [b]: 0 }, { personal: true, type: "RECEIPT" }),
      insert(33, { [a]: 0, [b]: 1 }, { date: "2035-05-10T00:00Z", actor: b }),
    ]);
    const result = await read();
    const expected = workspaceCashflowSummary(transactionsInMonth(entries, "2026-10"), members);
    assert.deepEqual(result.monthly, {
      people: members.map(member => ({ userId: member.id, ...totals(expected.people.get(member.id)!) })),
      total: totals(expected.total),
    });
    const calculation = calculateSettlement(members, entries)!;
    const { transactionIds, ...expectedSettlement } = calculation;
    assert.equal(transactionIds.length, 3);
    assert.deepEqual(result.settlement, expectedSettlement);
    assert.deepEqual(result.unsettled, { count: 3, paymentTotal: "733", receiptTotal: "100", balanceYen: "-633" });
    const future = await read(workspaceId, a, "2035-05");
    assert.equal(future.monthly.total.paymentTotal, "33");
    assert.deepEqual(future.settlement, result.settlement, "選択月は全期間清算を変えない");
    await memory.query("DELETE FROM transactions");
  });

  await t.test("共有の最大剰余配分は支出・収入とも共通fixtureと一致し、個人workspaceも扱う", async () => {
    for (const fixture of analyticsAllocationCases) {
      const single = fixture.weights.length === 1, workspace = single ? personalId : workspaceId;
      const selectedMembers = single ? members.slice(0, 1) : members;
      const weights = Object.fromEntries(selectedMembers.map((member, index) => [member.id, fixture.weights[index]]));
      const entries = [
        await insert(fixture.amount, weights, { workspace, settled: true }),
        await insert(fixture.amount, weights, { workspace, settled: true, type: "RECEIPT", actor: single ? a : b }),
      ];
      const result = await read(workspace);
      const expected = workspaceCashflowSummary(entries, selectedMembers);
      assert.deepEqual(result.monthly.people, selectedMembers.map(member => ({ userId: member.id, ...totals(expected.people.get(member.id)!) })), fixture.name);
      assert.deepEqual(result.monthly.total, totals(expected.total));
      assert.equal(result.settlement, null);
      await memory.query("DELETE FROM transactions");
    }
  });

  await t.test("1円ずつの月次配分と合計して最後に丸める清算を区別し、参加順で同率端数を配る", async () => {
    await insert(1, { [a]: 1, [b]: 1 });
    await insert(1, { [a]: 1, [b]: 1 });
    const first = await read();
    assert.deepEqual(first.monthly.people.map(person => person.paymentTotal), ["2", "0"]);
    assert.deepEqual(first.settlement?.people.map(person => person.target), [1, 1]);
    await memory.query("UPDATE workspace_members SET joined_at=CASE WHEN user_id=$2 THEN '2025-01-01T00:00Z'::timestamptz ELSE '2026-01-01T00:00Z'::timestamptz END WHERE workspace_id=$1", [workspaceId, b]);
    const second = await read();
    assert.deepEqual(second.members.map(member => member.id), [b, a]);
    assert.deepEqual(second.monthly.people.map(person => person.paymentTotal), ["2", "0"]);
    await memory.query("UPDATE workspace_members SET joined_at='2026-01-01T00:00Z' WHERE workspace_id=$1", [workspaceId]);
    assert.deepEqual((await read()).members.map(member => member.id), [a, b]);
    await memory.query("DELETE FROM transactions");
  });

  await t.test("空月・最小年・最大年・うるう月の全月を正しく検索する", async () => {
    for (const month of ["0001-01", "1880-01", "2024-02", "9999-12"]) {
      const empty = await read(workspaceId, a, month);
      assert.deepEqual(empty.monthly.total, { paymentTotal: "0", receiptTotal: "0", balanceYen: "0" });
      assert.deepEqual(empty.unsettled, { count: 0, paymentTotal: "0", receiptTotal: "0", balanceYen: "0" });
      await insert(11, { [a]: 1, [b]: 1 }, { date: `${month}-01T00:00:00+09:00`, settled: true });
      const result = await read(workspaceId, a, month);
      assert.equal(result.monthly.total.paymentTotal, "11", month);
      if (month === "2024-02") {
        await insert(12, { [a]: 1, [b]: 1 }, { date: "2024-02-29T14:59:59.999999Z", settled: true });
        await insert(13, { [a]: 1, [b]: 1 }, { date: "2024-02-29T15:00:00Z", settled: true });
        assert.equal((await read(workspaceId, a, month)).monthly.total.paymentTotal, "23");
      }
      await memory.query("DELETE FROM transactions");
    }
  });

  await t.test("履歴は最新20件に限定し、対象明細や清算ID配列を応答へ含めない", async () => {
    for (let day = 1; day <= 25; day++) {
      await memory.query(`INSERT INTO settlements(id,workspace_id,payer_user_id,payee_user_id,amount_yen,
        weight_snapshot,calculation_snapshot,completed_by,completed_at)
        VALUES($1,$2,$3,$4,$5,'{}','{}',$3,$6)`,
      [randomUUID(), workspaceId, a, b, day, `2026-10-${String(day).padStart(2, "0")}T00:00:00.123456Z`]);
    }
    const entry = await insert(3, { [a]: 1, [b]: 2 });
    const result = await read();
    assert.equal(result.settlementHistory.length, 20);
    assert.deepEqual(result.settlementHistory.map(history => history.amountYen), Array.from({ length: 20 }, (_, index) => 25 - index));
    assert.equal(result.settlementHistory[0].completedAt, "2026-10-25T00:00:00.123Z");
    const encoded = JSON.stringify(result);
    assert.doesNotMatch(encoded, new RegExp(entry.id));
    assert.doesNotMatch(encoded, /transactionIds|transactions|splitWeights|merchant|応答に含めない取引先/);
    await memory.query("DELETE FROM transactions");
  });

  await t.test("履歴明細を増やしても月次SQLは範囲検索し、ブラウザ応答へ明細が増えない", async () => {
    await insert(100, { [a]: 1, [b]: 2 });
    const before = await read();
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,settled_at)
      SELECT gen_random_uuid(),$1,'2000-01-01T00:00Z','過去の大量明細','現金','PAYMENT',100,
        $2,'SHARED',$3::jsonb,'old-'||seq,'MANUAL',$2,$2,'2000-01-02T00:00Z'
      FROM generate_series(1,1500) seq`, [workspaceId, a, JSON.stringify({ [a]: 1, [b]: 2 })]);
    const after = await read();
    assert.deepEqual(after, before, "範囲外・清算済み1500明細は応答量にも値にも影響しない");
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by)
      SELECT gen_random_uuid(),$1,'1999-01-01T00:00Z','未清算の大量明細','現金','PAYMENT',1,
        $2,'SHARED',$3::jsonb,'pending-'||seq,'MANUAL',$2,$2
      FROM generate_series(1,1000) seq`, [workspaceId, a, JSON.stringify({ [a]: 1, [b]: 1 })]);
    const pending = await read();
    assert.equal(pending.unsettled.count, 1001);
    assert.deepEqual(pending.monthly, before.monthly);
    assert.equal(pending.settlement?.people[0].target, 533);
    assert.ok(JSON.stringify(pending).length - JSON.stringify(before).length < 100, "未清算1000件の増加は集計値の桁数だけ変える");
    const query = queries.at(-1)!.query;
    assert.match(query, /t\.occurred_at >= \(SELECT start_at FROM month_bounds\)/);
    assert.match(query, /t\.occurred_at < \(SELECT end_at FROM month_bounds\)/);
    assert.match(query, /t\.expense_class = 'SHARED' AND t\.settled_at IS NULL/);
    assert.doesNotMatch(query, /\bmerchant\b|\bmemo\b|\bexternal_id\b|\bsource\b|\bcategory_id\b/);
    await memory.query("DELETE FROM transactions");
  });

  await t.test("現在の利用停止・所属なし・不存在workspaceを区別して拒否する", async () => {
    await assert.rejects(read(workspaceId, outside), error => error instanceof UserAccessError && error.status === 403);
    await assert.rejects(read(otherId), error => error instanceof UserAccessError && error.status === 403);
    await assert.rejects(read(randomUUID()), error => error instanceof UserAccessError && error.status === 403);
    await memory.query("UPDATE app_users SET is_enabled=false WHERE id=$1", [a]);
    try { await assert.rejects(read(), error => error instanceof UserAccessError && error.status === 401); }
    finally { await memory.query("UPDATE app_users SET is_enabled=true WHERE id=$1", [a]); }
  });

  await t.test("不正な保存割合を正常な集計値として返さない", async () => {
    const entry = await insert(2, { [a]: 1, [b]: 1 }, { settled: true });
    await memory.query("UPDATE transactions SET split_weights=$2::jsonb WHERE id=$1", [entry.id, JSON.stringify({ [a]: 0, [b]: 0 })]);
    await assert.rejects(read(), /保存済み負担割合が不正/);
  });
});
