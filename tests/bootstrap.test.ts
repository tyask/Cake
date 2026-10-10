import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getBootstrap } from "../lib/repository";
import type { AppUser } from "../lib/types";

const user: AppUser = {
  id: "member-a", email: "A@EXAMPLE.TEST", name: "A", imageUrl: null,
};
const workspaceId = "00000000-0000-0000-0000-000000000001";
const workspace = {
  id: workspaceId, name: "家計", type: "SHARED", owner_user_id: user.id, member_count: 2,
};
const members = [
  { id: user.id, email: user.email, name: "A", image_url: null, weight: 1, role: "OWNER" },
  { id: "member-b", email: "b@example.test", name: "B", image_url: "b.png", weight: 1, role: "MEMBER" },
];
const rules = [{
  id: "rule", merchant_contains: "スーパー", expense_class: "SHARED", sort_order: 0,
  split_weights: { "member-a": 2, "member-b": 1 }, enabled: true,
}];
const transactions = [{
  id: "transaction", occurred_at: "2026-10-08T09:00:00+09:00", merchant: "スーパー",
  method: "現金", type: "PAYMENT", amount_yen: 1000, actor_user_id: user.id, actor_name: "A",
  expense_class: "SHARED", settled_at: null, external_id: "manual-1", source: "MANUAL",
  split_weights: { "member-a": 1, "member-b": 1 }, memo: "レシートあり",
}];
const histories = [{
  id: "history", payer_name: "B", payee_name: "A", amount_yen: 200,
  completed_at: "2026-10-07T09:00:00+09:00",
}];
const invitations = [{
  id: "invitation", workspace_name: "別の家計", inviter_name: "C",
  expires_at: "2026-10-15T09:00:00+09:00",
}];

type Row = Record<string, unknown>;
type Query = { kind: "aggregate" | "create"; query: string; params: unknown[] };
interface FixtureOptions {
  initiallyEmpty?: boolean;
  workspaces?: Row[];
  selectedWorkspaceId?: string;
  overrides?: Partial<Record<"members" | "rules" | "transactions" | "settlement_history" | "pending_invitations", Row[]>>;
}

// Keep Neon HTTP decoding in the test so the actual SQL and repository mapping run.
function neonResponse(rows: Record<string, unknown>[]) {
  const fields = Object.entries(rows[0] ?? {}).map(([name, value]) => ({
    name, dataTypeID: typeof value === "boolean" ? 16 : value && typeof value === "object" ? 3802 : 25,
  }));
  return new Response(JSON.stringify({
    fields,
    rows: rows.map(row => fields.map(({ name, dataTypeID }) => {
      const value = row[name];
      if (value == null) return null;
      if (dataTypeID === 16) return value ? "t" : "f";
      if (dataTypeID === 3802) return JSON.stringify(value);
      return String(value);
    })),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Model the aggregate JSON's date_trunc values; source timestamps remain intact.
function aggregateTimestamps(rows: Row[], keys: string[]): Row[] {
  return rows.map(row => {
    const result = { ...row };
    for (const key of keys) {
      if (result[key] == null) continue;
      const date = new Date(String(result[key]));
      date.setUTCMilliseconds(0);
      result[key] = date.toISOString();
    }
    return result;
  });
}

function databaseFixture(t: TestContext, options: FixtureOptions = {}) {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:password@mock.neon.tech/test";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });
  const queries: Query[] = [];
  let created = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.ok(url.hostname.endsWith(".neon.tech"));
    assert.equal(url.pathname, "/sql");
    assert.equal(new Headers(init?.headers).get("Neon-Connection-String"), process.env.DATABASE_URL);
    assert.equal(init?.method, "POST");
    const { query, params } = JSON.parse(String(init?.body)) as { query: string; params: unknown[] };

    if (/\bINSERT INTO workspaces\b/.test(query)) {
      assert.equal(options.initiallyEmpty, true, "an existing workspace must never be created during a read");
      assert.equal(created, false, "initial workspace must be created only once");
      assert.match(query, /INSERT INTO workspace_members/);
      assert.deepEqual(params, [user.id, user.id]);
      created = true;
      queries.push({ kind: "create", query, params });
      return neonResponse([]);
    }
    assert.match(query, /^\s*WITH\b/);
    assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE)\b/, "the aggregate must only read the database");
    assert.ok(params.includes(user.id));
    assert.ok(params.includes(user.email.toLowerCase()));
    queries.push({ kind: "aggregate", query, params });
    const ownWorkspaces = options.initiallyEmpty
      ? created ? [{ ...workspace, name: "個人の家計", type: "PERSONAL", member_count: 1 }] : []
      : options.workspaces ?? [workspace];
    const requested = params.find(value => typeof value === "string" && value !== user.id && value !== user.email.toLowerCase());
    const selected = ownWorkspaces.find(item => item.id === requested) ?? ownWorkspaces[0];
    const personal = selected?.type === "PERSONAL";
    const aggregate: Row = {
      workspaces: ownWorkspaces,
      selected_workspace_id: options.selectedWorkspaceId ?? selected?.id ?? null,
      members: selected ? personal ? [members[0]] : options.overrides?.members ?? members : [],
      rules: selected && !personal ? options.overrides?.rules ?? rules : [],
      pending_invitations: aggregateTimestamps(options.overrides?.pending_invitations ?? invitations, ["expires_at"]),
    };
    if (/\bFROM transactions\b/.test(query)) {
      aggregate.transactions = aggregateTimestamps(selected && !personal ? options.overrides?.transactions ?? transactions : [], ["occurred_at", "settled_at"]);
      aggregate.settlement_history = aggregateTimestamps(selected && !personal ? options.overrides?.settlement_history ?? histories : [], ["completed_at"]);
    }
    return neonResponse([aggregate]);
  });
  return queries;
}

