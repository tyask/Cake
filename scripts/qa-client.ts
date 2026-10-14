import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fullSha, leaseToken, QA_NEON_PROJECT_ID, qaAlias, SLOTS, type QaDeployment, type Slot } from "../lib/qa-pool";
import {
  assertTaskGitGate, CAKE_REPOSITORY, cleanTaskHead, commandOutput, executeWorkflowCommand,
  previewUrl, taskPullRequests, validTaskBranch, type TaskHead, type WorkflowExecutor,
} from "./task-workflow";
import { readQaArtifactArchive } from "./qa-artifact";

export const QA_REGISTRY_WORKFLOW = ".github/workflows/qa-registry.yml";
export const QA_RESULT_PROTOCOL = "cake-qa-result/v1" as const;
export const QA_CLIENT_ACTIONS = ["reserve", "status", "begin", "register", "publish", "release"] as const;
export type QaClientAction = typeof QA_CLIENT_ACTIONS[number];
export type QaPublicLease = {
  slot: Slot; state: "reserved" | "published" | "deleting" | "free";
  leaseId: string; pr: number; branch: string; headSha: string; version: number; updatedAt?: string;
  deployments: QaDeployment[]; readyDeploymentId?: string; aliasSha?: string;
  productionHostDigest?: string;
  database?: { projectId: typeof QA_NEON_PROJECT_ID; branchId: string; endpointId: string };
};
export type QaActionReceipt = {
  protocol: typeof QA_RESULT_PROTOCOL; requestId: string; action: QaClientAction;
  status: "success" | "full"; payload: QaPublicLease | null;
};
export type QaActionResult = QaActionReceipt & { workflowUrl: string };
export type QaActionRequest = {
  action: QaClientAction; head: TaskHead; mainSha: string; prNumber: number;
  leaseId?: string; sourceSha?: string; phase?: QaDeployment["phase"]; attemptId?: string; deploymentId?: string;
  requestId?: string; execute?: WorkflowExecutor; log?: (message: string) => void;
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number; pollIntervalMs?: number;
  artifactCacheDir?: string;
};
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const deploymentId = (value: unknown): value is string => typeof value === "string" && /^dpl_[a-zA-Z0-9_-]+$/.test(value);
const onlyKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const invalidReceipt = () => new Error("QA結果の形式または対象が一致しません。Actionsを確認して再実行してください。");

/** Parse only the public projection; never carry a DB host, token, or provider response into local evidence. */
export function parseQaPublicLease(value: unknown): QaPublicLease {
  if (!object(value) || !onlyKeys(value, ["slot", "state", "leaseId", "pr", "branch", "headSha", "version", "updatedAt",
    "deployments", "deploymentIds", "readyDeploymentId", "aliasSha", "database", "productionHostDigest"])
    || !SLOTS.includes(value.slot as Slot) || !["reserved", "published", "deleting", "free"].includes(String(value.state))
    || !leaseToken(value.leaseId) || !positiveInteger(value.pr) || !validTaskBranch(value.branch)
    || !fullSha(value.headSha) || !positiveInteger(value.version) || !Array.isArray(value.deployments)
    || value.updatedAt !== undefined && (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))) throw invalidReceipt();
  if (value.productionHostDigest !== undefined && (typeof value.productionHostDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.productionHostDigest))) throw invalidReceipt();
  const ids = new Set<string>();
  for (const entry of value.deployments) {
    if (!object(entry) || !onlyKeys(entry, ["id", "sha", "phase", "url"]) || !deploymentId(entry.id)
      || ids.has(entry.id) || !fullSha(entry.sha) || !["provisioning", "application"].includes(String(entry.phase))) throw invalidReceipt();
    if (entry.url !== undefined) {
      try { if (previewUrl(entry.url) !== entry.url) throw new Error(); } catch { throw invalidReceipt(); }
    }
    ids.add(entry.id);
  }
  if (value.deploymentIds !== undefined && (!Array.isArray(value.deploymentIds) || value.deploymentIds.length !== ids.size
    || value.deploymentIds.some((id) => typeof id !== "string" || !ids.has(id)) || new Set(value.deploymentIds).size !== ids.size)) throw invalidReceipt();
  if (value.database !== undefined && (!object(value.database) || !onlyKeys(value.database, ["projectId", "branchId", "endpointId"])
    || value.database.projectId !== QA_NEON_PROJECT_ID || typeof value.database.branchId !== "string" || !/^br-[a-z0-9-]+$/.test(value.database.branchId)
    || typeof value.database.endpointId !== "string" || !/^ep-[a-z0-9-]+$/.test(value.database.endpointId))) throw invalidReceipt();
  if (value.readyDeploymentId !== undefined && (!deploymentId(value.readyDeploymentId)
    || !value.deployments.some((entry) => object(entry) && entry.id === value.readyDeploymentId && entry.phase === "application"))) throw invalidReceipt();
  if (value.aliasSha !== undefined && (!fullSha(value.aliasSha) || value.aliasSha !== value.headSha || !value.database
    || !value.deployments.some((entry) => object(entry) && entry.id === value.readyDeploymentId && entry.sha === value.aliasSha))) throw invalidReceipt();
  if (value.state === "published" && (!value.database || !value.readyDeploymentId || value.aliasSha !== value.headSha)
    || ["deleting", "free"].includes(String(value.state)) && (value.readyDeploymentId !== undefined || value.aliasSha !== undefined)) throw invalidReceipt();
  const safe = { ...value };
  delete safe.deploymentIds;
  return JSON.parse(JSON.stringify(safe)) as QaPublicLease;
}

