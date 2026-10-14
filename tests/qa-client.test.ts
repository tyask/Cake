import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQaActionReceipt, parseQaPublicLease, qaLeaseRecordPath, requestQaAction, runQaClient, type QaPublicLease } from "../scripts/qa-client";
import { QA_NEON_PROJECT_ID } from "../lib/qa-pool";
import type { WorkflowExecutor, WorkflowCommandResult } from "../scripts/task-workflow";

const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/qa-client-test";
const leaseId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const attemptId = "00000000-0000-4000-8000-000000000003";
const config = { git: { deploymentEnabled: { "**": false, main: true } } };
const configBytes = Buffer.from(JSON.stringify(config));
const blob = createHash("sha1").update(`blob ${configBytes.length}\0`).update(configBytes).digest("hex");
const lease: QaPublicLease = { slot: "qa1", state: "reserved", leaseId, pr: 46, branch, headSha: sha, version: 1,
  updatedAt: "2026-10-14T12:00:00Z", deployments: [] };
const published = (): QaPublicLease => ({ ...lease, state: "published", version: 4,
  database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-test", endpointId: "ep-test" },
  deployments: [{ id: "dpl_test", sha, phase: "application", url: "https://cake-test-fumin1.vercel.app" }],
  readyDeploymentId: "dpl_test", aliasSha: sha });
const result = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });
const encoded = (value: unknown) => result(JSON.stringify(value));

