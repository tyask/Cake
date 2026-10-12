import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/qa-pool.yml", import.meta.url), "utf8");
const inspect = workflow.slice(workflow.indexOf("  inspect:"), workflow.indexOf("  writer:"));
const writer = workflow.slice(workflow.indexOf("  writer:"));

test("通常生成は有効化条件を持ち、close/明示cleanup/probeは独立したmain入口を使う", () => {
  assert.match(workflow, /pull_request_target:\s+branches: \[main\]/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
  assert.match(writer, /vars\.CAKE_QA_POOL_ENABLED == 'true'/);
  assert.match(writer, /github\.event_name == 'pull_request_target' && github\.event\.action == 'closed'/);
  assert.match(writer, /contains\(fromJSON\('\["probe","claim","release","refresh"\]'\), inputs\.action\)/);
  assert.match(writer, /github\.event_name == 'schedule' && vars\.CAKE_QA_DELETE_APPROVALS != ''/);
  assert.match(writer, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(writer, /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/);
  assert.match(writer, /startsWith\(github\.event\.pull_request\.head\.ref, 'codex\/'\)/);
});

test("全writerは同一queueへ直列化し、default pending差替や実行キャンセルを使わない", () => {
  for (const job of [inspect, writer]) assert.match(job, /concurrency:\s+group: cake-qa-pool-writer\s+queue: max\s+cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: 5/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
});

test("資格情報を持つwriterはmainだけをcheckoutし、PRのコードや引数をshellへ挿入しない", () => {
  assert.match(workflow, /repository: tyask\/Cake\s+ref: refs\/heads\/main\s+persist-credentials: false/);
  assert.match(workflow, /environment: Preview/);
  assert.doesNotMatch(workflow, /ref:.*(?:head\.sha|head\.ref|pull_request\.merge_commit_sha)/);
  assert.match(workflow, /run: npm ci\s+- name: Reconcile QA pool/);
  assert.match(workflow, /run: node --import tsx scripts\/qa-pool-writer\.ts/);
  assert.match(workflow, /CAKE_QA_APPROVED_HEADS: \$\{\{ vars\.CAKE_QA_APPROVED_HEADS \}\}/);
  for (const [job, following] of [[inspect, "- name: Inspect without mutations"], [writer, "- name: Reconcile QA pool"]]) {
    assert.match(job, /repository: tyask\/Cake\s+ref: refs\/heads\/main\s+persist-credentials: false/);
    const install = job.slice(job.indexOf("- name: Install trusted dependencies"), job.indexOf(following));
    assert.doesNotMatch(install, /secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY/);
  }
  assert.doesNotMatch(workflow, /run:.*\$\{\{.*(?:inputs\.|pull_request\.)/);
});

test("検査jobはDeployments readだけを持ち、変更jobへ検査actionを流さない", () => {
  assert.match(inspect, /github\.event_name == 'workflow_dispatch'/);
  assert.match(inspect, /github\.ref == 'refs\/heads\/main'/);
  assert.match(inspect, /contains\(fromJSON\('\["preflight","plan-probe","plan-release"\]'\), inputs\.action\)/);
  assert.match(inspect, /deployments: read/);
  assert.doesNotMatch(inspect, /deployments: write/);
  assert.match(inspect, /CAKE_QA_PRODUCTION_DATABASE_HOST: \$\{\{ vars\.CAKE_QA_PRODUCTION_DATABASE_HOST \}\}/);
  assert.match(writer, /deployments: write/);
  assert.match(writer, /!contains\(fromJSON\('\["preflight","plan-probe","plan-release"\]'\), inputs\.action\)/);
});

test("生成probeと削除には専用manifest環境値を渡し、旧pool全体booleanで削除しない", () => {
  assert.match(writer, /CAKE_QA_DELETE_APPROVALS: \$\{\{ vars\.CAKE_QA_DELETE_APPROVALS \}\}/);
  assert.match(writer, /CAKE_QA_PROBE_APPROVALS: \$\{\{ vars\.CAKE_QA_PROBE_APPROVALS \}\}/);
  assert.match(writer, /QA_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(inspect, /QA_SLOT: \$\{\{ inputs\.slot \}\}/);
  assert.doesNotMatch(workflow, /CAKE_QA_DELETE_APPROVED/);
});

test("固定QA/feature枝のGit自動deployと固定Git枝のCIを停止する", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.git.deploymentEnabled, { "**": false, main: true });
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /^\s+- qa[123]$/m);
});
