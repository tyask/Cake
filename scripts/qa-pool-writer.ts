import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  featureBranch, fullSha, leaseToken, parseLeaseRecord, qaAlias, QA_ENVIRONMENT, QA_NEON_PROJECT_ID,
  QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, replayDeployments, sameDatabase,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord, type SavedLease,
} from "../lib/qa-pool";
import { runQaRequest, type QaGateTarget, type QaGateway, type QaPullRequest, type QaRequest, type RemoteDeployment } from "../lib/qa-pool-service";
import { decodeGitConfigFile, type GitConfigEvidence } from "../lib/qa-pool-gate";
import { aliasApproval, aliasPlan, deletionApproval, deletePlan, diagnoseDeletionApproval, probeApproval,
  type AliasPlan, type DeletePlan, type DeletionApprovalDiagnosis } from "../lib/qa-pool-authorization";
import { maskQaHosts, publicQaOutput } from "../lib/qa-output-privacy";
import { contextualQaFailure, QaDiagnosticFailure, qaDiagnosticFields, qaFailureAnnotation, type QaDiagnosticFields } from "../lib/qa-diagnostics";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;
type ApiResult = { status: number; data: unknown };
export type QaTransport = (method: string, url: string, token: string, body?: unknown) => Promise<ApiResult>;
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QaDiagnosticFailure({ reason: "INVALID_RESPONSE" });
  return value as JsonObject;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new QaDiagnosticFailure({ reason: "INVALID_RESPONSE" });
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new QaDiagnosticFailure({ reason: "INVALID_RESPONSE" });
  return value;
};
const safeNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new QaDiagnosticFailure({ reason: "INVALID_RESPONSE" });
  return Number(value);
};
const publicDatabase = (database: DatabaseIdentity | undefined) => database ? {
  projectId: database.projectId, branchId: database.branchId, endpointId: database.endpointId,
} : null;
const apiDiagnosticContext = (provider: "github" | "vercel" | "neon", path: string, method: string): Partial<QaDiagnosticFields> => {
  const stage: QaDiagnosticFields["stage"] = provider === "github"
    ? path.includes("/deployments") ? method === "POST" ? "SAVE_LEDGER" : "READ_LEDGER"
      : /\/pulls(?:\/|\?|$)/.test(path) ? "READ_PR" : path.includes("/actions/variables") ? "READ_VARIABLES" : "READ_GIT"
    : provider === "neon" ? "READ_DATABASE"
      : path.includes("/aliases") ? method === "DELETE" ? "DELETE_ALIAS" : method === "POST" ? "ASSIGN_ALIAS" : "READ_ALIAS"
        : path.includes("/deployments") ? method === "DELETE" ? "DELETE_DEPLOYMENT" : method === "POST" ? "CREATE_DEPLOYMENT"
          : path.startsWith("/v7/deployments?") ? "READ_DEPLOYMENTS" : "READ_DEPLOYMENT" : "READ_PROJECT";
  return { stage, provider: provider === "github" ? "GITHUB" : provider === "vercel" ? "VERCEL" : "NEON",
    method: ["GET", "POST", "PATCH", "DELETE"].includes(method) ? method as QaDiagnosticFields["method"] : "UNKNOWN" };
};
const transport: QaTransport = async (method, url, token, body) => {
  try {
    const response = await fetch(url, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    // Never include URLs, environment values or remote error bodies in logs.
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data };
  } catch { throw new Error("外部APIの応答を確認できません。記録を保持します。"); }
};

