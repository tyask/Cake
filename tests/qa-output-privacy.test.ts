import test from "node:test";
import assert from "node:assert/strict";
import { maskQaHosts, publicQaOutput } from "../lib/qa-output-privacy";

const directHost = "ep-private-example.us-east-1.aws.neon.tech";
const pooledHost = "ep-private-example-pooler.us-east-1.aws.neon.tech";
const database = { projectId: "test-project", branchId: "br-private-example", endpointId: "ep-private-example", host: directHost };

test("ledger/Native/JSON承認のhostをActionsだけでmaskし、pooled/unpooledを保護する", () => {
  const commands: string[] = [];
  maskQaHosts({ payload: { database }, endpoints: [{ host: pooledHost }], approval: JSON.stringify({ database }) },
    { GITHUB_ACTIONS: "true" }, (command) => commands.push(command));
  assert.deepEqual(new Set(commands), new Set([`::add-mask::${directHost}`, `::add-mask::${pooledHost}`]));
  assert.equal(commands.length, 2);
  maskQaHosts({ payload: { database } }, {}, (command) => commands.push(command));
  assert.equal(commands.length, 2);
});

test("remote文字列の改行やworkflow-command断片をmask commandへ取り込まない", () => {
  const commands: string[] = [];
  maskQaHosts({ host: `${directHost}\n::error::injected`, invalid: "ep-not-a-host", nested: { endpointId: database.endpointId } },
    { GITHUB_ACTIONS: "true" }, (command) => commands.push(command));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command, /^::add-mask::ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/);
    assert.doesNotMatch(command, /\n|\r|::error::/);
  }
});

test("診断/manifestはhostと接続情報を除き、資源ID・比較判定・data loss表示を保つ", () => {
  const input = Object.freeze({ readOnly: true, slots: Object.freeze([{ database: Object.freeze(database) }]),
    plan: Object.freeze({ database, deploymentIds: ["dpl_example"], alias: null, dataLoss: true }),
    productionHostComparison: { result: "no-match", endpoints: [{ endpointId: database.endpointId, result: "no-match" }] },
    url: "https://private-preview.vercel.app", connectionString: `postgresql://user:password@${directHost}/database`,
    credentials: { password: "fixture-password" }, body: "opaque-provider-error" });
  const projected = publicQaOutput(input, {}) as Record<string, unknown>;
  const serialized = JSON.stringify(projected);
  for (const text of [directHost, "postgresql://", "private-preview", "fixture-password", "opaque-provider-error"]) assert.ok(!serialized.includes(text));
  assert.deepEqual(projected.slots, [{ database: { projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId } }]);
  assert.deepEqual(projected.productionHostComparison, input.productionHostComparison);
  assert.deepEqual(projected.plan, { database: { projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId }, deploymentIds: ["dpl_example"], alias: null, dataLoss: true });
  assert.equal(input.slots[0].database.host, directHost);
});

test("自由記述に埋まったhost/URL/既知tokenとsecret fieldもローカル出力から除く", () => {
  const token = "fixture-provider-credential";
  const serialized = JSON.stringify(publicQaOutput({ detail: `failed ${directHost} ${pooledHost} ${token} https://provider.invalid/private?key=example`,
    nested: [{ token, API_KEY: token, password: token, DATABASE_URL: `postgres://user:password@${directHost}/db` }] }, { VERCEL_TOKEN: token }));
  for (const text of [directHost, pooledHost, token, "https://provider", "postgres://"]) assert.ok(!serialized.includes(text));
  assert.ok(serialized.includes("[redacted]"));
});

test("不足credentialの設定名は公開し、credential実値やprovider本文は公開しない", () => {
  assert.deepEqual(publicQaOutput({ checks: [{ reason: { credential: "NEON_API_KEY", code: "missing-credential" } }],
    extra: { credential: "opaque-private-value", response: { body: "opaque-provider-body" } } }, {}),
  { checks: [{ reason: { credential: "NEON_API_KEY", code: "missing-credential" } }], extra: {} });
});
