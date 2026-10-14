import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/qa-pool.yml", import.meta.url), "utf8");
const inspect = workflow.slice(workflow.indexOf("  inspect:"), workflow.indexOf("  writer:"));
const writer = workflow.slice(workflow.indexOf("  writer:"));
const runner = readFileSync(new URL("../.github/workflows/qa-private-run.yml", import.meta.url), "utf8");
const poolRunner = runner.slice(runner.indexOf("\n  pool:\n"), runner.indexOf("\n  diagnostics:\n"));

test("通常生成は有効化条件を持ち、close/明示cleanup/probeは独立したmain入口を使う", () => {
  assert.match(workflow, /pull_request_target:\s+branches: \[main\]/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
  assert.match(writer, /vars\.CAKE_QA_POOL_ENABLED == 'true'/);
  assert.match(writer, /github\.event_name == 'pull_request_target' && github\.event\.action == 'closed'/);
  assert.match(writer, /contains\(fromJSON\('\["request-preview","request-release","approve","revoke","probe","alias-only","claim","release","refresh"\]'\), inputs\.action\)/);
  assert.doesNotMatch(writer, /github\.event_name == 'schedule'/);
  assert.match(writer, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(writer, /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/);
  assert.match(writer, /startsWith\(github\.event\.pull_request\.head\.ref, 'codex\/'\)/);
});

test("全writerは同一queueへ直列化し、default pending差替や実行キャンセルを使わない", () => {
  for (const job of [inspect, writer]) {
    assert.match(job, /uses: \.\/\.github\/workflows\/qa-private-run\.yml/);
    assert.match(job, /with:\s+mode: pool/);
    assert.doesNotMatch(job, /concurrency:/);
  }
  assert.match(poolRunner, /concurrency:\s+group: cake-qa-pool-writer\s+queue: max\s+cancel-in-progress: false/);
  assert.equal(runner.match(/group: cake-qa-pool-writer/g)?.length, 1);
  assert.match(poolRunner, /timeout-minutes: 5/);
  assert.doesNotMatch(workflow, /^\s*schedule:|\bcron:/m);
});

test("資格情報を持つwriterはmainだけをcheckoutし、PRのコードや引数をshellへ挿入しない", () => {
  assert.match(poolRunner, /repository: tyask\/Cake\s+ref: refs\/heads\/main\s+persist-credentials: false/);
  assert.match(poolRunner, /inputs\.mode == 'pool' && github\.repository == 'tyask\/Cake'/);
  assert.match(poolRunner, /github\.ref == 'refs\/heads\/main'/);
  assert.match(poolRunner, /environment: Preview/);
  assert.match(poolRunner, /run: npm ci\s+- name: Run reviewed QA action/);
  assert.match(poolRunner, /export QA_TRUSTED_MAIN_SHA="\$\(git rev-parse HEAD\)"\s+node --import tsx scripts\/qa-pool-writer\.ts/);
  assert.match(poolRunner, /CAKE_QA_APPROVED_HEADS: \$\{\{ vars\.CAKE_QA_APPROVED_HEADS \}\}/);
  for (const job of [inspect, writer]) {
    assert.match(job, /uses: \.\/\.github\/workflows\/qa-private-run\.yml/);
    assert.match(job, /with:\s+mode: pool/);
    assert.doesNotMatch(job, /steps:/);
    assert.match(job, /VERCEL_TOKEN: \$\{\{ secrets\.VERCEL_TOKEN \}\}/);
    assert.match(job, /NEON_API_KEY: \$\{\{ secrets\.NEON_API_KEY \}\}/);
  }
  const install = poolRunner.slice(poolRunner.indexOf("- name: Install trusted dependencies"), poolRunner.indexOf("- name: Run reviewed QA action"));
  assert.doesNotMatch(install, /secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY/);
  for (const source of [workflow, poolRunner]) {
    assert.doesNotMatch(source, /ref:.*(?:head\.sha|head\.ref|pull_request\.merge_commit_sha)/);
    assert.doesNotMatch(source, /run:.*\$\{\{.*(?:inputs\.|pull_request\.)/);
  }
});

test("検査jobはDeployments readだけを持ち、変更jobへ検査actionを流さない", () => {
  assert.match(inspect, /github\.event_name == 'workflow_dispatch'/);
  assert.match(inspect, /github\.ref == 'refs\/heads\/main'/);
  assert.match(inspect, /contains\(fromJSON\('\["preflight","plan-probe","plan-release"\]'\), inputs\.action\)/);
  assert.match(inspect, /deployments: read/);
  assert.doesNotMatch(inspect, /deployments: write/);
  assert.match(inspect, /production_database_host: \$\{\{ vars\.CAKE_QA_PRODUCTION_DATABASE_HOST \}\}/);
  assert.match(poolRunner, /CAKE_QA_PRODUCTION_DATABASE_HOST: \$\{\{ secrets\.production_database_host \}\}/);
  assert.doesNotMatch(poolRunner, /^    permissions:/m);
  assert.match(writer, /deployments: write/);
  assert.match(writer, /!contains\(fromJSON\('\["preflight","plan-probe","plan-release"\]'\), inputs\.action\)/);
});

test("生成probeと削除には専用manifest環境値を渡し、旧pool全体booleanで削除しない", () => {
  assert.match(poolRunner, /CAKE_QA_DELETE_APPROVALS: \$\{\{ secrets\.delete_approvals \}\}/);
  assert.match(poolRunner, /CAKE_QA_ALIAS_APPROVALS: \$\{\{ secrets\.alias_approvals \}\}/);
  assert.match(poolRunner, /CAKE_QA_PROBE_APPROVALS: \$\{\{ vars\.CAKE_QA_PROBE_APPROVALS \}\}/);
  assert.match(writer, /source_sha: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(poolRunner, /QA_SOURCE_SHA: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(inspect, /slot: \$\{\{ inputs\.slot \}\}/);
  assert.match(poolRunner, /QA_SLOT: \$\{\{ inputs\.slot \}\}/);
  for (const source of [workflow, poolRunner]) assert.doesNotMatch(source, /CAKE_QA_DELETE_APPROVED/);
});

test("alias-onlyはmainの単一writerで既存候補の全識別入力を渡す", () => {
  assert.match(workflow, /options: \[request-preview, request-release, approve, revoke, preflight, plan-probe, plan-release, probe, alias-only, claim, release, refresh\]/);
  assert.match(workflow, /deployment_id:\n        description: Existing READY deployment ID \(alias-only\)\n        required: false\n        type: string/);
  for (const name of ["pr_number", "source_sha", "slot", "lease_id", "deployment_id"]) {
    assert.match(writer, new RegExp(`${name}: \\$\\{\\{ inputs\\.${name} \\}\\}`));
  }
  assert.match(poolRunner, /QA_DEPLOYMENT_ID: \$\{\{ inputs\.deployment_id \}\}/);
  assert.match(writer, /deployments: write/);
  assert.doesNotMatch(workflow, /secrets: inherit/);
});

test("owner承認はmainの同一writerでplan IDとactual run titleを結び、権限を拡大しない", () => {
  assert.match(workflow, /run-name: Cake QA.*inputs\.action.*inputs\.plan_id/);
  assert.match(writer, /plan_id: \$\{\{ inputs\.plan_id \}\}/);
  assert.match(poolRunner, /QA_PLAN_ID: \$\{\{ inputs\.plan_id \}\}/);
  assert.match(poolRunner, /QA_OWNER_FLOW: "true"/);
  for (const source of [workflow, runner]) assert.doesNotMatch(source, /actions: write|actions: read|pull-requests: write|contents: write/);
});

test("固定QA/feature枝のGit自動deployと固定Git枝のCIを停止する", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.git.deploymentEnabled, { "**": false, main: true });
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /^\s+- qa[123]$/m);
});
