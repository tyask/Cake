import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_GIT_CONFIG_BYTES, assertMainOnlyGitConfig, decodeGitConfigFile } from "../lib/qa-pool-gate";

const config = (rules: Record<string, unknown> = { "**": false, main: true }) => ({ git: { deploymentEnabled: rules } });
const bytesFile = (bytes: Buffer) => ({
  type: "file", name: "vercel.json", path: "vercel.json", encoding: "base64", size: bytes.length,
  sha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), content: bytes.toString("base64"),
});
const file = (value: unknown = config()) => bytesFile(Buffer.from(JSON.stringify(value) + "\n", "utf8"));
const privateError = (error: unknown) => error instanceof Error && !error.message.includes("private-");

test("mainだけGit生成を許可し、他の規則をfalseに限定する", () => {
  for (const value of [config(), config({ "**": false, main: true, "codex/**": false, qa1: false }),
    { crons: [{ path: "/api/cron/example", schedule: "0 0 * * *" }], ...config() }]) {
    const before = structuredClone(value);
    assert.doesNotThrow(() => assertMainOnlyGitConfig(value));
    assert.deepEqual(value, before);
  }
});

for (const [name, value] of [
  ["undefined", undefined], ["null", null], ["array", []], ["empty", {}],
  ["missing git", { deploymentEnabled: { "**": false, main: true } }], ["git null", { git: null }],
  ["git array", { git: [] }], ["missing deploymentEnabled", { git: {} }],
  ["boolean deploymentEnabled", { git: { deploymentEnabled: false } }],
  ["array deploymentEnabled", { git: { deploymentEnabled: [] } }],
  ["missing catch-all", config({ main: true })], ["single-star catch-all", config({ "*": false, main: true })],
  ["missing main", config({ "**": false })], ["main denied", config({ "**": false, main: false })],
  ["catch-all allowed", config({ "**": true, main: true })], ["main string", config({ "**": false, main: "true" })],
  ["catch-all string", config({ "**": "false", main: true })], ["extra string", config({ "**": false, main: true, qa1: "false" })],
  ["extra number", config({ "**": false, main: true, qa1: 0 })], ["extra null", config({ "**": false, main: true, qa1: null })],
  ["extra undefined", config({ "**": false, main: true, qa1: undefined })],
  ["inherited git", Object.create(config())],
  ["inherited deploymentEnabled", { git: Object.create(config().git) }],
  ["inherited rules", { git: { deploymentEnabled: Object.create({ "**": false, main: true }) } }],
  ["inherited allow with own rules", config(Object.assign(Object.create({ "codex/**": true }), { "**": false, main: true }))],
] as const) {
  test(name + "の設定では生成を許可しない", () => assert.throws(() => assertMainOnlyGitConfig(value)));
}

for (const branch of ["qa1", "codex/**", "*", "!main", "main*", "**/main", "{main,codex/**}", "__proto__", "constructor"]) {
  test("main以外のtrue規則" + branch + "を拒否する", () => {
    const value = JSON.parse('{"git":{"deploymentEnabled":{"**":false,"main":true,' + JSON.stringify(branch) + ':true}}}');
    assert.throws(() => assertMainOnlyGitConfig(value));
  });
}

test("JSONに存在できない継承値やgetter例外から応答内容を表示しない", () => {
  const value = Object.defineProperty({}, "git", { get() { throw new Error("private-config"); } });
  assert.throws(() => assertMainOnlyGitConfig(value), privateError);
  const hidden = Object.defineProperty({ "**": false, main: true }, "codex/**", { value: true });
  assert.throws(() => assertMainOnlyGitConfig(config(hidden)));
  const symbolRule = { "**": false, main: true, [Symbol("private-rule")]: false };
  assert.throws(() => assertMainOnlyGitConfig(config(symbolRule)));
});

test("Contentsの完全なfileをGit blob SHAと実バイト数で確認する", () => {
  const value = file();
  const before = structuredClone(value);
  assert.deepEqual(decodeGitConfigFile(value, { blobSha: value.sha }),
    { config: config(), blobSha: value.sha, size: value.size, path: "vercel.json" });
  assert.deepEqual(value, before);
});