function archivedReceipt(value: unknown): Buffer {
  const contents = Buffer.from(JSON.stringify(value)), name = Buffer.from("result.json");
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + contents.length, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-qa-client-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const state = {
    status: "", origin: "git@github.com:tyask/Cake.git", mainSha, callerId: 42, draft: true,
    remoteSha: sha, remoteRepo: "tyask/Cake", prState: "open", action: "reserve", requestId,
    payload: lease as unknown, receiptStatus: "success", receiptProtocol: "cake-qa-result/v1",
    runStatus: "completed", runConclusion: "success", actorId: 42, triggerId: 42, attempt: 1,
    runMainSha: mainSha, runPath: ".github/workflows/qa-registry.yml", runRepo: "tyask/Cake",
    workflowId: 20, expired: false, artifactRunId: 100, artifactMain: mainSha,
    jobConclusion: "success", stepConclusion: "success", matches: 1, artifactMatches: 1,
    artifactSize: 2048, artifactDigest: "sha256:" + "d".repeat(64), reusableSha: mainSha,
    queuedReads: 0, downloadRaw: undefined as string | undefined,
    afterDownload: undefined as (() => void) | undefined, dispatchStatus: 0,
  };
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const logs: string[] = [], sleeps: number[] = [];
  let clock = 0;
  const run = () => ({ id: 100, workflow_id: state.workflowId, path: state.runPath, event: "workflow_dispatch", head_branch: "main",
    head_sha: state.runMainSha, run_attempt: state.attempt, display_title: `Cake QA ${state.action} ${state.requestId}`,
    repository: { id: 1, full_name: state.runRepo }, head_repository: { id: 1, full_name: "tyask/Cake" },
    actor: { id: state.actorId, type: "User" }, triggering_actor: { id: state.triggerId, type: "User" },
    referenced_workflows: [{ path: `tyask/Cake/.github/workflows/qa-registry-run.yml@${state.reusableSha}`, ref: "refs/heads/main", sha: state.reusableSha }],
    status: state.runStatus, conclusion: state.runConclusion });
  const execute: WorkflowExecutor = async (command, args, directory) => {
    calls.push({ command, args: [...args], cwd: directory });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return result(branch);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return result(sha);
      if (args[0] === "rev-parse" && args[1] === `${sha}:vercel.json`) return result(blob);
      if (args[0] === "show") return result(JSON.stringify(config));
      if (args[0] === "status") return result(state.status);
      if (args[0] === "remote") return result(state.origin);
    }
    if (command === "gh") {
      if (args[0] === "workflow") {
        state.action = args.find((arg) => arg.startsWith("action="))!.slice(7);
        state.requestId = args.find((arg) => arg.startsWith("request_id="))!.slice(11);
        return result("", state.dispatchStatus);
      }
      if (args[0] === "pr") return encoded([{ number: 46, url: "https://github.com/tyask/Cake/pull/46", headRefOid: state.remoteSha, isDraft: state.draft }]);
      if (args[0] === "run" && args[1] === "download") {
        const directory = args[args.indexOf("--dir") + 1];
        await writeFile(join(directory, "result.json"), state.downloadRaw ?? JSON.stringify({ protocol: state.receiptProtocol, requestId: state.requestId,
          action: state.action, status: state.receiptStatus, payload: state.payload }));
        state.afterDownload?.();
        return result();
      }
      if (args[0] === "api") {
        const path = args[args.length - 1];
        if (path === "user") return encoded({ id: state.callerId, login: "tyask", type: "User" });
        if (path === "repos/tyask/Cake") return encoded({ id: 1, full_name: "tyask/Cake", owner: { id: 42, login: "tyask", type: "User" } });
        if (path === "repos/tyask/Cake/branches/main") return encoded({ name: "main", commit: { sha: state.mainSha } });
        if (path === `repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`) return encoded({ type: "file", path: "vercel.json", name: "vercel.json",
          encoding: "base64", size: configBytes.length, sha: blob, content: configBytes.toString("base64") });
        if (path === "repos/tyask/Cake/pulls/46") return encoded({ number: 46, state: state.prState, draft: state.draft,
          head: { ref: branch, sha: state.remoteSha, repo: { full_name: state.remoteRepo } }, base: { ref: "main", repo: { full_name: "tyask/Cake" } } });
        if (path === "repos/tyask/Cake/actions/workflows/qa-registry.yml") return encoded({ id: 20, path: ".github/workflows/qa-registry.yml", state: "active" });
        if (path.startsWith("repos/tyask/Cake/actions/workflows/20/runs?")) return encoded({ workflow_runs: Array.from({ length: state.matches }, () => ({ id: 100,
          display_title: `Cake QA ${state.action} ${state.requestId}` })) });
        if (path === "repos/tyask/Cake/actions/runs/100") {
          if (state.queuedReads > 0) { state.queuedReads--; return encoded({ ...run(), status: "queued", conclusion: null, referenced_workflows: [] }); }
          return encoded(run());
        }
        if (path.startsWith("repos/tyask/Cake/actions/runs/100/jobs?")) return encoded({ total_count: 1, jobs: [{ run_id: 100, run_attempt: 1,
          status: "completed", conclusion: state.jobConclusion, steps: [{ status: "completed", conclusion: state.stepConclusion }] }] });
        if (path.startsWith("repos/tyask/Cake/actions/runs/100/artifacts?")) return encoded({ artifacts: Array.from({ length: state.artifactMatches }, () => ({ id: 200,
          name: `qa-result-${state.requestId}`, expired: state.expired, size_in_bytes: state.artifactSize, digest: state.artifactDigest,
          workflow_run: { id: state.artifactRunId, head_sha: state.artifactMain, head_branch: "main" } })) });
      }
    }
    assert.fail(`Unexpected ${command} ${args.join(" ")}`);
  };
  const options = { cwd, execute, log: (message: string) => { logs.push(message); }, now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; }, timeoutMs: 50, pollIntervalMs: 10 };
  const requestOptions = { ...options, head: { cwd, branch, sha }, mainSha, prNumber: 46, action: "reserve" as const, requestId };
  return { state, cwd, calls, logs, sleeps, options, requestOptions, execute };
}

test("Cloud/PC共通clientはowner main dispatchの成功receiptだけを保存しDB/Vercelを直接操作しない", async t => {
  const f = await fixture(t);
  const receipt = await runQaClient({ ...f.options, args: ["reserve"] });
  assert.equal(receipt.status, "success");
  assert.deepEqual(receipt.payload, lease);
  assert.equal(receipt.workflowUrl, "https://github.com/tyask/Cake/actions/runs/100");
  assert.deepEqual(JSON.parse(await readFile(qaLeaseRecordPath(f.cwd), "utf8")), lease);
  assert.equal((await stat(qaLeaseRecordPath(f.cwd))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.cwd, ".cake"))).mode & 0o777, 0o700);
  assert.equal(f.calls.some((call) => call.command === "npx" || call.args.includes("push")), false);
  assert.equal(f.calls.some((call) => call.args.some((arg) => arg.includes("deployments?"))), false);
  const dispatch = f.calls.find((call) => call.args[0] === "workflow")!.args;
  assert.ok(dispatch.includes("qa-registry.yml") && dispatch.includes("main") && dispatch.includes(`source_sha=${sha}`));
  assert.ok(dispatch.includes("pr_number=46"));
  assert.equal(f.sleeps.length, 0);
});

