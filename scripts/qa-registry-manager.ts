import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { fullSha, featureBranch, leaseToken, qaAlias, QA_PROJECT_ID, QA_REPOSITORY, SLOTS, sameDatabase, type QaLeaseRecord, type Pool, type SavedLease } from "../lib/qa-pool";
import { registryLeaseToPoolRecord, registryPublicSummary, parseRegistryLease, type QaRegistryStore, type QaRegistryLease } from "../lib/qa-registry";
import { deletePlan, type DeletePlan } from "../lib/qa-pool-authorization";
import { runQaRequestWithWaiting } from "../lib/qa-pool-runner";
import { HttpQaGateway, type QaTransport } from "./qa-pool-writer";
import { createQaRegistryStore } from "./qa-registry-store";
import { HttpOwnerApprovalStore } from "./qa-owner-store";
import { initializeRegistry } from "./qa-registry-initialize";
import { registryLegacyWorkflows } from "./qa-registry-ddl";

type Env = Readonly<Record<string, string | undefined>>;
export type RegistryAction = "reserve" | "status" | "begin" | "register" | "publish" | "release" | "migrate";
export type RegistryRequest = { action: RegistryAction; requestId: string; pr: number; leaseId?: string; sha?: string; phase?: "provisioning" | "application"; attemptId?: string; deploymentId?: string };
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("QA API response is invalid."); return v as Record<string, unknown>; };

