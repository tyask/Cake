import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  featureBranch, fullSha, leaseToken, parseLeaseRecord, qaAlias, QA_ENVIRONMENT, QA_NEON_PROJECT_ID,
  QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, replayDeployments,
  type DatabaseIdentity, type GithubDeployment, type QaLeaseRecord, type SavedLease,
} from "../lib/qa-pool";
import { runQaRequest, type QaGateway, type QaPullRequest, type QaRequest, type RemoteDeployment } from "../lib/qa-pool-service";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;
type ApiResult = { status: number; data: unknown };
export type QaTransport = (method: string, url: string, token: string, body?: unknown) => Promise<ApiResult>;
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("APIの応答形式を確認できません。");
  return value as JsonObject;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("API一覧の応答形式を確認できません。");
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string" || !value) throw new Error("API識別子を確認できません。");
  return value;
};
const safeNumber = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("API番号を確認できません。");
  return Number(value);
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
  constructor(private readonly env: Environment, private readonly request: QaTransport = transport) {}
  private async api(provider: "github" | "vercel" | "neon", path: string, method = "GET", body?: unknown, missing = false): Promise<unknown> {
    const base = { github: "https://api.github.com", vercel: "https://api.vercel.com", neon: "https://console.neon.tech/api/v2" }[provider];
    const token = this.env[{ github: "GITHUB_TOKEN", vercel: "VERCEL_TOKEN", neon: "NEON_API_KEY" }[provider]];
    if (!token) throw new Error(`${provider} API認証がありません。`);
    const suffix = provider === "vercel" ? `${path.includes("?") ? "&" : "?"}slug=fumin1` : "";
    const response = await this.request(method, base + path + suffix, token, body);
    if (missing && response.status === 404) return null;
    if (response.status < 200 || response.status > 299) throw new Error(`${provider} API ${response.status}。確認不能のため処理を停止します。`);
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
    try { return object(JSON.parse(this.env.CAKE_QA_APPROVED_HEADS ?? "{}"))[String(number)] === sha; }
    catch { throw new Error("確認済みPR SHA設定が不正です。"); }
  }
  async pullRequest(number: number): Promise<QaPullRequest> {
    const pr = object(await this.api("github", `/repos/${QA_REPOSITORY}/pulls/${number}`));
    const head = object(pr.head), base = object(pr.base), repo = object(head.repo);
    const sha = str(head.sha);
    if (pr.state !== "open" && pr.state !== "closed") throw new Error("PR状態が不正です。");
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
  async assertGate(): Promise<void> {
    for (const key of ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED"]) {
      if (this.env[key] !== "true") throw new Error(`${key} の確認設定がありません。生成・削除を開始しません。`);
    }
    const project = object(await this.api("vercel", `/v9/projects/${QA_PROJECT_ID}`));
    const link = object(project.link);
    if (project.id !== QA_PROJECT_ID || project.name !== "cake" || project.accountId !== "team_D1Mcx2TdFWPKcypfu8KzNMub"
      || link.type !== "github" || link.org !== "tyask" || link.repo !== "Cake" || link.productionBranch !== "main") throw new Error("対象project/team/repositoryが一致しません。");
    this.repoId = safeNumber(link.repoId);
    if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST ?? "")
      || !/^br-[a-z0-9-]+$/.test(this.env.CAKE_QA_PARENT_BRANCH_ID ?? "")) throw new Error("本番hostまたはNative親branchの確認情報がありません。");
    // Fail before claiming if branch/endpoint verification cannot authenticate.
    const neonProject = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}`)).project);
    if (neonProject.id !== QA_NEON_PROJECT_ID) throw new Error("Neon project所属を確認できません。");
    // Old PRs without the gate must be migrated/closed before activation; main config alone is insufficient.
    for (const pr of await this.openPullRequests()) {
      if (pr.repository !== QA_REPOSITORY || !featureBranch(pr.branch)) continue;
      const content = object(await this.api("github", `/repos/${QA_REPOSITORY}/contents/vercel.json?ref=${pr.sha}`));
      let config: JsonObject;
      try { config = object(JSON.parse(Buffer.from(str(content.content), "base64").toString("utf8"))); } catch { throw new Error("既存PRのデプロイ停止設定を確認できません。"); }
      const enabled = object(object(config.git).deploymentEnabled);
      if (enabled["**"] !== false || enabled.main !== true || Object.entries(enabled).some(([key, value]) => key !== "main" && value !== false)) throw new Error("既存PRの自動Preview停止が未適用です。有効化できません。");
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
  async database(record: QaLeaseRecord): Promise<DatabaseIdentity | null> {
    const { branches, endpoints } = await this.neonResources();
    const matches = branches.filter((b) => b.name === `preview/${record.branch}`);
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error("Native枝名が重複しています。");
    const branch = matches[0];
    if (branch.project_id !== QA_NEON_PROJECT_ID || branch.parent_id !== this.env.CAKE_QA_PARENT_BRANCH_ID || branch.default !== false || branch.protected !== false
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
    const value = await this.api("vercel", `/v4/aliases/${qaAlias(slot)}`, "GET", undefined, true);
    if (value === null) return null;
    const alias = object(value);
    return { projectId: str(alias.projectId), deploymentId: str(alias.deploymentId ?? object(alias.deployment).id) };
  }
  async assignAlias(record: QaLeaseRecord, deployment: RemoteDeployment) {
    await this.api("vercel", `/v2/deployments/${deployment.id}/aliases`, "POST", { alias: qaAlias(record.slot) });
  }
  deletionApproved() { return this.env.CAKE_QA_DELETE_APPROVED === "true"; }
  async deleteAlias(record: QaLeaseRecord) {
    if (!this.deletionApproved() || record.state !== "deleting") throw new Error("削除は未承認です。");
    await this.api("vercel", `/v2/aliases/${qaAlias(record.slot)}`, "DELETE");
  }
  async deleteDeployment(deployment: RemoteDeployment) {
    if (!this.deletionApproved()) throw new Error("削除は未承認です。");
    const value = object(await this.api("vercel", `/v13/deployments/${deployment.id}`, "DELETE"));
    if (value.state !== "DELETED") throw new Error("deployment削除応答を確認できません。");
  }
}

export async function runQaWriter(env: Environment = process.env, request?: QaRequest, gateway?: QaGateway): Promise<void> {
  if (env.CAKE_QA_POOL_ENABLED !== "true") { console.log("Cake: QA poolは未有効化です。生成・削除・台帳変更を実行しません。"); return; }
  if (!request) {
    const event = env.EVENT_PATH ? object(JSON.parse(await readFile(env.EVENT_PATH, "utf8"))) : {};
    const action = env.QA_ACTION?.trim() || (env.EVENT_NAME === "schedule" || env.EVENT_NAME === "pull_request_target" && event.action === "closed" ? "refresh" : "claim");
    if (!["claim", "release", "refresh"].includes(action)) throw new Error("QA操作が不正です。");
    const pr = env.QA_PR_NUMBER ? safeNumber(Number(env.QA_PR_NUMBER)) : event.number ? safeNumber(event.number) : undefined;
    request = { action: action as QaRequest["action"], pr, leaseId: env.QA_LEASE_ID };
  }
  // Mutations must run in the single reviewed Actions writer, never from a local CLI.
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== QA_REPOSITORY || env.GITHUB_REF !== "refs/heads/main") throw new Error("信頼済みmainの単一Actions writerから実行してください。");
  await runQaRequest(gateway ?? new HttpQaGateway(env), request, { token: randomUUID });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runQaWriter().catch(() => { console.error("QA writerが確認不能で停止しました。枠・削除対象記録を保持します。"); process.exitCode = 1; });
}
