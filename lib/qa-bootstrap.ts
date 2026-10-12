import {
  featureBranch, fullSha, leaseToken, qaAlias, replayDeployments, sameDatabase, validDatabase,
  QA_NEON_PROJECT_ID, QA_PROJECT_ID, QA_REPOSITORY, QA_TASK, SLOTS,
  type DatabaseIdentity, type GithubDeployment, type Pool, type QaLeaseRecord, type Slot,
} from "./qa-bootstrap-ledger";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;
type Provider = "github" | "vercel" | "neon";
export type QaBootstrapTransport = (method: string, url: string, token: string) => Promise<{ status: number; data: unknown }>;
export type QaBootstrapOptions = { action: "preflight" | "plan-probe" | "plan-release"; pr?: number; sha?: string; slot?: Slot; leaseId?: string };
export type QaBootstrapReason = {
  code: string; provider?: Provider; status?: number; credential?: string; requirement?: string;
};
export type QaBootstrapCheck = { name: string; ok: boolean; reason: QaBootstrapReason };
type Alias = { projectId: typeof QA_PROJECT_ID; deploymentId: string };
type PullRequest = { number: number; state: "open" | "closed"; branch: string; sha: string };
type RemoteDeployment = { id: string; projectId: string; target: string | null; branch: string; sha: string; leaseId: string; pr: number; phase: "provisioning" | "application" };
type NeonResources = { branches: JsonObject[]; endpoints: JsonObject[] };
type NeonBranchMetadata = {
  projectId: typeof QA_NEON_PROJECT_ID; branchId: string; name: string | null; nameEvidence: "branch.name" | "unavailable";
  parentId: string | null; parentIdEvidence: "branch.parent_id" | "unavailable";
  default: boolean | null; defaultEvidence: "branch.default" | "unavailable";
};
type NeonMetadata = {
  projectId: typeof QA_NEON_PROJECT_ID; branchCount: number; endpointCount: number; branches: NeonBranchMetadata[];
  endpoints: { projectId: typeof QA_NEON_PROJECT_ID; endpointId: string; branchId: string | null; branchIdEvidence: "endpoint.branch_id" | "unavailable" }[];
  defaultBranchIds: string[]; observedPreviewCodexBranchIds: string[];
};
type HostComparisonResult = "match" | "no-match" | "unknown";
type ProductionHostComparison = { result: HostComparisonResult; endpoints: { endpointId: string; result: HostComparisonResult }[] | null };
export type ProbePlan = {
  action: "plan-probe"; executionEnabled: false; projectId: typeof QA_PROJECT_ID; neonProjectId: typeof QA_NEON_PROJECT_ID;
  pr: number; branch: string; sha: string; headSha: string; slot: Slot; maximumNewDeployments: number;
  fixedAliasChanges: false; deletionRequiresSeparateExactResourceApproval: true;
};
export type ReleasePlan = {
  action: "plan-release"; executionEnabled: false; projectId: typeof QA_PROJECT_ID; neonProjectId: typeof QA_NEON_PROJECT_ID;
  pr: number; branch: string; slot: Slot; leaseId: string; headSha: string; deploymentIds: string[];
  alias: string | null; database: DatabaseIdentity;
};
export type QaBootstrapReport = {
  action: QaBootstrapOptions["action"]; readOnly: true; executionEnabled: false;
  executionReason: "bootstrap-has-no-mutating-operation";
  projectId: typeof QA_PROJECT_ID; neonProjectId: typeof QA_NEON_PROJECT_ID;
  checks: QaBootstrapCheck[]; prerequisites: { name: string; confirmed: boolean; requirement: string }[];
  missingRepositoryVariables: string[] | null;
  native: NeonMetadata | null;
  productionHostComparison: ProductionHostComparison;
  parent: {
    projectId: typeof QA_NEON_PROJECT_ID; branchId: string; emptyStateProven: false;
    candidateSummary: { branch: NeonBranchMetadata; observedChildBranchIds: string[] | null;
      observedPreviewCodexChildBranchIds: string[] | null; childEvidence: "listed branch.parent_id" | "unavailable" };
  } | null;
  sourcePolicy: { requirement: "Preview-only REST API source policy"; confirmed: boolean; previewDeploymentsDisabled: boolean | null; previewRuleCount: number | null; sources: string[] | null };
  aliases: Record<Slot, Alias | null | "unconfirmed">;
  slots: Record<Slot, { state: QaLeaseRecord["state"]; purpose: "probe" | "normal"; pr: number; leaseId: string; headSha: string; deploymentIds: string[]; database: DatabaseIdentity | null } | null> | null;
  plan: ProbePlan | ReleasePlan | null;
};

