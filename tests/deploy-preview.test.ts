import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureVercelProject, runPreviewDeployment } from "../scripts/deploy-preview";

type CommandResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string };
type CommandCall = { args: readonly string[]; captureStdout: boolean };

const deploymentUrl = "https://cake-test-one-fumin1.vercel.app";
const defaultAlias = "cake-preview-fumin1.vercel.app";
const commandResult = (stdout = "", status = 0, signal: NodeJS.Signals | null = null): CommandResult => ({ status, signal, stdout });

function executor(outcomes: (CommandResult | Error)[]) {
  const calls: CommandCall[] = [];
  const execute = async (args: readonly string[], captureStdout: boolean): Promise<CommandResult> => {
    calls.push({ args: [...args], captureStdout });
    const outcome = outcomes.shift();
    assert.ok(outcome, "unexpected extra CLI execution");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { execute, calls };
}

async function withProjectFile(action: (projectFile: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "cake-vercel-link-test-"));
  const vercelDirectory = join(directory, ".vercel");
  await mkdir(vercelDirectory);
  try { await action(join(vercelDirectory, "project.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function writeRepoFile(projectFile: string, content: unknown): Promise<string> {
  const repoFile = join(dirname(projectFile), "repo.json");
  await writeFile(repoFile, JSON.stringify(content));
  return repoFile;
}

test("Preview成功後だけ固定aliasを最新Deploymentへ割り当てる", async () => {
  const stub = executor([commandResult(`\n${deploymentUrl}/\n`), commandResult()]);
  const logs: string[] = [];
  const result = await runPreviewDeployment({ environment: {}, execute: stub.execute, log: (message) => logs.push(message) });
  assert.deepEqual(result, { deploymentUrl, fixedUrl: `https://${defaultAlias}` });
  assert.deepEqual(stub.calls, [
    { args: ["vercel", "deploy", "--target", "preview"], captureStdout: true },
    { args: ["vercel", "alias", "set", deploymentUrl, defaultAlias], captureStdout: false },
  ]);
  assert.ok(logs.some((message) => message.includes(`https://${defaultAlias}`)));
});

test("CAKE_PREVIEW_ALIASで共有用固定ホスト名を変更できる", async () => {
  const alias = "cake-staging.example.com";
  const stub = executor([commandResult(deploymentUrl), commandResult()]);
  const result = await runPreviewDeployment({ environment: { CAKE_PREVIEW_ALIAS: alias }, execute: stub.execute, log: () => {} });
  assert.equal(result.fixedUrl, `https://${alias}`);
  assert.deepEqual(stub.calls[1].args, ["vercel", "alias", "set", deploymentUrl, alias]);
});

test("許可されたビルドflagsだけをPreviewのdeployコマンドへ渡す", async () => {
  const args = ["--logs", "--force", "--with-cache"] as const;
  const stub = executor([commandResult(deploymentUrl), commandResult()]);
  await runPreviewDeployment({ environment: {}, args, execute: stub.execute, log: () => {} });
  assert.deepEqual(stub.calls[0].args, ["vercel", "deploy", "--target", "preview", ...args]);
  assert.deepEqual(stub.calls[1].args, ["vercel", "alias", "set", deploymentUrl, defaultAlias]);
});

test("deployが失敗するとURLを出力していても固定aliasを更新しない", async () => {
  const stub = executor([commandResult(deploymentUrl, 1)]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }));
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].args[1], "deploy");
});

test("deployの起動エラーでは固定aliasコマンドを呼ばない", async () => {
  const stub = executor([new Error("isolated CLI launch failure")]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }));
  assert.equal(stub.calls.length, 1);
});

test("deployがsignalで終了した場合も固定aliasを更新しない", async () => {
  const stub = executor([{ status: null, signal: "SIGTERM", stdout: deploymentUrl }]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }));
  assert.equal(stub.calls.length, 1);
});

