import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAKE_REPOSITORY, commandOutput, type TaskHead, type WorkflowExecutor } from "./task-workflow";

const failure = () => new Error("PR本文の更新を確認できませんでした。GitHubのPRを確認して再実行してください。draftは解除しません。");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Avoid gh pr edit's unrelated GraphQL Projects lookup; preserve the exact Markdown via JSON input. */
export async function updateTaskPullRequest(head: TaskHead, prNumber: number, title: string, body: string, execute: WorkflowExecutor): Promise<void> {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !title.trim() || title.length > 240 || /[\r\n\0]/.test(title)
    || !body.trim() || body.includes("\0")) throw failure();
  const directory = await mkdtemp(join(tmpdir(), "cake-pr-update-"));
  try {
    const file = join(directory, "request.json");
    await writeFile(file, `${JSON.stringify({ title, body })}\n`, { mode: 0o600, flag: "wx" });
    const raw = await commandOutput(execute, "gh", ["api", `repos/${CAKE_REPOSITORY}/pulls/${prNumber}`, "--method", "PATCH", "--input", file], head.cwd, failure().message);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw failure(); }
    if (!object(value)) throw failure();
    const pr = value;
    if (pr.number !== prNumber || pr.html_url !== `https://github.com/${CAKE_REPOSITORY}/pull/${prNumber}` || pr.state !== "open"
      || pr.title !== title || pr.body !== body || !object(pr.head) || pr.head.ref !== head.branch || pr.head.sha !== head.sha
      || !object(pr.head.repo) || pr.head.repo.full_name !== CAKE_REPOSITORY || !object(pr.base) || pr.base.ref !== "main"
      || !object(pr.base.repo) || pr.base.repo.full_name !== CAKE_REPOSITORY) throw failure();
  } finally { await rm(directory, { recursive: true, force: true }); }
}
