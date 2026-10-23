import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkDocumentation, inspectDocumentation, type DocumentationFile } from "../../scripts/tooling/check-docs";

function inspect(content: string, targets: DocumentationFile[] = [], paths: string[] = []) {
  const source = { path: "docs/source.md", content };
  return checkDocumentation([source], new Set([source.path, ...targets.map((target) => target.path), ...paths]), [source, ...targets]);
}

test("相対リンク・画像・HTML属性の欠落を文書と行番号で返す", () => {
  const issues = inspect("# Source\n[missing](missing.md)\n![image](images/missing.svg)\n<a href='../lib/missing.ts'>code</a>\n<img src=missing.png>");
  assert.deepEqual(issues.map(({ file, line, target, kind }) => [file, line, target, kind]), [
    ["docs/source.md", 2, "missing.md", "missing-file"],
    ["docs/source.md", 3, "images/missing.svg", "missing-file"],
    ["docs/source.md", 4, "../lib/missing.ts", "missing-file"],
    ["docs/source.md", 5, "missing.png", "missing-file"],
  ]);
});

test("日本語・大文字・装飾・重複見出しとsetextのanchorを照合する", () => {
  const content = "# 日本語 API\n## _Save_ `item_id`\n## Repeat\n## Repeat\nSetext title\n---\n";
  const target = { path: "docs/target.md", content };
  const links = ["日本語-api", "save-item_id", "repeat", "repeat-1", "setext-title"].map((anchor) => `[ok](target.md#${anchor})`).join("\n");
  assert.deepEqual(inspect(links, [target]), []);
  assert.equal(inspect("[bad](target.md#repeat-2)", [target])[0].kind, "missing-anchor");
});

test("HTML id・a nameを認識しdata-idやinput nameをanchorにしない", () => {
  const target = { path: "docs/target.html", content: '<section id="API"><a name=legacy></a><input name="field"><p data-id="fake">' };
  assert.deepEqual(inspect("[id](target.html#API) [name](target.html#legacy)", [target]), []);
  assert.deepEqual(inspect("[bad](target.html#api) [bad](target.html#fake) [bad](target.html#field)", [target])
    .map(({ kind }) => kind), ["missing-anchor", "missing-anchor", "missing-anchor"]);
});

test("percent encoded path/anchor・query・括弧と引用titleを正しく分離する", () => {
  const target = { path: "docs/space 日本語(v2).md", content: "# 日本語 API" };
  assert.deepEqual(inspect('[quoted](space%20%E6%97%A5%E6%9C%AC%E8%AA%9E(v2).md?raw=1#%E6%97%A5%E6%9C%AC%E8%AA%9E-api "title")\n[angle](<space 日本語(v2).md#日本語-api> \'title\')', [target]), []);
  assert.equal(inspect("[bad](broken%ZZ.md)")[0].kind, "invalid-link");
});

test("HTML entityを復号してリンクとanchorを照合する", () => {
  const source = { path: "docs/source.html", content: '<a href="target.html?one=1&amp;two=2#a&amp;b">link</a>' };
  const target = { path: "docs/target.html", content: '<p id="a&amp;b">target</p>' };
  assert.deepEqual(checkDocumentation([source], new Set([source.path, target.path]), [source, target]), []);
});

test("referenceリンク・collapsed・shortcutと未定義referenceを扱う", () => {
  const target = { path: "docs/target.md", content: "# Target" };
  assert.deepEqual(inspect('[first][A label] [second][] [short]\n\n[a LABEL]: target.md#target "title"\n[second]: target.md\n[short]: <target.md>', [target]), []);
  assert.deepEqual(inspect("[missing][undefined]\n[literal brackets]\n[used][target]\n[target]: nowhere.md").map(({ line, kind, target }) => [line, kind, target]), [
    [1, "missing-reference", "undefined"], [3, "missing-file", "nowhere.md"],
  ]);
});

test("inline・fenced・HTML codeと引用command内の明示repo pathを検査する", () => {
  const issues = inspect('`lib/missing.ts`\n```bash\nnode "scripts/missing file.ts"\n```\n<code>tests/missing.test.ts</code>\n`lib\\shared\\missing.ts`\n`package.json`', [], ["package.json"]);
  assert.deepEqual(issues.map(({ line, target }) => [line, target]), [
    [1, "lib/missing.ts"], [3, "scripts/missing file.ts"], [5, "tests/missing.test.ts"], [6, "lib/shared/missing.ts"],
  ]);
});

