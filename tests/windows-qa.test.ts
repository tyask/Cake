import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  brokerArguments,
  csharpVerbatim,
  parseWindowsQaArgs,
  safeWindowsToolEnvironment,
} from '../scripts/windows-qa';
import { parseWindowsQaResult, windowsHelperFailureCodes } from '../scripts/windows-qa-result';
import { windowsQaCodes } from '../scripts/windows-qa-model';

const cwd = resolve('qa-parser-fixture');
const pins = {
  pr: 123,
  sha: 'a'.repeat(40),
  deploymentId: 'dpl_TestDeployment123',
  databaseBranchId: 'br-test-qa-branch',
  generation: '01234567-89ab-4cde-8f01-23456789abcd',
};
const verifyArgs = ['verify', '--pr', String(pins.pr), '--sha', pins.sha,
  '--deployment', pins.deploymentId, '--database', pins.databaseBranchId, '--generation', pins.generation];

test('Windows QA modes have explicit, separate contracts and help needs no credential', () => {
  for (const mode of ['status', 'input', 'preflight', 'self-test'] as const)
    assert.deepEqual(parseWindowsQaArgs([mode], cwd), { mode });
  assert.deepEqual(parseWindowsQaArgs(['--help'], cwd), { mode: 'help' });
  assert.deepEqual(parseWindowsQaArgs(verifyArgs, cwd), { mode: 'verify', targetWorktree: cwd, ...pins });
});

test('verify requires every resource pin, rejects unknown/duplicate arguments and never accepts a branch as SHA', () => {
  const invalid = [[], ['unknown'], ['status', 'extra'], ['--help', 'verify'],
    [...verifyArgs, '--unknown', 'value'], [...verifyArgs, '--pr', '123'],
    [...verifyArgs, '--target-worktree', cwd, '--target-worktree', cwd]];
  for (let index = 1; index < verifyArgs.length; index += 2) {
    invalid.push(verifyArgs.filter((_, position) => position !== index && position !== index + 1));
    invalid.push(verifyArgs.slice(0, index + 1));
  }
  for (const args of invalid) assert.throws(() => parseWindowsQaArgs(args, cwd));
});

test('verify rejects malformed PR, incomplete SHA, URL deployment, unsafe DB name and non-v4 generation', () => {
  const replacements = [
    ['--pr', '0'], ['--pr', '0123'], ['--pr', '-1'], ['--pr', '1e3'],
    ['--pr', String(Number.MAX_SAFE_INTEGER + 1)],
    ['--sha', 'main'], ['--sha', pins.sha.slice(0, -1)], ['--sha', 'A'.repeat(40)],
    ['--deployment', 'https://example.com'], ['--deployment', 'dpl_bad/other'],
    ['--database', 'production'], ['--database', 'br-test; command'],
    ['--generation', '01234567-89ab-1cde-8f01-23456789abcd'],
    ['--generation', '01234567-89ab-4cde-0f01-23456789abcd'],
    ['--generation', `${pins.generation}\n`],
  ];
  for (const [flag, value] of replacements) {
    const args = [...verifyArgs]; args[args.indexOf(flag) + 1] = value;
    assert.throws(() => parseWindowsQaArgs(args, cwd), `${flag}=${value}`);
  }
});

test('status/input/preflight/self-test reject verify pins and target paths rather than ignoring them', () => {
  for (const mode of ['status', 'input', 'preflight', 'self-test']) {
    for (const pair of [['--pr', '123'], ['--sha', pins.sha], ['--deployment', pins.deploymentId],
      ['--database', pins.databaseBranchId], ['--generation', pins.generation], ['--target-worktree', cwd]])
      assert.throws(() => parseWindowsQaArgs([mode, ...pair], cwd), `${mode} ${pair[0]}`);
  }
});