test("deploy成功でもstdoutが単一のHTTPS Deployment URLでなければ更新しない", async () => {
  for (const stdout of [
    "", "not-a-url", "http://cake-insecure.vercel.app", "javascript:alert(1)",
    `${deploymentUrl}\nhttps://cake-test-two-fumin1.vercel.app`,
    `build log\n${deploymentUrl}`, "https://user:password@cake-secret.vercel.app",
  ]) {
    const stub = executor([commandResult(stdout)]);
    await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }), stdout);
    assert.equal(stub.calls.length, 1, stdout);
  }
});

test("不正なaliasはdeploy前に拒否し外部コマンドを実行しない", async () => {
  for (const alias of [
    "", "   ", "https://cake-preview.vercel.app", "cake-preview.vercel.app/path",
    "cake-preview.vercel.app?secret=value", "cake-preview.vercel.app#fragment",
    "cake-preview.vercel.app:443", "cake preview.vercel.app", "--prod",
    "cake-preview.vercel.app\n--prod", "cake-preview.vercel.app; echo unsafe",
    "$(echo unsafe).vercel.app", "`echo unsafe`.vercel.app",
  ]) {
    const stub = executor([]);
    await assert.rejects(() => runPreviewDeployment({ environment: { CAKE_PREVIEW_ALIAS: alias }, execute: stub.execute, log: () => {} }), alias);
    assert.deepEqual(stub.calls, [], alias);
  }
});

test("Production切替やbuild待機省略を含む未知の引数をdeploy前に拒否する", async () => {
  for (const args of [
    ["--prod"], ["--target", "production"], ["--target=production"], ["--no-wait"],
    ["--token", "never-forward-token"], ["--scope", "other-team"], ["--yes"],
    ["--logs", "--prod"], ["--force; echo unsafe"], ["https://other-project.vercel.app"],
  ]) {
    const stub = executor([]);
    await assert.rejects(() => runPreviewDeployment({ environment: {}, args, execute: stub.execute, log: () => {} }), args.join(" "));
    assert.deepEqual(stub.calls, []);
  }
});

test("alias設定失敗では成功Deployment URLと手動再試行コマンドを返す", async () => {
  const stub = executor([commandResult(deploymentUrl), commandResult("", 1)]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(deploymentUrl));
    assert.ok(error.message.includes(defaultAlias));
    assert.match(error.message, /vercel alias set/);
    return true;
  });
  assert.equal(stub.calls.length, 2);
});

test("aliasの起動エラーでも完成済みDeploymentへの再試行情報を残す", async () => {
  const stub = executor([commandResult(deploymentUrl), new Error("isolated alias launch failure")]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(deploymentUrl));
    assert.match(error.message, /vercel alias set/);
    return true;
  });
  assert.equal(stub.calls.length, 2);
});

test("繰り返し実行すると同じ固定aliasを各回の新Deploymentへ更新する", async () => {
  const secondUrl = "https://cake-test-two-fumin1.vercel.app";
  const stub = executor([commandResult(deploymentUrl), commandResult(), commandResult(secondUrl), commandResult()]);
  const first = await runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} });
  const second = await runPreviewDeployment({ environment: {}, execute: stub.execute, log: () => {} });
  assert.equal(first.fixedUrl, second.fixedUrl);
  assert.equal(second.deploymentUrl, secondUrl);
  assert.deepEqual(stub.calls[1].args, ["vercel", "alias", "set", deploymentUrl, defaultAlias]);
  assert.deepEqual(stub.calls[3].args, ["vercel", "alias", "set", secondUrl, defaultAlias]);
});

test("環境内の認証キー・DB接続情報をログやコマンド引数へ出さない", async () => {
  const environment = {
    AUTH_SECRET: "never-log-auth-secret",
    DATABASE_URL: "postgresql://secret-user:never-log-password@isolated.invalid/cake",
    VERCEL_TOKEN: "never-log-vercel-token",
  };
  const logs: string[] = [];
  const stub = executor([commandResult(deploymentUrl), commandResult()]);
  await runPreviewDeployment({ environment, execute: stub.execute, log: (message) => logs.push(message) });
  const visibleOutput = JSON.stringify({ logs, calls: stub.calls });
  for (const secret of Object.values(environment)) assert.ok(!visibleOutput.includes(secret));
});