class ReadFailure extends Error {
  constructor(readonly reason: QaBootstrapReason) { super("QA read could not be confirmed."); }
}
function fail(code: string, requirement?: string): never { throw new ReadFailure({ code, ...(requirement ? { requirement } : {}) }); }
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-response");
  return value as JsonObject;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) fail("invalid-response");
  return value as unknown[];
};
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const deploymentId = (value: unknown): value is string => typeof value === "string" && /^dpl_[a-zA-Z0-9_-]+$/.test(value);
const branchId = (value: unknown): value is string => typeof value === "string" && /^br-[a-z0-9-]+$/.exec(value)?.[0] === value;
const endpointId = (value: unknown): value is string => typeof value === "string" && /^ep-[a-z0-9-]+$/.exec(value)?.[0] === value;
const databaseHost = (value: unknown): value is string => typeof value === "string" && /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(value);
const normalizedHost = (value: unknown): string => {
  if (!databaseHost(value)) fail("invalid-response");
  return (value as string).replace(/-pooler(?=\.)/, "");
};

function comparisonHost(value: unknown): { normalized: string; endpointId: string } | null {
  if (typeof value !== "string" || value.length > 253) return null;
  const labels = value.toLowerCase().split(".");
  if (labels.length < 4 || labels.at(-2) !== "neon" || labels.at(-1) !== "tech"
    || labels.some((label) => label.length > 63 || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.exec(label)?.[0] !== label)) return null;
  const id = labels[0].replace(/-pooler$/, "");
  if (!endpointId(id) || id.endsWith("-")) return null;
  return { normalized: [id, ...labels.slice(1)].join("."), endpointId: id };
}

function productionHostComparison(resources: NeonResources | undefined, productionValue: unknown): ProductionHostComparison {
  const production = comparisonHost(productionValue);
  const endpoints = resources ? resources.endpoints.map((endpoint): NonNullable<ProductionHostComparison["endpoints"]>[number] => {
    const observed = comparisonHost(endpoint.host);
    const result: HostComparisonResult = !production || !observed || observed.endpointId !== endpoint.id ? "unknown"
      : production.normalized === observed.normalized ? "match"
      : production.endpointId === observed.endpointId ? "unknown" : "no-match";
    return { endpointId: endpoint.id as string, result };
  }).sort((a, b) => a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0) : null;
  return { result: endpoints?.some((endpoint) => endpoint.result === "match") ? "match"
    : endpoints?.length && endpoints.every((endpoint) => endpoint.result === "no-match") ? "no-match" : "unknown", endpoints };
}

function neonBranchMetadata(branch: JsonObject, env: Environment): NeonBranchMetadata {
  const value = branch.name;
  const name = typeof value === "string" && value.length <= 255 && /^[a-zA-Z0-9]/.test(value)
    && !/[^a-zA-Z0-9._/-]/.test(value)
    && !comparisonHost(value)
    && ![env.GITHUB_TOKEN, env.GH_TOKEN, env.VERCEL_TOKEN, env.NEON_API_KEY, env.CAKE_QA_PRODUCTION_DATABASE_HOST].includes(value) ? value : null;
  const parentAvailable = Object.hasOwn(branch, "parent_id") && (branch.parent_id === null || branchId(branch.parent_id));
  const defaultAvailable = typeof branch.default === "boolean";
  return { projectId: QA_NEON_PROJECT_ID, branchId: branch.id as string, name, nameEvidence: name === null ? "unavailable" : "branch.name",
    parentId: parentAvailable ? branch.parent_id as string | null : null, parentIdEvidence: parentAvailable ? "branch.parent_id" : "unavailable",
    default: defaultAvailable ? branch.default as boolean : null, defaultEvidence: defaultAvailable ? "branch.default" : "unavailable" };
}

