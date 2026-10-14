import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { fullSha, featureBranch, qaAlias, QA_ENVIRONMENT, QA_PROJECT_ID, QA_REPOSITORY, replayDeployments, sameDatabase, SLOTS,
  type GithubDeployment, type SavedLease, type Pool } from "../lib/qa-pool";
import { deletePlan, type DeletePlan } from "../lib/qa-pool-authorization";
import { makeOwnerDecision, makeOwnerPlan, parseDecision, parsePlan, planMatches, replayApprovalEvents, safePlanSummary,
  QA_APPROVAL_TASK, QA_APPROVAL_WORKFLOW, type OwnerApprovalEvent, type OwnerApprovalState, type OwnerIdentity,
  type OwnerPlan, type OwnerPlanPrivateTarget, type OwnerRunEvidence } from "../lib/qa-owner-approval";
import type { QaPullRequest } from "../lib/qa-pool-service";

type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>;
type Env = Readonly<Record<string, string | undefined>>;
const invalid = (): never => { throw new Error("QA承認の実行元・現在計画を確認できません。処理を保留します。"); };
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const positive = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : invalid();
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();

/** Only trusted main instantiates this adapter. Public records contain a hostless projection and digest. */
export class HttpOwnerApprovalStore {
  private readonly completedEvidence = new Map<string, OwnerRunEvidence>();
  constructor(private readonly env: Env, private readonly api: Api, private readonly ledger: () => Promise<GithubDeployment[]>,
    private readonly now: () => number = Date.now, private readonly token: () => string = randomUUID) {}