test("明示したteam scopeをdeployとaliasの両方へ引き継ぐ", async () => {
  const scope = "team_fixture-123";
  const stub = executor([commandResult(deploymentUrl), commandResult()]);
  await runPreviewDeployment({ environment: {}, scope, execute: stub.execute, log: () => {} });
  assert.deepEqual(stub.calls, [
    { args: ["vercel", "deploy", "--target", "preview", "--scope", scope], captureStdout: true },
    { args: ["vercel", "alias", "set", deploymentUrl, defaultAlias, "--scope", scope], captureStdout: false },
  ]);
});

test("alias失敗の手動再試行コマンドにも同じteam scopeを含める", async () => {
  const scope = "team_fixture-123";
  const stub = executor([commandResult(deploymentUrl), commandResult("", 1)]);
  await assert.rejects(() => runPreviewDeployment({ environment: {}, scope, execute: stub.execute, log: () => {} }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(`vercel alias set ${deploymentUrl} ${defaultAlias} --scope ${scope}`));
    return true;
  });
  assert.equal(stub.calls.length, 2);
});

test("不正なteam scopeはdeploy前に拒否する", async () => {
  for (const scope of ["", " ", "team with space", "team/other", "team;echo unsafe", "$(echo unsafe)", "日本語", "team\n--prod"]) {
    const stub = executor([]);
    await assert.rejects(() => runPreviewDeployment({ environment: {}, scope, execute: stub.execute, log: () => {} }), scope);
    assert.deepEqual(stub.calls, [], scope);
  }
});

test("未リンクなら対話linkを実行し、作成された接続先のteamでdeployとaliasを行う", async () => {
  await withProjectFile(async (projectFile) => {
    const project = { orgId: "team_newly-linked", projectId: "prj_existing-cake" };
    const calls: CommandCall[] = [];
    const execute = async (args: readonly string[], captureStdout: boolean): Promise<CommandResult> => {
      calls.push({ args: [...args], captureStdout });
      if (args[1] === "link") {
        await writeFile(projectFile, JSON.stringify({ ...project, projectName: "cake" }));
        return commandResult("interactive link output");
      }
      return commandResult(captureStdout ? deploymentUrl : "");
    };
    const linked = await ensureVercelProject({ projectFile, execute, log: () => {} });
    assert.deepEqual(linked, project);
    await runPreviewDeployment({ environment: {}, scope: linked.orgId, execute, log: () => {} });
    assert.deepEqual(calls, [
      { args: ["vercel", "link"], captureStdout: false },
      { args: ["vercel", "deploy", "--target", "preview", "--scope", project.orgId], captureStdout: true },
      { args: ["vercel", "alias", "set", deploymentUrl, defaultAlias, "--scope", project.orgId], captureStdout: false },
    ]);
  });
});

test("既存の有効な接続情報は再linkせずorgIdとprojectIdだけ返す", async () => {
  await withProjectFile(async (projectFile) => {
    const project = { orgId: "team_existing", projectId: "prj_existing" };
    await writeFile(projectFile, JSON.stringify({ ...project, projectName: "cake", settings: { framework: "nextjs" } }));
    const stub = executor([]);
    const linked = await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} });
    assert.deepEqual(linked, project);
    assert.deepEqual(stub.calls, []);
  });
});

test("既存の破損した接続情報は書き換えず再linkも行わない", async () => {
  await withProjectFile(async (projectFile) => {
    for (const content of ["{broken-json", "{}", JSON.stringify({ orgId: "team_existing", projectId: "" }),
      JSON.stringify({ orgId: " ", projectId: "prj_existing" }), JSON.stringify({ orgId: 42, projectId: "prj_existing" })]) {
      await writeFile(projectFile, content);
      const stub = executor([]);
      await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
      assert.deepEqual(stub.calls, []);
      assert.equal(await readFile(projectFile, "utf8"), content);
    }
  });
});

