import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QA_ENVIRONMENT, QA_NEON_PROJECT_ID, QA_TASK, qaAlias, type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord } from "../lib/qa-pool";
import { CAKE_VERCEL_PROJECT, previewRecordPath, readPreviewRecord, readyQaPreview,
  type PreviewProviderReader, type TaskHead, type TaskPreviewRecord, type WorkflowExecutor } from "../scripts/task-workflow";

const sha = "a".repeat(40), branch = "codex/ready-url", leaseId = "00000000-0000-4000-8000-000000000042";
const uniqueUrl = "https://cake-unique-ready.vercel.app", fixedUrl = `https://${qaAlias("qa1")}`;
const database: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: "br-ready", endpointId: "ep-ready", host: "ep-ready.mock.aws.neon.tech" };
const payload: QaLeaseRecord = { protocol: "cake-qa/v1", slot: "qa1", pr: 42, leaseId, branch, headSha: sha,
  state: "held", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:01:00Z", sequence: 2, previousRecordId: 100,
  deployments: [{ id: "dpl_ready", phase: "application", sha, url: uniqueUrl }], database,
  retiredDatabases: [], readyDeploymentId: "dpl_ready", aliasSha: sha };
const initial: GithubDeployment = { id: 100, task: QA_TASK, environment: QA_ENVIRONMENT, sha,
  payload: { ...payload, sequence: 1, previousRecordId: null, deployments: [], database: undefined, readyDeploymentId: undefined, aliasSha: undefined } };
const ready: GithubDeployment = { id: 101, task: QA_TASK, environment: QA_ENVIRONMENT, sha, payload };
const artifact: TaskPreviewRecord = { projectId: CAKE_VERCEL_PROJECT, branch, sha, url: uniqueUrl, fixedUrl,
  deploymentId: "dpl_ready", createdAt: payload.updatedAt, slot: "qa1", leaseId, prNumber: 42, ledgerRecordId: 101, database };