function neonMetadata(resources: NeonResources, env: Environment): NeonMetadata {
  const byId = (a: { branchId: string }, b: { branchId: string }) => a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
  const branches = resources.branches.map((branch) => neonBranchMetadata(branch, env)).sort(byId);
  return { projectId: QA_NEON_PROJECT_ID, branchCount: branches.length, endpointCount: resources.endpoints.length, branches,
    endpoints: resources.endpoints.map((endpoint): NeonMetadata["endpoints"][number] => ({ projectId: QA_NEON_PROJECT_ID,
      endpointId: endpoint.id as string, branchId: branchId(endpoint.branch_id) ? endpoint.branch_id : null,
      branchIdEvidence: branchId(endpoint.branch_id) ? "endpoint.branch_id" : "unavailable" }))
      .sort((a, b) => a.endpointId < b.endpointId ? -1 : a.endpointId > b.endpointId ? 1 : 0),
    defaultBranchIds: branches.filter((branch) => branch.default === true).map((branch) => branch.branchId),
    observedPreviewCodexBranchIds: branches.filter((branch) => branch.name?.startsWith("preview/codex/")).map((branch) => branch.branchId) };
}

// Provider bases and credentials cannot be supplied by workflow inputs or remote responses.
const BASES = { github: "https://api.github.com", vercel: "https://api.vercel.com", neon: "https://console.neon.tech/api/v2" } as const;
const CREDENTIALS = { github: "GITHUB_TOKEN", vercel: "VERCEL_TOKEN", neon: "NEON_API_KEY" } as const;
const fetchRead: QaBootstrapTransport = async (method, url, token) => {
  if (method !== "GET") fail("method-not-allowed");
  try {
    const response = await fetch(url, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  } catch { fail("transport-unconfirmed"); }
};

export function validateQaBootstrapOptions(options: QaBootstrapOptions): void {
  if (!["preflight", "plan-probe", "plan-release"].includes(options.action)
    || options.pr !== undefined && !positiveInteger(options.pr)
    || options.sha !== undefined && !fullSha(options.sha)
    || options.slot !== undefined && !SLOTS.includes(options.slot)
    || options.leaseId !== undefined && !leaseToken(options.leaseId)
    || options.action === "plan-probe" && (!options.pr || !options.sha || !options.slot)
    || options.action === "plan-release" && (!options.pr || !options.leaseId)) {
    throw new Error("QA bootstrapのaction・PR・完全SHA・slot・lease IDを確認してください。");
  }
}

/** This adapter has no write mode, writer imports, settings operations, or SQL connection. */
export class ReadOnlyQaBootstrap {
  private ledgerBranches = new Set<string>();
  constructor(private readonly env: Environment, private readonly request: QaBootstrapTransport = fetchRead) {}

  private async api(provider: Provider, path: string, method = "GET", notFound?: "alias" | "exact-resource"): Promise<unknown> {
    // Keep this guard before credential lookup and before any injectable transport.
    if (method !== "GET") fail("method-not-allowed");
    if (!Object.hasOwn(BASES, provider) || !path.startsWith("/") || path.startsWith("//")) fail("invalid-request");
    const token = provider === "github" ? this.env.GITHUB_TOKEN || this.env.GH_TOKEN : this.env[CREDENTIALS[provider]];
    if (!token) throw new ReadFailure({ code: "missing-credential", provider, credential: CREDENTIALS[provider] });
    const suffix = provider === "vercel" ? `${path.includes("?") ? "&" : "?"}slug=fumin1` : "";
    let response: { status: number; data: unknown };
    try { response = await this.request("GET", BASES[provider] + path + suffix, token); }
    catch { throw new ReadFailure({ code: "transport-unconfirmed", provider }); }
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new ReadFailure({ code: "invalid-response", provider });
    if (response.status === 404 && notFound) return null;
    if (response.status < 200 || response.status > 299) {
      throw new ReadFailure({ code: [401, 403].includes(response.status) ? "authorization-denied" : response.status === 404 ? "resource-unconfirmed" : "http-error", provider, status: response.status });
    }
    if (response.data === null || response.data === undefined) throw new ReadFailure({ code: "invalid-response", provider });
    return response.data;
  }

  private async pool(): Promise<Pool> {
    const records: GithubDeployment[] = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = array(await this.api("github", `/repos/${QA_REPOSITORY}/deployments?task=${QA_TASK}&per_page=100&page=${page}`));
      records.push(...batch.map((v) => object(v) as unknown as GithubDeployment));
      if (batch.length < 100) {
        try {
          const pool = replayDeployments(records);
          this.ledgerBranches = new Set(records.filter((r) => r.task === QA_TASK).map((r) => object(typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload).branch as string));
          return pool;
        } catch { fail("invalid-ledger"); }
      }
    }
    fail("pagination-unconfirmed");
  }

  private async variableNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (let page = 1; page <= 1000; page++) {
      const data = object(await this.api("github", `/repos/${QA_REPOSITORY}/actions/variables?per_page=30&page=${page}`));
      const batch = array(data.variables);
      for (const entry of batch) {
        const name = object(entry).name;
        if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(name)) fail("invalid-response");
        names.add(name);
      }
      if (batch.length < 30) return names;
    }
    fail("pagination-unconfirmed");
  }

  private async pullRequest(number: number): Promise<PullRequest> {
    const value = object(await this.api("github", `/repos/${QA_REPOSITORY}/pulls/${number}`));
    const head = object(value.head), base = object(value.base);
    if (value.number !== number || !["open", "closed"].includes(String(value.state)) || !fullSha(head.sha)
      || !featureBranch(head.ref) || object(head.repo).full_name !== QA_REPOSITORY
      || base.ref !== "main" || object(base.repo).full_name !== QA_REPOSITORY) fail("identity-mismatch", "same-repository feature PR targeting main with a full current SHA");
    return { number, state: value.state as PullRequest["state"], branch: head.ref as string, sha: head.sha as string };
  }

  private async aliases(slot: Slot): Promise<Alias | null> {
    const value = await this.api("vercel", `/v4/aliases/${qaAlias(slot)}`, "GET", "alias");
    if (value === null) return null;
    const alias = object(value), id = alias.deploymentId ?? object(alias.deployment).id;
    if (alias.projectId !== QA_PROJECT_ID || !deploymentId(id)) fail("identity-mismatch");
    return { projectId: QA_PROJECT_ID, deploymentId: id };
  }

  private async neonResources(): Promise<NeonResources> {
    const readList = async (kind: "branches" | "endpoints") => {
      const values: JsonObject[] = [], seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const query = kind === "branches" ? `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : "";
        const response = object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/${kind}${query}`));
        values.push(...array(response[kind]).map(object));
        const next = object(response.pagination ?? {}).next;
        if (next === null || next === undefined || next === "") {
          const ids = values.map((v) => v.id);
          if (new Set(ids).size !== ids.length || values.some((v) => v.project_id !== QA_NEON_PROJECT_ID
            || !(kind === "branches" ? branchId(v.id) : endpointId(v.id)))) fail("identity-mismatch");
          return values;
        }
        // Neon lists all project endpoints in this endpoint; an unknown continuation cannot prove completeness.
        if (kind === "endpoints" || typeof next !== "string" || !next || seen.has(next)) fail("pagination-unconfirmed");
        seen.add(next); cursor = next;
      }
      fail("pagination-unconfirmed");
    };
    return { branches: await readList("branches"), endpoints: await readList("endpoints") };
  }

  private remote(value: unknown): RemoteDeployment {
    const d = object(value), meta = object(d.meta), git = object(d.gitSource ?? {});
    const id = d.id ?? d.uid, branch = git.ref ?? meta.githubCommitRef, sha = git.sha ?? meta.githubCommitSha;
    if (!deploymentId(id) || typeof d.projectId !== "string" || !featureBranch(branch) || !fullSha(sha)
      || !leaseToken(meta.cakeQaLeaseId) || !leaseToken(meta.cakeQaAttemptId)
      || !["provisioning", "application"].includes(String(meta.cakeQaPhase))
      || !(typeof meta.cakeQaPr === "string" && /^[1-9][0-9]*$/.test(meta.cakeQaPr) && positiveInteger(Number(meta.cakeQaPr)))
      || git.ref !== undefined && meta.githubCommitRef !== undefined && git.ref !== meta.githubCommitRef
      || git.sha !== undefined && meta.githubCommitSha !== undefined && git.sha !== meta.githubCommitSha
      || d.target !== null && typeof d.target !== "string") fail("identity-mismatch");
    return { id, projectId: d.projectId, target: d.target as string | null,
      branch: branch as string, sha: sha as string, leaseId: meta.cakeQaLeaseId as string,
      pr: Number(meta.cakeQaPr), phase: meta.cakeQaPhase as RemoteDeployment["phase"] };
  }

  private async deployments(record: QaLeaseRecord): Promise<RemoteDeployment[]> {
    const result: RemoteDeployment[] = [], seen = new Set<number>();
    let until: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const list = object(await this.api("vercel", `/v7/deployments?projectId=${QA_PROJECT_ID}&branch=${encodeURIComponent(record.branch)}&limit=100${until ? `&until=${until}` : ""}`));
      for (const value of array(list.deployments)) result.push(this.remote(value));
      const next = object(list.pagination ?? {}).next;
      if (next === null || next === undefined) {
        if (new Set(result.map((d) => d.id)).size !== result.length) fail("pagination-unconfirmed");
        return result;
      }
      if (!positiveInteger(next) || seen.has(next)) fail("pagination-unconfirmed");
      seen.add(next); until = next;
    }
    fail("pagination-unconfirmed");
  }

  private matches(record: QaLeaseRecord, d: RemoteDeployment): boolean {
    const known = record.deployments.find((entry) => entry.id === d.id);
    return Boolean(known && d.projectId === QA_PROJECT_ID && (d.target === null || d.target === "preview")
      && d.branch === record.branch && d.sha === known.sha && d.phase === known.phase && d.leaseId === record.leaseId && d.pr === record.pr);
  }

  private async releaseResources(record: QaLeaseRecord, resources: NeonResources): Promise<ReleasePlan> {
    if (record.intent) fail("unresolved-intent");
    // A creation claim without a known Native identity never becomes an approval candidate.
    if (!record.database) fail("native-identity-unconfirmed");
    const identity = record.database;
    if (databaseHost(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST) && identity.host === normalizedHost(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST)
      || identity.branchId === this.env.CAKE_QA_PARENT_BRANCH_ID) fail("identity-mismatch");
    const remote = await this.deployments(record);
    if (remote.some((d) => !this.matches(record, d))) fail("identity-mismatch");
    for (const known of record.deployments) {
      const value = await this.api("vercel", `/v13/deployments/${known.id}?withGitRepoInfo=true`, "GET", "exact-resource");
      if (value === null) {
        if (remote.some((d) => d.id === known.id)) fail("identity-mismatch");
      } else {
        const actual = this.remote(value);
        if (actual.id !== known.id || !this.matches(record, actual)) fail("identity-mismatch");
      }
    }
    const branch = resources.branches.find((b) => b.id === identity.branchId);
    const endpoints = resources.endpoints.filter((e) => e.branch_id === identity.branchId);
    if (branch) {
      if (branch.name !== `preview/${record.branch}`
        || branch.default !== false || branch.protected !== false || !Number.isFinite(Date.parse(String(branch.created_at)))
        || Date.parse(String(branch.created_at)) < Date.parse(record.createdAt)) fail("identity-mismatch");
      const writable = endpoints.filter((e) => e.type === "read_write");
      if (writable.length !== 1) fail("native-identity-unconfirmed");
      const endpoint = writable[0];
      const actual = { projectId: QA_NEON_PROJECT_ID, branchId: branch.id, endpointId: endpoint.id, host: normalizedHost(endpoint.host) };
      if (!validDatabase(actual) || !sameDatabase(actual, identity)
        || record.retiredDatabases.some((old) => old.branchId === identity.branchId || old.endpointId === identity.endpointId || old.host === identity.host)) fail("identity-mismatch");
    } else {
      if (endpoints.length || resources.endpoints.some((e) => e.id === identity.endpointId || normalizedHost(e.host) === identity.host)) fail("identity-mismatch");
      // Only authenticated full lists plus both exact-ID 404s establish Native disappearance.
      const b = await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/branches/${identity.branchId}`, "GET", "exact-resource");
      const e = await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/endpoints/${identity.endpointId}`, "GET", "exact-resource");
      if (b !== null || e !== null) fail("native-identity-unconfirmed");
    }
    const alias = record.purpose === "probe" ? null : await this.aliases(record.slot);
    if (alias && !record.deployments.some((d) => d.id === alias.deploymentId)) fail("identity-mismatch");
    return { action: "plan-release", executionEnabled: false, projectId: QA_PROJECT_ID, neonProjectId: QA_NEON_PROJECT_ID,
      pr: record.pr, branch: record.branch, slot: record.slot, leaseId: record.leaseId, headSha: record.headSha,
      deploymentIds: record.deployments.map((d) => d.id).sort(), alias: record.purpose === "probe" ? null : qaAlias(record.slot), database: { ...identity } };
  }

  async inspect(options: QaBootstrapOptions): Promise<QaBootstrapReport> {
    validateQaBootstrapOptions(options);
    const checks: QaBootstrapCheck[] = [];
    const check = async <T>(name: string, read: () => Promise<T>, absent = false): Promise<T | undefined> => {
      try {
        const value = await read();
        checks.push({ name, ok: true, reason: absent && value === null ? { code: "resource-absent", provider: "vercel", status: 404 } : { code: "read-confirmed" } });
        return value;
      } catch (error) {
        const reason = error instanceof ReadFailure ? error.reason : { code: "invalid-response" };
        checks.push({ name, ok: false, reason: name === "GitHub repository Variables read" && reason.code === "authorization-denied"
          ? { ...reason, requirement: "repository Variables API read access; Actions read permission does not grant Variables permission" } : reason });
        return undefined;
      }
    };
    const project = await check("Vercel project", async () => {
      const value = object(await this.api("vercel", `/v9/projects/${QA_PROJECT_ID}`)), link = object(value.link);
      if (value.id !== QA_PROJECT_ID || value.name !== "cake" || value.accountId !== "team_D1Mcx2TdFWPKcypfu8KzNMub"
        || link.type !== "github" || link.org !== "tyask" || link.repo !== "Cake" || link.productionBranch !== "main" || !positiveInteger(link.repoId)) fail("identity-mismatch");
      return value;
    });
    const sourcePolicy: QaBootstrapReport["sourcePolicy"] = { requirement: "Preview-only REST API source policy", confirmed: false,
      previewDeploymentsDisabled: typeof project?.previewDeploymentsDisabled === "boolean" ? project.previewDeploymentsDisabled : null, previewRuleCount: null, sources: null };
    await check("Preview source policy", async () => {
      if (!project) fail("prerequisite-unconfirmed", "Vercel project read");
      if (!project.deploymentPolicy) fail("prerequisite-unconfirmed", sourcePolicy.requirement);
      const policy = object(project.deploymentPolicy);
      if (!Array.isArray(policy.deploymentSources)) fail("prerequisite-unconfirmed", sourcePolicy.requirement);
      if (Object.keys(policy).some((key) => !["deploymentSources", "gitSources"].includes(key))) fail("invalid-response");
      const rules = policy.deploymentSources.map(object);
      const allowedSources = ["cli", "deploy-hook", "git", "integration", "rest-api", "v0"];
      const environments = new Set<string>();
      for (const rule of rules) {
        if (typeof rule.enabled !== "boolean" || Object.keys(rule).some((key) => !["enabled", "environments", "sources"].includes(key))
          || !array(rule.environments).length || array(rule.sources).some((s) => typeof s !== "string" || !allowedSources.includes(s))) fail("invalid-response");
        for (const item of array(rule.environments)) {
          const env = object(item);
          if (!(env.type === "system" && ["preview", "production"].includes(String(env.target)) && Object.keys(env).every((key) => ["type", "target"].includes(key))
            || env.type === "custom" && typeof env.environmentId === "string" && env.environmentId.length > 0 && Object.keys(env).every((key) => ["type", "environmentId"].includes(key)))) fail("invalid-response");
          const key = env.type === "system" ? String(env.target) : `custom:${env.environmentId}`;
          if (environments.has(key)) fail("invalid-response");
          environments.add(key);
        }
      }
      const preview = rules.filter((r) => array(r.environments).some((e) => object(e).type === "system" && object(e).target === "preview"));
      sourcePolicy.previewRuleCount = preview.length;
      const observedSources = preview.flatMap((r) => array(r.sources));
      if (observedSources.some((s) => typeof s !== "string" || !allowedSources.includes(s))) fail("invalid-response");
      sourcePolicy.sources = [...new Set(observedSources as string[])].sort();
      sourcePolicy.confirmed = project.previewDeploymentsDisabled === false && preview.length === 1 && preview[0].enabled === true
        && array(preview[0].sources).length === 1 && array(preview[0].sources)[0] === "rest-api"
        && array(preview[0].environments).every((e) => object(e).type === "system" && object(e).target === "preview");
      if (!sourcePolicy.confirmed) fail("policy-requirement-unmet", sourcePolicy.requirement);
      return true;
    });
    const pool = await check("GitHub lease ledger", () => this.pool());
    const variables = await check("GitHub repository Variables read", () => this.variableNames());
    const resources = await check("Neon metadata read", async () => {
      const p = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}`)).project);
      if (p.id !== QA_NEON_PROJECT_ID) fail("identity-mismatch");
      return this.neonResources();
    });
    const native = resources ? neonMetadata(resources, this.env) : null;
    const parent = await check("Native parent configuration", async () => {
      const id = this.env.CAKE_QA_PARENT_BRANCH_ID;
      if (!branchId(id)) fail("missing-configuration", "CAKE_QA_PARENT_BRANCH_ID");
      const b = object(object(await this.api("neon", `/projects/${QA_NEON_PROJECT_ID}/branches/${id}`)).branch);
      if (b.id !== id || b.project_id !== QA_NEON_PROJECT_ID) fail("identity-mismatch");
      const branch = neonBranchMetadata(b, this.env), listed = native?.branches.find((candidate) => candidate.branchId === id);
      if (listed && (listed.name !== null && branch.name !== null && listed.name !== branch.name
        || listed.parentIdEvidence === "branch.parent_id" && branch.parentIdEvidence === "branch.parent_id" && listed.parentId !== branch.parentId
        || listed.default !== null && branch.default !== null && listed.default !== branch.default)) fail("identity-mismatch");
      const children = native?.branches.filter((candidate) => candidate.parentIdEvidence === "branch.parent_id" && candidate.parentId === id);
      return { projectId: QA_NEON_PROJECT_ID as typeof QA_NEON_PROJECT_ID, branchId: id, emptyStateProven: false as const,
        candidateSummary: { branch, observedChildBranchIds: children ? children.map((child) => child.branchId) : null,
          observedPreviewCodexChildBranchIds: children ? children.filter((child) => child.name?.startsWith("preview/codex/")).map((child) => child.branchId) : null,
          childEvidence: native ? "listed branch.parent_id" as const : "unavailable" as const } };
    });
    await check("Production comparison host configured", async () => {
      if (!databaseHost(this.env.CAKE_QA_PRODUCTION_DATABASE_HOST)) fail("missing-configuration", "CAKE_QA_PRODUCTION_DATABASE_HOST");
      return true;
    });
    const aliases = {} as QaBootstrapReport["aliases"];
    for (const slot of SLOTS) {
      const value = await check(`Alias ${slot}`, () => this.aliases(slot), true);
      aliases[slot] = value === undefined ? "unconfirmed" : value;
    }
    const requiredVariables = ["CAKE_QA_POOL_ENABLED", "CAKE_QA_GIT_GATE_CONFIRMED", "CAKE_QA_NATIVE_CONFIRMED", "CAKE_QA_PRODUCTION_DATABASE_HOST",
      "CAKE_QA_PARENT_BRANCH_ID", "CAKE_QA_APPROVED_HEADS", "CAKE_QA_PROBE_APPROVALS", "CAKE_QA_DELETE_APPROVALS"];
    const report: QaBootstrapReport = {
      action: options.action, readOnly: true, executionEnabled: false, executionReason: "bootstrap-has-no-mutating-operation",
      projectId: QA_PROJECT_ID, neonProjectId: QA_NEON_PROJECT_ID, checks, prerequisites: [], sourcePolicy,
      missingRepositoryVariables: variables ? requiredVariables.filter((name) => !variables.has(name)) : null,
      native, productionHostComparison: productionHostComparison(resources, this.env.CAKE_QA_PRODUCTION_DATABASE_HOST),
      parent: parent ?? null, aliases,
      slots: pool ? Object.fromEntries(SLOTS.map((slot) => {
        const saved = pool[slot];
        return [slot, saved ? { state: saved.payload.state, purpose: saved.payload.purpose ?? "normal", pr: saved.payload.pr,
          leaseId: saved.payload.leaseId, headSha: saved.payload.headSha, deploymentIds: saved.payload.deployments.map((d) => d.id).sort(), database: saved.payload.database ?? null } : null];
      })) as QaBootstrapReport["slots"] : null, plan: null,
    };
    const prerequisite = (name: string, confirmed: boolean, requirement: string) => report.prerequisites.push({ name, confirmed, requirement });
    for (const name of ["Vercel project", "Preview source policy", "GitHub lease ledger", "Neon metadata read", "Native parent configuration", "Production comparison host configured"]) {
      prerequisite(name, checks.some((c) => c.name === name && c.ok), name);
    }
    prerequisite("Native parent empty state", false, "separate database verification; metadata does not prove an empty database");
    prerequisite("Native build and runtime identity", false, "separate live verification of Native isolation and guard injection");
    prerequisite("Native cleanup behavior", false, "separate live verification of branch and endpoint cleanup");
    prerequisite("Reviewed authorization", false, "separate reviewed authorization before any future mutation");
    prerequisite("Mutating implementation", false, "this bootstrap has no mutating operation");
    if (options.action === "preflight") return report;
    const pr = await check("Target PR", () => this.pullRequest(options.pr!));
    prerequisite("Target PR", Boolean(pr), "same-repository feature PR targeting main with an exact full current SHA");
    if (options.action === "plan-probe") {
      report.plan = await check("Probe prerequisites", async () => {
        if (!pr || !pool) fail("prerequisite-unconfirmed");
        if (pr.state !== "open" || pr.sha !== options.sha) fail("stale-sha", "OPEN PR current head must equal the requested full SHA");
        const current = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === pr.number);
        const occupied = pool[options.slot!];
        if (current && (current.payload.purpose !== "probe" || current.payload.slot !== options.slot || current.payload.state !== "held" || current.payload.branch !== pr.branch)
          || occupied && occupied.payload.state !== "free" && (!current || occupied.payload.leaseId !== current.payload.leaseId)) fail("slot-occupied");
        // Replayed history also prevents reuse of a retired feature branch in a new claim.
        if (!current && this.ledgerBranches.has(pr.branch)) fail("identity-mismatch", "new feature branch for a new lease");
        return { action: "plan-probe" as const, executionEnabled: false as const, projectId: QA_PROJECT_ID, neonProjectId: QA_NEON_PROJECT_ID,
          pr: pr.number, branch: pr.branch, sha: pr.sha, headSha: pr.sha, slot: options.slot!, maximumNewDeployments: current?.payload.database ? 1 : 2,
          fixedAliasChanges: false as const, deletionRequiresSeparateExactResourceApproval: true as const };
      }) ?? null;
      return report;
    }
    report.plan = await check("Exact release resources", async () => {
      if (!project || !pool || !resources || !pr) fail("prerequisite-unconfirmed");
      const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === options.pr);
      if (!saved || saved.payload.leaseId !== options.leaseId || options.slot && options.slot !== saved.payload.slot) fail("lease-mismatch");
      // Cleanup describes the recorded lease even after a later, unapproved PR push.
      if (pr.branch !== saved.payload.branch) fail("identity-mismatch");
      if (options.sha && options.sha !== saved.payload.headSha) fail("stale-sha");
      return this.releaseResources(saved.payload, resources);
    }) ?? null;
    return report;
  }
}