test('worktree paths remain literal argv values, including spaces, apostrophes and shell punctuation', () => {
  const target = join(cwd, "owner's [tasks] & literal $value; example");
  assert.deepEqual(parseWindowsQaArgs([...verifyArgs, '--target-worktree', target], cwd),
    { mode: 'verify', targetWorktree: target, ...pins });
  const relative = "../owner's [tasks] & literal $value; example";
  assert.equal(parseWindowsQaArgs([...verifyArgs, '--target-worktree', relative], cwd).targetWorktree,
    resolve(cwd, relative));
  for (const target of ['bad\0path', 'bad\rpath', 'bad\npath'])
    assert.throws(() => parseWindowsQaArgs([...verifyArgs, '--target-worktree', target], cwd));
});

test('broker arguments do not concatenate a command line or expose target pins to non-QA modes', () => {
  const testRoot = join(cwd, "dummy & owner's $literal");
  assert.deepEqual(brokerArguments('self-test', testRoot), ['--self-test', testRoot]);
  for (const mode of ['status', 'input', 'preflight', 'verify'])
    assert.deepEqual(brokerArguments(mode, testRoot), [`--${mode}`]);
  for (const mode of ['unknown', 'verify --pr 123', '--status', 'input\n'])
    assert.throws(() => brokerArguments(mode, testRoot));
});

test('C# path literals preserve backslashes and shell punctuation without allowing multiline source injection', () => {
  const path = "C:\\Cake owner's [tasks] & $literal\\helper";
  assert.equal(csharpVerbatim(path), `@"${path}"`);
  assert.equal(csharpVerbatim('a"b'), '@"a""b"');
  for (const value of ['path\0value', 'path\rvalue', 'path\nvalue'])
    assert.throws(() => csharpVerbatim(value));
});

test('frontend tool environment drops all credentials, injected runtimes and inherited search paths', () => {
  const environment = {
    SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', LOCALAPPDATA: 'C:\\Profile\\Local',
    HTTPS_PROXY: 'http://proxy.example:8080', NODE_EXTRA_CA_CERTS: 'C:\\trust\\ca.pem',
    PLAYWRIGHT_BROWSERS_PATH: 'C:\\browsers', NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1',
    PATH: 'C:\\untrusted', Path: 'C:\\also-untrusted', PATHEXT: '.EXE;.CMD',
    VERCEL_TOKEN: 'fixture-vercel', VERCEL_OIDC_TOKEN: 'fixture-oidc',
    GH_TOKEN: 'fixture-gh', GITHUB_TOKEN: 'fixture-github', NEON_API_KEY: 'fixture-neon',
    DATABASE_URL: 'fixture-database', CAKE_TEST_DATABASE_URL: 'fixture-test-database',
    AUTH_SECRET: 'fixture-auth', AUTH_URL: 'fixture-auth-url', OPENAI_API_KEY: 'fixture-openai',
    NODE_OPTIONS: '--import unsafe', NODE_PATH: 'C:\\unsafe', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    DEBUG: '*', NODE_DEBUG: '*', PWDEBUG: '1', CAKE_BROWSER_EXECUTABLE: 'C:\\unsafe.exe',
    GH_CONFIG_DIR: 'C:\\alternate-account', GIT_CONFIG_GLOBAL: 'C:\\unsafe-config',
    arbitrary: 'fixture-not-allowlisted',
  };
  const result = safeWindowsToolEnvironment(environment);
  for (const key of ['SystemRoot', 'TEMP', 'LOCALAPPDATA', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS',
    'PLAYWRIGHT_BROWSERS_PATH']) assert.equal(result[key], environment[key as keyof typeof environment]);
  for (const key of ['PATH', 'Path', 'PATHEXT', 'VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'GH_TOKEN',
    'GITHUB_TOKEN', 'NEON_API_KEY', 'DATABASE_URL', 'CAKE_TEST_DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL',
    'OPENAI_API_KEY', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DEBUG', 'NODE_DEBUG',
    'PWDEBUG', 'CAKE_BROWSER_EXECUTABLE', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'arbitrary'])
    assert.equal(result[key], undefined, key);
  assert.equal(environment.VERCEL_TOKEN, 'fixture-vercel');
  assert.equal(environment.PATH, 'C:\\untrusted');
  assert.equal(result.NODE_USE_SYSTEM_CA, '1');
  assert.equal(result.NODE_USE_ENV_PROXY, '1');
  assert.equal(safeWindowsToolEnvironment({ NODE_USE_SYSTEM_CA: '0', NODE_USE_ENV_PROXY: 'yes' }).NODE_USE_SYSTEM_CA, undefined);
  assert.equal(safeWindowsToolEnvironment({ NODE_USE_SYSTEM_CA: '0', NODE_USE_ENV_PROXY: 'yes' }).NODE_USE_ENV_PROXY, undefined);
});

