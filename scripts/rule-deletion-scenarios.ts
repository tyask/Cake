import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export type RuleDeletionDatabase = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
type Options = { prefix: string; runCase?: (name: string, run: () => Promise<void>) => Promise<void> };

/** Exercise only new, caller-owned workspaces; never change users or shared schema. */
export async function verifyRuleDeletionScenarios(sql: RuleDeletionDatabase, actorId: string, options: Options) {
  assert.ok(options.prefix.startsWith("verify-rule-deletion-") && options.prefix.length <= 80);
  const started = performance.now();
  const workspaceIds = [randomUUID(), randomUUID()];
  const report = { cases: [] as { name: string; seconds: number }[], workspaceIds, cleanup: {} as Record<string, number>, seconds: 0 };
  const [target, foreign] = workspaceIds;
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now();
    if (options.runCase) await options.runCase(name, run); else await run();
    report.cases.push({ name, seconds: (performance.now() - at) / 1000 });
  }
  async function rules(workspaceId = target) {
    return (await sql.query("SELECT id::text,sort_order,priority FROM default_rules WHERE workspace_id=$1::uuid ORDER BY sort_order,created_at,id", [workspaceId])).rows;
  }
  async function reset(workspaceId = target) {
    await sql.query("DELETE FROM default_rules WHERE workspace_id=$1::uuid", [workspaceId]);
    for (const [i, rank] of [4, 8, 8, 12].entries()) await sql.query(
      `INSERT INTO default_rules(id,workspace_id,merchant_contains,expense_class,sort_order,enabled,created_by,created_at)
       VALUES ($1::uuid,$2::uuid,$3,'SHARED',$4,$5,$6,'2026-10-18T00:00:00Z')`,
      [randomUUID(), workspaceId, `${options.prefix}-${i}`, rank, i !== 0, actorId],
    );
    return (await rules(workspaceId)).map(r => String(r.id));
  }
  async function state(workspaceId = target) {
    return (await sql.query(`SELECT jsonb_build_object(
      'workspace',(SELECT to_jsonb(w) FROM workspaces w WHERE id=$1::uuid),
      'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY sort_order,created_at,id) FROM default_rules r WHERE workspace_id=$1::uuid)
    ) AS snapshot`, [workspaceId])).rows[0].snapshot;
  }
  async function remove(ids: (string | null)[], requireAll: boolean | null, actor = actorId, workspaceId = target) {
    const { rows } = await sql.query(`SELECT cake_delete_default_rules($1::uuid,$2,
      ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)),$4::boolean) AS deleted`,
    [workspaceId, actor, JSON.stringify(ids), requireAll]);
    return Number(rows[0].deleted);
  }
  async function ordered(ids: string[]) {
    assert.deepEqual(await rules(), ids.map((id, i) => ({ id, sort_order: i, priority: i })));
  }
  async function rejected(run: () => Promise<unknown>, pattern: RegExp) {
    const before = await state();
    await assert.rejects(run(), pattern);
    assert.deepEqual(await state(), before, "失敗時はworkspace時刻・削除・順序を全てrollbackする");
  }
  try {
    for (const id of workspaceIds) {
      await sql.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1::uuid,$2,'SHARED',$3)", [id, options.prefix, actorId]);
      await sql.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1::uuid,$2,'OWNER')", [id, actorId]);
    }
    const foreignIds = await reset(foreign), foreignBefore = await state(foreign);
    await check("単件削除は無効ルールも対象とし、同順位のcreated_at/id順とpriority同期を維持する", async () => {
      const ids = await reset();
      assert.equal(await remove([ids[0]], false), 1);
      await ordered(ids.slice(1));
    });
    await check("不存在の単件削除は0件成功し、残存順序を詰める", async () => {
      const ids = await reset();
      assert.equal(await remove([randomUUID()], false), 0);
      await ordered(ids);
    });
    await check("複数削除は指定全件を削除し、中間の残存順序を詰める", async () => {
      const ids = await reset();
      assert.equal(await remove([ids[0], ids[2]], true), 2);
      await ordered([ids[1], ids[3]]);
    });
    await check("全件削除は正確な件数を返し、空一覧の並べ替えと共存する", async () => {
      const ids = await reset();
      assert.equal(await remove(ids, true), 4);
      await sql.query("SELECT cake_reorder_default_rules($1::uuid,$2,ARRAY[]::uuid[])", [target, actorId]);
      await ordered([]);
    });
    await check("複数の一部不存在は全件を中止する", async () => {
      const ids = await reset();
      await rejected(() => remove([ids[0], randomUUID()], true), /選択したルールが見つかりません/);
    });
    await check("別workspaceの単件は成功0件、複数への混在は全件を中止する", async () => {
      const ids = await reset();
      assert.equal(await remove([foreignIds[0]], false), 0);
      await ordered(ids);
      await rejected(() => remove([ids[0], foreignIds[0]], true), /選択したルールが見つかりません/);
    });
    await check("UUIDの大小文字違いを含む重複をDB内で拒否する", async () => {
      const ids = await reset();
      await rejected(() => remove([ids[0], ids[0]], true), /選択したルールが見つかりません/);
      await rejected(() => remove([ids[0], ids[0].toUpperCase()], true), /選択したルールが見つかりません/);
    });
    await check("ロック後の最新所属確認で非所属・消失workspaceを拒否する", async () => {
      const ids = await reset();
      await rejected(() => remove([ids[0]], false, "rule-deletion-outsider"), /権限がありません/);
      await rejected(() => remove([ids[0]], true, actorId, randomUUID()), /権限がありません/);
    });
    await check("空・NULL要素・上限超過・不正な単件モードは書込前に拒否する", async () => {
      const ids = await reset();
      for (const [values, mode] of [[[], true], [[null], true], [[ids[0]], null], [[ids[0], ids[1]], false], [Array.from({ length: 5001 }, () => randomUUID()), true]] as const) {
        await rejected(() => remove([...values], mode), /操作するルールを重複せずに/);
      }
      await rejected(() => sql.query("SELECT cake_delete_default_rules($1::uuid,$2,NULL::uuid[],true)", [target, actorId]), /操作するルールを重複せずに/);
    });
    await check("旧並べ替え・旧単件削除SQLと新しい削除関数が共存する", async () => {
      const ids = (await reset()).reverse();
      await sql.query("SELECT cake_reorder_default_rules($1::uuid,$2,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)))", [target, actorId, JSON.stringify(ids)]);
      await sql.query("BEGIN");
      try {
        await sql.query("UPDATE workspaces SET updated_at=now() WHERE id=$1::uuid", [target]);
        await sql.query("DELETE FROM default_rules WHERE workspace_id=$1::uuid AND id=$2::uuid", [target, ids[0]]);
        await sql.query(`WITH ranked AS (SELECT id,(row_number() OVER (ORDER BY sort_order,created_at,id)-1)::integer AS position FROM default_rules WHERE workspace_id=$1::uuid)
          UPDATE default_rules r SET sort_order=ranked.position FROM ranked WHERE r.id=ranked.id`, [target]);
        await sql.query("COMMIT");
      } catch (error) { await sql.query("ROLLBACK"); throw error; }
      await ordered(ids.slice(1));
      assert.equal(await remove([ids[2]], true), 1);
      await ordered([ids[1], ids[3]]);
    });
    await check("削除・再採番の成功後でも後続失敗でTransaction全体がrollbackする", async () => {
      const ids = await reset(), before = await state();
      await sql.query("BEGIN");
      try {
        assert.equal(await remove([ids[0], ids[2]], true), 2);
        await assert.rejects(sql.query("SELECT 1/0"), /division by zero/);
      } finally { await sql.query("ROLLBACK"); }
      assert.deepEqual(await state(), before);
    });
    assert.deepEqual(await state(foreign), foreignBefore, "別workspaceの全データを維持する");
  } finally {
    await sql.query("DELETE FROM workspaces WHERE id IN ($1::uuid,$2::uuid) AND name=$3 AND owner_user_id=$4", [...workspaceIds, options.prefix, actorId]);
    for (const table of ["workspaces", "workspace_members", "default_rules"]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      const { rows } = await sql.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} IN ($1::uuid,$2::uuid)`, workspaceIds);
      report.cleanup[table] = Number(rows[0].count);
      assert.equal(report.cleanup[table], 0);
    }
    report.seconds = (performance.now() - started) / 1000;
  }
  return report;
}

/** Requires two independent PostgreSQL sessions, not PGlite's single-session queue. */
export async function verifyRuleDeletionConcurrency(first: RuleDeletionDatabase, second: RuleDeletionDatabase,
  actorId: string, otherActorId: string, options: Options) {
  assert.ok(options.prefix.startsWith("verify-rule-deletion-") && options.prefix.length <= 80);
  const workspaceId = randomUUID(), started = performance.now();
  const report = { cases: [] as { name: string; lockWaitObserved: boolean; seconds: number }[], workspaceId, cleanup: {} as Record<string, number>, seconds: 0 };
  const firstPid = Number((await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  const secondPid = Number((await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  assert.notEqual(firstPid, secondPid);
  async function rules() {
    return (await first.query("SELECT id::text,sort_order,priority FROM default_rules WHERE workspace_id=$1::uuid ORDER BY sort_order,created_at,id", [workspaceId])).rows;
  }
  async function reset() {
    await first.query("DELETE FROM default_rules WHERE workspace_id=$1::uuid", [workspaceId]);
    for (let i = 0; i < 4; i++) await first.query(`INSERT INTO default_rules(id,workspace_id,merchant_contains,expense_class,sort_order,created_by)
      VALUES ($1::uuid,$2::uuid,$3,'SHARED',$4,$5)`, [randomUUID(), workspaceId, `${options.prefix}-${i}`, i, actorId]);
    return (await rules()).map(row => String(row.id));
  }
  async function remove(client: RuleDeletionDatabase, ids: string[], requireAll = true, actor = actorId) {
    const { rows } = await client.query(`SELECT cake_delete_default_rules($1::uuid,$2,
      ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)),$4::boolean) AS deleted`,
    [workspaceId, actor, JSON.stringify(ids), requireAll]);
    return Number(rows[0].deleted);
  }
  async function reorder(client: RuleDeletionDatabase, ids: string[]) {
    await client.query(`SELECT cake_reorder_default_rules($1::uuid,$2,
      ARRAY(SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb)))`, [workspaceId, actorId, JSON.stringify(ids)]);
    return 0;
  }
  async function ordered(ids: string[]) {
    assert.deepEqual(await rules(), ids.map((id, i) => ({ id, sort_order: i, priority: i })));
  }
  async function competing(queued: () => Promise<number>, release: () => Promise<void>) {
    // Attach both handlers immediately: the expected SQL exception may arrive
    // before the assertion resumes after COMMIT.
    const outcome = queued().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    let blocked = false;
    try {
      const deadline = performance.now() + 10_000;
      do {
        blocked = (await first.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [firstPid, secondPid])).rows[0].blocked === true;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 40));
      } while (!blocked && performance.now() < deadline);
      assert.ok(blocked, "第二sessionが同じworkspaceロックを待つことを確認する");
      await release();
      await first.query("COMMIT");
      return await outcome;
    } finally {
      await first.query("ROLLBACK");
      await outcome;
    }
  }
  async function check(name: string, run: () => Promise<void>) {
    const at = performance.now();
    if (options.runCase) await options.runCase(name, run); else await run();
    report.cases.push({ name, lockWaitObserved: true, seconds: (performance.now() - at) / 1000 });
  }
  async function begin() {
    await first.query("BEGIN");
    await first.query("UPDATE workspaces SET updated_at=now() WHERE id=$1::uuid", [workspaceId]);
  }
  try {
    await first.query("INSERT INTO workspaces(id,name,type,owner_user_id) VALUES ($1::uuid,$2,'SHARED',$3)", [workspaceId, options.prefix, actorId]);
    await first.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1::uuid,$2,'OWNER'),($1::uuid,$3,'MEMBER')", [workspaceId, actorId, otherActorId]);
    await check("先行削除を待った複数削除は最新の不足対象で全件中止する", async () => {
      const ids = await reset(); await begin();
      assert.equal(await remove(first, [ids[1]], false), 1);
      const result = await competing(() => remove(second, [ids[1], ids[2]]), async () => {});
      assert.match(String(result.error?.message), /選択したルールが見つかりません/);
      await ordered([ids[0], ids[2], ids[3]]);
    });
    await check("先行並べ替えを待つ複数削除は新しい残存順序を維持する", async () => {
      const ids = await reset(), reversed = [...ids].reverse(); await begin();
      await reorder(first, reversed);
      const result = await competing(() => remove(second, [ids[1], ids[3]]), async () => {});
      assert.equal(result.error, undefined); assert.equal(result.value, 2);
      await ordered([ids[2], ids[0]]);
    });
    await check("先行削除を待った古い全件並べ替えは失敗し、削除後の順序を維持する", async () => {
      const ids = await reset(); await begin(); await remove(first, [ids[1]]);
      const result = await competing(() => reorder(second, [...ids].reverse()), async () => {});
      assert.match(String(result.error?.message), /ルールの一覧が変わりました/);
      await ordered([ids[0], ids[2], ids[3]]);
    });
    await check("同じ単件の同時削除は1件成功・0件成功となる", async () => {
      const ids = await reset(); await begin(); assert.equal(await remove(first, [ids[0]], false), 1);
      const result = await competing(() => remove(second, [ids[0]], false), async () => {});
      assert.equal(result.error, undefined); assert.equal(result.value, 0);
      await ordered(ids.slice(1));
    });
    await check("待機中に所属を解除された利用者の削除はロック取得後に拒否する", async () => {
      const ids = await reset(); await begin();
      const result = await competing(() => remove(second, [ids[0]], true, otherActorId), async () => {
        await first.query("DELETE FROM workspace_members WHERE workspace_id=$1::uuid AND user_id=$2", [workspaceId, otherActorId]);
      });
      assert.match(String(result.error?.message), /権限がありません/);
      await ordered(ids);
    });
  } finally {
    await first.query("ROLLBACK");
    await first.query("DELETE FROM workspaces WHERE id=$1::uuid AND name=$2 AND owner_user_id=$3", [workspaceId, options.prefix, actorId]);
    for (const table of ["workspaces", "workspace_members", "default_rules"]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      report.cleanup[table] = Number((await first.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column}=$1::uuid`, [workspaceId])).rows[0].count);
      assert.equal(report.cleanup[table], 0);
    }
    report.seconds = (performance.now() - started) / 1000;
  }
  return report;
}