/** Existing provider identity/deletion checks, with the registry DB as the only writer. */
export class RegistryGateway extends HttpQaGateway {
  constructor(private readonly registryEnv: Env, readonly store: QaRegistryStore, request?: QaTransport, private readonly manualRelease = false) {
    super({ ...registryEnv, QA_OWNER_FLOW: "false", CAKE_QA_APPROVED_HEADS: "{}" }, request, "write");
  }
  async pool(): Promise<Pool> {
    const pool = await this.store.read();
    return Object.fromEntries(SLOTS.map(slot => [slot, pool.slots[slot] ? { id: pool.slots[slot]!.version, payload: registryLeaseToPoolRecord(pool.slots[slot]!) } : null])) as Pool;
  }
  async save(record: QaLeaseRecord): Promise<SavedLease> {
    const previous = (await this.store.read()).slots[record.slot];
    if (!previous || record.previousRecordId !== previous.version || record.leaseId !== previous.leaseId) throw new Error("QA lease generation changed.");
    const fields: Partial<QaLeaseRecord> = { ...record };
    delete fields.protocol; delete fields.sequence; delete fields.previousRecordId; delete fields.purpose;
    const state = record.state === "held" ? previous.state === "published" && record.aliasSha ? "published" : "reserved" : record.state;
    const next = parseRegistryLease({ ...previous, ...fields, readyDeploymentId: record.readyDeploymentId,
      aliasSha: record.aliasSha, intent: record.intent, state, version: previous.version + 1, requestId: randomUUID() });
    const result = await this.store.writeSnapshot(record.slot, { leaseId: previous.leaseId, version: previous.version }, next);
    return { id: result.version, payload: registryLeaseToPoolRecord(result) };
  }
  async pullRequest(number: number) {
    const raw = obj(await this.api("github", `/repos/${QA_REPOSITORY}/pulls/${number}`));
    const head = obj(raw.head), base = obj(raw.base);
    if (raw.number !== number || obj(head.repo).full_name !== QA_REPOSITORY || obj(base.repo).full_name !== QA_REPOSITORY
      || base.ref !== "main" || !featureBranch(head.ref) || !fullSha(head.sha) || !["open", "closed"].includes(String(raw.state))) throw new Error("QA PR repository, branch or state does not match.");
    return { number, state: raw.state as "open" | "closed", branch: head.ref, sha: head.sha, repository: QA_REPOSITORY, base: "main", approved: true };
  }
  async isDraft(number: number): Promise<boolean> { return obj(await this.api("github", `/repos/${QA_REPOSITORY}/pulls/${number}`)).draft === true; }
  productionHostDigest(): string | undefined {
    const host = this.registryEnv.CAKE_QA_PRODUCTION_DATABASE_HOST;
    return host && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(host)
      ? createHash("sha256").update(host.replace(/-pooler(?=\.)/, "")).digest("hex") : undefined;
  }
  async assertDispatchOwner(): Promise<void> {
    const e = this.registryEnv;
    if (e.GITHUB_REPOSITORY !== QA_REPOSITORY || e.GITHUB_REF !== "refs/heads/main" || e.EVENT_NAME !== "workflow_dispatch"
      || !/^\d+$/.test(e.GITHUB_RUN_ID ?? "") || !fullSha(e.QA_TRUSTED_MAIN_SHA)) throw new Error("QA must run from the trusted main workflow.");
    const repository = obj(await this.api("github", `/repos/${QA_REPOSITORY}`)), owner = obj(repository.owner);
    const run = obj(await this.api("github", `/repos/${QA_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`));
    if (owner.type !== "User" || obj(run.actor).type !== "User" || obj(run.triggering_actor).type !== "User"
      || obj(run.actor).id !== owner.id || obj(run.triggering_actor).id !== owner.id
      || run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.head_sha !== e.QA_TRUSTED_MAIN_SHA
      || run.path !== ".github/workflows/qa-registry.yml" || run.run_attempt !== 1) throw new Error("QA dispatch owner or main commit is not verified.");
  }
  async assertCloseEvent(number: number): Promise<void> {
    const e = this.registryEnv;
    if (e.GITHUB_REPOSITORY !== QA_REPOSITORY || e.GITHUB_REF !== "refs/heads/main" || e.EVENT_NAME !== "pull_request_target" || !e.EVENT_PATH) throw new Error("QA close event is not trusted.");
    const event = obj(JSON.parse(await readFile(e.EVENT_PATH, "utf8"))), pr = obj(event.pull_request);
    if (event.action !== "closed" || pr.number !== number || obj(obj(pr.head).repo).full_name !== QA_REPOSITORY
      || obj(obj(pr.base).repo).full_name !== QA_REPOSITORY || obj(pr.base).ref !== "main") throw new Error("QA close event target does not match.");
    if ((await this.pullRequest(number)).state !== "closed") throw new Error("QA PR is no longer closed.");
  }
  async deletionApproved(plan: DeletePlan): Promise<boolean> {
    const latest = Object.values(await this.pool()).find(s => s?.payload.pr === plan.pr && s.payload.leaseId === plan.leaseId);
    if (!latest || latest.payload.state !== "deleting" || latest.payload.intent || !isDeepStrictEqual(deletePlan(latest.payload), plan)) return false;
    const pr = await this.pullRequest(plan.pr);
    return pr.branch === latest.payload.branch && (pr.state === "closed" || this.manualRelease);
  }
  async assertCi(pr: number, sha: string): Promise<void> {
    const current = await this.pullRequest(pr);
    if (current.state !== "open" || current.sha !== sha) throw new Error("QA PR head changed during CI verification.");
    // Only this existing reader is reused; registry requests never create approval Deployments.
    const ci = new HttpOwnerApprovalStore(this.registryEnv, (path, method, body) => this.api("github", path, method, body), async () => []);
    await ci.assertCi(pr, current.branch, sha);
  }
  async assertLegacyPoolFree(): Promise<void> {
    const legacy = new HttpQaGateway({ ...this.registryEnv, QA_OWNER_FLOW: "false" });
    if (Object.values(await legacy.pool()).some(saved => saved && saved.payload.state !== "free")) throw new Error("Legacy QA pool is still occupied; do not create a second ledger owner.");
  }
  async assertLegacyRunsIdle(): Promise<void> {
    for (const workflow of registryLegacyWorkflows) for (let page = 1; page <= 100; page++) {
      const response = obj(await this.api("github", `/repos/${QA_REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`));
      if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count) || Number(response.total_count)<0) throw new Error("Cannot verify legacy workflow queue.");
      for (const raw of response.workflow_runs) {
        const run = obj(raw);
        // The already authorized initializer itself is listed as active by its own entry workflow.
        const self = this.registryEnv.EVENT_NAME === "workflow_dispatch" && this.registryEnv.QA_ACTION === "initialize"
          && String(run.id) === this.registryEnv.GITHUB_RUN_ID && run.path === ".github/workflows/qa-registry.yml"
          && run.event === "workflow_dispatch" && run.head_branch === "main" && run.head_sha === this.registryEnv.QA_TRUSTED_MAIN_SHA
          && run.run_attempt === 1 && run.status === "in_progress";
        if (run.status !== "completed" && !self) throw new Error("Wait for all legacy QA workflow runs to finish before initializing.");
      }
      if (response.workflow_runs.length < 100) {
        if ((page-1)*100+response.workflow_runs.length<Number(response.total_count)) throw new Error("Legacy workflow list is incomplete.");
        break;
      }
      if (page === 100) throw new Error("Legacy workflow list is incomplete.");
    }
  }
}