test("接続情報がファイルとして読み取れない場合も外部コマンドを起動しない", async () => {
  await withProjectFile(async (projectFile) => {
    await mkdir(projectFile);
    const stub = executor([]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
    assert.deepEqual(stub.calls, []);
  });
});

test("link失敗・起動エラー・中断ではdeployとaliasを実行しない", async () => {
  await withProjectFile(async (projectFile) => {
    for (const outcome of [commandResult("", 1), new Error("isolated link launch failure"),
      { status: null, signal: "SIGTERM" as const, stdout: "" }]) {
      const stub = executor([outcome]);
      await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
      assert.deepEqual(stub.calls, [{ args: ["vercel", "link"], captureStdout: false }]);
    }
  });
});

test("linkが成功終了しても接続情報が作成されなければ停止する", async () => {
  await withProjectFile(async (projectFile) => {
    const stub = executor([commandResult()]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
    assert.deepEqual(stub.calls, [{ args: ["vercel", "link"], captureStdout: false }]);
  });
});

test("link後に不正な接続情報しか得られなければdeployへ進まない", async () => {
  await withProjectFile(async (projectFile) => {
    const calls: CommandCall[] = [];
    const execute = async (args: readonly string[], captureStdout: boolean): Promise<CommandResult> => {
      calls.push({ args: [...args], captureStdout });
      await writeFile(projectFile, JSON.stringify({ orgId: "team_newly-linked" }));
      return commandResult();
    };
    await assert.rejects(() => ensureVercelProject({ projectFile, execute, log: () => {} }));
    assert.deepEqual(calls, [{ args: ["vercel", "link"], captureStdout: false }]);
  });
});

test("linkを中断したあと同じ場所で再実行できる", async () => {
  await withProjectFile(async (projectFile) => {
    const cancelled = executor([{ status: null, signal: "SIGINT", stdout: "" }]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: cancelled.execute, log: () => {} }));
    const project = { orgId: "team_retried", projectId: "prj_existing-cake" };
    const linked = await ensureVercelProject({ projectFile, log: () => {}, execute: async (args, captureStdout) => {
      assert.deepEqual(args, ["vercel", "link"]);
      assert.equal(captureStdout, false);
      await writeFile(projectFile, JSON.stringify(project));
      return commandResult();
    } });
    assert.deepEqual(linked, project);
  });
});

test("Git連携のrepo.jsonを再linkせず読み取りdeployとaliasへ同じteamを引き継ぐ", async () => {
  await withProjectFile(async (projectFile) => {
    const project = { orgId: "team_repo-existing", projectId: "prj_existing-cake" };
    const repoFile = await writeRepoFile(projectFile, {
      projects: [{ id: project.projectId, name: "cake", directory: ".", orgId: project.orgId }],
    });
    const before = await readFile(repoFile, "utf8");
    const stub = executor([commandResult(deploymentUrl), commandResult()]);
    const linked = await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} });
    assert.deepEqual(linked, project);
    assert.deepEqual(stub.calls, []);
    await runPreviewDeployment({ environment: {}, scope: linked.orgId, execute: stub.execute, log: () => {} });
    assert.deepEqual(stub.calls, [
      { args: ["vercel", "deploy", "--target", "preview", "--scope", project.orgId], captureStdout: true },
      { args: ["vercel", "alias", "set", deploymentUrl, defaultAlias, "--scope", project.orgId], captureStdout: false },
    ]);
    assert.equal(await readFile(repoFile, "utf8"), before);
  });
});

test("対話linkがrepo.jsonだけを作成した場合もその接続先でdeployとaliasへ進む", async () => {
  await withProjectFile(async (projectFile) => {
    const project = { orgId: "team_repo-newly-linked", projectId: "prj_existing-cake" };
    const calls: CommandCall[] = [];
    const execute = async (args: readonly string[], captureStdout: boolean): Promise<CommandResult> => {
      calls.push({ args: [...args], captureStdout });
      if (args[1] === "link") {
        await writeRepoFile(projectFile, {
          projects: [{ id: project.projectId, name: "cake", directory: ".", orgId: project.orgId }],
        });
      }
      return commandResult(captureStdout ? deploymentUrl : "");
    };
    const linked = await ensureVercelProject({ projectFile, execute, log: () => {} });
    assert.deepEqual(linked, project);
    await runPreviewDeployment({ environment: {}, scope: linked.orgId, execute, log: () => {} });
    assert.deepEqual(calls, [
      { args: ["vercel", "link"], captureStdout: false },
      { args: ["vercel", "deploy", "--target", "preview", "--scope", project.orgId], captureStdout: true },
      { args: ["vercel", "alias", "set", deploymentUrl, defaultAlias, "--scope", project.orgId], captureStdout: false },
    ]);
  });
});

