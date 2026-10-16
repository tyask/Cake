import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { WorkflowCommandResult, WorkflowExecutor } from "../scripts/task-workflow";
import manifest from "../docs/cannele/resource-manifest.json";

type Profile = {
  instanceId: string; repository: { id: number; fullName: string }; baseBranch: string;
  vercelProjectId: string; vercelTeamId: string; neonProjectId: string; featureBranchPrefix: string;
};
type Source = { cwd: string; branch: string; sourceSha: string; prNumber: number; draft: boolean };
type Lease = {
  leaseId: string; slot: string; branch: string; sourceSha: string; prNumber: number; state: string;
  productionHostDigest: string; databaseHostDigest?: string;
  database?: { projectId: string; branchId: string; endpointId: string };
};
type Proof = {
  prNumber: number; sourceSha: string; database: { projectId: string; branchId: string; endpointId: string };
  databaseHostDigest: string; productionHostDigest: string;
};
type Adapter = {
  source(): Promise<Source>; assertSource(expected: Source): Promise<void>;
  deploymentEnvironment(input: { profile: Profile; source: Source; lease: Lease; attemptId: string; phase: string }): Record<string, string>;
  verify(proof: Proof): Promise<unknown>; ready?: (context: unknown) => Promise<void>;
};
type Factory = (input: { profile: Profile; cwd: string; execute: WorkflowExecutor;
  readyOptions?: { title: string; verificationFile: string }; environment?: Record<string, string> }) => Promise<Adapter>;

// A URL-derived dynamic specifier exercises the actual .mjs adapter without
// adding a TypeScript declaration or importing any credential-bearing profile.
const adapterUrl = pathToFileURL(fileURLToPath(new URL("../scripts/cannele-adapter.mjs", import.meta.url))).href;
const createApplicationAdapter: Factory = async input => {
  const adapterModule = await import(adapterUrl) as { createApplicationAdapter: Factory };
  return adapterModule.createApplicationAdapter(input);
};
const sha = "a".repeat(40), mainSha = "b".repeat(40), branch = "codex/cannele-adapter", prNumber = 71;
const cwd = "/tmp/cake-cannele-adapter-fixture";
const instanceId = "10000000-0000-4000-8000-000000000001";
const leaseId = "20000000-0000-4000-8000-000000000002";
const attemptId = "30000000-0000-4000-8000-000000000003";
const productionHostDigest = "c".repeat(64), databaseHostDigest = "d".repeat(64);
const gitConfig = { git: { deploymentEnabled: { "**": false, main: true } } };
const bytes = Buffer.from(JSON.stringify(gitConfig));
const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const contents = { type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64",
  size: bytes.length, sha: blob, content: bytes.toString("base64") };
const result = (stdout = "", status = 0): WorkflowCommandResult => ({ stdout, status, signal: null });

function fixture() {
  const profile: Profile = { instanceId, repository: { id: 1001, fullName: "tyask/Cake" }, baseBranch: "main",
    vercelProjectId: "prj_Z37vquodhpRd08ZTAtYnP0qa59jD", vercelTeamId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
    neonProjectId: "misty-meadow-88903426", featureBranchPrefix: "codex/" };
  const state = { branch, sha, status: "", origin: "https://github.com/tyask/Cake.git", pushedSha: sha,
    base: mainSha, headConfig: gitConfig as unknown, mainConfig: contents as unknown, blob,
    pr: { number: prNumber, url: `https://github.com/tyask/Cake/pull/${prNumber}`, headRefOid: sha, isDraft: true }, missingPr: false };
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const execute: WorkflowExecutor = async (command, args, directory) => {
    calls.push({ command, args: [...args], cwd: directory });
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return result(cwd);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return result(state.branch);
      if (args[0] === "status") return result(state.status);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return result(state.sha);
      if (args[0] === "remote") return result(state.origin);
      if (args[0] === "show") return result(JSON.stringify(state.headConfig));
      if (args[0] === "rev-parse" && args[1] === `${state.sha}:vercel.json`) return result(state.blob);
      if (args[0] === "merge-base") return result(state.base);
      if (args[0] === "ls-remote") return result(`${state.pushedSha}\trefs/heads/${state.branch}`);
    }
    if (command === "gh" && args[0] === "api") {
      assert.ok(args.includes("GET"), "The source fixture must never perform a GitHub mutation.");
      const path = args[args.indexOf("GET") + 1];
      if (path === "repos/tyask/Cake/branches/main") return result(JSON.stringify({ name: "main", commit: { sha: mainSha } }));
      if (path === `repos/tyask/Cake/contents/vercel.json?ref=${mainSha}`) return result(JSON.stringify(state.mainConfig));
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return result(JSON.stringify(state.missingPr ? [] : [state.pr]));
    throw new Error("Unexpected fixture command; live commands and mutations are prohibited.");
  };
  const lease: Lease = { leaseId, slot: "qa1", branch, sourceSha: sha, prNumber, state: "reserved", productionHostDigest };
  const source: Source = { cwd, branch, sourceSha: sha, prNumber, draft: true };
  return { profile, state, calls, execute, lease, source,
    adapter: (readyOptions?: { title: string; verificationFile: string }) => createApplicationAdapter({ profile, cwd, execute,
      ...(readyOptions ? { readyOptions } : {}), environment: {} }) };
}