export class HttpQaGateway implements QaGateway {
  private repoId = 0;
  constructor(private readonly env: Environment, private readonly request: QaTransport = transport, private readonly access: "read" | "write" = "read") {
    maskQaHosts([env.CAKE_QA_PRODUCTION_DATABASE_HOST, env.CAKE_QA_DELETE_APPROVALS, env.CAKE_QA_ALIAS_APPROVALS], env);
  }
  private async api(provider: "github" | "vercel" | "neon", path: string, method = "GET", body?: unknown, missing = false): Promise<unknown> {
    const diagnostic = apiDiagnosticContext(provider, path, method);
    if (this.access === "read" && method !== "GET") throw new QaDiagnosticFailure({ ...diagnostic, reason: "METHOD_NOT_ALLOWED" });
    const base = { github: "https://api.github.com", vercel: "https://api.vercel.com", neon: "https://console.neon.tech/api/v2" }[provider];
    const token = this.env[{ github: "GITHUB_TOKEN", vercel: "VERCEL_TOKEN", neon: "NEON_API_KEY" }[provider]];
    if (!token) throw new QaDiagnosticFailure({ ...diagnostic, reason: "AUTH_MISSING" });
    const suffix = provider === "vercel" ? `${path.includes("?") ? "&" : "?"}slug=fumin1` : "";
    const response = await this.request(method, base + path + suffix, token, body).catch(() => {
      throw new QaDiagnosticFailure({ ...diagnostic, reason: "TRANSPORT_ERROR" });
    });
    maskQaHosts(response.data, this.env);
    if (missing && response.status === 404) return null;
    if (response.status < 200 || response.status > 299) throw new QaDiagnosticFailure({ ...diagnostic, status: response.status, reason: "HTTP_ERROR" });
    return response.data;
  }
  private async ledgerRecords(): Promise<GithubDeployment[]> {
    const records: GithubDeployment[] = [];
    for (let page = 1; ; page++) {
      if (page > 1000) throw new Error("台帳の全ページ取得を確認できません。");
      const batch = array(await this.api("github", `/repos/${QA_REPOSITORY}/deployments?task=${QA_TASK}&per_page=100&page=${page}`));
      records.push(...batch.map((v) => object(v) as unknown as GithubDeployment));
      if (batch.length < 100) break;
    }
    return records;
  }
  async pool() {
    return replayDeployments(await this.ledgerRecords());
  }
  async save(record: QaLeaseRecord): Promise<SavedLease> {
    parseLeaseRecord(record);
    const records = await this.ledgerRecords();
    const latest = replayDeployments(records)[record.slot];
    if ((latest?.id ?? null) !== record.previousRecordId) throw new Error("台帳の保存前提が変わりました。");
    // Validate history before POST, including feature branch single-use across overwritten slot snapshots.
    const idForValidation = Math.max(0, ...records.map((d) => d.id)) + 1;
    replayDeployments([...records, { id: idForValidation, task: QA_TASK, environment: QA_ENVIRONMENT, sha: record.headSha, payload: record }]);
    const value = object(await this.api("github", `/repos/${QA_REPOSITORY}/deployments`, "POST", {
      ref: record.headSha, task: QA_TASK, environment: QA_ENVIRONMENT, auto_merge: false,
      required_contexts: [], transient_environment: true, production_environment: false,
      description: `${record.slot} PR #${record.pr} ${record.state}`, payload: record,
    }));
    const id = safeNumber(value.id);
    if (value.sha !== record.headSha || value.task !== QA_TASK || value.environment !== QA_ENVIRONMENT
      || !isDeepStrictEqual(parseLeaseRecord(value.payload), record)) throw new Error("台帳保存の応答が一致しません。再実行で再読込してください。");
    // No statuses are written: lease state is immutable payload, independent of auto_inactive/retention.
    return { id, payload: record };
  }
  private approved(number: number, sha: string): boolean {
    try {
      const heads = object(JSON.parse(this.env.CAKE_QA_APPROVED_HEADS?.trim() || "{}"));
      if (Object.entries(heads).some(([pr, approvedSha]) => !/^[1-9][0-9]*$/.test(pr)
        || !Number.isSafeInteger(Number(pr)) || !fullSha(approvedSha))) throw new Error();
      return fullSha(sha) && Object.hasOwn(heads, String(number)) && heads[String(number)] === sha;
    }
    catch { throw new Error("確認済みPR SHA設定が不正です。"); }
  }
  async pullRequest(number: number): Promise<QaPullRequest> {
    const pr = object(await this.api("github", `/repos/${QA_REPOSITORY}/pulls/${number}`));
    const head = object(pr.head), base = object(pr.base), repo = object(head.repo);
    const sha = str(head.sha);
    if (pr.state !== "open" && pr.state !== "closed") throw new Error("PR状態が不正です。");
    if (safeNumber(pr.number) !== number) throw new Error("取得PR番号が対象と一致しません。");
    return { number: safeNumber(pr.number), state: pr.state, branch: str(head.ref), sha, repository: str(repo.full_name), base: str(base.ref), approved: this.approved(number, sha) };
  }
  async openPullRequests(): Promise<QaPullRequest[]> {
    const result: QaPullRequest[] = [];
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error("PR一覧が大きすぎます。");
      const batch = array(await this.api("github", `/repos/${QA_REPOSITORY}/pulls?state=open&base=main&per_page=100&page=${page}`));
      for (const value of batch) {
        const pr = object(value), head = object(pr.head), repo = object(head.repo);
        const number = safeNumber(pr.number), sha = str(head.sha);
        result.push({ number, state: "open", branch: str(head.ref), sha, repository: str(repo.full_name), base: "main", approved: this.approved(number, sha) });
      }
      if (batch.length < 100) return result;
    }
  }
  generationEnabled() { return this.env.CAKE_QA_POOL_ENABLED === "true"; }
  probeAuthorization(pr: number, sha: string) {
    try { return probeApproval(this.env.CAKE_QA_PROBE_APPROVALS, pr, sha); }
    catch { throw new QaDiagnosticFailure({ stage: "PROBE_APPROVAL", provider: "NONE", method: "NONE", reason: "VALIDATION_ERROR" }); }
  }
  private assertProject(value: unknown): JsonObject {
    const project = object(value), link = object(project.link);
    if (project.id !== QA_PROJECT_ID || project.name !== "cake" || project.accountId !== "team_D1Mcx2TdFWPKcypfu8KzNMub"
      || link.type !== "github" || link.org !== "tyask" || link.repo !== "Cake" || link.productionBranch !== "main") throw new Error("対象project/team/repositoryが一致しません。");
    this.repoId = safeNumber(link.repoId);
    return project;
  }
  private async gitConfiguration(branch: string, sha: string): Promise<GitConfigEvidence & { branch: string }> {
    if (!fullSha(sha)) throw new Error("Git設定の完全commit SHAを確認できません。");
    const file = decodeGitConfigFile(await this.api("github", `/repos/${QA_REPOSITORY}/contents/vercel.json?ref=${sha}`));
    return { branch, commitSha: sha, blobSha: file.blobSha };
  }
  private async mainGitConfiguration(): Promise<GitConfigEvidence & { branch: string }> {
    const branch = object(await this.api("github", `/repos/${QA_REPOSITORY}/branches/main`));
    if (branch.name !== "main") throw new Error("mainの現在commitを確認できません。");
    return this.gitConfiguration("main", str(object(branch.commit).sha));
  }
  private async currentTarget(target: QaGateTarget): Promise<QaPullRequest> {
    if (!Number.isSafeInteger(target.pr) || target.pr < 1 || !featureBranch(target.branch) || !fullSha(target.sha)) throw new Error("Git設定の対象PR・feature枝・完全SHAがありません。");
    const pr = await this.pullRequest(target.pr);
    if (pr.state !== "open" || pr.repository !== QA_REPOSITORY || pr.base !== "main"
      || pr.branch !== target.branch || pr.sha !== target.sha) throw new Error("生成対象PRの現在OPEN headが一致しません。");
    return pr;
  }
  async assertGate(mode: "create" | "probe" | "cleanup" | "alias" = "create", target?: QaGateTarget): Promise<void> {
    for (const key of mode === "create" ? ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED"] : []) {
      if (this.env[key] !== "true") throw new Error(`${key} の確認設定がありません。生成・削除を開始しません。`);
    }
    const project = this.assertProject(await this.api("vercel", `/v9/projects/${QA_PROJECT_ID}`));
    if (mode !== "cleanup" && project.previewDeploymentsDisabled !== false) throw new Error("Previewが有効であることを確認できません。");
    if (mode !== "cleanup" && (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST ?? "")
      || !/^br-[a-z0-9-]+$/.test(this.env.CAKE_QA_PARENT_BRANCH_ID ?? ""))) throw new Error("本番hostまたはNative親branchの確認情報がありません。");
    // Fail before claiming if branch/endpoint verification cannot authenticate.
    const neonProject = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}`)).project);
    if (neonProject.id !== QA_NEON_PROJECT_ID) throw new Error("Neon project所属を確認できません。");
    if (mode !== "cleanup") {
      if (!target || !Number.isSafeInteger(target.pr) || target.pr < 1 || !featureBranch(target.branch) || !fullSha(target.sha)) throw new Error("Git設定の対象PR・feature枝・完全SHAがありません。");
      // Re-read each immutable config for every target and every creation attempt.
      await this.mainGitConfiguration();
      await this.gitConfiguration(target.branch, target.sha);
      const pr = await this.currentTarget(target);
      if (mode === "create" && !pr.approved || mode === "probe" && !this.probeAuthorization(pr.number, pr.sha)) throw new Error("対象PRの現在SHAへの生成承認がありません。");
    }
  }
  private remote(value: unknown): RemoteDeployment {
    const d = object(value), meta = object(d.meta), git = d.gitSource ? object(d.gitSource) : {};
    const branch = str(git.ref ?? meta.githubCommitRef), sha = str(git.sha ?? meta.githubCommitSha);
    if (git.ref !== undefined && meta.githubCommitRef !== undefined && git.ref !== meta.githubCommitRef
      || git.sha !== undefined && meta.githubCommitSha !== undefined && git.sha !== meta.githubCommitSha) throw new Error("deployment sourceのSHA/枝が矛盾しています。");
    const phase = meta.cakeQaPhase;
    if (!["provisioning", "application"].includes(String(phase)) || !leaseToken(meta.cakeQaLeaseId)
      || !leaseToken(meta.cakeQaAttemptId) || !fullSha(sha) || !featureBranch(branch)) throw new Error("deploymentのQA識別情報がありません。");
    const url = typeof d.url === "string" && /^[a-z0-9-]+\.vercel\.app$/.test(d.url) ? `https://${d.url}` : undefined;
    return { id: str(d.id ?? d.uid), projectId: str(d.projectId), target: d.target === undefined ? null : d.target as string | null,
      branch, sha, leaseId: meta.cakeQaLeaseId as string, pr: safeNumber(Number(meta.cakeQaPr)), attemptId: meta.cakeQaAttemptId as string,
      phase: phase as RemoteDeployment["phase"], state: str(d.readyState ?? d.state), url };
  }
  async deployments(record: QaLeaseRecord): Promise<RemoteDeployment[]> {
    const result: RemoteDeployment[] = [];
    let until: number | undefined;
    const seen = new Set<number>();
    for (let page = 0; ; page++) {
      if (page > 1000) throw new Error("deployment一覧の全ページ取得を確認できません。");
      const list = object(await this.api("vercel", `/v7/deployments?projectId=${QA_PROJECT_ID}&branch=${encodeURIComponent(record.branch)}&limit=100${until ? `&until=${until}` : ""}`));
      for (const value of array(list.deployments)) {
        const d = object(value), meta = object(d.meta ?? {});
        // Every deployment on the lease's feature branch must belong to it. Never adopt/delete another lease.
        if (meta.githubCommitRef !== record.branch) throw new Error("branch filterが一致しないdeploymentを返しました。");
        result.push(this.remote(value));
      }
      const next = object(list.pagination ?? {}).next;
      if (next === null || next === undefined) return result;
      until = safeNumber(next);
      if (seen.has(until)) throw new Error("deployment paginationが循環しています。");
      seen.add(until);
    }
  }
  async deployment(id: string): Promise<RemoteDeployment | null> {
    const value = await this.api("vercel", `/v13/deployments/${id}?withGitRepoInfo=true`, "GET", undefined, true);
    return value === null ? null : this.remote(value);
  }
  async create(record: QaLeaseRecord): Promise<RemoteDeployment> {
    const intent = record.intent;
    if (record.state !== "held" || !intent || intent.sha !== record.headSha) throw new Error("貸出と作成intentがありません。");
    await this.assertGate(record.purpose === "probe" ? "probe" : "create", { pr: record.pr, branch: record.branch, sha: record.headSha });
    if (record.purpose === "probe" && this.probeAuthorization(record.pr, record.headSha)?.slot !== record.slot) throw new Error("限定probeの承認がありません。");
    const env = {
      AUTH_MODE: "test",
      CAKE_QA_SLOT: record.slot, CAKE_QA_PR: String(record.pr), CAKE_QA_LEASE_TOKEN: record.leaseId,
      CAKE_QA_SOURCE_BRANCH: record.branch, CAKE_QA_SOURCE_SHA: record.headSha,
      CAKE_QA_PRODUCTION_DATABASE_HOST: this.env.CAKE_QA_PRODUCTION_DATABASE_HOST!,
      // Empty on the first Native deployment: setup must fail before any DB connection.
      CAKE_QA_DATABASE_HOST: record.database?.host ?? "",
    };
    const value = await this.api("vercel", "/v13/deployments?forceNew=1", "POST", {
      name: "cake", project: QA_PROJECT_ID,
      gitSource: { type: "github", repoId: this.repoId, ref: record.branch, sha: record.headSha },
      env, build: { env }, meta: { cakeQaLeaseId: record.leaseId, cakeQaPr: String(record.pr), cakeQaSlot: record.slot,
        cakeQaAttemptId: intent.attemptId, cakeQaPhase: intent.phase },
    });
    return this.remote(value);
  }
  private async neonResources(): Promise<{ branches: JsonObject[]; endpoints: JsonObject[] }> {
    const branches: JsonObject[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page > 1000) throw new Error("Neon枝の全ページ取得を確認できません。");
      const value = object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/branches?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      branches.push(...array(value.branches).map(object));
      const next = object(value.pagination ?? {}).next;
      if (!next) break;
      cursor = str(next);
      if (seen.has(cursor)) throw new Error("Neon paginationが循環しています。");
      seen.add(cursor);
    }
    const endpointResponse = object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/endpoints`));
    return { branches, endpoints: array(endpointResponse.endpoints).map(object) };
  }
  async database(record: QaLeaseRecord, mode: "create" | "cleanup" = "create"): Promise<DatabaseIdentity | null> {
    const { branches, endpoints } = await this.neonResources();
    const matches = branches.filter((b) => mode === "cleanup" && record.database ? b.id === record.database.branchId : b.name === `preview/${record.branch}`);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("Native枝名が重複しています。");
    const branch = matches[0];
    if (branch.project_id !== QA_NEON_PROJECT_ID || branch.default !== false || branch.protected !== false
      || mode === "create" && branch.parent_id !== this.env.CAKE_QA_PARENT_BRANCH_ID
      || !Number.isFinite(Date.parse(String(branch.created_at))) || Date.parse(String(branch.created_at)) < Date.parse(record.createdAt)) throw new Error("Native枝の親・作成時刻・隔離を確認できません。");
    const found = endpoints.filter((e) => e.branch_id === branch.id && e.type === "read_write");
    if (found.length !== 1) throw new Error("Native書込みendpointを一意に確認できません。");
    const endpoint = found[0];
    if (endpoint.project_id !== QA_NEON_PROJECT_ID) throw new Error("Native endpointのproject所属を確認できません。");
    const identity: DatabaseIdentity = { projectId: QA_NEON_PROJECT_ID, branchId: str(branch.id), endpointId: str(endpoint.id), host: str(endpoint.host).replace(/-pooler(?=\.)/, "") };
    if (identity.host === this.env.CAKE_QA_PRODUCTION_DATABASE_HOST || record.retiredDatabases.some((d) => d.branchId === identity.branchId || d.endpointId === identity.endpointId || d.host === identity.host)) throw new Error("本番または旧貸出のDB識別子を検出しました。");
    parseLeaseRecord({ ...record, database: identity });
    return identity;
  }
  async databaseGone(identity: DatabaseIdentity): Promise<boolean> {
    const { branches, endpoints } = await this.neonResources();
    if (branches.some((b) => b.id === identity.branchId) || endpoints.some((e) => e.id === identity.endpointId || e.branch_id === identity.branchId || e.host === identity.host)) return false;
    const branch = await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/branches/${identity.branchId}`, "GET", undefined, true);
    const endpoint = await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/endpoints/${identity.endpointId}`, "GET", undefined, true);
    return branch === null && endpoint === null;
  }
  async alias(slot: QaLeaseRecord["slot"]) {
    try {
      const value = await this.api("vercel", `/v4/aliases/${qaAlias(slot)}`, "GET", undefined, true);
      if (value === null) return null;
      const alias = object(value);
      return { projectId: str(alias.projectId), deploymentId: str(alias.deploymentId ?? object(alias.deployment).id) };
    } catch (error) {
      throw contextualQaFailure(error, { stage: "READ_ALIAS", provider: "VERCEL", method: "GET" });
    }
  }
  async assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment) {
    if (record.purpose === "probe") throw new Error("限定probeは固定aliasを変更できません。");
    await this.api("vercel", `/v2/deployments/${deployment.id}/aliases`, "POST", { alias: qaAlias(record.slot) });
  }
  aliasApproved(plan: AliasPlan) { return aliasApproval(this.env.CAKE_QA_ALIAS_APPROVALS, plan); }
  async assignReadyAlias(record: QaLeaseRecord, deployment: RemoteDeployment, plan: AliasPlan) {
    if (this.access !== "write") throw new Error("GET専用検査からaliasを変更できません。");
    // Only a saved pending receipt permits this POST. An unknown POST is never retried here.
    if (record.purpose !== "probe" || record.state !== "held" || record.intent || !record.database
      || record.readyDeploymentId !== deployment.id || record.headSha !== deployment.sha
      || record.aliasAssignment?.state !== "pending" || record.aliasAssignment.deploymentId !== deployment.id
      || record.aliasAssignment.alias !== plan.alias || record.aliasAssignment.sha !== plan.headSha
      || !isDeepStrictEqual(aliasPlan(record, deployment.id), plan) || !this.aliasApproved(plan)) {
      throw new Error("保存済みREADY・貸出・限定alias承認が一致しません。");
    }
    await this.assertGate("alias", { pr: record.pr, branch: record.branch, sha: record.headSha });
    const ready = await this.deployment(deployment.id);
    if (!ready || ready.id !== deployment.id || ready.state !== "READY" || ready.phase !== "application" || ready.projectId !== QA_PROJECT_ID
      || !(ready.target === null || ready.target === "preview") || ready.pr !== record.pr || ready.branch !== record.branch
      || ready.sha !== record.headSha || ready.leaseId !== record.leaseId
      || !record.deployments.some((d) => d.id === ready.id && d.sha === ready.sha && d.phase === "application")) {
      throw new Error("alias直前のREADY deployment所属が一致しません。");
    }
    const database = await this.database(record);
    if (!database || !sameDatabase(database, record.database) || !sameDatabase(database, plan.database)) {
      throw new Error("alias直前のNative DB識別子が一致しません。");
    }
    await this.currentTarget({ pr: record.pr, branch: record.branch, sha: record.headSha });
    const assigned = await this.alias(record.slot);
    const latest = (await this.pool())[record.slot];
    if (!latest || !isDeepStrictEqual(latest.payload, record) || !this.aliasApproved(plan)) {
      throw new Error("alias直前に貸出世代または承認が変わりました。");
    }
    if (assigned) {
      if (assigned.projectId === QA_PROJECT_ID && assigned.deploymentId === deployment.id) return;
      throw new Error("alias直前に別の割当を検出しました。上書きしません。");
    }
    await this.api("vercel", `/v2/deployments/${deployment.id}/aliases`, "POST", { alias: plan.alias });
  }
  deletionApproved(plan: DeletePlan) {
    const now = Date.now();
    try { return deletionApproval(this.env.CAKE_QA_DELETE_APPROVALS, plan, now); }
    catch { throw new QaDiagnosticFailure({ stage: "APPROVAL_VALIDATE", provider: "NONE", method: "NONE", reason: "VALIDATION_ERROR" }); }
  }
  async deleteAlias(record: QaLeaseRecord, plan: DeletePlan) {
    try {
      if (this.access !== "write") throw new QaDiagnosticFailure({ reason: "METHOD_NOT_ALLOWED" });
      if (!this.deletionApproved(plan) || record.state !== "deleting" || !plan.alias
        || record.purpose === "probe" && !record.aliasAssignment
        || !isDeepStrictEqual(deletePlan(record), plan)) throw new QaDiagnosticFailure({ reason: "CHECK_FAILED" });
      const alias = await this.alias(record.slot);
      const latest = (await this.pool())[record.slot];
      if (!latest || !isDeepStrictEqual(latest.payload, record) || !this.deletionApproved(plan)) throw new QaDiagnosticFailure({ reason: "CHECK_FAILED" });
      if (!alias) return;
      if (alias.projectId !== QA_PROJECT_ID || (record.aliasAssignment
        ? alias.deploymentId !== record.aliasAssignment.deploymentId
        : !record.deployments.some((d) => d.id === alias.deploymentId))) throw new QaDiagnosticFailure({ reason: "CHECK_FAILED" });
      await this.api("vercel", `/v2/aliases/${plan.alias}`, "DELETE");
    } catch (error) {
      throw contextualQaFailure(error, { stage: "DELETE_ALIAS", provider: "VERCEL", method: "DELETE" });
    }
  }
  async deleteDeployment(record: QaLeaseRecord, deployment: RemoteDeployment, plan: DeletePlan) {
    try {
      if (!this.deletionApproved(plan) || record.state !== "deleting" || !isDeepStrictEqual(deletePlan(record), plan)
        || !plan.deploymentIds.includes(deployment.id) || deployment.leaseId !== record.leaseId || deployment.projectId !== QA_PROJECT_ID) throw new QaDiagnosticFailure({ reason: "CHECK_FAILED" });
      const value = object(await this.api("vercel", `/v13/deployments/${deployment.id}`, "DELETE"));
      if (value.state !== "DELETED") throw new QaDiagnosticFailure({ reason: "INVALID_RESPONSE" });
    } catch (error) {
      throw contextualQaFailure(error, { stage: "DELETE_DEPLOYMENT", provider: "VERCEL", method: "DELETE" });
    }
  }

  /** All outputs are curated metadata; remote bodies and environment values stay private. */
  async inspect(options: { action: "preflight" | "plan-probe" | "plan-release"; pr?: number; sha?: string; leaseId?: string; slot?: QaLeaseRecord["slot"] }) {
    if (this.access !== "read") throw new Error("検査にはGET専用adapterを使ってください。");
    if (options.action === "plan-probe" && (!Number.isSafeInteger(options.pr) || Number(options.pr) < 1
      || !fullSha(options.sha) || !options.slot || !["qa1", "qa2", "qa3"].includes(options.slot))) throw new Error("限定probe計画にはOPEN PRの最新完全SHAと指定枠が必要です。");
    if (options.action === "plan-release" && (!Number.isSafeInteger(options.pr) || Number(options.pr) < 1 || !leaseToken(options.leaseId))) throw new Error("削除計画には現在のPRとlease IDが必要です。");
    const approvalNow = Date.now();
    const checks: { name: string; ok: boolean; detail: string; failure?: QaDiagnosticFields }[] = [];
    const check = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
      try { const value = await read(); checks.push({ name, ok: true, detail: "読取・照合成功" }); return value; }
      catch (error) {
        const failure = qaDiagnosticFields(error);
        checks.push({ name, ok: false, detail: failure.status !== null ? `読取API ${failure.status}。未確認として保持。`
          : "認証・設定・識別情報が不足または不一致。未確認として保持。", failure });
        return undefined;
      }
    };
    const project = await check("Vercel project", async () => this.assertProject(await this.api("vercel", `/v9/projects/${QA_PROJECT_ID}`)));
    await check("Preview enabled", async () => {
      if (project?.previewDeploymentsDisabled !== false) throw new Error("Previewが有効であることを確認できません。");
      return true;
    });
    const mainGit = options.action === "plan-release" ? undefined : await check("Main Git configuration", () => this.mainGitConfiguration());
    const pool = await check("GitHub lease ledger", () => this.pool());
    const variables = await check("GitHub repository Variables read", async () => {
      const names: string[] = [];
      for (let page = 1; ; page++) {
        if (page > 100) throw new Error("変数一覧が大きすぎます。");
        const data = object(await this.api("github", `/repos/${QA_REPOSITORY}/actions/variables?per_page=30&page=${page}`));
        const batch = array(data.variables);
        names.push(...batch.map((v) => str(object(v).name)));
        if (batch.length < 30) return names;
      }
    });
    const native = await check("Neon metadata read", async () => {
      const p = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}`)).project);
      if (p.id !== QA_NEON_PROJECT_ID) throw new Error("Neon projectが不一致です。");
      const resources = await this.neonResources();
      return { branchCount: resources.branches.length, endpointCount: resources.endpoints.length };
    });
    const parent = await check("Native parent configuration", async () => {
      const id = this.env.CAKE_QA_PARENT_BRANCH_ID;
      if (!id || !/^br-[a-z0-9-]+$/.test(id)) throw new Error("Native親IDが未設定です。");
      const value = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/branches/${id}`)).branch);
      if (value.id !== id || value.project_id !== QA_NEON_PROJECT_ID) throw new Error("Native親のprojectが不一致です。");
      return { projectId: QA_NEON_PROJECT_ID, branchId: id, emptyStateProven: false };
    });
    await check("Production comparison host configured", async () => {
      if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST ?? "")) throw new Error("本番host比較設定がありません。");
      return true;
    });
    const aliases: Record<string, unknown> = {};
    for (const slot of ["qa1", "qa2", "qa3"] as const) {
      const value = await check(`Alias ${slot}`, () => this.alias(slot));
      aliases[slot] = value === undefined ? "unconfirmed" : value;
    }
    const requiredVariables = ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED",
      "CAKE_QA_PRODUCTION_DATABASE_HOST", "CAKE_QA_PARENT_BRANCH_ID", "CAKE_QA_APPROVED_HEADS", "CAKE_QA_PROBE_APPROVALS", "CAKE_QA_DELETE_APPROVALS"];
    let selectedPr: QaPullRequest | undefined;
    let targetGit: (GitConfigEvidence & { branch: string; pr: number }) | undefined;
    if (options.pr && options.action !== "plan-release") {
      selectedPr = await check("Target PR", async () => {
        const value = await this.pullRequest(options.pr!);
        if (value.repository !== QA_REPOSITORY || value.base !== "main" || !featureBranch(value.branch) || !fullSha(value.sha)) throw new Error("対象PRの所属が一致しません。");
        return value;
      });
      if (selectedPr && selectedPr.repository === QA_REPOSITORY && selectedPr.base === "main" && featureBranch(selectedPr.branch)) {
        if (options.action === "plan-probe" && (selectedPr.state !== "open" || selectedPr.sha !== options.sha)) throw new Error("限定probe計画にはOPEN PRの最新完全SHAと指定枠が必要です。");
        const target = { pr: selectedPr.number, branch: selectedPr.branch, sha: options.sha ?? selectedPr.sha };
        targetGit = await check("Target Git configuration", async () => {
          await this.currentTarget(target);
          return { ...await this.gitConfiguration(target.branch, target.sha), pr: target.pr };
        });
      }
    }
    const generationChecks = ["Vercel project", "Preview enabled", "Main Git configuration", "Target Git configuration",
      "GitHub lease ledger", "Neon metadata read", "Native parent configuration", "Production comparison host configured", "Target PR"];
    const summary = {
      readOnly: true, projectId: QA_PROJECT_ID, neonProjectId: QA_NEON_PROJECT_ID, checks,
      generationBlocked: options.action !== "plan-release" && checks.some((c) => !c.ok && generationChecks.includes(c.name)),
      gitConfiguration: { scope: "repository-git-trigger-configuration", backendForcedDeploymentPreventionProven: false,
        main: mainGit ?? null, target: targetGit ?? null },
      missingRepositoryVariables: variables ? requiredVariables.filter((name) => !variables.includes(name)) : null,
      native: native ?? null,
      parent: parent ?? null, aliases,
      slots: pool ? Object.fromEntries(Object.entries(pool).map(([slot, saved]) => [slot, saved ? {
        state: saved.payload.state, purpose: saved.payload.purpose ?? "normal", pr: saved.payload.pr, leaseId: saved.payload.leaseId,
        headSha: saved.payload.headSha, deploymentIds: saved.payload.deployments.map((d) => d.id), database: publicDatabase(saved.payload.database),
      } : null])) : null,
      plan: null as unknown,
      deleteApproval: options.action === "plan-release"
        ? diagnoseDeletionApproval(this.env.CAKE_QA_DELETE_APPROVALS, undefined, approvalNow) : undefined as DeletionApprovalDiagnosis | undefined,
    };
    if (options.action === "preflight") return summary;
    if (!options.pr || !Number.isSafeInteger(options.pr)) throw new Error("計画には対象PR番号が必要です。");
    const pr = options.action === "plan-release" ? await check("Target PR", () => this.pullRequest(options.pr!)) : selectedPr;
    if (!pr || !pool || pr.repository !== QA_REPOSITORY || pr.base !== "main" || !featureBranch(pr.branch)) return summary;
    if (options.action === "plan-probe") {
      if (!fullSha(options.sha) || pr.state !== "open" || pr.sha !== options.sha || !options.slot || !["qa1", "qa2", "qa3"].includes(options.slot)) throw new Error("限定probe計画にはOPEN PRの最新完全SHAと指定枠が必要です。");
      const existing = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === pr.number);
      if (existing && (existing.payload.purpose !== "probe" || existing.payload.slot !== options.slot || existing.payload.state !== "held")) throw new Error("対象PRは別の貸出で使用中または返却中です。限定probe計画を作成しません。");
      const occupied = pool[options.slot];
      if (occupied && occupied.payload.state !== "free"
        && !(occupied.payload.purpose === "probe" && occupied.payload.pr === pr.number)) throw new Error("指定枠は別の貸出で使用中です。");
      summary.plan = { action: "probe", projectId: QA_PROJECT_ID, neonProjectId: QA_NEON_PROJECT_ID,
        pr: pr.number, branch: pr.branch, sha: pr.sha, slot: options.slot,
        maximumNewDeployments: occupied && occupied.payload.state !== "free" && occupied.payload.database ? 1 : 2, fixedAliasChanges: false,
        approvalFields: ["projectId", "pr", "sha", "slot", "expiresAt"],
        executionBlocked: summary.generationBlocked || !targetGit,
        requires: ["現在mainと対象PR完全SHAのmain-only Git設定の読取一致", "期限付きprobe承認", "確認済みQA初期状態のNative親IDと本番host", "信頼済みmainの手動writer"],
        deletionRequiresSeparateExactResourceApproval: true };
      return summary;
    }
    const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === options.pr);
    if (!saved || !options.leaseId || saved.payload.leaseId !== options.leaseId) throw new Error("削除計画には現在のPRとlease IDが必要です。");
    const record = saved.payload;
    const planned = await check("Exact deletion resources", async () => {
      if (record.intent || record.deployments.length && !record.database) throw new Error("作成intentまたはDB所属が未確認です。");
      const remote = await this.deployments(record);
      for (const d of remote) {
        const known = record.deployments.find((v) => v.id === d.id);
        if (!known || known.sha !== d.sha || d.projectId !== QA_PROJECT_ID || !(d.target === null || d.target === "preview")
          || d.branch !== record.branch || d.leaseId !== record.leaseId || d.pr !== record.pr) throw new Error("未記録または別貸出のdeploymentがあります。");
      }
      for (const known of record.deployments) {
        const d = await this.deployment(known.id);
        if (d && (d.sha !== known.sha || d.phase !== known.phase || d.projectId !== QA_PROJECT_ID || !(d.target === null || d.target === "preview")
          || d.branch !== record.branch || d.leaseId !== record.leaseId || d.pr !== record.pr)) throw new Error("deployment IDの所属が不一致です。");
      }
      if (record.database) {
        const actual = await this.database(record, "cleanup");
        if (actual ? !sameDatabase(actual, record.database) : !(await this.databaseGone(record.database))) throw new Error("DB識別子の再読取が不一致です。");
      }
      const alias = deletePlan(record).alias ? await this.alias(record.slot) : null;
      if (record.aliasAssignment?.state === "pending" && !alias) throw new Error("alias割当応答が未確認です。削除計画を保留します。");
      if (alias && (alias.projectId !== QA_PROJECT_ID || (record.aliasAssignment
        ? alias.deploymentId !== record.aliasAssignment.deploymentId
        : !record.deployments.some((d) => d.id === alias.deploymentId)))) throw new Error("aliasは別貸出です。");
      return deletePlan(record);
    });
    summary.deleteApproval = diagnoseDeletionApproval(this.env.CAKE_QA_DELETE_APPROVALS, planned, approvalNow);
    summary.plan = planned ? { ...planned, database: publicDatabase(planned.database ?? undefined),
      approvalManifestRequiresPrivateHost: Boolean(planned.database),
      databaseDataLossRequiresApproval: Boolean(planned.database),
      dataLossNotice: planned.database ? "削除するとQA DBと入力データを失います。deploymentの復元はDBの復旧を保証しません。" : null,
    } : null;
    return summary;
  }
}

export async function runQaWriter(env: Environment = process.env, request?: QaRequest, gateway?: QaGateway, apiTransport: QaTransport = transport): Promise<void> {
  if (!request) {
    const event = env.EVENT_PATH ? object(JSON.parse(await readFile(env.EVENT_PATH, "utf8"))) : {};
    const action = env.QA_ACTION?.trim() || (env.EVENT_NAME === "pull_request_target" && event.action === "closed"
      ? "close" : env.EVENT_NAME === "schedule" ? "refresh" : "claim");
    if (["preflight", "plan-probe", "plan-release"].includes(action)) {
      const reader = new HttpQaGateway({ ...env, GITHUB_TOKEN: env.GITHUB_TOKEN ?? env.GH_TOKEN }, apiTransport);
      const report = await reader.inspect({ action: action as "preflight" | "plan-probe" | "plan-release",
        pr: env.QA_PR_NUMBER ? safeNumber(Number(env.QA_PR_NUMBER)) : undefined, sha: env.QA_SOURCE_SHA,
        slot: env.QA_SLOT as QaLeaseRecord["slot"] | undefined, leaseId: env.QA_LEASE_ID });
      console.log(JSON.stringify(publicQaOutput(report, env), null, 2)); return;
    }
    if (!["claim", "release", "refresh", "probe", "alias-only", "close"].includes(action)) throw new Error("QA操作が不正です。");
    const pr = env.QA_PR_NUMBER ? safeNumber(Number(env.QA_PR_NUMBER)) : event.number ? safeNumber(event.number) : undefined;
    request = { action: action as QaRequest["action"], pr, leaseId: env.QA_LEASE_ID, sha: env.QA_SOURCE_SHA,
      slot: env.QA_SLOT as QaLeaseRecord["slot"] | undefined, deploymentId: env.QA_DEPLOYMENT_ID };
  }
  // Mutations must run in the single reviewed Actions writer, never from a local CLI.
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== QA_REPOSITORY || env.GITHUB_REF !== "refs/heads/main") throw new Error("信頼済みmainの単一Actions writerから実行してください。");
  await runQaRequest(gateway ?? new HttpQaGateway(env, apiTransport, "write"), request, { token: randomUUID });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runQaWriter().catch((error) => {
    console.error("QA writerが確認不能で停止しました。枠・削除対象記録を保持します。");
    console.error(qaFailureAnnotation(error));
    process.exitCode = 1;
  });
}