test("満枠receiptは予約待機をせずdraftのまま終了しローカル貸出を残さない", async t => {
  const f = await fixture(t); f.state.receiptStatus = "full"; f.state.payload = null;
  const receipt = await runQaClient({ ...f.options, args: ["reserve"] });
  assert.equal(receipt.status, "full"); assert.equal(receipt.payload, null);
  assert.equal(f.sleeps.length, 0);
  assert.ok(f.logs.some((message) => message.includes("draftのまま終了")));
  await assert.rejects(readFile(qaLeaseRecordPath(f.cwd)), /ENOENT/);
});

test("別環境でキャッシュがなくてもstatusで同じPR貸出を復元できる", async t => {
  const f = await fixture(t); f.state.draft = false; f.state.payload = published();
  const receipt = await runQaClient({ ...f.options, args: ["status"] });
  assert.deepEqual(receipt.payload, published());
  assert.deepEqual(JSON.parse(await readFile(qaLeaseRecordPath(f.cwd), "utf8")), published());
  assert.ok(f.logs.some((message) => message.includes("https://cake-qa1-fumin.vercel.app")));
});

test("Actionsがqueuedでも同じUUIDの実行だけ短い有限pollで待つ", async t => {
  const f = await fixture(t); f.state.queuedReads = 2;
  await requestQaAction(f.requestOptions);
  assert.deepEqual(f.sleeps, [10, 10]);
  const g = await fixture(t); g.state.matches = 0;
  await assert.rejects(requestQaAction(g.requestOptions), /待機時間内/);
  assert.deepEqual(g.sleeps, [10, 10, 10, 10, 10]);
});

test("owner以外・fork・別HEAD・dirtyではdispatch前に停止する", async t => {
  for (const scenario of ["owner", "fork", "head", "dirty", "origin"] as const) {
    const f = await fixture(t);
    if (scenario === "owner") f.state.callerId = 90;
    if (scenario === "fork") f.state.remoteRepo = "other/Cake";
    if (scenario === "head") f.state.remoteSha = "c".repeat(40);
    if (scenario === "dirty") f.state.status = " M README.md";
    if (scenario === "origin") f.state.origin = "https://github.com/other/Cake.git";
    await assert.rejects(runQaClient({ ...f.options, args: ["reserve"] }));
    assert.equal(f.calls.some((call) => call.args[0] === "workflow"), false);
  }
});

test("owner actor・trigger・main・workflow・rerun・重複requestが異なるrunを消費しない", async t => {
  for (const scenario of ["actor", "trigger", "main", "path", "workflow", "rerun", "duplicate", "repository"] as const) {
    const f = await fixture(t);
    if (scenario === "actor") f.state.actorId = 9;
    if (scenario === "trigger") f.state.triggerId = 9;
    if (scenario === "main") f.state.runMainSha = "c".repeat(40);
    if (scenario === "path") f.state.runPath = ".github/workflows/evil.yml";
    if (scenario === "workflow") f.state.workflowId = 90;
    if (scenario === "rerun") f.state.attempt = 2;
    if (scenario === "duplicate") f.state.matches = 2;
    if (scenario === "repository") f.state.runRepo = "other/Cake";
    await assert.rejects(requestQaAction(f.requestOptions));
    assert.equal(f.calls.some((call) => call.args[0] === "run"), false);
  }
});

test("失敗run・失敗job/step・期限切れ/別run/別main/重複artifactをダウンロードしない", async t => {
  for (const scenario of ["run", "job", "step", "expired", "runId", "main", "duplicate"] as const) {
    const f = await fixture(t);
    if (scenario === "run") f.state.runConclusion = "failure";
    if (scenario === "job") f.state.jobConclusion = "failure";
    if (scenario === "step") f.state.stepConclusion = "failure";
    if (scenario === "expired") f.state.expired = true;
    if (scenario === "runId") f.state.artifactRunId = 999;
    if (scenario === "main") f.state.artifactMain = "c".repeat(40);
    if (scenario === "duplicate") f.state.artifactMatches = 2;
    await assert.rejects(requestQaAction(f.requestOptions));
    assert.equal(f.calls.some((call) => call.args[0] === "run"), false);
  }
});

test("download中のmain/PR/attempt変更は結果消費前に再確認して拒否する", async t => {
  for (const scenario of ["main", "head", "rerun"] as const) {
    const f = await fixture(t);
    f.state.afterDownload = () => {
      if (scenario === "main") f.state.mainSha = "c".repeat(40);
      if (scenario === "head") f.state.remoteSha = "c".repeat(40);
      if (scenario === "rerun") f.state.attempt = 2;
    };
    await assert.rejects(requestQaAction(f.requestOptions));
    await assert.rejects(readFile(qaLeaseRecordPath(f.cwd)), /ENOENT/);
  }
});