test("glob・placeholder・OS path・生成物は静的ファイル参照から除く", () => {
  assert.deepEqual(inspect('`lib/*.ts` `tests/**/*.test.ts` `lib/<name>.ts` `lib/${name}.ts` `lib/{name}.ts`\n`C:\\Cake\\lib\\missing.ts` `/tmp/Cake/lib/missing.ts` `%LOCALAPPDATA%\\CakeQa`\n`.cake/report.md` `.next/types/app.ts` `some-module` `GET /api/app`'), []);
});

test("外部scheme・protocol relative・アプリ絶対URLは巡回しない", () => {
  assert.deepEqual(inspect("[web](https://invalid.example/missing.md#missing) [mail](mailto:sample@example.invalid) [data](data:text/plain,hello) [file](file:///C:/Cake/missing.md) [cdn](//example.invalid/icon.svg) [app](/api/app)"), []);
});

test("コメント・コード例・script/style内のリンクと見出しを本文扱いしない", () => {
  const content = '<!-- [bad](missing.md) -->\n`[bad](missing.md)`\n````md\n# Fake\n[bad](missing.md)\n```\n````\n<script>const x = "<a href=missing.md>";</script>\n<style>/* <a href=missing.md> */</style>\n# Real\n[ok](#real)';
  assert.deepEqual(inspect(content), []);
  assert.equal(inspect(`${content}\n[bad](#fake)`)[0].kind, "missing-anchor");
});

test("script/styleの開始タグのsrcを検査し本文内の疑似参照は除外する", () => {
  for (const path of ["docs/source.md", "docs/source.html"]) {
    const content = '<script src="missing.js">\nconst example = "<a href=missing.md>";\n</script>\n<style src="missing.css">/* <img src=missing.png> */</style>\n<script src="exists.js">const example = "<a href=missing.md>";</script>';
    const document = { path, content };
    assert.deepEqual(checkDocumentation([document], new Set([path, "docs/exists.js"]))
      .map(({ line, target, kind }) => [line, target, kind]), [
      [1, "missing.js", "missing-file"], [4, "missing.css", "missing-file"],
    ]);
  }
});

test("同じファイル内anchorとsourceファイルの行番号付き参照を扱う", () => {
  assert.deepEqual(inspect("# Local\n[local](#local)\n`lib/exists.ts:20` [source](../lib/exists.ts#L20)\n`lib/shared/`", [], ["lib/exists.ts", "lib/shared"]), []);
  assert.equal(inspect("[outside](../../missing.md)")[0].kind, "missing-file");
});

test("root生成物だけを除外し下位build/outとdocs配下の文書を収集する", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cake-docs-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const files = {
    "AGENTS.md": "[nested](docs/nested/guide.md#guide)",
    "README.md": "`scripts/build/` `app/build/route.ts` `tests/fixtures/out/source.ts`",
    "docs/nested/guide.md": "# Guide\n[HTML](../guide.html#html)\n[root](../../)",
    "docs/guide.html": '<h1 id="html">HTML</h1>',
    "scripts/build/vercel-build.ts": "",
    "app/build/route.ts": "",
    "tests/fixtures/out/source.ts": "",
    "build/generated.md": "[ignored](missing.md)",
    "out/generated.md": "[ignored](missing.md)",
    ".cake/local.md": "[ignored](missing.md)",
    "node_modules/package/README.md": "[ignored](missing.md)",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  assert.deepEqual(inspectDocumentation(cwd), { documents: 4, issues: [] });
  writeFileSync(join(cwd, "docs/nested/guide.md"), "[bad](missing.md)");
  assert.deepEqual(inspectDocumentation(cwd).issues, [{ file: "AGENTS.md", line: 1, target: "docs/nested/guide.md#guide", kind: "missing-anchor" },
    { file: "docs/nested/guide.md", line: 1, target: "missing.md", kind: "missing-file" }]);
});

test("CLIは欠落をfile:lineで報告してexit 1、修正後はexit 0にする", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "cake-docs-cli-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "scripts/tooling"), { recursive: true });
  const cli = join(cwd, "scripts/tooling/check-docs.ts");
  copyFileSync(new URL("../../scripts/tooling/check-docs.ts", import.meta.url), cli);
  writeFileSync(join(cwd, "README.md"), "# Test\n[bad](missing.md)");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", cli], { cwd: process.cwd(), encoding: "utf8" });
  const failed = run();
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /README\.md:2: missing-file: missing\.md/);
  writeFileSync(join(cwd, "missing.md"), "# Found");
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /文書検査: 1ファイル、問題0件/);
});