  private async owner(): Promise<OwnerIdentity> {
    const repository = obj(await this.api(`/repos/${QA_REPOSITORY}`)), owner = obj(repository.owner);
    if (repository.full_name !== QA_REPOSITORY || owner.login !== "tyask" || owner.type !== "User") return invalid();
    return { id: positive(owner.id), login: "tyask", type: "User" };
  }
  private async main(): Promise<string> {
    const value = obj(await this.api(`/repos/${QA_REPOSITORY}/branches/main`));
    const sha = obj(value.commit).sha;
    if (value.name !== "main" || !fullSha(sha) || sha !== this.env.QA_TRUSTED_MAIN_SHA) return invalid();
    return sha;
  }
  private async events(): Promise<OwnerApprovalEvent[]> {
    const result: OwnerApprovalEvent[] = [];
    for (let page = 1; ; page++) {
      if (page > 1000) return invalid();
      const batch = list(await this.api(`/repos/${QA_REPOSITORY}/deployments?task=${QA_APPROVAL_TASK}&per_page=100&page=${page}`));
      for (const raw of batch) {
        const value = obj(raw), creator = obj(value.creator);
        // Never turn arbitrary deployment provenance into trusted Actions evidence.
        if (creator.login !== "github-actions[bot]" || creator.type !== "Bot") return invalid();
        result.push({ id: positive(value.id), task: String(value.task), environment: String(value.environment), sha: String(value.sha),
          payload: value.payload, creator: { login: "github-actions[bot]", type: "Bot" } });
      }
      if (batch.length < 100) return result;
    }
  }
  private async evidence(runId: number, attempt: number, plans: ReadonlyMap<number, OwnerPlan>): Promise<OwnerRunEvidence> {
    const cacheKey = `${runId}:${attempt}`, cached = this.completedEvidence.get(cacheKey);
    if (cached) return cached;
    const run = obj(await this.api(`/repos/${QA_REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`));
    const actor = obj(run.actor), trigger = obj(run.triggering_actor), repository = obj(run.repository), head = obj(run.head_repository);
    if (positive(run.id) !== runId || positive(run.run_attempt) !== attempt || repository.full_name !== QA_REPOSITORY
      || head.full_name !== QA_REPOSITORY) return invalid();
    const workflows = list(run.referenced_workflows);
    const trusted = workflows.map(obj).filter((workflow) => fullSha(workflow.sha) && workflow.ref === "refs/heads/main"
      && [String(workflow.sha), "main", "refs/heads/main"].some((ref) => workflow.path === `${QA_REPOSITORY}/.github/workflows/qa-private-run.yml@${ref}`));
    if (trusted.length !== 1) return invalid();
    const mainSha = String(trusted[0].sha);
    if (![QA_APPROVAL_WORKFLOW, ...[mainSha, "main", "refs/heads/main"].map((ref) => `${QA_APPROVAL_WORKFLOW}@${ref}`)].includes(String(run.path))) return invalid();
    if (run.event !== "workflow_dispatch" && run.event !== "schedule" && run.event !== "pull_request_target") return invalid();
    if (run.event !== "pull_request_target" && (run.head_branch !== "main" || run.head_sha !== mainSha)) return invalid();
    const title = String(run.display_title), decision = /^Cake QA (approve|revoke) ([1-9][0-9]*)$/.exec(title);
    let binding: OwnerRunEvidence["binding"] = null;
    if (decision) {
      const planId = positive(Number(decision[2])), plan = plans.get(planId);
      if (!plan) return invalid();
      binding = { planId, digest: plan.digest, state: decision[1] === "approve" ? "approved" : "revoked" };
    }
    if (!decision && !/^Cake QA (request-preview|request-release|refresh|claim|release|opened|synchronize|reopened|closed|schedule|pull_request_target) -$/.test(title)) return invalid();
    if ((actor.type !== "User" && actor.type !== "Bot") || (trigger.type !== "User" && trigger.type !== "Bot")) return invalid();
    if (!["queued", "in_progress", "completed"].includes(String(run.status))
      || ![null, "success", "failure", "cancelled", "skipped", "timed_out", "action_required", "neutral"].includes(run.conclusion as string | null)) return invalid();
    const result: OwnerRunEvidence = { mainSha, event: run.event, branch: String(run.head_branch), path: QA_APPROVAL_WORKFLOW, repository: QA_REPOSITORY,
      headRepository: QA_REPOSITORY, actorId: positive(actor.id), triggeringActorId: positive(trigger.id),
      actorType: actor.type, triggeringActorType: trigger.type, attempt, trustedMain: true, binding,
      status: run.status as OwnerRunEvidence["status"], conclusion: run.conclusion as OwnerRunEvidence["conclusion"] };
    if (result.status === "completed") this.completedEvidence.set(cacheKey, result);
    return result;
  }
  async states(): Promise<Map<number, OwnerApprovalState>> {
    const events = await this.events();
    if (!events.length) return new Map();
    const plans = new Map<number, OwnerPlan>();
    for (const event of events) if (obj(event.payload).kind === "plan") plans.set(event.id, parsePlan(event.payload));
    const runs = new Map<string, OwnerRunEvidence>();
    for (const event of events) {
      const payload = obj(event.payload).kind === "plan" ? parsePlan(event.payload) : parseDecision(event.payload);
      const key = `${payload.runId}:${payload.runAttempt}`;
      if (!runs.has(key)) runs.set(key, await this.evidence(payload.runId, payload.runAttempt, plans));
    }
    return replayApprovalEvents(events, runs, await this.owner(), this.now());
  }
  private target(plan: OwnerPlan, records: GithubDeployment[]): OwnerPlanPrivateTarget {
    const baseline = plan.previousLeaseRecordId === null ? undefined : records.find((r) => r.id === plan.previousLeaseRecordId);
    if (plan.previousLeaseRecordId !== null && !baseline) return invalid();
    const prior = baseline ? replayDeployments(records.filter((r) => r.id <= baseline.id))[plan.slot] : null;
    if (baseline && prior?.id !== baseline.id) return invalid();
    const sameLease = prior?.payload.state !== "free" && prior?.payload.leaseId === plan.leaseId;
    if (prior?.payload.state !== "free" && prior && !sameLease) return invalid();
    return { action: plan.action, projectId: QA_PROJECT_ID, pr: plan.pr, branch: plan.branch, sha: plan.sha, slot: plan.slot,
      leaseId: plan.leaseId, previousLeaseRecordId: plan.previousLeaseRecordId,
      deploymentIds: sameLease ? prior!.payload.deployments.map((d) => d.id).sort() : [],
      alias: plan.action === "preview" ? qaAlias(plan.slot) : sameLease ? deletePlan(prior!.payload).alias : null,
      database: sameLease ? prior!.payload.database ?? null : null,
      parentBranchId: this.env.CAKE_QA_PARENT_BRANCH_ID ?? "", runId: plan.runId, runAttempt: plan.runAttempt };
  }
  private currentMatches(plan: OwnerPlan, target: OwnerPlanPrivateTarget, pool: Pool): boolean {
    const active = Object.values(pool).find((saved) => saved && saved.payload.state !== "free" && saved.payload.pr === plan.pr);
    if (active && (active.payload.slot !== plan.slot || active.payload.leaseId !== plan.leaseId)) return false;
    const saved = pool[plan.slot];
    if (plan.action === "cleanup") {
      if (!saved || saved.payload.state !== "deleting" || saved.payload.leaseId !== plan.leaseId || saved.payload.pr !== plan.pr
        || saved.payload.branch !== plan.branch || saved.payload.headSha !== plan.sha || saved.payload.intent) return false;
      return isDeepStrictEqual(deletePlan(saved.payload), { projectId: QA_PROJECT_ID, pr: plan.pr,
        headSha: plan.sha, slot: plan.slot, leaseId: plan.leaseId, deploymentIds: target.deploymentIds,
        alias: target.alias, database: target.database });
    }
    if (!saved || saved.payload.state === "free") return (saved?.id ?? null) === plan.previousLeaseRecordId;
    const record = saved.payload;
    if (record.state !== "held" || record.purpose || record.leaseId !== plan.leaseId || record.pr !== plan.pr || record.branch !== plan.branch
      || !record.deployments.every((d) => target.deploymentIds.includes(d.id) || d.sha === plan.sha)
      || !target.deploymentIds.every((id) => record.deployments.some((d) => d.id === id))
      || record.deployments.filter((d) => !target.deploymentIds.includes(d.id)).length > plan.maximumNewDeployments
      || record.intent && (record.intent.sha !== plan.sha || record.deployments.filter((d) => !target.deploymentIds.includes(d.id)).length >= plan.maximumNewDeployments)) return false;
    if (target.database && !sameDatabase(target.database, record.database)) return false;
    // Only the reviewed state's descendants, or that state itself, may consume the plan.
    return saved.id >= (plan.previousLeaseRecordId ?? 0);
  }
  private latest(states: Map<number, OwnerApprovalState>, action: "preview" | "cleanup", pr: number, sha: string, leaseId?: string) {
    return [...states.values()].filter((s) => s.plan.action === action && s.plan.pr === pr && s.plan.sha === sha
      && (!leaseId || s.plan.leaseId === leaseId)).sort((a, b) => b.planId - a.planId)[0];
  }
  async preview(pr: QaPullRequest, requireCi = true): Promise<{ known: boolean; authorization: { slot: OwnerPlan["slot"]; leaseId: string } | null }> {
    const states = await this.states(), state = this.latest(states, "preview", pr.number, pr.sha);
    if (!state) return { known: [...states.values()].some((s) => s.plan.action === "preview" && s.plan.pr === pr.number), authorization: null };
    const records = await this.ledger(), target = this.target(state.plan, records);
    const valid = state.status === "APPROVED" && pr.state === "open" && pr.repository === QA_REPOSITORY && pr.base === "main"
      && pr.branch === state.plan.branch && planMatches(state.plan, target, await this.main(), this.now())
      && this.currentMatches(state.plan, target, replayDeployments(records));
    if (valid && requireCi) await this.assertCi(pr.number, pr.branch, pr.sha);
    return { known: true, authorization: valid ? { slot: state.plan.slot, leaseId: state.plan.leaseId } : null };
  }
  /** Both configured CI events must have successful latest runs for this exact feature head. */
  async assertCi(pr: number, branch: string, sha: string): Promise<void> {
    if (!featureBranch(branch) || !fullSha(sha)) return invalid();
    const latest = new Map<string, Record<string, unknown>>();
    for (let page = 1; ; page++) {
      if (page > 1000) return invalid();
      const response = obj(await this.api(`/repos/${QA_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100&page=${page}`));
      const batch = list(response.workflow_runs);
      for (const raw of batch) {
        const run = obj(raw), event = String(run.event);
        if (run.head_sha !== sha || run.head_branch !== branch || obj(run.head_repository).full_name !== QA_REPOSITORY
          || obj(run.repository).full_name !== QA_REPOSITORY
          || !["push", "pull_request"].includes(event)
          || ![".github/workflows/ci.yml", `.github/workflows/ci.yml@${sha}`, `.github/workflows/ci.yml@${branch}`].includes(String(run.path))) return invalid();
        if (event === "pull_request" && !list(run.pull_requests).some((value) => obj(value).number === pr)) return invalid();
        const id = positive(run.id), prior = latest.get(event);
        if (!prior || id > Number(prior.id)) latest.set(event, run);
      }
      if (batch.length < 100) break;
    }
    for (const event of ["push", "pull_request"]) {
      const run = latest.get(event);
      if (!run || run.status !== "completed" || run.conclusion !== "success") return invalid();
    }
  }
  async cleanup(plan: DeletePlan): Promise<{ known: boolean; approved: boolean }> {
    const state = this.latest(await this.states(), "cleanup", plan.pr, plan.headSha, plan.leaseId);
    if (!state) return { known: false, approved: false };
    const records = await this.ledger(), target = this.target(state.plan, records);
    const current = replayDeployments(records)[state.plan.slot];
    return { known: true, approved: state.status === "APPROVED" && planMatches(state.plan, target, await this.main(), this.now())
      && Boolean(current && isDeepStrictEqual(plan, deletePlan(current.payload)))
      && this.currentMatches(state.plan, target, replayDeployments(records)) };
  }
  private async append(payload: OwnerPlan | ReturnType<typeof makeOwnerDecision>): Promise<number> {
    const value = obj(await this.api(`/repos/${QA_REPOSITORY}/deployments`, "POST", { ref: payload.sha, task: QA_APPROVAL_TASK,
      environment: QA_ENVIRONMENT, auto_merge: false, required_contexts: [], transient_environment: true, production_environment: false,
      description: `QA ${payload.kind} PR #${payload.pr}`, payload }));
    const creator = obj(value.creator);
    if (value.task !== QA_APPROVAL_TASK || value.environment !== QA_ENVIRONMENT || value.sha !== payload.sha
      || creator.login !== "github-actions[bot]" || creator.type !== "Bot" || !isDeepStrictEqual(value.payload, payload)) return invalid();
    return positive(value.id);
  }
  private async showPlan(plan: OwnerPlan, planId: number): Promise<void> {
    console.log(JSON.stringify(safePlanSummary(plan, planId)));
    if (this.env.GITHUB_STEP_SUMMARY) {
      const summary = safePlanSummary(plan, planId);
      await appendFile(this.env.GITHUB_STEP_SUMMARY, [
        `## QA plan ${planId}: ${plan.action}`, "", `PR #${plan.pr} / ${plan.branch}`, "",
        `SHA: \`${plan.sha}\``, `Trusted main: \`${plan.generatedMainSha}\``, `Slot: ${plan.slot} / lease: \`${plan.leaseId}\``,
        `Parent: \`${plan.parentBranchId}\``, `Expires: ${plan.expiresAt}`, `Digest: \`${plan.digest}\``, "",
        `Maximum new deployments: ${plan.maximumNewDeployments}; maximum new DBs: ${plan.maximumNewDatabases}`,
        `Deployment IDs: ${plan.resources.deploymentIds.join(", ") || "none"}`,
        `DB IDs: ${plan.resources.database ? `${plan.resources.database.branchId} / ${plan.resources.database.endpointId}` : "new child of reviewed parent"}`,
        `Alias target: ${plan.resources.alias ?? "none"} (availability is checked before assignment)`, "",
        summary.dataLossNotice ?? "Creation initializes only the approved empty QA database and fixed samples.", "",
        `Owner approval: \`npm run qa:approve -- --plan-id ${planId}\``,
        "Preview approval and resource mutation also require successful latest push and pull_request CI for this exact SHA. Plan issuance alone does not prove CI success.",
        `Revoke: \`npm run qa:approve -- --plan-id ${planId} --revoke\``, "",
      ].join("\n"));
    }
  }
  async requestPlan(action: "preview" | "cleanup", pr: QaPullRequest, supplied?: SavedLease): Promise<void> {
    if (pr.repository !== QA_REPOSITORY || pr.base !== "main" || !featureBranch(pr.branch) || !fullSha(pr.sha)) return invalid();
    const records = await this.ledger(), pool = replayDeployments(records);
    const saved = Object.values(pool).find((s) => s && s.payload.state !== "free" && s.payload.pr === pr.number);
    if (supplied && !isDeepStrictEqual(saved, supplied)) return invalid();
    if (action === "preview" && (pr.state !== "open" || saved?.payload.state === "deleting" || saved?.payload.purpose || saved?.payload.intent)) return invalid();
    if (action === "cleanup" && (!saved || saved.payload.state !== "deleting" || saved.payload.intent
      || saved.payload.deployments.length && !saved.payload.database)) return invalid();
    const slot = saved?.payload.slot ?? SLOTS.find((s) => !pool[s] || pool[s]!.payload.state === "free");
    if (!slot) { console.log("Cake: 空きQA枠を待っています。資源は作成しません。"); return; }
    const sha = action === "cleanup" ? saved!.payload.headSha : pr.sha;
    const states = await this.states(), existing = this.latest(states, action, pr.number, sha, saved?.payload.leaseId);
    if (existing && existing.status !== "EXPIRED" && existing.status !== "REVOKED") {
      const original = this.target(existing.plan, records);
      if (planMatches(existing.plan, original, await this.main(), this.now()) && this.currentMatches(existing.plan, original, pool)) {
        await this.showPlan(existing.plan, existing.planId); return;
      }
    }
    const runId = positive(Number(this.env.GITHUB_RUN_ID)), runAttempt = positive(Number(this.env.GITHUB_RUN_ATTEMPT));
    const target: OwnerPlanPrivateTarget = { action, projectId: QA_PROJECT_ID, pr: pr.number, branch: pr.branch, sha, slot,
      leaseId: saved?.payload.leaseId ?? this.token(), previousLeaseRecordId: pool[slot]?.id ?? null,
      deploymentIds: saved?.payload.deployments.map((d) => d.id).sort() ?? [],
      alias: action === "preview" ? qaAlias(slot) : deletePlan(saved!.payload).alias,
      database: saved?.payload.database ?? null, parentBranchId: this.env.CAKE_QA_PARENT_BRANCH_ID ?? "", runId, runAttempt };
    const plan = makeOwnerPlan(target, await this.main(), this.now());
    // Validate the actual run before persisting its source claim. Never trust actor/name inputs.
    const evidence = await this.evidence(runId, runAttempt, new Map());
    if (evidence.mainSha !== plan.generatedMainSha || evidence.binding !== null) return invalid();
    const id = await this.append(plan);
    await this.showPlan(plan, id);
  }
  async decide(planId: number, state: "approved" | "revoked"): Promise<void> {
    const states = await this.states(), selected = states.get(planId);
    if (!selected || await this.main() !== selected.plan.generatedMainSha) return invalid();
    const records = await this.ledger(), target = this.target(selected.plan, records);
    if (state === "approved" && selected.plan.action === "preview") {
      const pr = obj(await this.api(`/repos/${QA_REPOSITORY}/pulls/${selected.plan.pr}`)), head = obj(pr.head), base = obj(pr.base);
      if (pr.state !== "open" || pr.number !== selected.plan.pr || obj(head.repo).full_name !== QA_REPOSITORY
        || base.ref !== "main" || head.ref !== selected.plan.branch || head.sha !== selected.plan.sha) return invalid();
      await this.assertCi(selected.plan.pr, selected.plan.branch, selected.plan.sha);
    }
    if (state === "approved" && (!planMatches(selected.plan, target, await this.main(), this.now())
      || !this.currentMatches(selected.plan, target, replayDeployments(records)))) return invalid();
    const runId = positive(Number(this.env.GITHUB_RUN_ID)), attempt = positive(Number(this.env.GITHUB_RUN_ATTEMPT));
    const plans = new Map([...states.values()].map((s) => [s.planId, s.plan]));
    const evidence = await this.evidence(runId, attempt, plans);
    const decision = makeOwnerDecision(planId, selected.plan, state, { runId, ...evidence }, await this.owner(), selected.decision ?? undefined, this.now());
    await this.append(decision);
    console.log(`Cake: 計画 ${planId} を${state === "approved" ? "承認" : "取消"}しました。この実行の成功確認後に反映します。`);
  }
}