test('checked-in Windows helper runtime is independent of a personal profile, SID, old PR and dated browser cache', () => {
  const helper = new URL('../scripts/windows-token-helper/', import.meta.url);
  const files = readdirSync(helper).filter(name => /\.(?:cs|mjs|manifest)$/.test(name));
  assert.ok(files.length >= 5);
  const sources = [new URL('../scripts/windows-qa.ts', import.meta.url),
    new URL('../scripts/windows-qa-result.ts', import.meta.url),
    new URL('../scripts/windows-qa-child.ts', import.meta.url),
    new URL('../scripts/windows-qa-model.ts', import.meta.url),
    ...files.map(name => new URL(name, helper))];
  for (const source of sources) {
    const text = readFileSync(source, 'utf8');
    assert.doesNotMatch(text, /[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]+/i, source.pathname);
    assert.doesNotMatch(text, /S-1-5-21-\d+-\d+-\d+-\d+/, source.pathname);
    assert.doesNotMatch(text, /\b[a-f0-9]{40}\b/, source.pathname);
    assert.doesNotMatch(text, /(?:pr75|qa75|20261017|2026-10-17|ms-playwright\\+chromium-[0-9]+)/i, source.pathname);
  }
});

const statusResult = () => ({ protocol: 'cake-token-status/v1', success: true, tokenSaved: true,
  aclValidated: true, tokenContentsRead: false, networkRequests: 0 });
const inputResult = () => ({ protocol: 'cake-token-input/v1', success: true, tokenSaved: false,
  tokenContentsRead: false, networkRequests: 0 });
const selfTestNames = ['dpapiRoundTrip', 'ciphertextHasNoDummy', 'ownerOnlyProtectedAcl',
  'duplicateSaveRejectedUnchanged', 'tamperedCipherRejected', 'unsafeAclRejected', 'childDummyMatched',
  'childUnwantedEnvironmentAbsent', 'unsafeEnvironmentFiltered', 'parentTokenPresenceUnchanged',
  'tamperedChildRejectedBeforeDecrypt', 'guiPasswordMasked', 'guiHasNoShowPasswordControl', 'guiHasNoImplicitSave', 'guiPreviewSaved',
  'failedRunnerProofInvalidated', 'existingFailedProofPreserved', 'childResponseSecretsRejected',
  'sandboxProfileRejected', 'normalProfileResolved', 'validVerifyConfigAccepted'];
const selfTestResult = (): Record<string, unknown> => ({ protocol: 'cake-token-selftest/v1', success: true,
  code: 'OK', dummyOnly: true, networkRequests: 0, filesDeleted: false,
  ...Object.fromEntries(selfTestNames.map(key => [key, true])) });
function childResult(mode: 'preflight' | 'verify', success = true) {
  return { protocol: 'cake-windows-qa-child/v1', mode, success, code: success ? 'OK' : 'AUTH_REJECTED',
    oidcProjectMatches: success, oidcOwnerMatches: success,
    oidcDevelopment: success, oidcExpiryValid: success,
    counts: { statusDispatchCount: mode === 'verify' ? 2 : 0, statusReceiptCount: mode === 'verify' ? 2 : 0,
      clickCount: mode === 'verify' ? 16 : 0, caseCount: mode === 'verify' ? 5 : 0,
      observationCount: mode === 'verify' ? 12 : 0, screenshotCount: mode === 'verify' ? 12 : 0, elapsedMs: 1234 } };
}