export function parseQaActionReceipt(value: unknown, request: Pick<QaActionRequest, "action" | "prNumber" | "head" | "leaseId"> & { requestId: string }): QaActionReceipt {
  if (!object(value) || !onlyKeys(value, ["protocol", "requestId", "action", "status", "payload"])
    || value.protocol !== QA_RESULT_PROTOCOL || value.requestId !== request.requestId || value.action !== request.action
    || !["success", "full"].includes(String(value.status)) || !Object.hasOwn(value, "payload")) throw invalidReceipt();
  if (value.status === "full" && (request.action !== "reserve" || value.payload !== null)) throw invalidReceipt();
  const payload = value.payload === null ? null : parseQaPublicLease(value.payload);
  if (payload && (payload.pr !== request.prNumber || payload.branch !== request.head.branch
    || request.leaseId !== undefined && payload.leaseId !== request.leaseId)) throw invalidReceipt();
  if (value.status === "success" && request.action !== "status" && !payload) throw invalidReceipt();
  if (payload && !["reserve", "status", "release"].includes(request.action) && payload.headSha !== request.head.sha) throw invalidReceipt();
  if (request.action === "publish" && payload?.state !== "published" || request.action === "release" && payload?.state !== "free") throw invalidReceipt();
  return { protocol: QA_RESULT_PROTOCOL, requestId: request.requestId, action: request.action, status: value.status as "success" | "full", payload };
}

async function api(execute: WorkflowExecutor, cwd: string, path: string): Promise<unknown> {
  const raw = await commandOutput(execute, "gh", ["api", "--method", "GET", path], cwd,
    "GitHubのQA実行情報を読み取れませんでした。認証と接続を確認してください。");
  try { return JSON.parse(raw); } catch { throw new Error("GitHubのQA実行情報の形式が不正です。"); }
}

async function identity(execute: WorkflowExecutor, cwd: string) {
  const repo = await api(execute, cwd, `repos/${CAKE_REPOSITORY}`);
  const caller = await api(execute, cwd, "user");
  if (!object(repo) || repo.full_name !== CAKE_REPOSITORY || !positiveInteger(repo.id) || !object(repo.owner)
    || repo.owner.login !== "tyask" || repo.owner.type !== "User" || !positiveInteger(repo.owner.id)
    || !object(caller) || caller.type !== "User" || caller.login !== repo.owner.login || caller.id !== repo.owner.id) {
    throw new Error("QA操作はtyask/Cakeのowner本人のGitHub認証で実行してください。");
  }
  return { repoId: repo.id, ownerId: repo.owner.id };
}

