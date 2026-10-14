import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskPreviewRegistry } from "../scripts/task-preview-registry";
import { type QaActionRequest, type QaActionResult, type QaPublicLease, qaLeaseRecordPath } from "../scripts/qa-client";
import { QA_NEON_PROJECT_ID } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, type WorkflowExecutor, type WorkflowCommandResult } from "../scripts/task-workflow";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/qa-client-preview";
const leaseId = "00000000-0000-4000-8000-000000000001";
const qaHost = "ep-preview.mock.aws.neon.tech";
const databaseDigest = createHash("sha256").update(qaHost).digest("hex");
const productionDigest = createHash("sha256").update("ep-production.mock.aws.neon.tech").digest("hex");
const database = { projectId: QA_NEON_PROJECT_ID, branchId: "br-preview", endpointId: "ep-preview" } as const;
const config = { git: { deploymentEnabled: { "**": false, main: true } } };
const bytes = Buffer.from(JSON.stringify(config));
const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const result = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
const encoded = (value: unknown) => result(JSON.stringify(value));

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-qa-client-preview-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let lease: QaPublicLease = { slot: "qa1", state: "reserved", leaseId, pr: 46, branch, headSha: sha, version: 1,
    deployments: [], productionHostDigest: productionDigest };
  const state = { full: false, projectRepoId: 1234, applicationError: false,
    queuedReads: 0, alreadyPublished: false, beginFailure: false,
    databaseDigest: databaseDigest as string | undefined, applicationBeginMutation: "" };
  const requests: QaActionRequest[] = [], calls: { command: string; args: readonly string[] }[] = [], logs: string[] = [], sleeps: number[] = [];
  const bodies: Record<string, unknown>[] = [], temporaryFiles: string[] = [];
  const remotes = new Map<string, Record<string, unknown>>();
  let clock = 0;
  const request = async (input: QaActionRequest): Promise<QaActionResult> => {
    requests.push(input);
    if (input.action === "reserve" && state.full) return { protocol: "cake-qa-result/v1", requestId: "00000000-0000-4000-8000-000000000002",
      action: "reserve", status: "full", payload: null, workflowUrl: "https://github.com/tyask/Cake/actions/runs/1" };
    if (input.action === "begin") {
      if (state.beginFailure) throw new Error("pending intent");
      lease = { ...lease, state: "reserved", headSha: sha, version: lease.version + 1, readyDeploymentId: undefined, aliasSha: undefined };
      if (input.phase === "application") {
        if (state.applicationBeginMutation === "hash") lease.databaseHostDigest = "c".repeat(64);
        if (state.applicationBeginMutation === "missingHash") lease.databaseHostDigest = undefined;
        if (state.applicationBeginMutation === "prodEqual") lease.productionHostDigest = lease.databaseHostDigest;
        if (state.applicationBeginMutation === "lease") lease.leaseId = "00000000-0000-4000-8000-000000000009";
        if (state.applicationBeginMutation === "pr") lease.pr = 47;
        if (state.applicationBeginMutation === "branch") lease.branch = "codex/OTHER";
        if (state.applicationBeginMutation === "sha") lease.headSha = "c".repeat(40);
        if (state.applicationBeginMutation === "endpoint") lease.database = { ...database, endpointId: "ep-OTHER" };
      }
    }
    if (input.action === "register") {
      const remote = remotes.get(input.deploymentId!)!;
      const known = lease.deployments.some((entry) => entry.id === input.deploymentId);
      lease = { ...lease, database, databaseHostDigest: state.databaseDigest, version: lease.version + 1,
        deployments: known ? lease.deployments : [...lease.deployments, { id: input.deploymentId!, sha, phase: input.phase!, url: `https://cake-${input.deploymentId!.replaceAll("_", "-")}.vercel.app` }],
        readyDeploymentId: input.phase === "application" && remote.readyState === "READY" ? input.deploymentId : undefined };
    }
    return { protocol: "cake-qa-result/v1", requestId: "00000000-0000-4000-8000-000000000002", action: input.action,
      status: "success", payload: lease, workflowUrl: "https://github.com/tyask/Cake/actions/runs/1" };
  };
  const execute: WorkflowExecutor = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return result(branch);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return result(sha);
      if (args[0] === "rev-parse" && args[1] === `${sha}:vercel.json`) return result(blob);
      if (args[0] === "status") return result();
      if (args[0] === "show") return encoded(config);
      if (args[0] === "remote") return result("git@github.com:tyask/Cake.git");
      if (args[0] === "ls-remote") return result(`${sha}\trefs/heads/${branch}`);
    }
    if (command === "gh") {
      if (args[0] === "pr") return encoded([{ number: 46, url: "https://github.com/tyask/Cake/pull/46", headRefOid: sha, isDraft: true }]);
      if (args.at(-1) === "repos/tyask/Cake/branches/main") return encoded({ name: "main", commit: { sha: mainSha } });
      if (args.at(-1) === `repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`) return encoded({ type: "file", path: "vercel.json", name: "vercel.json",
        size: bytes.length, encoding: "base64", sha: blob, content: bytes.toString("base64") });
    }
    if (command === "npx") {
      const path = args[3];
      assert.equal(new URL(path, "https://api.vercel.com").searchParams.get("teamId"), "team_D1Mcx2TdFWPKcypfu8KzNMub");
      if (path.startsWith("/v9/projects/")) return encoded({ id: CAKE_VERCEL_PROJECT, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
        link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main", repoId: state.projectRepoId } });
      if (path.startsWith("/v13/deployments?") && new URL(path, "https://api.vercel.com").searchParams.get("forceNew") === "1") {
        const file = args[args.indexOf("--input") + 1]; temporaryFiles.push(file);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        const body = JSON.parse(await readFile(file, "utf8")); bodies.push(body);
        const id = body.meta.cakeQaPhase === "provisioning" ? "dpl_native" : "dpl_application";
        const remote = { id, projectId: CAKE_VERCEL_PROJECT, target: null, gitSource: body.gitSource, meta: body.meta, readyState: "QUEUED",
          url: `cake-${id.replaceAll("_", "-")}.vercel.app` };
        remotes.set(id, remote); return encoded(remote);
      }
      if (path.startsWith("/v13/deployments/")) {
        const id = path.split("/").at(-1)!.split("?")[0];
        const remote = remotes.get(id)!;
        if (state.queuedReads > 0) { state.queuedReads--; return encoded(remote); }
        remote.readyState = id === "dpl_native" || state.applicationError ? "ERROR" : "READY";
        return encoded(remote);
      }
    }
    assert.fail(`Unexpected ${command} ${args.join(" ")}`);
  };
  const options = { cwd, execute, request, log: (message: string) => { logs.push(message); }, now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; }, timeoutMs: 100, pollIntervalMs: 10, globalConfig: "/test/private-vercel-config" };
  return { state, cwd, logs, calls, requests, bodies, sleeps, temporaryFiles, options, remotes,
    setLease: (value: QaPublicLease) => { lease = value; } };
}

