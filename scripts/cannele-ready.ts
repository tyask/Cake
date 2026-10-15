import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanTaskHead, assertTaskGitGate, commandOutput, taskPullRequests, executeWorkflowCommand, CAKE_REPOSITORY, type WorkflowExecutor } from "./task-workflow";
import { updateTaskPullRequest } from "./task-pr-update";

type Source = { cwd: string; branch: string; sourceSha: string; prNumber: number; draft: boolean };
type Proof = { leaseId: string; sourceSha: string; deploymentId: string; leaseVersion: number; urlKind: "unique" | "fixed"; url: string };
type Evidence = { before: Proof; after: Proof; cases: readonly string[]; verifiedAt: string };
type Lease = { leaseId: string; slot: string; state: string; sourceSha: string; version: number; prNumber: number; readyDeploymentId?: string;
  currentPublication?: { deploymentId: string; sourceSha: string; url: string; aliasId: string } };
export type CanneleReadyOptions = { cwd: string; title: string; verificationFile: string; source: Source; lease: Lease; unique: Evidence; fixed: Evidence;
  execute?: WorkflowExecutor; log?: (message: string) => void };

const failure = (message: string) => new Error(message);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function canonicalPreview(value: string): boolean {
  try { const url = new URL(value); return url.origin === value && url.protocol === "https:" && /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
function assertEvidence(options: CanneleReadyOptions): void {
  const { source, lease, unique, fixed } = options;
  if (lease.state !== "published" || lease.prNumber !== source.prNumber || lease.sourceSha !== source.sourceSha || !lease.readyDeploymentId
    || lease.currentPublication?.deploymentId !== lease.readyDeploymentId || lease.currentPublication.sourceSha !== source.sourceSha
    || lease.currentPublication.url !== fixed.after.url || !canonicalPreview(unique.after.url) || !canonicalPreview(fixed.after.url)) throw failure("Current QA publication is required before Ready.");
  for (const [kind, evidence] of [["unique", unique], ["fixed", fixed]] as const) {
    if (!evidence.cases.length || evidence.cases.some(value => typeof value !== "string" || !value.trim())
      || !Number.isFinite(Date.parse(evidence.verifiedAt)) || !Number.isSafeInteger(evidence.before.leaseVersion)
      || evidence.before.leaseVersion !== evidence.after.leaseVersion || evidence.after.leaseVersion > lease.version
      || kind === "fixed" && evidence.after.leaseVersion !== lease.version) throw failure("Both browser verification results are required before Ready.");
    for (const proof of [evidence.before, evidence.after]) {
      if (proof.urlKind !== kind || proof.url !== evidence.after.url || proof.leaseId !== lease.leaseId || proof.sourceSha !== source.sourceSha
        || proof.deploymentId !== lease.readyDeploymentId) throw failure("Browser verification belongs to another lease or commit.");
    }
  }
}

/** Workflow-scoped CI inventory: the newest run/attempt for each event must
 * validate this exact source commit. Older successful runs cannot mask a new
 * queued, failed or cancelled run.
 */
export async function assertCanneleCi(source: Source, execute: WorkflowExecutor): Promise<void> {
  const raw = await commandOutput(execute, "gh", ["api", "--paginate", "--slurp", "--method", "GET",
    `repos/${CAKE_REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${source.sourceSha}&per_page=100`], source.cwd, "Cannot verify CI for the current PR commit.");
  let pages: unknown; try { pages = JSON.parse(raw); } catch { throw failure("CI response is invalid."); }
  if (!Array.isArray(pages) || !pages.length || pages.some(page => !record(page) || !Array.isArray(page.workflow_runs))) throw failure("CI inventory is incomplete.");
  const runs = pages.flatMap(page => (page as { workflow_runs: unknown[] }).workflow_runs);
  for (const event of ["push", "pull_request"]) {
    const matching = runs.filter((run): run is Record<string, unknown> => record(run) && run.event === event && run.head_sha === source.sourceSha
      && run.head_branch === source.branch && record(run.head_repository) && run.head_repository.full_name === CAKE_REPOSITORY
      && run.path === ".github/workflows/ci.yml"
      && (event === "push" || Array.isArray(run.pull_requests) && run.pull_requests.some(pr => record(pr) && pr.number === source.prNumber)));
    if (!matching.length || matching.some(run => [run.id, run.run_number, run.run_attempt].some(value => !Number.isSafeInteger(value) || Number(value) < 1))) throw failure("Current push and PR CI runs are required before Ready.");
    matching.sort((a, b) => Number(b.run_number) - Number(a.run_number) || Number(b.run_attempt) - Number(a.run_attempt));
    if (matching.length > 1 && matching[0]?.run_number === matching[1]?.run_number && matching[0]?.run_attempt === matching[1]?.run_attempt) throw failure("CI inventory is ambiguous; read the latest runs again.");
    if (matching[0]?.status !== "completed" || matching[0]?.conclusion !== "success") throw failure("Wait for successful push and PR CI on the current commit before Ready.");
  }
}

export async function runCanneleReady(options: CanneleReadyOptions): Promise<void> {
  const { source, lease, unique, fixed, title } = options;
  const execute = options.execute ?? executeWorkflowCommand; const log = options.log ?? console.log;
  assertEvidence(options);
  if (!title.trim() || title.length > 240 || /[\r\n\0]/.test(title)) throw failure("Specify a valid PR title.");
  const file = resolve(options.cwd, options.verificationFile); const metadata = await lstat(file).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 1_000_000) throw failure("A regular verification report is required before Ready.");
  const verification = (await readFile(file, "utf8")).trim();
  if (!verification || verification.includes("\0")) throw failure("The verification report is empty or invalid.");
  const assertHead = async () => {
    const head = await cleanTaskHead(options.cwd, execute);
    if (head.branch !== source.branch || head.sha !== source.sourceSha) throw failure("PR head changed; repeat deployment and verification.");
    const remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd, "Cannot verify the pushed PR head.");
    if (remote !== `${head.sha}\trefs/heads/${head.branch}`) throw failure("Current PR commit is not pushed.");
    const requests = await taskPullRequests(head, execute); const pr = requests[0];
    if (!pr || pr.number !== source.prNumber || pr.headRefOid !== source.sourceSha) throw failure("Current draft PR is missing or changed.");
    return { head, pr };
  };
  const { head, pr } = await assertHead(); await assertTaskGitGate(head, execute); await assertCanneleCi(source, execute);
  const body = `${title.trim()}\n\n## QA\n\n- 固定QA URL: ${fixed.after.url}\n- Deployment URL: ${unique.after.url}\n- PR: #${source.prNumber} / branch: ${source.branch}\n- Commit: ${source.sourceSha}\n- QA枠: ${lease.slot} / 貸出ID: ${lease.leaseId}\n- Deployment: ${lease.readyDeploymentId}\n- 管理DB世代: ${lease.version}\n\n## 画面確認\n\n- 固有URL: ${unique.cases.join(", ")}\n- 固定URL: ${fixed.cases.join(", ")}\n\n## 検証結果\n\n${verification}\n`;
  await assertHead(); await updateTaskPullRequest(head, source.prNumber, title.trim(), body, execute);
  const final = await assertHead();
  if (final.pr.isDraft) await commandOutput(execute, "gh", ["pr", "ready", pr.url, "--repo", CAKE_REPOSITORY], head.cwd, "PR Ready transition failed.");
  log(`Cake: QAとCIを確認したPRを更新しました: ${pr.url}`);
}