function selected(pool: Awaited<ReturnType<QaRegistryStore["read"]>>, pr: number, leaseId?: string): QaRegistryLease | null {
  const matches = Object.values(pool.slots).filter((v): v is QaRegistryLease => v !== null && v.pr === pr && v.state !== "free");
  if (matches.length > 1) throw new Error("PR owns multiple QA slots.");
  const value = matches[0] ?? null;
  if (value && leaseId && value.leaseId !== leaseId) throw new Error("QA lease ID does not match.");
  return value;
}
async function update(g: RegistryGateway, previous: QaRegistryLease, changes: Partial<QaRegistryLease>, requestId: string) {
  return g.store.writeSnapshot(previous.slot, { leaseId: previous.leaseId, version: previous.version }, parseRegistryLease({ ...previous, ...changes, version: previous.version + 1, requestId, updatedAt: new Date().toISOString() }));
}

export async function runRegistryAction(g: RegistryGateway, request: RegistryRequest, closed = false) {
  if (!leaseToken(request.requestId) || !Number.isSafeInteger(request.pr) || request.pr < 1) throw new Error("QA request identity is invalid.");
  if (closed) await g.assertCloseEvent(request.pr); else await g.assertDispatchOwner();
  const pr = await g.pullRequest(request.pr);
  let record = selected(await g.store.read(), request.pr, request.leaseId);
  const success = (payload: QaRegistryLease | null, status: "success" | "full" = "success") => {
    const current = payload ? parseRegistryLease(payload) : null;
    return { protocol: "cake-qa-result/v1", requestId: request.requestId, action: request.action, status,
      payload: current ? { ...registryPublicSummary(current), productionHostDigest: g.productionHostDigest(),
        ...(current.database ? { databaseHostDigest: createHash("sha256").update(current.database.host.replace(/-pooler(?=\.)/, "")).digest("hex") } : {}) } : null };
  };
  if (request.action === "status") {
    if (record?.state === "published") {
      const alias = await g.alias(record.slot), deployment = await g.deployment(record.readyDeploymentId!);
      const database = await g.database(registryLeaseToPoolRecord(record));
      if (pr.state !== "open" || record.headSha !== pr.sha || record.aliasSha !== pr.sha
        || !alias || alias.projectId !== QA_PROJECT_ID || alias.deploymentId !== record.readyDeploymentId
        || !deployment || deployment.id !== record.readyDeploymentId || deployment.projectId !== QA_PROJECT_ID
        || ![null, "preview"].includes(deployment.target) || deployment.state !== "READY" || deployment.pr !== pr.number
        || deployment.branch !== record.branch || deployment.sha !== record.headSha || deployment.leaseId !== record.leaseId
        || !database || !sameDatabase(database, record.database)) throw new Error("Published QA resources no longer match the current PR and registry.");
    }
    return success(record);
  }
  if (request.action === "reserve") {
    if (pr.state !== "open" || pr.sha !== request.sha || record?.state === "deleting") throw new Error("QA reservation needs the current open PR commit.");
    await g.assertGate("create", { pr: pr.number, branch: pr.branch, sha: pr.sha });
    await g.assertLegacyPoolFree();
    if (record) return success(record);
    if (!await g.isDraft(pr.number)) throw new Error("Create a draft PR before reserving a QA slot.");
    record = await g.store.reserve({ repository: QA_REPOSITORY, base: "main", pr: pr.number, branch: pr.branch, headSha: pr.sha, leaseId: randomUUID(), requestId: request.requestId, now: new Date().toISOString() });
    return success(record, record ? "success" : "full");
  }
  if (!record || !leaseToken(request.leaseId) || record.leaseId !== request.leaseId) throw new Error("QA action needs the current lease ID.");
  if (request.action === "release") {
    const assignment = record.aliasAssignment;
    if (assignment?.state === "pending") {
      const alias = await g.alias(record.slot);
      if (!alias || alias.projectId !== QA_PROJECT_ID || alias.deploymentId !== assignment.deploymentId) throw new Error("QA alias mutation has an unconfirmed outcome; retain the slot.");
      record = await update(g, record, { aliasAssignment: { ...assignment, state: "assigned" } }, request.requestId);
    }
    await runQaRequestWithWaiting(g, { action: closed ? "close" : "release", pr: request.pr, leaseId: record.leaseId });
    const result = (await g.store.read()).slots[record.slot];
    if (!result || result.state !== "free" || result.leaseId !== record.leaseId) throw new Error("QA cleanup is not confirmed; retain the slot.");
    return success(result);
  }
  if (pr.state !== "open" || pr.sha !== request.sha || record.state === "deleting") throw new Error("QA action needs the current open PR commit.");
  await g.assertGate("create", { pr: pr.number, branch: pr.branch, sha: pr.sha });
  await g.assertCi(pr.number, pr.sha);
  if (request.action === "begin") {
    if (!request.phase || !leaseToken(request.attemptId)) throw new Error("QA creation intent is incomplete.");
    if (record.intent) throw new Error("QA creation outcome is pending. Recover the recorded attempt before creating another deployment.");
    if (record.aliasAssignment?.state === "pending") throw new Error("QA alias assignment must be confirmed before another deployment.");
    if (request.phase === "application" && !record.database) throw new Error("QA Native database identity is not confirmed.");
    if (request.phase === "application") {
      const database = await g.database(registryLeaseToPoolRecord(record));
      if (!database || !sameDatabase(database, record.database)) throw new Error("QA Native database disappeared or changed before creation.");
    }
    const intent = { sha: pr.sha, phase: request.phase, attemptId: request.attemptId, startedAt: new Date().toISOString() };
    return success(await update(g, record, { intent, headSha: pr.sha, state: "reserved", readyDeploymentId: undefined, aliasSha: undefined, aliasAssignment: undefined }, request.requestId));
  }
  if (request.action === "register") {
    if (!/^dpl_[A-Za-z0-9_-]+$/.test(request.deploymentId ?? "")) throw new Error("QA Deployment ID is invalid.");
    const previouslyRegistered = record.deployments.find(d => d.id === request.deploymentId);
    if (record.intent ? record.intent.sha !== pr.sha || record.intent.phase !== request.phase || record.intent.attemptId !== request.attemptId
      : !previouslyRegistered || previouslyRegistered.sha !== pr.sha || previouslyRegistered.phase !== request.phase) throw new Error("QA creation intent or registered deployment does not match.");
    const deployment = await g.deployment(request.deploymentId!);
    if (!deployment || deployment.projectId !== QA_PROJECT_ID || ![null, "preview"].includes(deployment.target) || deployment.pr !== pr.number || deployment.branch !== pr.branch
      || deployment.leaseId !== record.leaseId || deployment.sha !== pr.sha || deployment.attemptId !== request.attemptId || deployment.phase !== request.phase) throw new Error("QA Deployment identity does not match.");
    const known = record.deployments.find(d => d.id === deployment.id);
    if (known && (known.sha !== deployment.sha || known.phase !== deployment.phase)) throw new Error("QA Deployment history conflicts.");
    const deployments = known ? record.deployments : [...record.deployments, { id: deployment.id, sha: deployment.sha, phase: deployment.phase, url: deployment.url }];
    // Record resource ID before database discovery, so a failed lookup can be retried without losing the cleanup target.
    if (!known || record.intent) record = await update(g, record, { deployments, intent: undefined }, request.requestId);
    const database = await g.database(registryLeaseToPoolRecord(record));
    if (!database || record.database && !sameDatabase(record.database, database)) throw new Error("QA Native database identity is not confirmed; resources remain registered.");
    record = await update(g, record, { database, readyDeploymentId: deployment.phase === "application" && deployment.state === "READY" ? deployment.id : undefined }, randomUUID());
    return success(record);
  }
  if (request.action === "publish") {
    if (record.intent || !record.database || !record.readyDeploymentId || request.deploymentId !== record.readyDeploymentId || record.headSha !== pr.sha) throw new Error("QA publish target is not confirmed READY.");
    const deployment = await g.deployment(record.readyDeploymentId);
    if (!deployment || deployment.id !== request.deploymentId || deployment.projectId !== QA_PROJECT_ID || ![null, "preview"].includes(deployment.target)
      || deployment.pr !== pr.number || deployment.branch !== record.branch || deployment.state !== "READY" || deployment.sha !== pr.sha
      || deployment.leaseId !== record.leaseId || deployment.phase !== "application") throw new Error("QA publish Deployment is not READY.");
    const database = await g.database(registryLeaseToPoolRecord(record));
    if (!database || !sameDatabase(database, record.database)) throw new Error("QA publish database identity changed.");
    const alias = await g.alias(record.slot);
    if (alias && (alias.projectId !== QA_PROJECT_ID || !record.deployments.some(d => d.id === alias.deploymentId))) throw new Error("QA alias belongs to another lease.");
    if (record.aliasAssignment?.state === "pending") {
      if (!alias || alias.deploymentId !== deployment.id) throw new Error("QA alias assignment outcome is uncertain; do not retry the mutation.");
    } else {
      record = await update(g, record, { aliasAssignment: { alias: qaAlias(record.slot), deploymentId: deployment.id, sha: deployment.sha, state: "pending" } }, request.requestId);
      await g.assignAlias(registryLeaseToPoolRecord(record), deployment);
    }
    const assigned = await g.alias(record.slot);
    if (!assigned || assigned.projectId !== QA_PROJECT_ID || assigned.deploymentId !== deployment.id) throw new Error("QA alias assignment is unconfirmed.");
    return success(await update(g, record, { state: "published", aliasSha: pr.sha, aliasAssignment: { ...record.aliasAssignment!, state: "assigned" } }, randomUUID()));
  }
  throw new Error("Unsupported QA registry action.");
}