async function currentMain(execute: WorkflowExecutor, cwd: string, mainSha: string): Promise<void> {
  const main = await api(execute, cwd, `repos/${CAKE_REPOSITORY}/branches/main`);
  if (!object(main) || main.name !== "main" || !object(main.commit) || main.commit.sha !== mainSha) {
    throw new Error("QA操作中にmainが変更されました。現在のmainでコマンドを再実行してください。");
  }
}

async function assertPullRequest(request: QaActionRequest, execute: WorkflowExecutor): Promise<void> {
  const pr = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/pulls/${request.prNumber}`);
  if (!object(pr) || pr.number !== request.prNumber || !object(pr.head) || !object(pr.base)
    || !object(pr.head.repo) || pr.head.repo.full_name !== CAKE_REPOSITORY || !object(pr.base.repo)
    || pr.base.repo.full_name !== CAKE_REPOSITORY || pr.base.ref !== "main" || pr.head.ref !== request.head.branch
    || !fullSha(pr.head.sha) || typeof pr.draft !== "boolean"
    || !["open", "closed"].includes(String(pr.state))
    || request.action !== "release" && pr.state !== "open"
    || !["release", "status"].includes(request.action) && pr.head.sha !== request.head.sha) {
    throw new Error("同一repository・main向けPRのブランチとHEADを確認できませんでした。");
  }
  // An active PR may reuse its existing lease. The main-side reserve handler
  // enforces draft for a new reservation after checking the authoritative DB.
}

function trustedRun(value: unknown, expected: { id?: number; mainSha: string; workflowId: number; ownerId: number; repoId: number; title: string }): asserts value is JsonObject {
  if (!object(value) || !positiveInteger(value.id) || expected.id !== undefined && value.id !== expected.id
    || value.workflow_id !== expected.workflowId || value.path !== QA_REGISTRY_WORKFLOW || value.event !== "workflow_dispatch"
    || value.head_branch !== "main" || value.head_sha !== expected.mainSha || value.run_attempt !== 1
    || value.display_title !== expected.title || !object(value.repository) || value.repository.full_name !== CAKE_REPOSITORY
    || value.repository.id !== expected.repoId || !object(value.head_repository) || value.head_repository.full_name !== CAKE_REPOSITORY
    || value.head_repository.id !== expected.repoId || !object(value.actor) || value.actor.type !== "User" || value.actor.id !== expected.ownerId
    || !object(value.triggering_actor) || value.triggering_actor.type !== "User" || value.triggering_actor.id !== expected.ownerId
    || !["queued", "waiting", "pending", "in_progress", "requested", "completed"].includes(String(value.status))) {
    throw new Error("QA Actionsの実行元・main・owner・依頼IDの一致を確認できませんでした。");
  }
  // GitHub can populate reusable-workflow metadata only after a queued run starts.
  // Do not consume its artifact until the final, successful source is verified.
  if (value.status === "completed" && value.conclusion === "success" && (!Array.isArray(value.referenced_workflows)
    || value.referenced_workflows.length !== 1 || !object(value.referenced_workflows[0])
    || value.referenced_workflows[0].path !== `${CAKE_REPOSITORY}/.github/workflows/qa-registry-run.yml@${expected.mainSha}`
    || value.referenced_workflows[0].sha !== expected.mainSha || value.referenced_workflows[0].ref !== "refs/heads/main")) {
    throw new Error("QA Actionsの成功結果とmainの再利用workflowを照合できませんでした。");
  }
}

async function successfulJobs(execute: WorkflowExecutor, cwd: string, runId: number): Promise<void> {
  const response = await api(execute, cwd, `repos/${CAKE_REPOSITORY}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  if (!object(response) || !positiveInteger(response.total_count) || !Array.isArray(response.jobs)
    || response.jobs.length !== response.total_count || response.jobs.some((job) => !object(job)
      || job.run_id !== runId || job.run_attempt !== 1 || job.status !== "completed" || job.conclusion !== "success"
      || !Array.isArray(job.steps) || job.steps.length === 0 || job.steps.some((step) => !object(step)
        || step.status !== "completed" || !["success", "skipped"].includes(String(step.conclusion))))) {
    throw new Error("QA Actionsの全ジョブの成功を確認できませんでした。結果は使用しません。");
  }
}