test("Cake adapter returns the clean pushed draft head only after main-only Git and ancestry checks", async () => {
  const f = fixture(); const adapter = await f.adapter();
  assert.deepEqual(await adapter.source(), f.source);
  assert.equal(adapter.ready, undefined);
  assert.ok(f.calls.some(call => call.command === "git" && call.args[0] === "merge-base" && call.args[2] === mainSha));
  assert.ok(f.calls.some(call => call.command === "git" && call.args[0] === "ls-remote" && call.args[3] === `refs/heads/${branch}`));
  const pr = f.calls.find(call => call.command === "gh" && call.args[0] === "pr");
  assert.ok(pr?.args.includes("tyask/Cake") && pr.args.includes("main") && pr.args.includes("open"));
  assert.ok(f.calls.every(call => call.cwd === cwd && call.command !== "npx"));
});

test("the actual reviewed generation reaches adapter.source while a different generation and recursive paths stop before PR/provider work", async () => {
  const f = fixture(), actualBranch = `${manifest.repository.featureBranchPrefix}qa-acceptance`;
  f.profile.instanceId = manifest.instanceId; f.profile.featureBranchPrefix = manifest.repository.featureBranchPrefix;
  f.state.branch = actualBranch; f.source.branch = actualBranch;
  const adapter = await f.adapter(); assert.deepEqual(await adapter.source(), f.source); await adapter.assertSource(f.source);
  for (const invalid of [`codex/cannele-00000000-0000-4000-8000-000000000001/qa-acceptance`, `${actualBranch}/nested`, `${manifest.repository.featureBranchPrefix}${"a".repeat(16)}`]) {
    f.state.branch = invalid; f.calls.length = 0; await assert.rejects(adapter.source());
    assert.equal(f.calls.some(call => call.command === "gh" || call.command === "npx"), false);
  }
});

test("wrong repository, base branch and provider bindings reject before any command", async () => {
  for (const change of [
    { repository: { id: 1002, fullName: "attacker/Cake" } }, { baseBranch: "feature" },
    { vercelProjectId: "prj_other" }, { vercelTeamId: "team_other" }, { neonProjectId: "other-project" },
  ]) {
    const f = fixture(); Object.assign(f.profile, change);
    await assert.rejects(f.adapter(), { code: "CAKE_BINDING_MISMATCH" });
    assert.equal(f.calls.length, 0);
  }
});

test("dirty, fork, unpushed, missing, stale and out-of-prefix sources cannot reach deployment environment", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.state.status = " M app/page.tsx"; },
    f => { f.state.origin = "https://github.com/attacker/Cake.git"; },
    f => { f.state.pushedSha = "e".repeat(40); },
    f => { f.state.missingPr = true; },
    f => { f.state.pr.headRefOid = "e".repeat(40); },
    f => { f.state.pr.url = `https://github.com/attacker/Cake/pull/${prNumber}`; },
    f => { f.profile.featureBranchPrefix = "codex/different-"; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); const adapter = await f.adapter();
    await assert.rejects(adapter.source());
    assert.ok(f.calls.every(call => call.command !== "npx" && !call.args.includes("POST")));
  }
});

