import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qaAlias, type QaDeployment } from "../lib/qa-pool";
import { requestQaAction, saveQaLease, type QaActionRequest, type QaActionResult, type QaPublicLease } from "./qa-client";
import { assertTaskGitGate, CAKE_VERCEL_PROJECT, CAKE_VERCEL_SCOPE, cleanTaskHead, commandOutput,
  executeWorkflowCommand, previewUrl, taskPullRequests, type TaskHead, type WorkflowExecutor } from "./task-workflow";

const CLI_VERSION = "64.0.2";
const TEAM_ID = "team_D1Mcx2TdFWPKcypfu8KzNMub";
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const deploymentId = (value: unknown): value is string => typeof value === "string" && /^dpl_[A-Za-z0-9_-]+$/.test(value);
const hostDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const failure = () => new Error("Previewを完了できませんでした。貸出を保持しています。記録済みDeploymentとActionsを確認して同じ作業を再開してください。");

export type RegistryPreviewRecord = {
  protocol: "cake-qa-preview/v2"; projectId: string; branch: string; sha: string; url: string; deploymentId: string;
  slot: QaPublicLease["slot"]; leaseId: string; prNumber: number; registryVersion: number; createdAt: string;
  database: NonNullable<QaPublicLease["database"]>;
};
export type RegistryPreviewResult = { status: "READY"; payload: QaPublicLease; record: RegistryPreviewRecord }
  | { status: "FULL"; payload: null; workflowUrl: string };
type Options = {
  args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void;
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>; timeoutMs?: number; pollIntervalMs?: number;
  globalConfig?: string; request?: (input: QaActionRequest) => Promise<QaActionResult>;
};

function cliArgs(args: readonly string[], globalConfig?: string): string[] {
  return ["--yes", `vercel@${CLI_VERSION}`, ...args, "--scope", CAKE_VERCEL_SCOPE,
    ...(globalConfig ? ["--global-config", globalConfig] : [])];
}

