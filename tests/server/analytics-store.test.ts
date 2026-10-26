import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { neonConfig } from "@neondatabase/serverless";
import { findAnalytics } from "../../lib/server/stores/analytics-store";
import { analyticsHandler } from "../../lib/server/handlers/analytics-handler";
import { UserAccessError } from "../../lib/server/errors";
import { type AnalyticsRange, type AnalyticsScope } from "../../lib/shared/analytics";
import { splitAmounts } from "../../lib/shared/split-allocations";
import { analyticsAllocationCases } from "../shared/fixtures/analytics-allocation-cases";

test("集計の実SQLは保存割合の整数配分・対象期間・認可を一つの読み取りsnapshotで保証する", async t => {
  const memory = new PGlite({ extensions: { pgcrypto } });
  t.after(() => memory.close());
  const migrations = new URL("../../db/migrations/", import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await memory.exec(await readFile(new URL(name, migrations), "utf8"));
  }
  const a = "test-user-a", b = "test-user-b", outside = "outside";
  await memory.query(`INSERT INTO app_users(id,email,name,is_enabled) VALUES
    ($1,'test-a@cake.local','A',true),($2,'test-b@cake.local','B',true),($3,'outside@example.test','Outside',true)`, [a, b, outside]);
  const workspaceId = randomUUID(), personalWorkspaceId = randomUUID(), otherWorkspaceId = randomUUID();
  await memory.query(`INSERT INTO workspaces(id,name,type,owner_user_id) VALUES
    ($1,'集計対象','SHARED',$4),($2,'一人の家計','PERSONAL',$4),($3,'別家計','PERSONAL',$5)`,
  [workspaceId, personalWorkspaceId, otherWorkspaceId, a, outside]);
  // Insert in reverse identity order: joined_at, then user_id is the canonical tie order.
  await memory.query(`INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES
    ($1,$5,'MEMBER','2026-01-02T00:00Z'),($1,$4,'OWNER','2026-01-01T00:00Z'),
    ($2,$4,'OWNER','2026-01-01T00:00Z'),($3,$6,'OWNER','2026-01-01T00:00Z')`,
  [workspaceId, personalWorkspaceId, otherWorkspaceId, a, b, outside]);

  const previous = { url: process.env.DATABASE_URL, logging: process.env.DB_QUERY_LOG, fetch: neonConfig.fetchFunction };
  process.env.DATABASE_URL = "postgresql://fixture:fixture@mock.neon.tech/analytics";
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
  const periods: Record<AnalyticsScope, AnalyticsRange> = {
    current: { from: "2026-10-01", to: "2026-10-23" },
    comparison: { from: "2026-09-01", to: "2026-09-23" },
    trend: { from: "2026-05-01", to: "2026-10-23" },
  };
  const category = async (name: string, workspace = workspaceId) => {
    const id = randomUUID(), creator = workspace === otherWorkspaceId ? outside : a;
    await memory.query(`INSERT INTO categories(id,workspace_id,name,color_hex,sort_order,created_by,updated_by)
      VALUES($1,$2,$3,'#123456',0,$4,$4)`, [id, workspace, name, creator]);
    return id;
  };
  type PaymentOptions = { date?: string; actor?: string; type?: string; expenseClass?: string; workspace?: string; source?: string; settled?: boolean };
  const insert = async (amount: number, weights: Record<string, number>, categoryId: string | null, options: PaymentOptions = {}) => {
    const id = randomUUID(), actor = options.actor ?? a;
    await memory.query(`INSERT INTO transactions(id,workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,source,created_by,updated_by,category_id,settled_at)
      VALUES($1::uuid,$2,$3,'非公開の取引先','現金',$4,$5,$6,$7,$8::jsonb,$1::text,$9,$6,$6,$10,$11)`,
    [id, options.workspace ?? workspaceId, options.date ?? "2026-10-10T00:00:00Z", options.type ?? "PAYMENT", amount,
      actor, options.expenseClass ?? "SHARED", JSON.stringify(weights), options.source ?? "MANUAL", categoryId,
      options.settled ? "2026-10-11T00:00Z" : null]);
    return id;
  };
  const read = async (workspace = workspaceId, user = a, targetPeriods = periods) => {
    const start = queries.length;
    const result = await findAnalytics(workspace, user, targetPeriods);
    assert.equal(queries.length - start, 1, "所属確認・metadata・全scopeを固定1SQLで取得");
    return result;
  };

  await t.test("共通fixtureの最大剰余結果はsplitAmountsと一致し、支払者や既定割合を参照しない", async () => {
    for (const fixture of analyticsAllocationCases) {
      const single = fixture.weights.length === 1, workspace = single ? personalWorkspaceId : workspaceId;
      const members = single ? [{ id: a }] : [{ id: a }, { id: b }];
      const weights = Object.fromEntries(members.map((member, index) => [member.id, fixture.weights[index]]));
      const categoryId = await category(fixture.name, workspace);
      await insert(fixture.amount, weights, categoryId, { workspace, actor: single ? a : b });
      const expected = splitAmounts(fixture.amount, weights, members);
      const result = await read(workspace);
      for (const scope of ["current", "trend"]) {
        const actual = Object.fromEntries(members.map(member => [member.id,
          result.buckets.find(bucket => bucket.scope === scope && bucket.categoryId === categoryId && bucket.memberId === member.id)?.burdenYen ?? "0",
        ]));
        assert.deepEqual(actual, Object.fromEntries(Object.entries(expected).map(([id, value]) => [id, String(value)])), `${fixture.name}/${scope}`);
      }
      assert.equal(result.buckets.filter(bucket => bucket.scope === "current" && bucket.categoryId === categoryId)
        .reduce((sum, bucket) => sum + BigInt(bucket.burdenYen), BigInt(0)), BigInt(fixture.amount));
    }
    await memory.query("UPDATE workspace_members SET weight=CASE WHEN user_id=$2 THEN 0 ELSE 100 END WHERE workspace_id=$1", [workspaceId, a]);
    const result = await read();
    const first = result.categories.find(item => item.name === "1円の同率")!;
    assert.equal(result.buckets.find(bucket => bucket.scope === "current" && bucket.categoryId === first.id)?.memberId, a);
  });

  await t.test("joined_at同率時のuser_id順で端数を配り、重複scopeで分母・配分を増やさない", async () => {
    const id = await category("境界と重複");
    await insert(1, { [a]: 1, [b]: 1 }, id, { date: "2026-09-10T00:00Z", actor: b });
    await memory.query("UPDATE workspace_members SET joined_at=CASE WHEN user_id=$2 THEN '2025-01-01T00:00Z'::timestamptz ELSE '2026-01-01T00:00Z'::timestamptz END WHERE workspace_id=$1", [workspaceId, b]);
    assert.deepEqual((await read()).buckets.filter(bucket => bucket.categoryId === id).map(bucket => bucket.memberId), [b, b]);
    await memory.query("UPDATE workspace_members SET joined_at='2026-01-01T00:00Z' WHERE workspace_id=$1", [workspaceId]);
    const result = await read();
    const buckets = result.buckets.filter(bucket => bucket.categoryId === id);
    assert.deepEqual(buckets.map(bucket => [bucket.scope, bucket.memberId, bucket.burdenYen]), [["comparison", a, "1"], ["trend", a, "1"]]);
  });

  await t.test("収入も保存割合の最大剰余で配分し、受取者の本人額や現在の既定割合へ置き換えない", async () => {
    for (const fixture of analyticsAllocationCases) {
      const single = fixture.weights.length === 1, workspace = single ? personalWorkspaceId : workspaceId;
      const members = single ? [{ id: a }] : [{ id: a }, { id: b }];
      const weights = Object.fromEntries(members.map((member, index) => [member.id, fixture.weights[index]]));
      const categoryId = await category(`収入：${fixture.name}`, workspace);
      await insert(fixture.amount, weights, categoryId, { workspace, type: "RECEIPT", actor: single ? a : b, settled: true });
      const expected = splitAmounts(fixture.amount, weights, members);
      const result = await read(workspace);
      for (const scope of ["current", "trend"]) {
        const actual = Object.fromEntries(members.map(member => [member.id,
          result.receiptBuckets.find(bucket => bucket.scope === scope && bucket.categoryId === categoryId && bucket.memberId === member.id)?.burdenYen ?? "0",
        ]));
        assert.deepEqual(actual, Object.fromEntries(Object.entries(expected).map(([id, value]) => [id, String(value)])), `${fixture.name}/${scope}`);
      }
      assert.equal(result.receiptBuckets.filter(bucket => bucket.scope === "current" && bucket.categoryId === categoryId)
        .reduce((sum, bucket) => sum + BigInt(bucket.burdenYen), BigInt(0)), BigInt(fixture.amount));
      assert.ok(!result.buckets.some(bucket => bucket.categoryId === categoryId), "収入は支出のカテゴリ構成比へ入れない");
    }
    const id = await category("収入の比較期間と個人区分");
    await insert(1, { [a]: 1, [b]: 1 }, id, { type: "RECEIPT", actor: b, date: "2026-09-10T00:00Z" });
    await insert(29, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT", actor: a, expenseClass: "PERSONAL" });
    await insert(41, { [a]: 0, [b]: 1 }, id, { type: "RECEIPT", actor: b, expenseClass: "PERSONAL" });
    const result = await read();
    assert.deepEqual(result.receiptBuckets.filter(bucket => bucket.categoryId === id)
      .map(bucket => [bucket.scope, bucket.month, bucket.memberId, bucket.expenseClass, bucket.burdenYen]), [
        ["comparison", "2026-09", a, "SHARED", "1"],
        ["current", "2026-10", a, "PERSONAL", "29"],
        ["trend", "2026-09", a, "SHARED", "1"],
        ["trend", "2026-10", a, "PERSONAL", "29"],
      ]);
    assert.ok(!result.receiptBuckets.some(bucket => bucket.expenseClass === "PERSONAL" && bucket.memberId === b));
    const partner = await read(workspaceId, b);
    assert.ok(!partner.receiptBuckets.some(bucket => bucket.expenseClass === "PERSONAL" && bucket.memberId === a));
    assert.equal(partner.receiptBuckets.find(bucket => bucket.scope === "current" && bucket.categoryId === id
      && bucket.expenseClass === "PERSONAL" && bucket.memberId === b)?.burdenYen, "41");
  });

  await t.test("収入のJST境界・未分類・別家計を同じsnapshotで扱い未来日を期間へ混ぜない", async () => {
    const id = await category("収入のJST期間"), foreign = await category("他家計の収入", otherWorkspaceId);
    await insert(10, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT", date: "2026-09-30T14:59:59.999999Z" });
    await insert(20, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT", date: "2026-09-30T15:00:00Z" });
    await insert(30, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT", date: "2026-10-23T14:59:59.999999Z" });
    await insert(40, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT", date: "2026-10-23T15:00:00Z" });
    await insert(7, { [a]: 1, [b]: 0 }, null, { type: "RECEIPT", actor: a, expenseClass: "PERSONAL", settled: true });
    await insert(2000, { [outside]: 1 }, foreign, { type: "RECEIPT", workspace: otherWorkspaceId, actor: outside, expenseClass: "PERSONAL" });
    const result = await read();
    assert.deepEqual(result.receiptBuckets.filter(bucket => bucket.categoryId === id)
      .map(bucket => [bucket.scope, bucket.month, bucket.burdenYen]), [
        ["current", "2026-10", "50"], ["trend", "2026-09", "10"], ["trend", "2026-10", "50"],
      ]);
    assert.equal(result.receiptBuckets.find(bucket => bucket.scope === "current" && bucket.categoryId === null
      && bucket.memberId === a && bucket.expenseClass === "PERSONAL")?.burdenYen, "7");
    assert.ok(!result.receiptBuckets.some(bucket => bucket.categoryId === foreign));
    assert.ok(!result.buckets.some(bucket => bucket.categoryId === id));
  });

  await t.test("収入だけの家計も空の支出と配分済み収入を返す", async () => {
    const workspace = randomUUID();
    await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES($1,'収入だけ','PERSONAL',$2)", [workspace, a]);
    await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'OWNER')", [workspace, a]);
    await insert(17, { [a]: 1 }, null, { type: "RECEIPT", workspace, expenseClass: "PERSONAL" });
    const result = await read(workspace);
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.receiptBuckets.map(bucket => [bucket.scope, bucket.memberId, bucket.burdenYen]), [
      ["current", a, "17"], ["trend", a, "17"],
    ]);
  });

  await t.test("JSTの日付境界を半開区間で扱い、範囲間の隙間と未来日を現在期間へ含めない", async () => {
    const id = await category("JST期間");
    await insert(10, { [a]: 1, [b]: 0 }, id, { date: "2026-09-30T14:59:59.999999Z" });
    await insert(20, { [a]: 1, [b]: 0 }, id, { date: "2026-09-30T15:00:00Z" });
    await insert(30, { [a]: 1, [b]: 0 }, id, { date: "2026-10-23T14:59:59.999999Z" });
    await insert(40, { [a]: 1, [b]: 0 }, id, { date: "2026-10-23T15:00:00Z" });
    const result = await read();
    assert.deepEqual(result.buckets.filter(bucket => bucket.categoryId === id).map(bucket => [bucket.scope, bucket.month, bucket.burdenYen]),
      [["current", "2026-10", "50"], ["trend", "2026-09", "10"], ["trend", "2026-10", "50"]]);
    const separate = { current: periods.current, comparison: periods.comparison, trend: { from: "2026-05-01", to: "2026-05-31" } };
    assert.deepEqual((await read(workspaceId, a, separate)).buckets.filter(bucket => bucket.categoryId === id).map(bucket => bucket.burdenYen), ["50"]);
  });

  await t.test("全source・清算済・本人個人費・未確認と使用停止カテゴリを含め、収入と支出を分離し別workspaceは除外する", async () => {
    const id = await category("全source"), archived = await category("使用停止"), foreign = await category("別家計カテゴリ", otherWorkspaceId);
    for (const source of ["MANUAL", "PAYPAY", "RECURRING"]) await insert(101, { [a]: 1, [b]: 2 }, id, { source, settled: true });
    await insert(97, { [a]: 1, [b]: 0 }, archived);
    await insert(31, { [a]: 0, [b]: 1 }, null, { expenseClass: "PERSONAL", actor: b });
    await insert(23, { [a]: 1, [b]: 0 }, null, { expenseClass: "PERSONAL", actor: a });
    await insert(1000, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT" });
    await insert(2000, { [outside]: 1 }, foreign, { workspace: otherWorkspaceId, actor: outside, expenseClass: "PERSONAL" });
    await memory.query("UPDATE categories SET archived_at='2026-10-11T00:00Z' WHERE id=$1", [archived]);
    await memory.exec("ALTER TABLE transactions DISABLE TRIGGER transactions_category_guard");
    try { await memory.query("UPDATE transactions SET category_confirmed=false WHERE category_id=$1", [id]); }
    finally { await memory.exec("ALTER TABLE transactions ENABLE TRIGGER transactions_category_guard"); }
    const result = await read();
    const current = result.buckets.filter(bucket => bucket.scope === "current");
    assert.deepEqual(current.filter(bucket => bucket.categoryId === id).map(bucket => [bucket.memberId, bucket.burdenYen]), [[a, "102"], [b, "201"]]);
    assert.equal(current.find(bucket => bucket.categoryId === archived)?.burdenYen, "97");
    assert.deepEqual(result.receiptBuckets.filter(bucket => bucket.scope === "current" && bucket.categoryId === id)
      .map(bucket => [bucket.memberId, bucket.burdenYen]), [[a, "1000"]], "同じカテゴリでも収入を支出へ混ぜない");
    assert.ok(!current.some(bucket => bucket.expenseClass === "PERSONAL" && bucket.memberId === b));
    assert.equal(current.find(bucket => bucket.categoryId === null && bucket.expenseClass === "PERSONAL" && bucket.memberId === a)?.burdenYen, "23");
    const partner = await read(workspaceId, b);
    assert.ok(!partner.buckets.some(bucket => bucket.expenseClass === "PERSONAL" && bucket.memberId === a));
    assert.equal(partner.buckets.find(bucket => bucket.scope === "current" && bucket.expenseClass === "PERSONAL" && bucket.memberId === b)?.burdenYen, "31");
    assert.ok(result.categories.find(item => item.id === archived)?.archivedAt);
    assert.ok(!result.categories.some(item => item.id === foreign));
    assert.doesNotMatch(JSON.stringify(result), /非公開の取引先|splitWeights|actorUserId|externalId|memo/);
  });

  await t.test("整数上限を超える合計をSQL内で文字列化し、category未設定も失わない", async () => {
    const id = await category("大きい合計");
    for (let index = 0; index < 5; index++) {
      await insert(2147483647, { [a]: 1, [b]: 0 }, id);
      await insert(2147483647, { [a]: 1, [b]: 0 }, id, { type: "RECEIPT" });
    }
    const result = await read();
    assert.equal(result.buckets.find(bucket => bucket.scope === "current" && bucket.categoryId === id)?.burdenYen, "10737418235");
    assert.equal(result.receiptBuckets.find(bucket => bucket.scope === "current" && bucket.categoryId === id)?.burdenYen, "10737418235");
    assert.ok([...result.buckets, ...result.receiptBuckets].every(bucket => typeof bucket.burdenYen === "string" && /^\d+$/.test(bucket.burdenYen)));
    assert.match(queries.at(-1)!.query, /sum\(a\.burden_yen\)::text/);
  });

  await t.test("空の家計は空集約を返し、参照だけでworkspaceを作成しない", async () => {
    const empty = randomUUID();
    await memory.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES($1,'空','PERSONAL',$2)", [empty, a]);
    await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'OWNER')", [empty, a]);
    const before = (await memory.query("SELECT count(*)::text AS count FROM workspaces")).rows;
    const result = await read(empty);
    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.receiptBuckets, []);
    assert.deepEqual((await memory.query("SELECT count(*)::text AS count FROM workspaces")).rows, before);
  });

  await t.test("相手の個人支出・収入は不正な保存割合でも集計とエラーに影響しない", async () => {
    const before = await read();
    for (const type of ["PAYMENT", "RECEIPT"]) {
      const hidden = await insert(987654, { [a]: 0, [b]: 1 }, null, { type, expenseClass: "PERSONAL", actor: b });
      await memory.exec("ALTER TABLE transactions DISABLE TRIGGER transactions_complete_split");
      try {
        await memory.query("UPDATE transactions SET split_weights='{}'::jsonb WHERE id=$1", [hidden]);
        const actual = await read();
        assert.deepEqual(actual.buckets, before.buckets);
        assert.deepEqual(actual.receiptBuckets, before.receiptBuckets);
        await assert.rejects(read(workspaceId, b), /保存済み負担割合が不正/);
        await memory.query("DELETE FROM transactions WHERE id=$1", [hidden]);
      } finally { await memory.exec("ALTER TABLE transactions ENABLE TRIGGER transactions_complete_split"); }
    }
  });

  await t.test("支払い・収入の無効な保存割合・未知参加者・不在の担当者は集計全体を失敗させる", async () => {
    for (const type of ["PAYMENT", "RECEIPT"]) {
      const id = await insert(100, { [a]: 1, [b]: 1 }, null, { type });
      await memory.exec("ALTER TABLE transactions DISABLE TRIGGER transactions_complete_split");
      try {
        for (const weights of [{ [a]: 1 }, { [a]: 1, [b]: 1, outsider: 0 }, { [a]: 0, [b]: 0 },
          { [a]: -1, [b]: 1 }, { [a]: 0.5, [b]: 1 }, { [a]: 2147483648, [b]: 1 },
          { [a]: "1", [b]: 1 }, { [a]: null, [b]: 1 }, {}]) {
          await memory.query("UPDATE transactions SET split_weights=$2::jsonb WHERE id=$1", [id, JSON.stringify(weights)]);
          await assert.rejects(read(), /保存済み負担割合が不正/);
        }
        await memory.query("UPDATE transactions SET split_weights=$2::jsonb,actor_user_id=$3 WHERE id=$1", [id, JSON.stringify({ [a]: 1, [b]: 1 }), outside]);
        await assert.rejects(read(), /保存済み負担割合が不正/);
        await memory.query("UPDATE transactions SET actor_user_id=$2,expense_class='PERSONAL' WHERE id=$1", [id, a]);
        await assert.rejects(read(), /保存済み負担割合が不正/);
        await memory.query("DELETE FROM transactions WHERE id=$1", [id]);
      } finally { await memory.exec("ALTER TABLE transactions ENABLE TRIGGER transactions_complete_split"); }
    }
  });

  await t.test("通常APIは有効利用者確認と一括集計の2往復で、非所属・所属削除・利用停止を区別する", async () => {
    const get = analyticsHandler({
      currentUser: async () => {
        // The production currentUser boundary performs the equivalent enabled-user lookup.
        const start = queries.length;
        const { db } = await import("../../lib/server/database/db");
        const rows = await db()`SELECT id FROM app_users WHERE id=${a} AND is_enabled`;
        assert.equal(queries.length - start, 1);
        return rows[0] ? { id: String(rows[0].id) } : null;
      }, findAnalytics, now: () => new Date("2026-10-23T00:00Z"),
    });
    const start = queries.length;
    assert.equal((await get(new Request(`https://cake.example/api/analytics?workspaceId=${workspaceId}&period=month&month=2026-10`))).status, 200);
    assert.equal(queries.length - start, 2);
    const denied = (status: number) => (error: unknown) => error instanceof UserAccessError && error.status === status;
    await assert.rejects(read(workspaceId, outside), denied(403));
    await memory.query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, b]);
    await assert.rejects(read(workspaceId, b), denied(403));
    await memory.query("INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER','2026-01-01T00:00Z')", [workspaceId, b]);
    await memory.query("UPDATE app_users SET is_enabled=false WHERE id=$1", [a]);
    await assert.rejects(read(), denied(401));
    await memory.query("UPDATE app_users SET is_enabled=true WHERE id=$1", [a]);
    await assert.rejects(read(workspaceId, "unknown"), denied(401));
  });

  await t.test("READ ONLY transactionで集計でき、既存のworkspace/date Indexを期間抽出に使える", async () => {
    const snapshot = async () => (await memory.query(`SELECT jsonb_build_object(
      'transactions',(SELECT jsonb_agg(t ORDER BY id) FROM transactions t),
      'categories',(SELECT jsonb_agg(c ORDER BY id) FROM categories c),
      'workspaces',(SELECT jsonb_agg(w ORDER BY id) FROM workspaces w)) AS data`)).rows;
    const before = await snapshot();
    await memory.exec("BEGIN READ ONLY");
    try { await read(); } finally { await memory.exec("ROLLBACK"); }
    assert.deepEqual(await snapshot(), before);
    const query = queries.at(-1)!;
    // Representative history makes date selectivity visible to the planner.
    await memory.query(`INSERT INTO transactions(workspace_id,occurred_at,merchant,method,type,amount_yen,
      actor_user_id,expense_class,split_weights,external_id,created_by,updated_by)
      SELECT $1::uuid,'2000-01-01T00:00Z'::timestamptz,'範囲外の履歴','現金','PAYMENT',100,
        $2::text,'SHARED',jsonb_build_object($2::text,1,$3::text,1),'plan-'||n::text,$2::text,$2::text
      FROM generate_series(1,2000) n`, [workspaceId, a, b]);
    await memory.exec("ANALYZE transactions");
    await memory.exec("SET enable_seqscan=off");
    try {
      const plan = await memory.query("EXPLAIN (FORMAT JSON) " + query.query, query.params);
      assert.match(JSON.stringify(plan.rows), /transactions_workspace_date_idx/);
      assert.match(query.query, /t\.occurred_at >= \(SELECT min\(start_at\)/);
      assert.doesNotMatch(query.query, /INSERT INTO|UPDATE |DELETE FROM/);
    } finally { await memory.exec("RESET enable_seqscan"); }
  });
});
