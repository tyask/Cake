import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeWorkflowCommand, validTaskBranch } from "../scripts/task-workflow";
import manifest from "../docs/cannele/resource-manifest.json";

test("task branch grammar preserves flat branches and permits exactly the reviewed generation within the shared length budget", () => {
  const prefix = manifest.repository.featureBranchPrefix;
  for (const branch of ["codex/qa-acceptance", `codex/${"a".repeat(60)}`, `${prefix}qa-acceptance`, `${prefix}${"a".repeat(15)}`]) assert.equal(validTaskBranch(branch), true, branch);
  for (const branch of [null, "main", "codex/main", "codex/preview", "codex/production", `codex/${"a".repeat(61)}`,
    `${prefix}${"a".repeat(16)}`, prefix, `${prefix}main`, `${prefix}qa-acceptance/child`, `${prefix}../escape`, `${prefix}/task`,
    `${prefix}task/`, `${prefix}Upper`, `${prefix}task.lock`, `${prefix}two--parts`, `${prefix}task\n`, `${prefix}task\r`,
    `${prefix}task%2fescape`, `${prefix}task\\escape`, "codex/unreviewed/task", `codex/cannele-00000000-0000-4000-8000-000000000001/qa-acceptance`,
    `codex/cannele-${manifest.instanceId.toUpperCase()}/task`, "codex//task"]) assert.equal(validTaskBranch(branch), false, String(branch));
});

test("workflow executor fixes GitHub's host even when the caller selects another GH_HOST", { skip: process.platform === "win32" }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "cake-workflow-host-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const mock = join(cwd, "gh");
  await writeFile(mock, '#!/bin/sh\nprintf "%s" "$GH_HOST"\n', { mode: 0o700 });
  await chmod(mock, 0o700);
  const previousPath = process.env.PATH, previousHost = process.env.GH_HOST;
  process.env.PATH = cwd; process.env.GH_HOST = "another.example";
  try {
    assert.deepEqual(await executeWorkflowCommand("gh", [], cwd), { status: 0, signal: null, stdout: "github.com" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousHost === undefined) delete process.env.GH_HOST; else process.env.GH_HOST = previousHost;
  }
});