async function vercelApi(execute: WorkflowExecutor, cwd: string, path: string, globalConfig?: string, body?: unknown) {
  let directory: string | undefined;
  try {
    const target = new URL(path, "https://api.vercel.com");
    if (target.origin !== "https://api.vercel.com") throw failure();
    target.searchParams.set("teamId", TEAM_ID);
    const args = ["api", `${target.pathname}${target.search}`, "--method", body === undefined ? "GET" : "POST"];
    if (body !== undefined) {
      directory = await mkdtemp(join(tmpdir(), "cake-qa-api-"));
      const file = join(directory, "request.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600, flag: "wx" });
      args.push("--input", file);
    }
    const raw = await commandOutput(execute, "npx", cliArgs(args, globalConfig), cwd, failure().message);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw failure(); }
    if (!object(value)) throw failure();
    return value;
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}

async function ensureProjectLink(cwd: string) {
  // Link only the verified IDs. `vercel link` can download Development secrets;
  // neither that command nor any environment/connection-string pull is needed.
  const projectFile = resolve(cwd, ".vercel/project.json");
  let existing: unknown;
  try { existing = JSON.parse(await readFile(projectFile, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); }
  if (existing !== undefined) {
    if (!object(existing) || existing.projectId !== CAKE_VERCEL_PROJECT || existing.orgId !== TEAM_ID) throw failure();
  } else {
    await mkdir(resolve(cwd, ".vercel"), { recursive: true, mode: 0o700 });
    await writeFile(projectFile, JSON.stringify({ projectId: CAKE_VERCEL_PROJECT, orgId: TEAM_ID, projectName: "cake" }), { mode: 0o600, flag: "wx" });
  }
}

function assertRemote(value: Record<string, unknown>, lease: QaPublicLease, head: TaskHead, phase: QaDeployment["phase"], attemptId?: string) {
  const meta = value.meta;
  const source = value.gitSource;
  if (!deploymentId(value.id) || value.projectId !== CAKE_VERCEL_PROJECT || ![undefined, null, "preview"].includes(value.target as string | null | undefined)
    || !object(meta) || meta.cakeQaLeaseId !== lease.leaseId || meta.cakeQaPr !== String(lease.pr)
    || meta.cakeQaPhase !== phase || attemptId !== undefined && meta.cakeQaAttemptId !== attemptId
    || meta.githubCommitRef !== head.branch || meta.githubCommitSha !== head.sha
    || source !== undefined && (!object(source) || source.sha !== head.sha || source.ref !== head.branch)) throw failure();
  return { id: value.id, state: String(value.readyState ?? value.state), url: value.url === undefined ? undefined : previewUrl(value.url) };
}

async function unchanged(head: TaskHead, execute: WorkflowExecutor) {
  const current = await cleanTaskHead(head.cwd, execute);
  if (current.branch !== head.branch || current.sha !== head.sha) throw failure();
}

export async function runTaskPreviewRegistry({ args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log,
  now = Date.now, sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 15 * 60_000, pollIntervalMs = 10_000, globalConfig = process.env.CAKE_VERCEL_GLOBAL_CONFIG,
  request = requestQaAction }: Options = {}): Promise<RegistryPreviewResult> {
  if (args.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("deploy:previewは追加引数なしで実行してください。");
  }
  const head = await cleanTaskHead(cwd, execute);
  const mainSha = await assertTaskGitGate(head, execute);
  const pr = (await taskPullRequests(head, execute))[0];
  if (!pr || pr.headRefOid !== head.sha) throw new Error("先に現在HEADをpushし、main向けdraft PRを作成してください。");
  const remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd, failure().message);
  if (remote !== `${head.sha}\trefs/heads/${head.branch}`) throw new Error("現在HEADとpush済みPRが一致しません。draft PRを更新してから実行してください。");
  const action = (input: Pick<QaActionRequest, "action" | "leaseId" | "phase" | "attemptId" | "deploymentId">) => request({
    ...input, head, mainSha, prNumber: pr.number, sourceSha: head.sha, execute, log, now, sleep,
    timeoutMs: Math.min(timeoutMs, 5 * 60_000), pollIntervalMs,
  });
  const reserved = await action({ action: "reserve" });
  if (reserved.status === "full") {
    log("Cake: QA枠が満杯です。PRをdraftのまま終了し、再依頼時に予約から再開します。");
    return { status: "FULL", payload: null, workflowUrl: reserved.workflowUrl };
  }
  let lease = reserved.payload;
  if (!lease || ["free", "deleting"].includes(lease.state)) throw failure();
  await saveQaLease(head.cwd, lease);
  const finish = async (current: QaPublicLease): Promise<RegistryPreviewResult> => {
    await unchanged(head, execute);
    await ensureProjectLink(head.cwd);
    const deployment = current.deployments.find((d) => d.id === current.readyDeploymentId && d.phase === "application" && d.sha === head.sha);
    if (!deployment?.url || !current.database) throw failure();
    await saveQaLease(head.cwd, current);
    const record: RegistryPreviewRecord = { protocol: "cake-qa-preview/v2", projectId: CAKE_VERCEL_PROJECT, branch: head.branch, sha: head.sha,
      url: deployment.url, deploymentId: deployment.id, slot: current.slot, leaseId: current.leaseId, prNumber: current.pr,
      registryVersion: current.version, createdAt: current.updatedAt ?? new Date(now()).toISOString(), database: current.database };
    log(`Cake: ${current.slot} Deployment READY: ${deployment.url}`);
    if (current.state === "published") log(`Cake: 固定QA URL https://${qaAlias(current.slot)}`);
    else log(`Cake: Deployment固有URLで画面・APIを検証後、npm run qa:publish -- --lease ${current.leaseId} --deployment ${deployment.id} を実行してください。`);
    return { status: "READY", payload: current, record };
  };
  if (lease.state === "published" && lease.headSha === head.sha) {
    const verified = await action({ action: "status", leaseId: lease.leaseId });
    if (!verified.payload) throw failure();
    return finish(verified.payload);
  }
  const project = await vercelApi(execute, head.cwd, `/v9/projects/${CAKE_VERCEL_PROJECT}`, globalConfig);
  if (project.id !== CAKE_VERCEL_PROJECT || project.name !== "cake" || project.accountId !== TEAM_ID || !object(project.link)
    || project.link.type !== "github" || project.link.org !== "tyask" || project.link.repo !== "Cake" || project.link.productionBranch !== "main"
    || !/^[1-9][0-9]*$/.test(String(project.link.repoId))) throw failure();
  const repoId = Number(project.link.repoId);
  if (!Number.isSafeInteger(repoId)) throw failure();
  await ensureProjectLink(head.cwd);
  const deadline = now() + timeoutMs;
  const wait = async (id: string, phase: QaDeployment["phase"], token?: string) => {
    while (now() < deadline) {
      const response = await vercelApi(execute, head.cwd, `/v13/deployments/${id}?withGitRepoInfo=true`, globalConfig);
      const observed = assertRemote(response, lease!, head, phase, token);
      if (observed.id !== id) throw failure();
      if (phase === "provisioning" && observed.state === "ERROR") return;
      if (phase === "application" && observed.state === "READY") return;
      if (["ERROR", "CANCELED", "CANCELLED", "READY"].includes(observed.state)) throw failure();
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining));
    }
    throw failure();
  };
  const register = async (id: string, phase: QaDeployment["phase"], token: string) => {
    const registered = await action({ action: "register", leaseId: lease!.leaseId, deploymentId: id, phase, attemptId: token });
    if (!registered.payload) throw failure();
    lease = registered.payload;
    await saveQaLease(head.cwd, lease);
  };
  const create = async (phase: QaDeployment["phase"]) => {
    const prior = lease!;
    if (phase === "application" && (!prior.database || !hostDigest(prior.databaseHostDigest)
      || !hostDigest(prior.productionHostDigest) || prior.databaseHostDigest === prior.productionHostDigest)) throw failure();
    const token = randomUUID();
    const begun = await action({ action: "begin", leaseId: lease!.leaseId, phase, attemptId: token });
    if (!begun.payload || !hostDigest(begun.payload.productionHostDigest) || begun.payload.leaseId !== prior.leaseId
      || begun.payload.pr !== pr.number || begun.payload.branch !== head.branch || begun.payload.headSha !== head.sha
      || begun.payload.state !== "reserved") throw failure();
    if (phase === "application" && (!begun.payload.database || !hostDigest(begun.payload.databaseHostDigest)
      || begun.payload.databaseHostDigest !== prior.databaseHostDigest || begun.payload.databaseHostDigest === begun.payload.productionHostDigest
      || (["projectId", "branchId", "endpointId"] as const).some(key => begun.payload!.database![key] !== prior.database![key]))) throw failure();
    lease = begun.payload;
    await saveQaLease(head.cwd, lease);
    await unchanged(head, execute);
    const env = { AUTH_MODE: "test", CAKE_QA_SLOT: lease.slot, CAKE_QA_PR: String(pr.number), CAKE_QA_LEASE_TOKEN: lease.leaseId,
      CAKE_QA_SOURCE_BRANCH: head.branch, CAKE_QA_SOURCE_SHA: head.sha,
      // Empty provisioning hash deliberately stops before connecting to a DB.
      CAKE_QA_DATABASE_HOST_SHA256: phase === "application" ? lease.databaseHostDigest! : "",
      CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: lease.productionHostDigest };
    // CLI `api` preserves the verified gitSource needed by Vercel Native Neon.
    // Neither connection strings nor auth tokens are command arguments.
    const created = await vercelApi(execute, head.cwd, "/v13/deployments?forceNew=1", globalConfig, {
      name: "cake", project: CAKE_VERCEL_PROJECT, gitSource: { type: "github", repoId, ref: head.branch, sha: head.sha },
      env, build: { env }, meta: { cakeQaPr: String(pr.number), cakeQaSlot: lease.slot, cakeQaLeaseId: lease.leaseId, cakeQaAttemptId: token, cakeQaPhase: phase,
        githubCommitRef: head.branch, githubCommitSha: head.sha },
    });
    const observed = assertRemote(created, lease, head, phase, token);
    // Register IDs immediately, before a bounded build wait. The main handler
    // saves the resource before looking up an asynchronously provisioned DB.
    try { await register(observed.id, phase, token); }
    catch {
      const recovery = await action({ action: "status", leaseId: lease.leaseId });
      const confirmed = recovery.payload;
      if (!confirmed || !confirmed.deployments.some((d) => d.id === observed.id && d.sha === head.sha && d.phase === phase)) throw failure();
      lease = confirmed;
      await saveQaLease(head.cwd, lease);
    }
    await wait(observed.id, phase, token);
    await register(observed.id, phase, token);
  };
  if (!lease.database) {
    const prior = lease.deployments.find((d) => d.phase === "provisioning" && d.sha === head.sha);
    if (prior) {
      const detail = await vercelApi(execute, head.cwd, `/v13/deployments/${prior.id}?withGitRepoInfo=true`, globalConfig);
      const observed = assertRemote(detail, lease, head, "provisioning");
      if (!object(detail.meta) || typeof detail.meta.cakeQaAttemptId !== "string") throw failure();
      await wait(observed.id, "provisioning", detail.meta.cakeQaAttemptId);
      await register(observed.id, "provisioning", detail.meta.cakeQaAttemptId);
    } else { await create("provisioning"); }
  }
  if (!lease.database || !lease.productionHostDigest) throw failure();
  if (lease.headSha === head.sha && lease.readyDeploymentId) return finish(lease);
  const priorApplication = lease.deployments.findLast((d) => d.phase === "application" && d.sha === head.sha);
  if (priorApplication) {
    const detail = await vercelApi(execute, head.cwd, `/v13/deployments/${priorApplication.id}?withGitRepoInfo=true`, globalConfig);
    assertRemote(detail, lease, head, "application");
    if (!object(detail.meta) || typeof detail.meta.cakeQaAttemptId !== "string") throw failure();
    await wait(priorApplication.id, "application", detail.meta.cakeQaAttemptId);
    await register(priorApplication.id, "application", detail.meta.cakeQaAttemptId);
    return finish(lease);
  }
  await create("application");
  return finish(lease);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runTaskPreviewRegistry({ args: process.argv.slice(2) }).then((result) => {
    if (result.status === "FULL") process.exitCode = 2;
  }).catch(() => { console.error(failure().message); process.exitCode = 1; });
}