/** Dispatch to trusted main, then consume the exact successful run's immutable artifact. */
export async function requestQaAction({
  execute = executeWorkflowCommand, log = console.log, now = Date.now,
  sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  timeoutMs = 5 * 60_000, pollIntervalMs = 5_000, requestId = randomUUID(), ...request
}: QaActionRequest): Promise<QaActionResult> {
  if (!QA_CLIENT_ACTIONS.includes(request.action) || !positiveInteger(request.prNumber) || !fullSha(request.mainSha)
    || !fullSha(request.head.sha) || !validTaskBranch(request.head.branch) || !leaseToken(requestId)
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0
    || request.sourceSha !== undefined && request.sourceSha !== request.head.sha
    || request.leaseId !== undefined && !leaseToken(request.leaseId)
    || request.phase !== undefined && !["provisioning", "application"].includes(request.phase)
    || request.attemptId !== undefined && !leaseToken(request.attemptId)
    || request.deploymentId !== undefined && !deploymentId(request.deploymentId)
    || request.artifactCacheDir !== undefined && (typeof request.artifactCacheDir !== "string" || !request.artifactCacheDir.trim()
      || /[\r\n\0]/.test(request.artifactCacheDir))) throw new Error("QA操作の引数が不正です。");
  const artifactCacheDir = request.artifactCacheDir ?? process.env.CAKE_QA_ARTIFACT_CACHE;
  if (artifactCacheDir !== undefined && (!artifactCacheDir.trim() || /[\r\n\0]/.test(artifactCacheDir))) throw new Error("QA artifactの保存先が不正です。");
  const needsLease = ["begin", "register", "publish", "release"].includes(request.action);
  if (needsLease && !request.leaseId || request.action === "begin" && (!request.phase || !request.attemptId)
    || request.action === "register" && (!request.phase || !request.attemptId || !request.deploymentId)
    || request.action === "publish" && !request.deploymentId) throw new Error("QA操作に必要な貸出ID・作成ID・Deployment IDが不足しています。");
  const owner = await identity(execute, request.head.cwd);
  await currentMain(execute, request.head.cwd, request.mainSha);
  await assertPullRequest(request, execute);
  const workflow = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/actions/workflows/qa-registry.yml`);
  if (!object(workflow) || !positiveInteger(workflow.id) || workflow.path !== QA_REGISTRY_WORKFLOW || workflow.state !== "active") {
    throw new Error("mainのQA管理workflowを確認できませんでした。導入状態を確認してください。");
  }
  const fields = { action: request.action, request_id: requestId, pr_number: String(request.prNumber),
    lease_id: request.leaseId, source_sha: request.sourceSha ?? request.head.sha, phase: request.phase,
    attempt_id: request.attemptId, deployment_id: request.deploymentId };
  const args = ["workflow", "run", "qa-registry.yml", "--repo", CAKE_REPOSITORY, "--ref", "main"];
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) args.push("-f", `${key}=${value}`);
  await commandOutput(execute, "gh", args, request.head.cwd, "QA管理Actionsを起動できませんでした。認証と接続を確認してください。");
  log(`Cake: PR #${request.prNumber} のQA ${request.action}をActionsへ依頼しました。`);
  const expected = { ...owner, workflowId: workflow.id, mainSha: request.mainSha, title: `Cake QA ${request.action} ${requestId}` };
  const deadline = now() + timeoutMs;
  let runId: number | undefined;
  while (now() < deadline) {
    let run: unknown;
    if (runId === undefined) {
      const runs = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main&per_page=100`);
      if (!object(runs) || !Array.isArray(runs.workflow_runs)) throw new Error("QA Actionsの実行一覧を確認できませんでした。");
      const matches = runs.workflow_runs.filter((entry) => object(entry) && entry.display_title === expected.title);
      if (matches.length > 1) throw new Error("同じQA依頼IDのActionsが複数あります。結果は使用しません。");
      run = matches[0];
      // Collection responses may omit detailed actor/reusable-source metadata.
      // The exact run GET below must verify every identity before any result is used.
      if (run !== undefined) {
        if (!object(run) || !positiveInteger(run.id)) throw invalidReceipt();
        runId = run.id;
      }
    }
    if (runId !== undefined) {
      run = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/actions/runs/${runId}`);
      trustedRun(run, { ...expected, id: runId });
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`QA管理Actionsが成功しませんでした。https://github.com/${CAKE_REPOSITORY}/actions/runs/${runId}`);
        await successfulJobs(execute, request.head.cwd, runId);
        const artifactName = `qa-result-${requestId}`;
        const artifacts = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/actions/runs/${runId}/artifacts?per_page=100`);
        if (!object(artifacts) || !Array.isArray(artifacts.artifacts)) throw invalidReceipt();
        const matches = artifacts.artifacts.filter((entry) => object(entry) && entry.name === artifactName);
        const artifact = matches[0];
        if (matches.length !== 1 || !object(artifact) || !positiveInteger(artifact.id) || artifact.expired !== false
          || !positiveInteger(artifact.size_in_bytes) || artifact.size_in_bytes > 256_000 || !object(artifact.workflow_run)
          || artifact.workflow_run.id !== runId || artifact.workflow_run.head_sha !== request.mainSha
          || artifact.workflow_run.head_branch !== "main") throw invalidReceipt();
        let raw: string;
        if (artifactCacheDir !== undefined) {
          // A connector-downloaded ZIP is trusted only if it has the digest and
          // exact size obtained through the authenticated, scoped GitHub API.
          if (typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw invalidReceipt();
          log(`Cake: QA artifact ${artifact.id} run ${runId} request ${requestId} name ${artifactName}`);
          const cachePath = resolve(artifactCacheDir, `${artifact.id}.zip`);
          const cacheDeadline = Math.min(deadline, now() + 60_000);
          while (true) {
            let present = false;
            try {
              const entry = await lstat(cachePath);
              if (!entry.isFile() || entry.isSymbolicLink()) throw invalidReceipt();
              present = true;
            } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw invalidReceipt(); }
            if (present) break;
            const remaining = cacheDeadline - now();
            if (remaining <= 0) throw new Error("QA artifactの取得待機時間を超えました。認証付きで取得した同じartifactを用意して再実行してください。");
            await sleep(Math.min(pollIntervalMs, remaining));
          }
          try { raw = await readQaArtifactArchive(cachePath, { digest: artifact.digest, sizeInBytes: artifact.size_in_bytes as number }); }
          catch { throw invalidReceipt(); }
        } else {
          const directory = await mkdtemp(join(tmpdir(), "cake-qa-result-"));
          try {
            await commandOutput(execute, "gh", ["run", "download", String(runId), "--repo", CAKE_REPOSITORY, "--name", artifactName, "--dir", directory],
              request.head.cwd, "QA結果artifactを取得できませんでした。");
            raw = await readFile(join(directory, "result.json"), "utf8");
          } finally { await rm(directory, { recursive: true, force: true }); }
        }
        if (Buffer.byteLength(raw, "utf8") > 128_000) throw invalidReceipt();
        let value: unknown; try { value = JSON.parse(raw); } catch { throw invalidReceipt(); }
        const receipt = parseQaActionReceipt(value, { ...request, requestId });
        // Re-read after download: reruns, a changed main, or a changed PR invalidate the receipt.
        const latest = await api(execute, request.head.cwd, `repos/${CAKE_REPOSITORY}/actions/runs/${runId}`);
        trustedRun(latest, { ...expected, id: runId });
        if (latest.status !== "completed" || latest.conclusion !== "success") throw invalidReceipt();
        await currentMain(execute, request.head.cwd, request.mainSha);
        await assertPullRequest(request, execute);
        const current = await cleanTaskHead(request.head.cwd, execute);
        if (current.branch !== request.head.branch || current.sha !== request.head.sha) throw new Error("QA待機中にブランチまたはHEADが変更されました。現在の作業で再実行してください。");
        return { ...receipt, workflowUrl: `https://github.com/${CAKE_REPOSITORY}/actions/runs/${runId}` };
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  throw new Error("QA管理Actionsが待機時間内に完了しませんでした。Actionsの状態を確認して再実行してください。");
}