test("取込・設定用の読込は1回のSQL通信で必要な情報だけを返し、明細・清算履歴・プロフィール更新を省く", async (t) => {
  const queries = databaseFixture(t);
  const data = await getBootstrap(user, workspaceId, "metadata");

  assert.deepEqual(data.user, user);
  assert.deepEqual(data.workspaces, [{
    id: workspaceId, name: "家計", type: "SHARED", ownerUserId: user.id, memberCount: 2,
  }]);
  assert.deepEqual(data.pendingInvitations, [{
    id: "invitation", workspaceName: "別の家計", inviterName: "C", expiresAt: "2026-10-15T00:00:00.000Z",
  }]);
  assert.ok(data.selected);
  assert.deepEqual(data.selected.workspace, data.workspaces[0]);
  assert.deepEqual(data.selected.members, [
    { ...user, weight: 1, role: "OWNER" },
    { id: "member-b", email: "b@example.test", name: "B", imageUrl: "b.png", weight: 1, role: "MEMBER" },
  ]);
  assert.deepEqual(data.selected.rules, [{
    id: "rule", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0,
    splitWeights: { "member-a": 2, "member-b": 1 }, enabled: true,
  }]);
  for (const key of ["transactions", "settlement", "settlementHistory"]) {
    assert.equal(Object.hasOwn(data.selected, key), false);
  }
  assert.equal(queries.length, 1);
  assert.equal(queries[0].kind, "aggregate");
  assert.doesNotMatch(queries[0].query, /\b(?:transactions|settlements|settlement_history)\b/);
});

test("既定の読込は1回のSQL通信で明細・メモ・担当者名と清算情報を引き続き取得する", async (t) => {
  const queries = databaseFixture(t);
  const data = await getBootstrap(user, workspaceId);

  assert.ok(data.selected);
  assert.deepEqual(data.selected.transactions, [{
    id: "transaction", occurredAt: "2026-10-08T00:00:00.000Z", merchant: "スーパー", method: "現金",
    type: "PAYMENT", amountYen: 1000, actorUserId: user.id, actorName: "A", expenseClass: "SHARED",
    settledAt: null, externalId: "manual-1", source: "MANUAL",
    splitWeights: { "member-a": 1, "member-b": 1 }, memo: "レシートあり",
  }]);
  assert.equal(data.selected.settlement?.amountYen, 500);
  assert.equal(data.selected.settlement?.payerUserId, "member-b");
  assert.equal(data.selected.settlement?.payeeUserId, user.id);
  assert.deepEqual(data.selected.settlementHistory, [{
    id: "history", payerName: "B", payeeName: "A", amountYen: 200, completedAt: "2026-10-07T00:00:00.000Z",
  }]);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].kind, "aggregate");
  assert.match(queries[0].query, /\bFROM transactions\b/);
  assert.match(queries[0].query, /\bFROM settlements\b/);
});

test("未所属のワークスペースIDを指定しても、本人が所属するワークスペースだけを取得する", async (t) => {
  const queries = databaseFixture(t);
  const unknownId = "00000000-0000-0000-0000-000000000099";
  const data = await getBootstrap(user, unknownId, "metadata");

  assert.equal(data.selected?.workspace.id, workspaceId);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].params.includes(unknownId));
  const normalized = queries[0].query.replace(/\s+/g, " ");
  assert.match(normalized, /my_workspaces AS .*JOIN workspace_members mine ON mine\.workspace_id = w\.id AND mine\.user_id = \$\d+/);
  assert.match(normalized, /selected_workspace AS \( SELECT[^)]*\bFROM my_workspaces\b/);
  assert.match(normalized, /id::text\s*=\s*\$\d+(?:::text)?/);
  assert.match(normalized, /THEN 0 ELSE 1 END, updated_at DESC, created_at DESC, id ASC LIMIT 1/);
  assert.doesNotMatch(normalized, /\$\d+::uuid/, "untrusted requested IDs must not bypass selection or reject invalid strings");
});

