import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/qa-pool.yml", import.meta.url), "utf8");

test("固定QA writerは有効化前/外部PR/非main手動実行をjob入口で拒否する", () => {
  assert.match(workflow, /pull_request_target:\s+branches: \[main\]/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, closed\]/);
  assert.match(workflow, /vars\.CAKE_QA_POOL_ENABLED == 'true'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /startsWith\(github\.event\.pull_request\.head\.ref, 'codex\/'\)/);
});

test("全writerは同一queueへ直列化し、default pending差替や実行キャンセルを使わない", () => {
  assert.match(workflow, /concurrency:\s+group: cake-qa-pool-writer\s+queue: max\s+cancel-in-progress: false/);
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
  const install = workflow.slice(workflow.indexOf("- name: Install trusted dependencies"), workflow.indexOf("- name: Reconcile QA pool"));
  assert.doesNotMatch(install, /secrets\.|GITHUB_TOKEN|VERCEL_TOKEN|NEON_API_KEY/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{.*(?:inputs\.|pull_request\.)/);
});

test("固定QA/feature枝のGit自動deployと固定Git枝のCIを停止する", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.git.deploymentEnabled, { "**": false, main: true });
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /^\s+- qa[123]$/m);
});