export function qaLeaseRecordPath(cwd: string): string { return resolve(cwd, ".cake/qa-lease.json"); }

/** Local cache is a convenience only; every mutation is checked against the Actions DB. */
export async function saveQaLease(cwd: string, lease: QaPublicLease): Promise<void> {
  const record = parseQaPublicLease(lease);
  const path = qaLeaseRecordPath(cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

type QaClientOptions = {
  args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void;
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>; timeoutMs?: number; pollIntervalMs?: number;
  artifactCacheDir?: string;
};

function parseArgs(args: readonly string[]) {
  const [action, ...rest] = args;
  if (!QA_CLIENT_ACTIONS.includes(action as QaClientAction)) throw new Error("qa:manageには reserve/status/begin/register/publish/release を指定してください。");
  const values: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!["--pr", "--lease", "--sha", "--phase", "--attempt", "--deployment"].includes(key)
      || values[key] !== undefined || value === undefined || value.startsWith("--")) throw new Error("QAコマンドの引数が不正です。");
    values[key] = value;
  }
  if (values["--pr"] !== undefined && (!/^[1-9][0-9]*$/.test(values["--pr"]) || !positiveInteger(Number(values["--pr"])))) throw new Error("PR番号が不正です。");
  return { action: action as QaClientAction, prNumber: values["--pr"] === undefined ? undefined : Number(values["--pr"]),
    leaseId: values["--lease"], sourceSha: values["--sha"], phase: values["--phase"] as QaDeployment["phase"] | undefined,
    attemptId: values["--attempt"], deploymentId: values["--deployment"] };
}