test("UUID形式でない指定も所属ワークスペースへフォールバックし、SQL本文に埋め込まない", async (t) => {
  const queries = databaseFixture(t);
  const invalidId = "not-a-uuid' OR true --";
  const data = await getBootstrap(user, invalidId, "metadata");
  assert.equal(data.selected?.workspace.id, workspaceId);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].params.includes(invalidId));
  assert.equal(queries[0].query.includes(invalidId), false);
});

test("本人が所属する別のワークスペースを指定すると、SQLで選んだワークスペースを返す", async (t) => {
  const otherId = "00000000-0000-0000-0000-000000000002";
  const queries = databaseFixture(t, { workspaces: [workspace, { ...workspace, id: otherId, name: "もう一つの家計" }] });
  const data = await getBootstrap(user, otherId, "metadata");
  assert.equal(data.selected?.workspace.id, otherId);
  assert.equal(data.selected?.workspace.name, "もう一つの家計");
  assert.equal(data.workspaces[0].id, workspaceId);
  assert.equal(queries.length, 1);
});

test("所属ワークスペース一覧に存在しない選択IDの集約結果は表示データとして使わない", async (t) => {
  const queries = databaseFixture(t, { selectedWorkspaceId: "unrelated-workspace" });
  const data = await getBootstrap(user, workspaceId);
  assert.equal(data.selected, null);
  assert.equal(data.workspaces.length, 1);
  assert.equal(data.pendingInvitations.length, 1);
  assert.equal(queries.length, 1);
});

test("全データのSQLはメンバー・ルール・明細・履歴を所属先から選択したワークスペースに限定する", async (t) => {
  const queries = databaseFixture(t);
  await getBootstrap(user, workspaceId);
  const sql = queries[0].query.replace(/\s+/g, " ");
  for (const table of ["workspace_members", "default_rules", "transactions", "settlements"]) {
    assert.match(sql, new RegExp(`FROM ${table} \\w+ (?:JOIN|WHERE).*?selected_workspace`), `${table} must depend on the authorized selected workspace`);
  }
  assert.match(sql, /lower\(i\.email\) = \$\d+/);
  assert.match(sql, /i\.status = 'PENDING'/);
  assert.match(sql, /i\.expires_at > now\(\)/);
});

test("集約した配列の並び順・無効ルール・nullableな履歴・清算済みメモを保持する", async (t) => {
  const olderTransaction = {
    ...transactions[0], id: "older", occurred_at: "2026-10-07T09:00:00+09:00", settled_at: "2026-10-08T09:00:00+09:00", memo: "清算後のメモ",
  };
  const olderHistory = { ...histories[0], id: "older-history", payer_name: null, completed_at: "2026-10-06T09:00:00+09:00" };
  const disabledRule = { ...rules[0], id: "disabled", sort_order: 1, split_weights: null, enabled: false };
  const queries = databaseFixture(t, {
    overrides: { transactions: [transactions[0], olderTransaction], rules: [rules[0], disabledRule], settlement_history: [histories[0], olderHistory] },
  });
  const data = await getBootstrap(user, workspaceId);
  assert.ok(data.selected);
  assert.deepEqual(data.selected.transactions.map(item => item.id), ["transaction", "older"]);
  assert.equal(data.selected.transactions[1].memo, "清算後のメモ");
  assert.equal(data.selected.transactions[1].settledAt, "2026-10-08T00:00:00.000Z");
  assert.equal(data.selected.settlement?.amountYen, 500);
  assert.deepEqual(data.selected.rules.map(rule => rule.id), ["rule", "disabled"]);
  assert.equal(data.selected.rules[1].enabled, false);
  assert.equal(data.selected.rules[1].splitWeights, null);
  assert.deepEqual(data.selected.settlementHistory.map(item => item.id), ["history", "older-history"]);
  assert.equal(data.selected.settlementHistory[1].payerName, null);
  const sql = queries[0].query.replace(/\s+/g, " ");
  assert.match(sql, /ORDER BY (?:\w+\.)?updated_at DESC, (?:\w+\.)?created_at DESC, (?:\w+\.)?id ASC/);
  assert.match(sql, /ORDER BY (?:\w+\.)?joined_at ASC, (?:\w+\.)?user_id ASC/);
  assert.match(sql, /ORDER BY (?:\w+\.)?sort_order ASC, (?:\w+\.)?created_at ASC, (?:\w+\.)?id ASC/);
  assert.match(sql, /ORDER BY (?:\w+\.)?occurred_at DESC, (?:\w+\.)?created_at DESC/);
  assert.match(sql, /ORDER BY (?:\w+\.)?completed_at DESC/);
  assert.match(sql, /ORDER BY i\.created_at DESC/);
  assert.match(sql, /LIMIT 20/);
});