export async function runRegistryManager(env: Env = process.env): Promise<void> {
  if (env.EVENT_NAME === "schedule") throw new Error("Scheduled QA monitoring is disabled.");
  const initializing = env.EVENT_NAME === "workflow_dispatch" && env.QA_ACTION === "initialize";
  if (!initializing && env.CAKE_QA_REGISTRY_ENABLED !== "true") throw new Error("QA registry cutover has not been enabled.");
  const closed = env.EVENT_NAME === "pull_request_target";
  const event = closed ? obj(JSON.parse(await readFile(env.EVENT_PATH!, "utf8"))) : null;
  const pr = closed ? Number(obj(event!.pull_request).number) : Number(env.QA_PR_NUMBER);
  if (initializing) console.log("Cake: QA registry initialize stage=configuration");
  const store = createQaRegistryStore({ ...env });
  const g = new RegistryGateway(env, store, undefined, !closed && env.QA_ACTION === "release");
  if (initializing) { await initializeRegistry(g, env); return; }
  const request: RegistryRequest = { action: closed ? "release" : env.QA_ACTION as RegistryAction, requestId: closed ? randomUUID() : env.QA_REQUEST_ID!, pr,
    leaseId: env.QA_LEASE_ID, sha: env.QA_SOURCE_SHA, phase: env.QA_PHASE as RegistryRequest["phase"], attemptId: env.QA_ATTEMPT_ID, deploymentId: env.QA_DEPLOYMENT_ID };
  if (closed) {
    await g.assertCloseEvent(pr);
    const record = selected(await store.read(), pr);
    if (!record) { console.log("Cake: closed PR has no QA lease."); return; }
    request.leaseId = record.leaseId;
  }
  const result = await runRegistryAction(g, request, closed);
  console.log(JSON.stringify(result));
  if (!closed && env.QA_RESULT_PATH) await writeFile(env.QA_RESULT_PATH, JSON.stringify(result), { mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRegistryManager().catch(() => {
    console.error(process.env.QA_ACTION === "initialize"
      ? "QA registry initialization failed. Keep QA cutover disabled; inspect the last initialization stage."
      : "QA operation failed. The registry remains reserved; inspect the scoped operation and retry safely.");
    process.exitCode = 1;
  });
}