test("LF/CRLFで折り返したbase64と日本語のUTF-8バイト数を受理する", () => {
  const value = file({ comment: "日本語の設定", ...config() });
  for (const newline of ["\n", "\r\n"]) {
    const content = value.content.match(/.{1,60}/g)!.join(newline) + newline;
    assert.deepEqual(decodeGitConfigFile({ ...value, content }).config, { comment: "日本語の設定", ...config() });
  }
  assert.notEqual(value.size, JSON.stringify({ comment: "日本語の設定", ...config() }).length + 1);
});

test("64KiBのファイルまで受理し、その上限を超えたファイルを拒否する", () => {
  const base = Buffer.from(JSON.stringify(config()));
  const boundary = bytesFile(Buffer.concat([base, Buffer.alloc(MAX_GIT_CONFIG_BYTES - base.length, 0x20)]));
  assert.equal(decodeGitConfigFile(boundary).size, MAX_GIT_CONFIG_BYTES);
  assert.throws(() => decodeGitConfigFile(bytesFile(Buffer.concat([base, Buffer.alloc(MAX_GIT_CONFIG_BYTES + 1 - base.length, 0x20)]))));
});

for (const [name, changes] of [
  ["directory", { type: "dir" }], ["symlink", { type: "symlink" }], ["submodule", { type: "submodule" }],
  ["symlink target", { target: "private-target" }], ["submodule url", { submodule_git_url: "private-submodule" }],
  ["missing name", { name: undefined }], ["different name", { name: "other.json" }], ["different path", { path: "other/vercel.json" }],
  ["relative path", { path: "./vercel.json" }], ["path case", { path: "Vercel.json" }], ["path whitespace", { path: "vercel.json " }],
  ["missing encoding", { encoding: undefined }], ["raw encoding", { encoding: "none" }], ["uppercase encoding", { encoding: "BASE64" }],
  ["missing content", { content: undefined }], ["null content", { content: null }], ["empty content", { content: "" }],
  ["array content", { content: [] }], ["missing size", { size: undefined }], ["string size", { size: "60" }],
  ["zero size", { size: 0 }], ["negative size", { size: -1 }], ["fractional size", { size: 1.5 }],
  ["unsafe size", { size: Number.MAX_SAFE_INTEGER + 1 }], ["over limit size", { size: MAX_GIT_CONFIG_BYTES + 1 }],
  ["size mismatch", { size: 1 }], ["missing sha", { sha: undefined }], ["short sha", { sha: "a".repeat(39) }],
  ["uppercase sha", { sha: "A".repeat(40) }], ["sha mismatch", { sha: "a".repeat(40) }],
] as const) {
  test("Contentsの" + name + "を拒否し応答を例外に含めない", () => {
    assert.throws(() => decodeGitConfigFile({ ...file(), ...changes }), privateError);
  });
}

test("null/array/エラー応答と実内容のplain SHA1をfile証拠にしない", () => {
  const value = file();
  for (const response of [null, undefined, [], {}, { message: "private-error" },
    { ...value, sha: createHash("sha1").update(Buffer.from(value.content, "base64")).digest("hex") }]) {
    assert.throws(() => decodeGitConfigFile(response), privateError);
  }
});

test("期待blobと不一致・不正な期待SHAを拒否する", () => {
  for (const blobSha of ["b".repeat(40), "private-sha", "B".repeat(40), ""]) {
    assert.throws(() => decodeGitConfigFile(file(), { blobSha }), privateError);
  }
});

test("非canonical base64・不正UTF8・壊れたJSON・生成許可configを拒否する", () => {
  const value = file();
  for (const content of [" " + value.content, value.content + "\t", value.content + "\r",
    value.content.replace(/\+/g, "-") + "-", value.content.replace(/=/g, ""),
    value.content + "=", "e31=", "\n".repeat(MAX_GIT_CONFIG_BYTES * 2 + 1)]) {
    assert.throws(() => decodeGitConfigFile({ ...value, content }), privateError);
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("private-json"), Buffer.from("{}"),
    Buffer.from(JSON.stringify(config({ "**": false, main: true, qa1: true })))]) {
    assert.throws(() => decodeGitConfigFile(bytesFile(bytes)), privateError);
  }
});

test("file metadata getterの例外も秘密情報を含めない", () => {
  const value = Object.defineProperty({}, "type", { get() { throw new Error("private-api"); } });
  assert.throws(() => decodeGitConfigFile(value), privateError);
});