test("集約JSONの日時は従来の秒精度を保ち、ミリ秒による並び順と招待の有効期限判定は維持する", async (t) => {
  const recent = { ...transactions[0], id: "recent-fraction", occurred_at: "2026-10-08T09:00:00.900+09:00" };
  const earlier = {
    ...transactions[0], id: "earlier-fraction", occurred_at: "2026-10-08T09:00:00.100+09:00", settled_at: "2026-10-08T09:01:00.662+09:00",
  };
  const recentHistory = { ...histories[0], id: "recent-history", completed_at: "2026-10-07T09:00:00.900+09:00" };
  const earlierHistory = { ...histories[0], id: "earlier-history", completed_at: "2026-10-07T09:00:00.100+09:00" };
  const invitation = { ...invitations[0], expires_at: "2026-10-15T09:00:00.881+09:00" };
  const overrides = {
    transactions: [recent, earlier], settlement_history: [recentHistory, earlierHistory], pending_invitations: [invitation],
  };
  const originalRows = structuredClone(overrides);
  const queries = databaseFixture(t, { overrides });
  const data = await getBootstrap(user, workspaceId);

  assert.ok(data.selected);
  assert.deepEqual(data.selected.transactions.map(item => [item.id, item.occurredAt, item.settledAt]), [
    ["recent-fraction", "2026-10-08T00:00:00.000Z", null],
    ["earlier-fraction", "2026-10-08T00:00:00.000Z", "2026-10-08T00:01:00.000Z"],
  ]);
  assert.deepEqual(data.selected.settlementHistory.map(item => [item.id, item.completedAt]), [
    ["recent-history", "2026-10-07T00:00:00.000Z"],
    ["earlier-history", "2026-10-07T00:00:00.000Z"],
  ]);
  assert.equal(data.pendingInvitations[0].expiresAt, "2026-10-15T00:00:00.000Z");
  assert.deepEqual(overrides, originalRows);
  assert.equal(queries.length, 1);
  const sql = queries[0].query.replace(/\s+/g, " ");
  assert.match(sql, /'occurred_at', date_trunc\('second', t\.occurred_at\)/);
  assert.match(sql, /'settled_at', date_trunc\('second', t\.settled_at\)/);
  assert.match(sql, /'completed_at', date_trunc\('second', history\.completed_at\)/);
  assert.match(sql, /'expires_at', date_trunc\('second', i\.expires_at\)/);
  assert.equal([...sql.matchAll(/\bdate_trunc\(/g)].length, 4);
  assert.match(sql, /ORDER BY t\.occurred_at DESC, t\.created_at DESC/);
  assert.match(sql, /ORDER BY history\.completed_at DESC/);
  assert.match(sql, /ORDER BY s\.completed_at DESC LIMIT 20/);
  assert.match(sql, /AND i\.expires_at > now\(\)/);

  const metadata = await getBootstrap(user, workspaceId, "metadata");
  assert.equal(metadata.pendingInvitations[0].expiresAt, "2026-10-15T00:00:00.000Z");
  assert.equal([...queries[1].query.matchAll(/\bdate_trunc\(/g)].length, 1);
  assert.match(queries[1].query, /AND i\.expires_at > now\(\)/);
});

test("空の家計は初期作成してから1回だけ再取得し、個人の家計として返す", async (t) => {
  const queries = databaseFixture(t, { initiallyEmpty: true });
  const data = await getBootstrap(user);
  assert.deepEqual(queries.map(query => query.kind), ["aggregate", "create", "aggregate"]);
  assert.equal(data.selected?.workspace.type, "PERSONAL");
  assert.equal(data.selected?.workspace.name, "個人の家計");
  assert.equal(data.selected?.members.length, 1);
  assert.deepEqual(data.selected?.transactions, []);
  assert.deepEqual(data.selected?.rules, []);
  assert.deepEqual(data.selected?.settlementHistory, []);
  assert.equal(data.selected?.settlement, null);
});