test("旧repo.jsonのトップレベルorgIdを使い項目内のorgIdがあれば優先する", async () => {
  await withProjectFile(async (projectFile) => {
    for (const itemOrgId of [undefined, "team_project-specific"]) {
      await writeRepoFile(projectFile, {
        orgId: "team_legacy-repository",
        projects: [{ id: "prj_legacy-cake", name: "cake", directory: ".", orgId: itemOrgId }],
      });
      const stub = executor([]);
      const linked = await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} });
      assert.deepEqual(linked, { projectId: "prj_legacy-cake", orgId: itemOrgId ?? "team_legacy-repository" });
      assert.deepEqual(stub.calls, []);
    }
  });
});

test("project.jsonの明示接続は異なるrepo接続や破損したrepo.jsonより優先する", async () => {
  await withProjectFile(async (projectFile) => {
    const project = { orgId: "team_explicit-project", projectId: "prj_explicit-cake" };
    await writeFile(projectFile, JSON.stringify(project));
    const repoFile = await writeRepoFile(projectFile, {
      projects: [{ id: "prj_other-cake", name: "other-cake", directory: ".", orgId: "team_other" }],
    });
    for (const repoContent of [await readFile(repoFile, "utf8"), "{broken-repo-json"]) {
      await writeFile(repoFile, repoContent);
      const stub = executor([]);
      assert.deepEqual(await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }), project);
      assert.deepEqual(stub.calls, []);
      assert.equal(await readFile(repoFile, "utf8"), repoContent);
    }
  });
});

test("pullで作成された設定のみのproject.jsonではrepo.jsonの接続先を使う", async () => {
  await withProjectFile(async (projectFile) => {
    const settingsContent = JSON.stringify({
      settings: { framework: "nextjs", buildCommand: "npm run build:vercel" }, projectName: "cake",
    });
    await writeFile(projectFile, settingsContent);
    await writeRepoFile(projectFile, {
      projects: [{ id: "prj_repo-cake", name: "cake", directory: ".", orgId: "team_repo" }],
    });
    const stub = executor([]);
    assert.deepEqual(await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }), {
      projectId: "prj_repo-cake", orgId: "team_repo",
    });
    assert.deepEqual(stub.calls, []);
    assert.equal(await readFile(projectFile, "utf8"), settingsContent);
  });
});

test("project.jsonのJSON自体が破損していれば有効repo接続があっても停止する", async () => {
  await withProjectFile(async (projectFile) => {
    const content = "{broken-project-json";
    await writeFile(projectFile, content);
    await writeRepoFile(projectFile, {
      projects: [{ id: "prj_repo-cake", name: "cake", directory: ".", orgId: "team_repo" }],
    });
    const stub = executor([]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
    assert.deepEqual(stub.calls, []);
    assert.equal(await readFile(projectFile, "utf8"), content);
  });
});

test("祖先repo.jsonでは現在の場所を含む最も深いprojectを選び似た名前の兄弟を除外する", async () => {
  await withProjectFile(async (rootProjectFile) => {
    const directory = dirname(dirname(rootProjectFile));
    await writeRepoFile(rootProjectFile, {
      projects: [
        { id: "prj_repo-root", name: "root", directory: ".", orgId: "team_root" },
        { id: "prj_web", name: "web", directory: "apps/web", orgId: "team_web" },
        { id: "prj_web2", name: "web2", directory: "apps/web2", orgId: "team_web2" },
        { id: "prj_nested", name: "nested", directory: "apps/web/src", orgId: "team_nested" },
      ],
    });
    for (const [relativeDirectory, expected] of [
      ["apps/web/src/pages", { projectId: "prj_nested", orgId: "team_nested" }],
      ["apps/web", { projectId: "prj_web", orgId: "team_web" }],
      ["apps/web2/components", { projectId: "prj_web2", orgId: "team_web2" }],
      ["apps/web20", { projectId: "prj_repo-root", orgId: "team_root" }],
    ] as const) {
      const projectFile = join(directory, relativeDirectory, ".vercel", "project.json");
      await mkdir(dirname(projectFile), { recursive: true });
      const stub = executor([]);
      assert.deepEqual(await ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }), expected);
      assert.deepEqual(stub.calls, []);
    }
  });
});

