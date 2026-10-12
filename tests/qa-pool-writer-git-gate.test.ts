import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HttpQaGateway, runQaWriter, type QaTransport } from "../scripts/qa-pool-writer";
import { runQaRequest, type QaRequest } from "../lib/qa-pool-service";
import { QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, replayDeployments,
  type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";

const targetSha = "a".repeat(40), mainSha = "b".repeat(40), changedMainSha = "c".repeat(40), secondSha = "d".repeat(40);
const approvedConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
type ApiResponse = { status: number; data: unknown };
function gitFile(config: unknown = approvedConfig): ApiResponse {
  const bytes = Buffer.from(typeof config === "string" ? config : JSON.stringify(config));
  return { status: 200, data: { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64",
    size: bytes.length, content: bytes.toString("base64"),
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") } };
}
function pr(number = 42, sha = targetSha) {
  return { number, state: "open", head: { ref: `codex/task-${number}`, sha, repo: { full_name: QA_REPOSITORY } }, base: { ref: "main" } };
}
class WriterFixture {
  env: Record<string, string | undefined> = {
    GITHUB_TOKEN: "fixture-private-github", VERCEL_TOKEN: "fixture-private-vercel", NEON_API_KEY: "fixture-private-neon",
    CAKE_QA_POOL_ENABLED: "true", CAKE_QA_GIT_GATE_CONFIRMED: "true", CAKE_QA_NATIVE_CONFIRMED: "true",
    CAKE_QA_APPROVED_HEADS: JSON.stringify({ "42": targetSha, "43": secondSha }),
    CAKE_QA_PARENT_BRANCH_ID: "br-parent", CAKE_QA_PRODUCTION_DATABASE_HOST: "ep-production.ap-southeast-1.aws.neon.tech",
  };
  project = { id: QA_PROJECT_ID, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub", previewDeploymentsDisabled: false,
    // Hobby has no Deployment Sources policy override.
    link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: 1318171856 } };
  main = mainSha;
  prs = new Map([[42, pr()]]);
  configs = new Map<string, ApiResponse>([[mainSha, gitFile()], [targetSha, gitFile()], [secondSha, gitFile()]]);
  mainResponse?: ApiResponse;
  records: GithubDeployment[] = [];
  calls: { method: string; path: string; ref: string | null; body?: unknown }[] = [];
  onSave?: (record: QaLeaseRecord) => void;
  beforeConfig?: (sha: string) => void;
  request: QaTransport = async (method, address, _token, body) => {
    const url = new URL(address), path = url.pathname.replace(/^\/api\/v2(?=\/)/, "");
    this.calls.push({ method, path, ref: url.searchParams.get("ref"), body });
    if (method === "GET" && path === `/v9/projects/${QA_PROJECT_ID}`) return { status: 200, data: structuredClone(this.project) };
    if (method === "GET" && path === `/projects/${QA_NEON_PROJECT_ID}`) return { status: 200, data: { project: { id: QA_NEON_PROJECT_ID } } };
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/branches/main`) return structuredClone(this.mainResponse ?? { status: 200, data: { name: "main", commit: { sha: this.main } } });
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/contents/vercel.json`) {
      const ref = url.searchParams.get("ref")!;
      assert.match(ref, /^[a-f0-9]{40}$/, "Git config reads must use immutable complete commit SHAs");
      this.beforeConfig?.(ref);
      return structuredClone(this.configs.get(ref) ?? { status: 404, data: { message: "fixture-private-response" } });
    }
    if (method === "GET" && path === `/repos/${QA_REPOSITORY}/pulls`) return { status: 200, data: [...this.prs.values()].map((value) => structuredClone(value)) };
    if (method === "GET" && path.startsWith(`/repos/${QA_REPOSITORY}/pulls/`)) return { status: 200, data: structuredClone(this.prs.get(Number(path.split("/").at(-1)))) };
    if (path === `/repos/${QA_REPOSITORY}/deployments`) {
      if (method === "GET") return { status: 200, data: structuredClone(this.records) };
      assert.equal(method, "POST");
      const value = body as { ref: string; payload: QaLeaseRecord; task: string; environment: string };
      const saved = { id: this.records.length + 1, sha: value.ref, payload: structuredClone(value.payload), task: value.task, environment: value.environment };
      this.records.push(saved);
      this.onSave?.(saved.payload);
      return { status: 201, data: structuredClone(saved) };
    }
    if (method === "GET" && path === "/v7/deployments") return { status: 200, data: { deployments: [], pagination: { next: null } } };
    if (method === "POST" && path === "/v13/deployments") {
      const value = body as { gitSource: { ref: string; sha: string }; meta: Record<string, string> };
      return { status: 200, data: { id: "dpl_fixture", projectId: QA_PROJECT_ID, readyState: "BUILDING", target: null,
        gitSource: value.gitSource, meta: { ...value.meta, githubCommitRef: value.gitSource.ref, githubCommitSha: value.gitSource.sha } } };
    }
    assert.fail(`unexpected fixture API: ${method} ${path}`);
  };
  gateway() { return new HttpQaGateway(this.env, this.request, "write"); }
  async run(request: QaRequest = { action: "claim", pr: 42 }) {
    let tokens = 1000;
    return runQaRequest(this.gateway(), request, { now: () => "2026-10-12T01:00:00.000Z", token: () => uuid(++tokens), log: () => {} });
  }
  probe() {
    for (const key of ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED"]) this.env[key] = "false";
    this.env.CAKE_QA_PROBE_APPROVALS = JSON.stringify([{ projectId: QA_PROJECT_ID, pr: 42, sha: targetSha, slot: "qa2", expiresAt: "2099-01-01T00:00:00.000Z" }]);
    return this.run({ action: "probe", pr: 42, sha: targetSha });
  }
  vercelPosts() { return this.calls.filter((call) => call.method === "POST" && call.path === "/v13/deployments"); }
  assertNoMutation() { assert.equal(this.records.length, 0); assert.equal(this.calls.some((call) => call.method !== "GET"), false); }
}

test("Hobbyのpolicy未設定でもmainと対象commitのGit停止設定が一致すれば通常生成できる", async () => {
  const f = new WriterFixture();
  await f.run();
  const record = replayDeployments(f.records).qa1!.payload;
  assert.equal(record.pr, 42); assert.equal(record.deployments[0].phase, "provisioning");
  assert.equal(f.vercelPosts().length, 1);
  assert.ok(f.calls.filter((call) => call.path.endsWith("/contents/vercel.json") && call.ref === mainSha).length >= 3);
  assert.ok(f.calls.filter((call) => call.path.endsWith("/contents/vercel.json") && call.ref === targetSha).length >= 3);
  assert.equal(f.calls.some((call) => call.path.includes("/teams/") || call.path.includes("deployment-policy")), false);
  const postIndex = f.calls.findIndex((call) => call.method === "POST" && call.path === "/v13/deployments");
  assert.equal(f.calls[postIndex - 1].path, `/repos/${QA_REPOSITORY}/pulls/42`);
  assert.equal(f.calls[postIndex - 2].path, `/repos/${QA_REPOSITORY}/contents/vercel.json`);
  assert.equal(f.calls[postIndex - 2].ref, targetSha);
});

test("限定probeは五項目承認とGit設定の証明でflags falseのまま単一枠を取得する", async () => {
  const f = new WriterFixture(), before = structuredClone(f.env);
  await f.probe();
  const record = replayDeployments(f.records).qa2!.payload;
  assert.equal(record.purpose, "probe"); assert.equal(record.pr, 42); assert.equal(f.vercelPosts().length, 1);
  for (const key of ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED"]) assert.equal(f.env[key], "false");
  for (const key of ["GITHUB_TOKEN", "VERCEL_TOKEN", "NEON_API_KEY"]) assert.equal(f.env[key], before[key]);
  assert.equal(f.calls.some((call) => call.path.includes("/aliases")), false);
});

test("Git設定が適合しても通常生成は既存Git/Native確認flagと最新SHA承認を必要とする", async () => {
  for (const failure of ["CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED", "approval"] as const) {
    const f = new WriterFixture();
    if (failure === "approval") f.env.CAKE_QA_APPROVED_HEADS = "{}";
    else f.env[failure] = "false";
    if (failure === "approval") await f.run();
    else await assert.rejects(() => f.run());
    f.assertNoMutation();
  }
});

test("mainまたは対象設定が欠落・無効・403/404ならclaim/probeとも台帳と生成POSTを行わない", async () => {
  const bad = [gitFile({}), gitFile({ git: { deploymentEnabled: true } }), gitFile({ git: { deploymentEnabled: { "**": false, main: true, "codex/*": true } } }),
    gitFile("{private-unparseable"), { status: 401, data: { message: "fixture-private-response" } },
    { status: 403, data: { message: "fixture-private-response" } }, { status: 404, data: null }];
  for (const mode of ["claim", "probe"] as const) for (const ref of [mainSha, targetSha]) for (const response of bad) {
    const f = new WriterFixture(); f.configs.set(ref, response);
    await assert.rejects(mode === "probe" ? () => f.probe() : () => f.run(), (error: Error) => {
      assert.equal(error.message.includes("private"), false); return true;
    });
    f.assertNoMutation();
  }
});

test("main取得の403/404・短いSHA・別branch応答は生成前に停止する", async () => {
  for (const response of [{ status: 403, data: null }, { status: 404, data: null },
    { status: 200, data: { name: "main", commit: { sha: mainSha.slice(0, 7) } } },
    { status: 200, data: { name: "other", commit: { sha: mainSha } } }]) {
    const f = new WriterFixture(); f.mainResponse = response;
    await assert.rejects(() => f.run()); f.assertNoMutation();
  }
});

test("貸出とintentの保存後にmain設定が変わればREST直前の再証明で生成を止める", async () => {
  const f = new WriterFixture();
  f.configs.set(changedMainSha, gitFile({}));
  f.onSave = (record) => { if (record.intent) f.main = changedMainSha; };
  await assert.rejects(() => f.run());
  assert.equal(f.vercelPosts().length, 0);
  const record = replayDeployments(f.records).qa1!.payload;
  assert.equal(record.state, "held"); assert.ok(record.intent);
  assert.deepEqual(record.deployments, []);
  assert.ok(f.calls.some((call) => call.path.endsWith("/contents/vercel.json") && call.ref === changedMainSha));
});

test("別PRの生成ゲートを共有せず、二番目の不適合設定では追加leaseを保存しない", async () => {
  const f = new WriterFixture(); f.prs.set(43, pr(43, secondSha)); f.configs.set(secondSha, gitFile({}));
  await assert.rejects(() => f.run({ action: "refresh" }));
  assert.equal(f.vercelPosts().length, 1);
  assert.equal(f.records.some((entry) => (entry.payload as QaLeaseRecord).pr === 43), false);
  assert.ok(f.calls.some((call) => call.path.endsWith("/contents/vercel.json") && call.ref === secondSha));
});

test("対象probeのfork・別base・closed・現在SHA不一致はlease保存前に拒否する", async () => {
  for (const failure of ["fork", "base", "closed", "sha"] as const) {
    const f = new WriterFixture(), target = f.prs.get(42)!;
    if (failure === "fork") target.head.repo.full_name = "other/Cake";
    if (failure === "base") target.base.ref = "other";
    if (failure === "closed") target.state = "closed";
    if (failure === "sha") target.head.sha = secondSha;
    await assert.rejects(() => f.probe()); f.assertNoMutation();
    assert.equal(f.calls.some((call) => call.path.endsWith("/contents/vercel.json")), false);
  }
});

test("REST直前のGit設定読取中にPRがclose・head変更・承認取消されても生成しない", async () => {
  for (const failure of ["closed", "sha", "approval"] as const) {
    const f = new WriterFixture();
    f.onSave = (record) => {
      if (!record.intent) return;
      f.beforeConfig = (ref) => {
        if (ref !== targetSha) return;
        if (failure === "closed") f.prs.get(42)!.state = "closed";
        if (failure === "sha") f.prs.get(42)!.head.sha = secondSha;
        if (failure === "approval") f.env.CAKE_QA_APPROVED_HEADS = "{}";
      };
    };
    await assert.rejects(() => f.run()); assert.equal(f.vercelPosts().length, 0);
  }
});

test("cleanupゲートはGit設定やPreview生成flagに依存せず、既存projectとNeon所属だけを読む", async () => {
  const f = new WriterFixture();
  f.env.CAKE_QA_POOL_ENABLED = "false"; f.env.CAKE_QA_GIT_GATE_CONFIRMED = "false"; f.env.CAKE_QA_NATIVE_CONFIRMED = "false";
  f.project.previewDeploymentsDisabled = true; f.configs.clear();
  await f.gateway().assertGate("cleanup");
  assert.equal(f.calls.some((call) => call.path.includes("/contents/") || call.path.includes("/branches/main") || call.path.includes("/pulls/")), false);
  assert.ok(f.calls.every((call) => call.method === "GET"));
});

test("main以外のActions実行はtarget設定が適合しても外部APIに到達しない", async () => {
  const f = new WriterFixture();
  await assert.rejects(() => runQaWriter({ ...f.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: QA_REPOSITORY,
    GITHUB_REF: "refs/heads/codex/task-42" }, { action: "claim", pr: 42 }, undefined, f.request), /信頼済みmain/);
  assert.equal(f.calls.length, 0);
});

test("Preview有効状態・account・repo・productionBranchの不一致は生成前に停止する", async () => {
  for (const failure of ["preview", "account", "repo", "productionBranch"] as const) {
    const f = new WriterFixture();
    if (failure === "preview") f.project.previewDeploymentsDisabled = true;
    if (failure === "account") f.project.accountId = "team_other";
    if (failure === "repo") f.project.link.repo = "Other";
    if (failure === "productionBranch") f.project.link.productionBranch = "other";
    await assert.rejects(() => f.run()); f.assertNoMutation();
  }
});