test('result parser accepts each exact public mode result and returns a separate projection', () => {
  const cases = [['status', statusResult()], ['input', inputResult()], ['self-test', selfTestResult()],
    ['preflight', childResult('preflight')], ['verify', childResult('verify')]] as const;
  for (const [mode, value] of cases) {
    const parsed = parseWindowsQaResult(value, 0, mode);
    assert.deepEqual(parsed, value); assert.notEqual(parsed, value);
    for (const otherMode of ['status', 'input', 'self-test', 'preflight', 'verify'].filter(other => other !== mode))
      assert.throws(() => parseWindowsQaResult(value, 0, otherMode));
  }
  const initial = { ...statusResult(), tokenSaved: false, aclValidated: false };
  assert.deepEqual(parseWindowsQaResult(initial, 0, 'status'), initial);
  const cancelledInput = inputResult();
  assert.deepEqual(parseWindowsQaResult(cancelledInput, 0, 'input'), cancelledInput);
  assert.throws(() => parseWindowsQaResult({ ...statusResult(), aclValidated: false }, 0, 'status'));
});

test('result parser rejects extra fields, missing fields, secret-bearing objects and prototype payloads', () => {
  const cases = [['status', statusResult()], ['input', inputResult()], ['self-test', selfTestResult()],
    ['preflight', childResult('preflight')], ['verify', childResult('verify')]] as const;
  for (const [mode, value] of cases) {
    for (const key of ['token', 'oidc', 'protectedToken', 'path', 'sid', 'stderr', 'extra'])
      assert.throws(() => parseWindowsQaResult({ ...value, [key]: 'fixture-not-a-real-secret' }, 0, mode));
    for (const key of Object.keys(value)) {
      const incomplete: Record<string, unknown> = { ...value }; delete incomplete[key];
      assert.throws(() => parseWindowsQaResult(incomplete, 0, mode), `${mode} missing ${key}`);
    }
    assert.throws(() => parseWindowsQaResult(Object.assign(Object.create({ token: 'fixture' }), value), 0, mode));
  }
  for (const value of [null, undefined, true, 0, 'public-looking-string', [], [statusResult()]])
    assert.throws(() => parseWindowsQaResult(value, 0, 'status'));
});

test('result parser requires exit-code and success agreement and fixed failure codes', () => {
  for (const exitCode of [1, 2, -1, null]) assert.throws(() => parseWindowsQaResult(statusResult(), exitCode, 'status'));
  for (const mode of ['status', 'input', 'self-test', 'preflight', 'verify']) {
    for (const code of windowsHelperFailureCodes) {
      const failure = { protocol: 'cake-token-helper-error/v1', success: false, code };
      assert.deepEqual(parseWindowsQaResult(failure, 1, mode), failure);
      for (const exitCode of [0, 2, null]) assert.throws(() => parseWindowsQaResult(failure, exitCode, mode));
    }
  }
  for (const code of ['OK', 'provider returned fixture-secret', '', 123, { secret: 'fixture' }])
    assert.throws(() => parseWindowsQaResult({ protocol: 'cake-token-helper-error/v1', success: false, code }, 1, 'verify'));
  assert.throws(() => parseWindowsQaResult(statusResult(), 0, 'help'));
});

test('status and input results cannot claim credential reads, network operations or coerced booleans', () => {
  for (const [mode, value] of [['status', statusResult()], ['input', inputResult()]] as const) {
    for (const patch of [{ tokenContentsRead: true }, { tokenContentsRead: 0 }, { networkRequests: 1 },
      { networkRequests: '0' }, { tokenSaved: 'true' }, { success: 1 }])
      assert.throws(() => parseWindowsQaResult({ ...value, ...patch }, 0, mode));
  }
});

test('dummy self-test success requires every safety check and no network, deletion or real input', () => {
  const result = selfTestResult();
  for (const key of selfTestNames) {
    assert.throws(() => parseWindowsQaResult({ ...result, [key]: false }, 0, 'self-test'));
    assert.throws(() => parseWindowsQaResult({ ...result, [key]: 1 }, 0, 'self-test'));
    const failed = { ...result, [key]: false, success: false, code: 'SELF_TEST_FAILED' };
    assert.deepEqual(parseWindowsQaResult(failed, 1, 'self-test'), failed);
  }
  for (const patch of [{ dummyOnly: false }, { networkRequests: 1 }, { filesDeleted: true },
    { code: 'provider fixture-secret' }, { code: { toString: () => 'OK' } }])
    assert.throws(() => parseWindowsQaResult({ ...result, ...patch }, 0, 'self-test'));
  assert.throws(() => parseWindowsQaResult({ ...result, success: false }, 1, 'self-test'));
});