function fixture() {
  const head: TaskHead = { cwd: "/mock/cake", branch, sha };
  const state = { records: structuredClone([initial, ready]),
    pr: { number: 42, state: "open", head: { ref: branch, sha, repo: { full_name: "tyask/Cake" } }, base: { ref: "main" } },
    project: { id: CAKE_VERCEL_PROJECT, name: "cake", accountId: "team_D1Mcx2TdFWPKcypfu8KzNMub",
      link: { type: "github", org: "tyask", repo: "Cake", productionBranch: "main" } },
    alias: { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_ready", alias: qaAlias("qa1"), uid: "mock_alias" } as unknown,
    deployment: { id: "dpl_ready", projectId: CAKE_VERCEL_PROJECT, readyState: "READY", target: "preview", url: uniqueUrl,
      gitSource: { ref: branch, sha }, meta: { githubCommitRef: branch, githubCommitSha: sha,
        cakeQaPr: "42", cakeQaLeaseId: leaseId, cakeQaPhase: "application" } },
  };
  const calls: string[] = [];
  let before: ((path: string) => void) | undefined;
  const execute: WorkflowExecutor = async (command, args) => {
    assert.equal(command, "gh"); assert.equal(args[0], "api");
    const stdout = args.includes("--paginate") ? JSON.stringify([state.records]) : JSON.stringify(state.pr);
    return { stdout, status: 0, signal: null };
  };
  const provider: PreviewProviderReader = async (path) => {
    calls.push(path); before?.(path);
    if (path.startsWith("/v9/projects/")) return structuredClone(state.project);
    if (path.startsWith("/v4/aliases/")) return structuredClone(state.alias);
    if (path.startsWith("/v13/deployments/")) return structuredClone(state.deployment);
    assert.fail("unexpected provider mock path");
  };
  return { head, state, calls, execute, provider, setBefore: (callback: (path: string) => void) => { before = callback; },
    read: () => readyQaPreview(head, 42, execute, provider) };
}

test("fixed URL is computed only after live READY, alias, PR head and lease confirmation", async () => {
  const f = fixture();
  assert.deepEqual(await f.read(), artifact);
  assert.equal(f.calls.filter(path => path.startsWith("/v4/aliases/")).length, 2);
});

test("missing, foreign or contradictory aliases never produce a fixed preview URL", async () => {
  for (const alias of [null, "PRIVATE_BODY", {}, { projectId: "prj_foreign", deploymentId: "dpl_ready" },
    { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_foreign" },
    { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_ready", deployment: { id: "dpl_foreign" } },
    { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_ready", alias: qaAlias("qa2") },
    { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_ready", ownerId: "team_foreign" }]) {
    const f = fixture(); f.state.alias = alias; await assert.rejects(() => f.read());
  }
});

test("a stale or foreign live deployment fails even when the ledger says READY", async () => {
  for (const change of ["id", "conflicting-id", "project", "production", "building", "head", "branch", "lease", "pr", "phase", "url"] as const) {
    const f = fixture(), d = f.state.deployment;
    if (change === "id") d.id = "dpl_foreign";
    if (change === "conflicting-id") Object.assign(d, { uid: "dpl_foreign" });
    if (change === "project") d.projectId = "prj_foreign";
    if (change === "production") d.target = "production";
    if (change === "building") d.readyState = "BUILDING";
    if (change === "head") d.gitSource.sha = "b".repeat(40);
    if (change === "branch") d.gitSource.ref = "codex/foreign";
    if (change === "lease") d.meta.cakeQaLeaseId = "00000000-0000-4000-8000-000000000043";
    if (change === "pr") d.meta.cakeQaPr = "43";
    if (change === "phase") d.meta.cakeQaPhase = "provisioning";
    if (change === "url") d.url = "https://cake-foreign.vercel.app";
    await assert.rejects(() => f.read());
  }
});

test("alias reassignment, latest PR changes and a changed lease snapshot are caught before presentation", async () => {
  for (const change of ["alias", "pr", "ledger"] as const) {
    const f = fixture();
    f.setBefore(path => {
      if (!path.startsWith("/v13/deployments/")) return;
      if (change === "alias") f.state.alias = { projectId: CAKE_VERCEL_PROJECT, deploymentId: "dpl_foreign" };
      if (change === "pr") f.state.pr.head.sha = "b".repeat(40);
      if (change === "ledger") (f.state.records[1].payload as QaLeaseRecord).updatedAt = "2026-10-13T00:02:00Z";
    });
    await assert.rejects(() => f.read());
  }
});

test("unassigned or old alias SHA returns pending without provider reads", async () => {
  for (const aliasSha of [undefined, "b".repeat(40)]) {
    const f = fixture(), record = f.state.records[1].payload as QaLeaseRecord;
    record.aliasSha = aliasSha;
    if (aliasSha) {
      record.headSha = aliasSha; record.deployments[0].sha = aliasSha; f.state.records[1].sha = aliasSha;
    }
    assert.equal(await f.read(), null); assert.equal(f.calls.length, 0);
  }
});

test("provider errors cannot leak their response body, host or token", async () => {
  const f = fixture(), secret = `PRIVATE_BODY ${database.host} PRIVATE_TOKEN`;
  await assert.rejects(() => readyQaPreview(f.head, 42, f.execute, async () => { throw new Error(secret); }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("PRIVATE_BODY"), false);
    assert.equal(error.message.includes(database.host), false); assert.equal(error.message.includes("PRIVATE_TOKEN"), false); return true;
  });
});

async function saved(t: TestContext, value: unknown) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-preview-artifact-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".cake")); await writeFile(previewRecordPath(cwd), JSON.stringify(value)); return cwd;
}

test("legacy unique-URL artifacts still parse, while fixed URL is an exact computed field", async t => {
  const legacy = { ...artifact }; delete legacy.fixedUrl;
  assert.deepEqual(await readPreviewRecord(await saved(t, legacy)), legacy);
  assert.deepEqual(await readPreviewRecord(await saved(t, artifact)), artifact);
  for (const invalid of [qaAlias("qa1"), `https://${qaAlias("qa2")}`, `${fixedUrl}/`, `${fixedUrl}?token=PRIVATE_TOKEN`, uniqueUrl, null]) {
    await assert.rejects(async () => readPreviewRecord(await saved(t, { ...artifact, fixedUrl: invalid })));
  }
});