export async function runQaClient({ args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log, ...timing }: QaClientOptions = {}): Promise<QaActionResult> {
  const input = parseArgs(args);
  const head = await cleanTaskHead(cwd, execute);
  const mainSha = await assertTaskGitGate(head, execute);
  const requests = input.prNumber === undefined ? await taskPullRequests(head, execute) : [];
  const prNumber = input.prNumber ?? requests[0]?.number;
  if (!prNumber) throw new Error("先にdraft PRを作成してください。既存PRの操作は --pr <番号> で指定できます。");
  let leaseId = input.leaseId;
  if (["begin", "register", "publish", "release"].includes(input.action) && leaseId === undefined) {
    const current = await requestQaAction({ action: "status", head, mainSha, prNumber, execute, log, ...timing });
    if (!current.payload || current.payload.state === "free") throw new Error("このPRに利用中のQA枠がありません。先に予約してください。");
    leaseId = current.payload.leaseId;
  }
  const result = await requestQaAction({ ...input, leaseId, head, mainSha, prNumber, execute, log, ...timing });
  if (result.payload) await saveQaLease(head.cwd, result.payload);
  else await rm(qaLeaseRecordPath(head.cwd), { force: true });
  if (result.status === "full") {
    log("Cake: QA枠に空きがありません。PRはdraftのまま終了します。再依頼時に予約から再開します。");
  } else if (result.payload) {
    const lease = result.payload;
    log(`Cake: ${lease.slot} / PR #${lease.pr} / ${lease.state} / 貸出ID ${lease.leaseId}`);
    if (lease.state === "published") log(`Cake: 固定QA URL https://${qaAlias(lease.slot)}`);
  } else { log(`Cake: PR #${prNumber} はQA枠を利用していません。`); }
  log(`Cake: ${result.workflowUrl}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runQaClient({ args: process.argv.slice(2) }).then((result) => {
    if (result.status === "full") process.exitCode = 2;
  }).catch(() => {
    // Unexpected CLI/provider exceptions must not dump response bodies or secrets.
    console.error("QA操作を完了できませんでした。Actions・PR・認証・現在のコミットを確認してください。");
    process.exitCode = 1;
  });
}