test("ホスト・資格情報・別貸出・不正receiptの内容をログやエラーへ出さない", async t => {
  for (const payload of [{ ...lease, host: "PRIVATE_HOST" }, { ...lease, database: { projectId: QA_NEON_PROJECT_ID, branchId: "br-test", endpointId: "ep-test", host: "PRIVATE_HOST" } },
    { ...lease, leaseId: "bad_PRIVATE_TOKEN" }, { ...lease, pr: 47 }, { ...lease, deployments: [{ id: "dpl_test", sha, phase: "application", token: "PRIVATE_TOKEN" }] }]) {
    const f = await fixture(t); f.state.payload = payload;
    await assert.rejects(requestQaAction(f.requestOptions), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
    assert.equal(f.logs.some((log) => log.includes("PRIVATE")), false);
  }
  const f = await fixture(t); f.state.downloadRaw = "PRIVATE_INVALID_JSON";
  await assert.rejects(requestQaAction(f.requestOptions), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
});

test("publishは現在HEADのREADY/DB/alias一致を持つ公開済みreceiptのみ受理する", async t => {
  const f = await fixture(t); f.state.payload = published();
  const receipt = await requestQaAction({ ...f.requestOptions, action: "publish", leaseId, deploymentId: "dpl_test" });
  assert.equal(receipt.payload?.state, "published");
  const g = await fixture(t);
  await assert.rejects(requestQaAction({ ...g.requestOptions, action: "publish", leaseId, deploymentId: "dpl_test" }));
});

test("begin/registerはphaseと作成attemptを明示し古い作成を混同しない", async t => {
  const f = await fixture(t);
  await requestQaAction({ ...f.requestOptions, action: "begin", leaseId, phase: "provisioning", attemptId });
  const args = f.calls.find((call) => call.args[0] === "workflow")!.args;
  assert.ok(args.includes("phase=provisioning") && args.includes(`attempt_id=${attemptId}`) && args.includes(`lease_id=${leaseId}`));
  const g = await fixture(t);
  await assert.rejects(requestQaAction({ ...g.requestOptions, action: "register", leaseId, phase: "application", deploymentId: "dpl_test" }), /不足/);
  assert.equal(g.calls.length, 0);
});

test("releaseはclosed PRも照合しfree完了receipt以外は成功扱いしない", async t => {
  const f = await fixture(t); f.state.prState = "closed"; f.state.payload = { ...lease, state: "free", version: 5 };
  const receipt = await requestQaAction({ ...f.requestOptions, action: "release", leaseId });
  assert.equal(receipt.payload?.state, "free");
  const g = await fixture(t); g.state.payload = { ...lease, state: "deleting" };
  await assert.rejects(requestQaAction({ ...g.requestOptions, action: "release", leaseId }));
});

test("receipt parserは想定action/request/pr/leaseと公開状態の整合を検証する", () => {
  const base = { protocol: "cake-qa-result/v1", requestId, action: "reserve", status: "success", payload: lease };
  const request = { requestId, action: "reserve" as const, prNumber: 46, head: { cwd: "/tmp", branch, sha } };
  assert.deepEqual(parseQaActionReceipt(base, request).payload, lease);
  for (const change of [{ requestId: attemptId }, { action: "status" }, { protocol: "bad" }, { payload: null }, { private: "secret" }]) {
    assert.throws(() => parseQaActionReceipt({ ...base, ...change }, request));
  }
  assert.throws(() => parseQaPublicLease({ ...published(), aliasSha: "c".repeat(40) }));
  assert.throws(() => parseQaPublicLease({ ...lease, deployments: [{ id: "dpl_test", sha, phase: "application", url: "https://cake-test.vercel.app/?secret=x" }] }));
});

test("不正引数・重複引数・不足引数はコマンド実行前に拒否する", async t => {
  for (const args of [[], ["reserve", "--pr", "bad"], ["reserve", "--pr", "46", "--pr", "46"], ["status", "--unknown", "x"], ["reserve", "--lease"], ["reserve", "--sha", "bad"]]) {
    const f = await fixture(t);
    await assert.rejects(runQaClient({ ...f.options, args }));
    assert.equal(f.calls.some((call) => call.args[0] === "workflow"), false);
  }
});

test("queuedのreusable情報が未展開でも待機し成功runの正確なmain結合は必須にする", async t => {
  const f = await fixture(t); f.state.queuedReads = 1;
  await requestQaAction(f.requestOptions);
  assert.deepEqual(f.sleeps, [10]);
  const g = await fixture(t); g.state.reusableSha = "c".repeat(40);
  await assert.rejects(requestQaAction(g.requestOptions), /再利用workflow/);
  assert.equal(g.calls.some(call => call.args[0] === "run"), false);
});

test("connector cacheはauthenticated artifactのexact ZIP digest/sizeとreceiptを検証して受理する", async t => {
  const f = await fixture(t), cache = join(f.cwd, "artifact-cache");
  await mkdir(cache, { mode: 0o700 });
  const receipt = { protocol: "cake-qa-result/v1", requestId, action: "reserve", status: "success", payload: lease };
  const archive = archivedReceipt(receipt);
  f.state.artifactSize = archive.length; f.state.artifactDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  await writeFile(join(cache, "200.zip"), archive, { mode: 0o600 });
  const value = await requestQaAction({ ...f.requestOptions, artifactCacheDir: cache });
  assert.deepEqual(value.payload, lease);
  assert.equal(f.calls.some(call => call.args[0] === "run"), false);
  assert.ok(f.logs.includes(`Cake: QA artifact 200 run 100 request ${requestId} name qa-result-${requestId}`));
});

test("cacheのZIP差替え・サイズ不一致・別request・plain JSONを検証済み結果として扱わない", async t => {
  for (const scenario of ["digest", "size", "request", "json"] as const) {
    const f = await fixture(t), cache = join(f.cwd, "artifact-cache");
    await mkdir(cache, { mode: 0o700 });
    const receipt = { protocol: "cake-qa-result/v1", requestId: scenario === "request" ? attemptId : requestId,
      action: "reserve", status: "success", payload: lease };
    const archive = scenario === "json" ? Buffer.from(JSON.stringify(receipt)) : archivedReceipt(receipt);
    f.state.artifactSize = archive.length + (scenario === "size" ? 1 : 0);
    f.state.artifactDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
    const stored = scenario === "digest" ? Buffer.from(archive).fill(0, 0, 4) : archive;
    await writeFile(join(cache, "200.zip"), stored, { mode: 0o600 });
    await assert.rejects(requestQaAction({ ...f.requestOptions, artifactCacheDir: cache }), /QA結果/);
    assert.equal(f.calls.some(call => call.args[0] === "run"), false);
  }
});

test("cache取得待機は有限で保存後にもmain/run/PRを再照合する", async t => {
  const f = await fixture(t), cache = join(f.cwd, "artifact-cache");
  await mkdir(cache, { mode: 0o700 });
  await assert.rejects(requestQaAction({ ...f.requestOptions, artifactCacheDir: cache }), /取得待機時間/);
  assert.deepEqual(f.sleeps, [10, 10, 10, 10, 10]);
  assert.equal(f.calls.some(call => call.args[0] === "run"), false);
  const g = await fixture(t), otherCache = join(g.cwd, "artifact-cache");
  await mkdir(otherCache, { mode: 0o700 });
  const archive = archivedReceipt({ protocol: "cake-qa-result/v1", requestId, action: "reserve", status: "success", payload: lease });
  g.state.artifactSize = archive.length; g.state.artifactDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  let slept = false;
  await assert.rejects(requestQaAction({ ...g.requestOptions, artifactCacheDir: otherCache, sleep: async () => {
    assert.equal(slept, false); slept = true;
    await writeFile(join(otherCache, "200.zip"), archive, { mode: 0o600 });
    g.state.mainSha = "c".repeat(40);
  } }), /mainが変更/);
});

test("QA host digestは確認済みDBがある64桁hashのみ受理し本番一致やhost原文を拒否する", () => {
  const verified = { ...published(), databaseHostDigest: "c".repeat(64), productionHostDigest: "d".repeat(64) };
  assert.deepEqual(parseQaPublicLease(verified), verified);
  for (const invalid of [{ ...lease, databaseHostDigest: "c".repeat(64) }, { ...verified, databaseHostDigest: "PRIVATE_HOST" },
    { ...verified, databaseHostDigest: "d".repeat(64) }, { ...verified, databaseHostDigest: "C".repeat(64) },
    { ...verified, databaseHostDigest: "c".repeat(63) }, { ...verified, databaseHost: "PRIVATE_HOST" }]) {
    assert.throws(() => parseQaPublicLease(invalid), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
  }
});