test("feature deployment enablement, unverified main config, blob mismatch and stale ancestry stop before PR selection", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.state.headConfig = { git: { deploymentEnabled: { "**": false, main: true, [branch]: true } } }; },
    f => { f.state.mainConfig = { ...contents, content: Buffer.from('{"git":{"deploymentEnabled":true}}').toString("base64") }; },
    f => { f.state.blob = "e".repeat(40); },
    f => { f.state.base = "e".repeat(40); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); const adapter = await f.adapter();
    await assert.rejects(adapter.source());
    assert.equal(f.calls.some(call => call.command === "gh" && call.args[0] === "pr"), false);
  }
});

test("assertSource rereads the current pushed PR and rejects a head changed after earlier verification", async () => {
  const f = fixture(); const adapter = await f.adapter(); const expected = await adapter.source();
  f.state.sha = "e".repeat(40); f.state.pushedSha = f.state.sha; f.state.pr.headRefOid = f.state.sha;
  await assert.rejects(adapter.assertSource(expected), { code: "CAKE_SOURCE_CHANGED" });
  assert.equal(f.calls.filter(call => call.command === "git" && call.args[0] === "ls-remote").length, 2);
});

test("deployment overrides contain only bound public guard tags and require an application database", async () => {
  const f = fixture(); const adapter = await f.adapter();
  const input = { profile: f.profile, source: f.source, lease: f.lease, attemptId, phase: "provisioning" };
  const provisioning = adapter.deploymentEnvironment(input);
  assert.deepEqual(provisioning, {
    AUTH_MODE: "test", CAKE_QA_SLOT: "qa1", CAKE_QA_PR: String(prNumber), CAKE_QA_LEASE_TOKEN: leaseId,
    CAKE_QA_SOURCE_BRANCH: branch, CAKE_QA_SOURCE_SHA: sha, CAKE_QA_DATABASE_HOST_SHA256: "",
    CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: productionHostDigest,
    CANNELE_INSTANCE_ID: instanceId, CANNELE_ATTEMPT_ID: attemptId, CANNELE_PHASE: "provisioning",
  });
  const applicationLease = { ...f.lease, databaseHostDigest,
    database: { projectId: f.profile.neonProjectId, branchId: "br_application", endpointId: "ep_application" } };
  assert.equal(adapter.deploymentEnvironment({ ...input, lease: applicationLease, phase: "application" }).CAKE_QA_DATABASE_HOST_SHA256, databaseHostDigest);
  assert.doesNotMatch(JSON.stringify(provisioning), /postgres(?:ql)?:|https?:|DATABASE_URL|PASSWORD|API_KEY|SECRET/);
  const changes: Partial<Lease>[] = [
    { prNumber: prNumber + 1 }, { branch: "codex/other" }, { sourceSha: "e".repeat(40) }, { state: "published" },
    { productionHostDigest: "invalid" }, { database: undefined }, { databaseHostDigest: undefined },
    { databaseHostDigest: productionHostDigest },
    { database: { ...applicationLease.database, projectId: "other-project" } },
  ];
  for (const change of changes) assert.throws(() => adapter.deploymentEnvironment({ ...input,
    lease: { ...applicationLease, ...change }, phase: "application" }), { code: "CAKE_DATABASE_GUARD_UNCONFIRMED" });
  assert.throws(() => adapter.deploymentEnvironment({ ...input, profile: { ...f.profile, instanceId: "other-instance" } }),
    { code: "CAKE_DATABASE_GUARD_UNCONFIRMED" });
  assert.equal(f.calls.length, 0, "Guard failure must never run a deployment command.");
});

test("mismatched proof rejects before browser access and Ready exists only with explicit ready options", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Live browser/network access is prohibited."); });
  const f = fixture(); const adapter = await f.adapter();
  const proof: Proof = { prNumber, sourceSha: sha, database: { projectId: f.profile.neonProjectId, branchId: "br_application", endpointId: "ep_application" },
    databaseHostDigest, productionHostDigest };
  for (const change of [
    { prNumber: prNumber + 1 }, { sourceSha: "e".repeat(40) }, { databaseHostDigest: productionHostDigest },
    { databaseHostDigest: "invalid" }, { database: { ...proof.database, projectId: "other-project" } },
  ]) await assert.rejects(adapter.verify({ ...proof, ...change }), { code: "CAKE_PROOF_MISMATCH" });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(adapter.ready, undefined);
  const configured = await f.adapter({ title: "Reviewed change", verificationFile: "verification.md" });
  assert.equal(typeof configured.ready, "function");
  assert.equal(f.calls.some(call => call.args.includes("PATCH") || call.command === "gh" && call.args[1] === "ready"), false);
});
