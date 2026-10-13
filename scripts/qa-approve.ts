import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fullSha, QA_REPOSITORY } from "../lib/qa-pool";
import { safePlanSummary, type OwnerPlanSummary } from "../lib/qa-owner-approval";
import { HttpOwnerApprovalStore } from "./qa-owner-store";
import { commandOutput, executeWorkflowCommand, type WorkflowExecutor } from "./task-workflow";

const FAILURE = "QA本人承認を確認できませんでした。GitHubの接続・本人・計画ID・期限を確認してください。";
export type QaApprovalArguments = { planId: number; action: "approve" | "revoke" };
export type QaApprovalRequested = QaApprovalArguments & { status: "REQUESTED"; plan: OwnerPlanSummary; workflowUrl: string };
function invalid(): never { throw new Error(FAILURE); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

export function parseQaApprovalArgs(args: readonly string[]): QaApprovalArguments {
  try {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) invalid();
    let planId: number | undefined, revoke = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--plan-id") {
        const value = args[++index];
        if (planId !== undefined || typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !positive(Number(value))) invalid();
        planId = Number(value);
      } else if (args[index] === "--revoke") {
        if (revoke) invalid();
        revoke = true;
      } else invalid();
    }
    if (planId === undefined) invalid();
    return { planId, action: revoke ? "revoke" : "approve" };
  } catch { return invalid(); }
}

/** Explicit invocation for one reviewed plan is the owner's consent. No provider or variable API is used.
 * The only mutation requests the trusted main approval workflow; that job records the decision only.
 */
export async function runQaApproval(args: readonly string[] = [], cwd = process.cwd(), execute: WorkflowExecutor = executeWorkflowCommand): Promise<QaApprovalRequested> {
  try {
    const options = parseQaApprovalArgs(args);
    if (typeof cwd !== "string" || !cwd) invalid();
    const githubGet = async (path: string): Promise<unknown> => JSON.parse(await commandOutput(execute, "gh",
      ["api", "--hostname", "github.com", "--method", "GET", path], cwd, FAILURE));
    const user = object(await githubGet("user")), repository = object(await githubGet(`repos/${QA_REPOSITORY}`)), owner = object(repository.owner);
    if (repository.full_name !== QA_REPOSITORY || owner.login !== "tyask" || owner.type !== "User" || !positive(owner.id)
      || user.type !== "User" || user.login !== owner.login || !positive(user.id) || user.id !== owner.id) invalid();
    const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
      if (method !== "GET" || body !== undefined || !(path === `/repos/${QA_REPOSITORY}` || path.startsWith(`/repos/${QA_REPOSITORY}/`))) invalid();
      return githubGet(path.slice(1));
    };
    const store = new HttpOwnerApprovalStore({}, api, async () => invalid()), selected = (await store.states()).get(options.planId);
    if (!selected) invalid();
    const plan = safePlanSummary(selected.plan, selected.planId), main = object(await api(`/repos/${QA_REPOSITORY}/branches/main`)), now = Date.now();
    if (main.name !== "main" || !fullSha(object(main.commit).sha) || object(main.commit).sha !== plan.generatedMainSha
      || now < Date.parse(plan.createdAt) || options.action === "approve" && (selected.status === "EXPIRED" || now >= Date.parse(plan.expiresAt))) invalid();
    await commandOutput(execute, "gh", ["workflow", "run", "qa-pool.yml", "--repo", `github.com/${QA_REPOSITORY}`, "--ref", "main",
      "-f", `action=${options.action}`, "-f", `plan_id=${options.planId}`], cwd, FAILURE);
    return { ...options, status: "REQUESTED", plan, workflowUrl: `https://github.com/${QA_REPOSITORY}/actions/workflows/qa-pool.yml` };
  } catch { return invalid(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runQaApproval(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result.plan, null, 2));
    console.log(`Cake: 計画 ${result.planId} の${result.action === "approve" ? "承認" : "取消"}を要求しました。Actionsの成功確認後に反映します。`);
    console.log("Cake: この承認実行は判断の記録だけを行います。QA資源の操作は承認確認後の単一writerが別途行います。");
    console.log(`Cake: ${result.workflowUrl}`);
  }).catch(() => {
    console.error(FAILURE);
    process.exitCode = 1;
  });
}