test('child success requires all OIDC identity checks and exact complete QA counts', () => {
  for (const mode of ['preflight', 'verify'] as const)
    for (const key of ['oidcProjectMatches', 'oidcOwnerMatches', 'oidcDevelopment', 'oidcExpiryValid'])
      for (const value of [false, 0, 'true', undefined])
        assert.throws(() => parseWindowsQaResult({ ...childResult(mode), [key]: value }, 0, mode));
  for (const key of ['statusDispatchCount', 'statusReceiptCount', 'clickCount', 'caseCount', 'observationCount', 'screenshotCount']) {
    const result = childResult('verify');
    assert.throws(() => parseWindowsQaResult({ ...result, counts: { ...result.counts, [key]: 0 } }, 0, 'verify'));
    const preflight = childResult('preflight');
    assert.throws(() => parseWindowsQaResult({ ...preflight, counts: { ...preflight.counts, [key]: 1 } }, 0, 'preflight'));
  }
  const failed = childResult('verify', false);
  assert.deepEqual(parseWindowsQaResult(failed, 1, 'verify'), failed);
  assert.throws(() => parseWindowsQaResult({ ...failed, code: 'OK' }, 1, 'verify'));
  assert.throws(() => parseWindowsQaResult({ ...childResult('verify'), code: 'AUTH_REJECTED' }, 0, 'verify'));
});

test('child counts reject overflows, fractions, coercion, missing fields and nested secrets', () => {
  const result = childResult('verify', false);
  const limits = { statusDispatchCount: 2, statusReceiptCount: 2, clickCount: 16, caseCount: 5,
    observationCount: 12, screenshotCount: 12, elapsedMs: 3_600_000 };
  for (const [key, limit] of Object.entries(limits)) {
    for (const value of [-1, 0.5, limit + 1, NaN, Infinity, String(limit), true])
      assert.throws(() => parseWindowsQaResult({ ...result, counts: { ...result.counts, [key]: value } }, 1, 'verify'));
    const counts: Record<string, unknown> = { ...result.counts }; delete counts[key];
    assert.throws(() => parseWindowsQaResult({ ...result, counts }, 1, 'verify'));
  }
  assert.throws(() => parseWindowsQaResult({ ...result, counts: { ...result.counts, token: 'fixture' } }, 1, 'verify'));
  assert.throws(() => parseWindowsQaResult({ ...result, counts: { ...result.counts, statusDispatchCount: 1 } }, 1, 'verify'));
  const projected = parseWindowsQaResult(result, 1, 'verify');
  assert.ok('counts' in projected); assert.notEqual(projected.counts, result.counts);
});

test('public failure codes and dummy-check allowlists stay synchronized with the C# broker', () => {
  const text = readFileSync(new URL('../scripts/windows-token-helper/TokenRunner.cs', import.meta.url), 'utf8');
  function codes(name: string) {
    const section = text.match(new RegExp(`${name} = new HashSet<string>\\([^;]+?\\{([\\s\\S]+?)\\};`));
    assert.ok(section, name);
    return [...section[1].matchAll(/"([A-Z0-9_]+)"/g)].map(match => match[1]).sort();
  }
  assert.deepEqual(codes('ChildCodes'), [...windowsQaCodes].sort());
  assert.deepEqual(codes('FailureCodes'), windowsHelperFailureCodes.filter(code => code !== 'OPERATION_FAILED').sort());
  const selfTests = readFileSync(new URL('../scripts/windows-token-helper/SelfTests.cs', import.meta.url), 'utf8');
  const checks = selfTests.match(/foreach \(string key in new string\[\] \{([\s\S]+?)\}\) result\[key\] = false;/);
  assert.ok(checks);
  assert.deepEqual([...checks[1].matchAll(/"([A-Za-z]+)"/g)].map(match => match[1]).sort(), [...selfTestNames].sort());
});