test("Cloud/PC共通PreviewはActions予約後にCLI gitSourceで二段階生成し固有URL検証前にaliasを公開しない", async t => {
  const f = await fixture(t);
  const result = await runTaskPreviewRegistry(f.options);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") assert.fail();
  assert.equal(result.record.url, "https://cake-dpl-application.vercel.app");
  assert.deepEqual(result.record.database, database);
  assert.equal(f.bodies.length, 2);
  assert.deepEqual(f.bodies[0].gitSource, { type: "github", repoId: 1234, ref: branch, sha });
  assert.equal((f.bodies[0].env as Record<string, string>).CAKE_QA_DATABASE_HOST_SHA256, "");
  assert.equal((f.bodies[1].env as Record<string, string>).CAKE_QA_DATABASE_HOST_SHA256, databaseDigest);
  assert.equal((f.bodies[1].env as Record<string, string>).CAKE_QA_DATABASE_HOST, undefined);
  assert.equal((f.bodies[1].env as Record<string, string>).CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256, productionDigest);
  assert.deepEqual(f.requests.map((r) => r.action), ["reserve", "begin", "register", "register", "begin", "register", "register"]);
  assert.equal(f.requests.some((r) => r.action === "publish"), false);
  assert.equal(f.calls.some((c) => c.args.includes("alias")), false);
  assert.ok(f.calls.filter(c => c.command === "npx").every(c => c.args.includes("/test/private-vercel-config")));
  assert.equal(f.logs.some(log => log.includes("PRIVATE") || log.includes(qaHost)), false);
  const cache = await readFile(qaLeaseRecordPath(f.cwd), "utf8");
  assert.equal(cache.includes(qaHost) || cache.includes("PRIVATE"), false);
  for (const file of f.temporaryFiles) await assert.rejects(readFile(file), /ENOENT/);
});

test("満枠ならVercelへの操作なしでdraft終了する", async t => {
  const f = await fixture(t); f.state.full = true;
  assert.equal((await runTaskPreviewRegistry(f.options)).status, "FULL");
  assert.equal(f.calls.some(c => c.command === "npx"), false);
  assert.equal(f.sleeps.length, 0);
});

test("同PR更新は確認済みDBを保持してapplicationだけ作成する", async t => {
  const f = await fixture(t);
  f.setLease({ slot: "qa1", state: "reserved", leaseId, pr: 46, branch, headSha: "c".repeat(40), version: 5,
    deployments: [], database, databaseHostDigest: databaseDigest, productionHostDigest: productionDigest });
  await runTaskPreviewRegistry(f.options);
  assert.equal(f.bodies.length, 1);
  assert.equal((f.bodies[0].meta as Record<string, string>).cakeQaPhase, "application");
});