test("同じ深さに複数のrepo接続候補があれば勝手に選択せず停止する", async () => {
  await withProjectFile(async (projectFile) => {
    const repoFile = await writeRepoFile(projectFile, {
      projects: [
        { id: "prj_first", name: "cake", directory: ".", orgId: "team_first" },
        { id: "prj_second", name: "other", directory: "./", orgId: "team_second" },
      ],
    });
    const before = await readFile(repoFile, "utf8");
    const stub = executor([]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
    assert.deepEqual(stub.calls, []);
    assert.equal(await readFile(repoFile, "utf8"), before);
  });
});

test("repo.jsonがあっても現在の場所に対応するprojectがなければ再linkせず停止する", async () => {
  await withProjectFile(async (projectFile) => {
    const repoFile = await writeRepoFile(projectFile, {
      projects: [{ id: "prj_unrelated", name: "other", directory: "apps/other", orgId: "team_other" }],
    });
    const before = await readFile(repoFile, "utf8");
    const stub = executor([]);
    await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }));
    assert.deepEqual(stub.calls, []);
    assert.equal(await readFile(repoFile, "utf8"), before);
  });
});

test("破損repo.jsonや不正な選択先IDは外部コマンドや上書きを行わず停止する", async () => {
  await withProjectFile(async (projectFile) => {
    const repoFile = join(dirname(projectFile), "repo.json");
    for (const content of [
      "{broken-repo-json", "null", "{}", JSON.stringify({ projects: {} }), JSON.stringify({ projects: [] }),
      ...[
        { id: "", orgId: "team_valid", directory: "." },
        { id: " ", orgId: "team_valid", directory: "." },
        { id: 42, orgId: "team_valid", directory: "." },
        { id: "prj_valid", orgId: "", directory: "." },
        { id: "prj_valid", orgId: " ", directory: "." },
        { id: "prj_valid", orgId: 42, directory: "." },
        { id: "prj_valid", directory: "." },
        { id: "prj_valid", orgId: "team_valid", directory: "" },
        { id: "prj_valid", orgId: "team_valid", directory: "/" },
        { id: "prj_valid", orgId: "team_valid", directory: "../" },
        { id: "prj_valid", orgId: "team_valid", directory: 42 },
        { id: "prj_valid", orgId: "team_valid" },
      ].map((project) => JSON.stringify({ projects: [{ name: "cake", ...project }] })),
    ]) {
      await writeFile(repoFile, content);
      const stub = executor([]);
      await assert.rejects(() => ensureVercelProject({ projectFile, execute: stub.execute, log: () => {} }), content);
      assert.deepEqual(stub.calls, [], content);
      assert.equal(await readFile(repoFile, "utf8"), content);
    }
  });
});

test("link後のrepo接続が曖昧または不正ならdeployとaliasへ進まない", async () => {
  await withProjectFile(async (projectFile) => {
    const calls: CommandCall[] = [];
    const execute = async (args: readonly string[], captureStdout: boolean): Promise<CommandResult> => {
      calls.push({ args: [...args], captureStdout });
      await writeRepoFile(projectFile, {
        projects: [
          { id: "prj_first", name: "cake", directory: ".", orgId: "team_first" },
          { id: "prj_second", name: "other", directory: ".", orgId: "team_second" },
        ],
      });
      return commandResult();
    };
    await assert.rejects(() => ensureVercelProject({ projectFile, execute, log: () => {} }));
    assert.deepEqual(calls, [{ args: ["vercel", "link"], captureStdout: false }]);
  });
});
