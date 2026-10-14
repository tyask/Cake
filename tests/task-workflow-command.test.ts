import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeWorkflowCommand } from "../scripts/task-workflow";

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