test("公開済み同HEADはActionsのlive statusを再確認して生成を省略する", async t => {
  const f = await fixture(t);
  f.setLease({ slot: "qa1", state: "published", leaseId, pr: 46, branch, headSha: sha, version: 5,
    database, productionHostDigest: productionDigest, readyDeploymentId: "dpl_application", aliasSha: sha,
    deployments: [{ id: "dpl_application", sha, phase: "application", url: "https://cake-dpl-application.vercel.app" }] });
  await runTaskPreviewRegistry(f.options);
  assert.deepEqual(f.requests.map(r => r.action), ["reserve", "status"]);
  assert.equal(f.calls.some(c => c.command === "npx"), false);
});

test("失敗applicationはREADY扱いにせず削除対象IDを台帳に残す", async t => {
  const f = await fixture(t); f.state.applicationError = true;
  await assert.rejects(runTaskPreviewRegistry(f.options));
  const saved = JSON.parse(await readFile(qaLeaseRecordPath(f.cwd), "utf8"));
  assert.ok(saved.deployments.some((d: { id: string }) => d.id === "dpl_application"));
  assert.equal(saved.readyDeploymentId, undefined);
  assert.equal(f.requests.some(r => r.action === "publish"), false);
});

test("未確定intentのbegin失敗時は新しいDeploymentを作らない", async t => {
  const f = await fixture(t); f.state.beginFailure = true;
  await assert.rejects(runTaskPreviewRegistry(f.options));
  assert.equal(f.bodies.length, 0);
});

test("確認済みQA digestが欠落・不正・本番と一致する場合はapplicationを作成しない", async t => {
  for (const invalid of [undefined, "PRIVATE_INVALID_HASH", productionDigest]) {
    const f = await fixture(t); f.state.databaseDigest = invalid;
    await assert.rejects(runTaskPreviewRegistry(f.options), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
    assert.equal(f.bodies.length, 1);
    assert.equal(f.requests.some(request => request.action === "begin" && request.phase === "application"), false);
  }
});

test("fresh begin結果のQA hashとDB/PR/lease/branch/currentSHAを作成直前に照合する", async t => {
  for (const mutation of ["hash", "missingHash", "prodEqual", "lease", "pr", "branch", "sha", "endpoint"]) {
    const f = await fixture(t); f.state.applicationBeginMutation = mutation;
    await assert.rejects(runTaskPreviewRegistry(f.options));
    assert.equal(f.bodies.length, 1);
    assert.equal((f.bodies[0].meta as Record<string, string>).cakeQaPhase, "provisioning");
  }
});

test("Cloud/PCはenv/接続文字列を取得せずsafe project linkだけ作りenvlocalを保持する", async t => {
  const f = await fixture(t), localFile = join(f.cwd, ".env.local");
  await writeFile(localFile, "PRIVATE_LOCAL_ENV_UNCHANGED", { mode: 0o600 });
  await runTaskPreviewRegistry(f.options);
  assert.equal(f.calls.some(call => call.command === "npx" && ["env", "link"].includes(call.args[2])), false);
  assert.equal(f.calls.some(call => call.args.some(arg => arg.startsWith("/v3/env/pull/"))), false);
  assert.equal(await readFile(localFile, "utf8"), "PRIVATE_LOCAL_ENV_UNCHANGED");
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, ".vercel/project.json"), "utf8")), {
    projectId: CAKE_VERCEL_PROJECT, orgId: "team_D1Mcx2TdFWPKcypfu8KzNMub", projectName: "cake" });
  for (const body of f.bodies) {
    const env = body.env as Record<string, string>;
    assert.equal(Object.hasOwn(env, "CAKE_QA_DATABASE_HOST"), false);
    assert.equal(Object.hasOwn(env, "CAKE_TEST_DATABASE_URL"), false);
    assert.equal(Object.hasOwn(env, "DATABASE_URL"), false);
    assert.deepEqual(body.build, { env });
  }
});

test("別projectのlocal linkを上書きせず作成前に停止する", async t => {
  const f = await fixture(t), directory = join(f.cwd, ".vercel");
  await mkdir(directory);
  const file = join(directory, "project.json"), previous = JSON.stringify({ projectId: "prj_OTHER", orgId: "team_OTHER" });
  await writeFile(file, previous, { mode: 0o600 });
  await assert.rejects(runTaskPreviewRegistry(f.options));
  assert.equal(await readFile(file, "utf8"), previous);
  assert.equal(f.requests.some(request => request.action === "begin"), false);
  assert.equal(f.bodies.length, 0);
});
