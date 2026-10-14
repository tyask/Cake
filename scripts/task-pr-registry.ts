import { readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTaskPr } from "./task-pr";
import { requestQaAction } from "./qa-client";
import { cleanTaskHead, assertTaskGitGate, commandOutput, taskPullRequests, executeWorkflowCommand, CAKE_REPOSITORY, type WorkflowExecutor } from "./task-workflow";

type Options = { args?: readonly string[]; cwd?: string; execute?: WorkflowExecutor; log?: (message: string) => void };
/** Shared Cloud/PC entry. Ready is allowed only after live registry/provider verification. */
export async function runTaskPrRegistry({ args = [], cwd = process.cwd(), execute = executeWorkflowCommand, log = console.log }: Options = {}) {
  if (args.includes("--draft")) return runTaskPr({ args, cwd, execute, log });
  if (args.length !== 4 || args[0] !== "--title" || args[2] !== "--verification-file" || !args[1]?.trim()
    || args[1].length > 240 || /[\r\n\0]/.test(args[1]) || !args[3]?.trim()) throw new Error("Specify --title and --verification-file for the verified PR.");
  const title = args[1].trim(), reportFile = resolve(cwd, args[3]);
  const meta = await stat(reportFile).catch(() => null);
  if (!meta?.isFile() || meta.size > 1_000_000) throw new Error("Verification report is missing or too large.");
  const verification = (await readFile(reportFile, "utf8")).trim();
  if (!verification || verification.includes("\0")) throw new Error("Verification report is empty or invalid.");
  const head = await cleanTaskHead(cwd, execute);
  const requests = await taskPullRequests(head, execute), pr = requests[0];
  if (!pr || pr.headRefOid !== head.sha) throw new Error("Create the current commit's draft PR before QA verification.");
  const remote = await commandOutput(execute, "git", ["ls-remote", "--heads", "origin", `refs/heads/${head.branch}`], head.cwd, "Cannot verify the pushed PR commit.");
  if (remote !== `${head.sha}\trefs/heads/${head.branch}`) throw new Error("Current commit is not pushed; repeat deployment and tests.");
  const mainSha = await assertTaskGitGate(head, execute);
  const receipt = await requestQaAction({ action: "status", prNumber: pr.number, head, mainSha, execute, log });
  const lease = receipt.payload;
  if (!lease || lease.state !== "published" || lease.headSha !== head.sha || lease.aliasSha !== head.sha || !lease.database || !lease.readyDeploymentId) throw new Error("Current PR QA publication is not verified.");
  const deployment = lease.deployments.find(d => d.id === lease.readyDeploymentId);
  if (!deployment?.url) throw new Error("Verified QA Deployment URL is missing.");
  // A free-form report alone cannot advance a PR; the scoped browser verification receipt is also required.
  let evidence: Record<string, unknown>;
  try { evidence = JSON.parse(await readFile(resolve(head.cwd, ".cake/qa-verification.json"), "utf8")); } catch { throw new Error("Run QA browser/API verification for both unique and fixed URLs before Ready."); }
  if (evidence.protocol !== "cake-qa-verification/v1" || evidence.pr !== pr.number || evidence.leaseId !== lease.leaseId
    || evidence.sha !== head.sha || evidence.deploymentId !== lease.readyDeploymentId || evidence.uniqueUrl !== deployment.url
    || evidence.fixedUrl !== `https://cake-${lease.slot}-fumin.vercel.app` || evidence.success !== true) throw new Error("QA browser/API verification belongs to another lease or commit.");
  const current = await cleanTaskHead(head.cwd, execute);
  if (current.sha !== head.sha || current.branch !== head.branch) throw new Error("PR head changed during QA verification.");
  const body = `${title}\n\n## QA\n\n- 固定QA URL: https://cake-${lease.slot}-fumin.vercel.app\n- Deployment URL: ${deployment.url}\n- PR: #${pr.number} / branch: ${head.branch}\n- Commit: ${head.sha}\n- QA枠: ${lease.slot} / 貸出ID: ${lease.leaseId}\n- Deployment: ${lease.readyDeploymentId}\n- 管理DB世代: ${lease.version}\n- テストDB: ${lease.database.projectId} / ${lease.database.branchId} / ${lease.database.endpointId}\n\n## 検証結果\n\n${verification}\n`;
  const directory = await mkdtemp(join(tmpdir(), "cake-registry-pr-"));
  try {
    const file = join(directory, "body.md"); await writeFile(file, body, { mode: 0o600 });
    await commandOutput(execute, "gh", ["pr", "edit", pr.url, "--repo", CAKE_REPOSITORY, "--title", title, "--body-file", file], head.cwd, "PR body update failed; PR remains unchanged or draft.");
    if (pr.isDraft) await commandOutput(execute, "gh", ["pr", "ready", pr.url, "--repo", CAKE_REPOSITORY], head.cwd, "PR Ready transition failed.");
    log(`Cake: QAを確認したPRを更新しました: ${pr.url}`);
    return { url: pr.url, existing: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
