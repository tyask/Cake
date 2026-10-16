import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCakeCommand, runPinnedSharedCli } from '../scripts/cannele-command';
import { CanneleIntegrationError, executeConfigurationGit, isCanneleFeatureBranchPrefix, loadReviewedCanneleConfiguration, parseCakeCanneleConfiguration,
  type CakeCanneleConfiguration, type ConfigurationGit } from '../scripts/cannele-config';
import { runStartTask } from '../scripts/start-task';

const profile = {
  origin: 'https://cake-cannele.example.invalid', instanceId: '00000000-0000-4000-8000-000000000001', appId: 'cake', configDigest: 'a'.repeat(64),
  repository: { id: 12345, fullName: 'tyask/Cake' }, baseBranch: 'main', vercelProjectId: 'prj_Z37vquodhpRd08ZTAtYnP0qa59jD',
  vercelTeamId: 'team_D1Mcx2TdFWPKcypfu8KzNMub', neonProjectId: 'misty-meadow-88903426', registrySchemaVersion: 4,
  featureBranchPrefix: 'codex/cannele-v1-', acceptedPrCreatedAfter: '2026-10-15T00:00:00.000Z', requiredFeatures: ['reservation', 'closed_release'],
};
const disabled: CakeCanneleConfiguration = { protocol: 'cake-cannele/v1', enabled: false, sourceRevision: null, profile: null };
function configured(revision = 'b'.repeat(40)): CakeCanneleConfiguration {
  return parseCakeCanneleConfiguration({ protocol: 'cake-cannele/v1', enabled: true, sourceRevision: revision, profile });
}
function rejected(code: string) { return (error: unknown) => error instanceof CanneleIntegrationError && error.code === code; }

test('reviewed configuration comes from freshly fetched origin/main, never the feature checkout', () => {
  const calls: string[][] = [];
  const git: ConfigurationGit = (_cwd, args) => {
    calls.push([...args]);
    if (args[0] === 'fetch') return { status: 0, stdout: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'c'.repeat(40) };
    if (args[0] === 'ls-tree') return { status: 0, stdout: `100644 blob ${'d'.repeat(40)}\tcannele.config.json\n` };
    if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:tyask/Cake.git' };
    if (args[0] === 'show') return { status: 0, stdout: JSON.stringify(configured()) };
    throw new Error('Unexpected fixture Git operation.');
  };
  assert.equal(loadReviewedCanneleConfiguration({ cwd: '/feature/checkout', git }).enabled, true);
  assert.deepEqual(calls[0], ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  assert.ok(calls.some(args => args[0] === 'show' && args[1] === `${'c'.repeat(40)}:cannele.config.json`));
  assert.ok(!calls.some(args => args.includes('HEAD:cannele.config.json')));
});

test('missing main configuration preserves legacy mode; fetch failure and invalid or symlink config never fall back', () => {
  const base: ConfigurationGit = (_cwd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'c'.repeat(40) : '' });
  assert.deepEqual(loadReviewedCanneleConfiguration({ cwd: '/fixture', git: base }), disabled);
  assert.throws(() => loadReviewedCanneleConfiguration({ cwd: '/fixture', git: () => ({ status: 128, stdout: 'private-credential-error' }) }), rejected('CANNELE_GIT_UNAVAILABLE'));
  const symlink: ConfigurationGit = (cwd, args) => args[0] === 'ls-tree' ? { status: 0, stdout: `120000 blob ${'d'.repeat(40)}\tcannele.config.json` } : base(cwd, args);
  assert.throws(() => loadReviewedCanneleConfiguration({ cwd: '/fixture', git: symlink }), rejected('CANNELE_CONFIG_INVALID'));
  for (const value of [
    { ...disabled, enabled: true }, { ...configured(), profile: { ...profile, origin: 'http://insecure.example.invalid' } },
    { ...configured(), profile: { ...profile, repository: { id: 1, fullName: 'attacker/other' } } },
    { ...configured(), profile: { ...profile, secret: 'private-credential' } },
    { ...configured(), profile: { ...profile, featureBranchPrefix: 'codex/unreviewed/generation/' } },
    { ...configured(), sourceRevision: 'main' }, { ...disabled, additional: 'private-credential' },
  ]) assert.throws(() => parseCakeCanneleConfiguration(value), error => {
    assert.ok(error instanceof CanneleIntegrationError); assert.ok(!error.message.includes('private-credential')); return true;
  });
});

test('the prepared public instance profile parses while disabled and when enabled in memory', () => {
  const prepared = JSON.parse(readFileSync(new URL('../cannele.config.json', import.meta.url), 'utf8'));
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.sourceRevision, 'e1ef5058d1c3881ebb554ee8173d045cc7376f91');
  for (const enabled of [false, true]) {
    const config = parseCakeCanneleConfiguration({ ...prepared, enabled });
    assert.equal(config.enabled, enabled); assert.deepEqual(config.profile, prepared.profile);
    assert.equal(config.profile?.instanceId, '34122771-e322-4478-bc7b-96ed363c6c41');
    assert.equal(config.profile?.featureBranchPrefix, 'codex/cannele-34122771-e322-4478-bc7b-96ed363c6c41/');
  }
});

test('nested prefixes belong to exactly the lowercase profile instance and cannot introduce arbitrary paths', () => {
  const instanceId = '34122771-e322-4478-bc7b-96ed363c6c41', featureBranchPrefix = `codex/cannele-${instanceId}/`;
  const nested = { ...profile, instanceId, featureBranchPrefix };
  assert.equal(isCanneleFeatureBranchPrefix(featureBranchPrefix, instanceId), true);
  for (const value of [
    { ...nested, instanceId: '34122771-e322-4478-bc7b-96ed363c6c42' },
    { ...nested, instanceId: instanceId.toUpperCase(), featureBranchPrefix: `codex/cannele-${instanceId.toUpperCase()}/` },
    ...[
      `codex/cannele-${instanceId.toUpperCase()}/`, `Codex/cannele-${instanceId}/`, `codex/cannele-${instanceId}`,
      `codex/cannele-${instanceId}//`, `codex/cannele-${instanceId}/nested/`, `codex/cannele-${instanceId}/../`,
      `codex/cannele-${instanceId}%2f`, `codex/cannele-${instanceId}\\`, `codex/other-${instanceId}/`,
      'codex/../../', `codex/${'a'.repeat(57)}-/`, `${featureBranchPrefix}\n`, 'codex/legacy-\n', null,
    ].map(prefix => ({ ...nested, featureBranchPrefix: prefix })),
  ]) {
    assert.equal(isCanneleFeatureBranchPrefix(value.featureBranchPrefix, value.instanceId), false);
    assert.throws(() => parseCakeCanneleConfiguration({ ...configured(), profile: value }), rejected('CANNELE_CONFIG_INVALID'));
  }
  for (const prefix of ['codex/cannele-v1-', `codex/${'a'.repeat(57)}-`]) {
    assert.equal(isCanneleFeatureBranchPrefix(prefix, instanceId), true);
    assert.equal(parseCakeCanneleConfiguration({ ...configured(), profile: { ...nested, featureBranchPrefix: prefix } }).profile?.featureBranchPrefix, prefix);
  }
  assert.equal(isCanneleFeatureBranchPrefix(`codex/${'a'.repeat(58)}-`, instanceId), false);
});

test('disabled routing preserves existing QA arguments while enabled routing and draft PR creation stay separate', async () => {
  const calls: string[] = [];
  for (const command of ['reserve', 'status', 'publish', 'release', 'verify', 'preview', 'task-pr'] as const) {
    assert.equal(await runCakeCommand({ command, args: ['--legacy-argument'], load: () => disabled,
      runLegacy: async (name, args) => { calls.push(`${name}:${args.join(',')}`); return 0; }, shared: () => { assert.fail('Legacy mode must not load Cannele.'); } }), 0);
  }
  assert.equal(calls.length, 7);
  let shared = false;
  assert.equal(await runCakeCommand({ command: 'preview', load: configured,
    shared: invocation => { shared = true; assert.equal(invocation.configuration.sourceRevision, 'b'.repeat(40)); return 2; },
    runLegacy: async () => { assert.fail('Enabled mode must not dispatch old QA actions.'); } }), 2);
  assert.equal(shared, true);
  assert.equal(await runCakeCommand({ command: 'task-pr', args: ['--draft'], load: configured,
    shared: () => { assert.fail('Draft creation does not require a Cannele session or checkout.'); }, runLegacy: async () => 0 }), 0);
  let legacy = false;
  await assert.rejects(runCakeCommand({ command: 'preview', load: () => { throw new CanneleIntegrationError('CANNELE_CONFIG_INVALID'); },
    runLegacy: async () => { legacy = true; return 0; } }), rejected('CANNELE_CONFIG_INVALID'));
  assert.equal(legacy, false);
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Cake Test', '-c', 'user.email=test@cake.local', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.status, 0); return result.stdout.trim();
}
function checkout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cake-cannele-routing-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'cannele'); const cake = join(root, 'Cake');
  mkdirSync(join(source, 'src/cli'), { recursive: true }); mkdirSync(join(source, 'scripts')); mkdirSync(join(cake, 'scripts'), { recursive: true });
  writeFileSync(join(source, '.gitignore'), 'node_modules/\nsrc/generated/\n');
  writeFileSync(join(source, 'src/cli/index.ts'), 'export {};\n'); writeFileSync(join(source, 'scripts/generate-contracts.ts'), 'export {};\n');
  git(source, 'init', '--initial-branch=main'); git(source, 'add', '.'); git(source, 'commit', '-m', 'reviewed CLI source');
  mkdirSync(join(source, 'node_modules/tsx/dist'), { recursive: true }); writeFileSync(join(source, 'node_modules/tsx/dist/loader.mjs'), 'export {};\n');
  writeFileSync(join(cake, 'scripts/cannele-adapter.mjs'), 'export {};\n');
  return { root, source, cake, configuration: configured(git(source, 'rev-parse', 'HEAD')) };
}

test('pinned invocation regenerates schemas and creates only a private temporary public config, then removes it', t => {
  const f = checkout(t); const stages: string[] = []; let file = '';
  const status = runPinnedSharedCli({ configuration: f.configuration, command: 'preview', args: [], cwd: f.cake,
    environment: { CANNELE_SOURCE_DIR: f.source, VERCEL_TOKEN: 'private-local-credential' },
    launch: (args, cwd, environment, stage) => {
      stages.push(stage); assert.equal(cwd, f.source); assert.ok(!args.join(' ').includes('private-local-credential'));
      assert.equal(environment.VERCEL_TOKEN, 'private-local-credential');
      if (stage === 'generate') { assert.ok(args[2]?.endsWith('scripts/generate-contracts.ts')); return 0; }
      file = args[args.indexOf('--config') + 1]!;
      const config = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(config.protocol, 'cannele-cli/v1'); assert.equal(config.adapterModule, join(f.cake, 'scripts/cannele-adapter.mjs'));
      assert.deepEqual(config.profile, profile); assert.ok(!JSON.stringify(config).includes('private-local-credential'));
      if (process.platform !== 'win32') { assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(dirname(file)).mode & 0o777, 0o700); }
      assert.deepEqual(args.slice(-2), ['qa', 'preview']); return 2;
    } });
  assert.equal(status, 2); assert.deepEqual(stages, ['generate', 'command']); assert.equal(existsSync(file), false); assert.equal(existsSync(dirname(file)), false);
});

test('wrong source revision, dirty source and failed generation cannot run the credential-bearing shared command', t => {
  const f = checkout(t); let launched = false;
  const base = { command: 'status' as const, args: [], cwd: f.cake, environment: { CANNELE_SOURCE_DIR: f.source }, launch: () => { launched = true; return 0; } };
  assert.throws(() => runPinnedSharedCli({ ...base, configuration: { ...f.configuration, sourceRevision: 'f'.repeat(40) } }), rejected('CANNELE_SOURCE_REVISION_MISMATCH'));
  writeFileSync(join(f.source, 'src/cli/index.ts'), 'unreviewed changes\n');
  assert.throws(() => runPinnedSharedCli({ ...base, configuration: f.configuration }), rejected('CANNELE_SOURCE_REVISION_MISMATCH'));
  assert.equal(launched, false);
  git(f.source, 'checkout', '--', 'src/cli/index.ts');
  assert.throws(() => runPinnedSharedCli({ ...base, configuration: f.configuration, launch: (_args, _cwd, _environment, stage) => {
    assert.equal(stage, 'generate'); return 1;
  } }), rejected('CANNELE_GENERATION_FAILED'));
});

test('relative source and Vercel credential-profile paths are pinned to the Cake cwd before either child changes directories', t => {
  const f = checkout(t); const stages: string[] = [];
  const status = runPinnedSharedCli({ configuration: f.configuration, command: 'verify', args: ['--url-kind', 'fixed'], cwd: f.cake,
    environment: { CANNELE_SOURCE_DIR: '../cannele', CANNELE_VERCEL_GLOBAL_CONFIG: '../vercel-profile' },
    launch: (args, cwd, environment, stage) => {
      stages.push(stage); assert.equal(cwd, f.source);
      assert.equal(environment.CANNELE_SOURCE_DIR, f.source);
      assert.equal(environment.CANNELE_VERCEL_GLOBAL_CONFIG, join(f.root, 'vercel-profile'));
      if (stage === 'command') {
        const file = args[args.indexOf('--config') + 1]!;
        const config = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(config.adapterModule, join(f.cake, 'scripts/cannele-adapter.mjs'));
        assert.deepEqual(config.profile, profile);
        assert.equal(args[args.indexOf('--cwd') + 1], f.cake);
      }
      return 0;
    } });
  assert.equal(status, 0); assert.deepEqual(stages, ['generate', 'command']);
});

test('enabled mode rejects old mutating flags before checking source credentials', () => {
  for (const [command, args] of [['reserve', ['--pr', '42']], ['release', ['--lease', 'old']], ['publish', ['--deployment', 'dpl_old']]] as const) {
    assert.throws(() => runPinnedSharedCli({ configuration: configured(), command, args, cwd: '/fixture', environment: {} }), rejected('CANNELE_LEGACY_ARGUMENTS_REJECTED'));
  }
});

test('task startup uses the reviewed main generation prefix while local configuration cannot choose its branch', t => {
  const root = mkdtempSync(join(tmpdir(), 'cake-cannele-start-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote'), cwd = join(root, 'Cake'); mkdirSync(remote);
  git(remote, 'init', '--initial-branch=main'); writeFileSync(join(remote, 'cannele.config.json'), JSON.stringify(configured()));
  git(remote, 'add', '.'); git(remote, 'commit', '-m', 'reviewed enabled config'); git(root, 'clone', remote, cwd);
  writeFileSync(join(cwd, 'cannele.config.json'), JSON.stringify({ ...configured(), profile: { ...profile, featureBranchPrefix: 'codex/attacker-' } }));
  const configurationGit: ConfigurationGit = (directory, args) => args[0] === 'remote' ? { status: 0, stdout: 'https://github.com/tyask/Cake.git' } : executeConfigurationGit(directory, args);
  const task = runStartTask({ args: ['feature'], cwd, environment: {}, installDependencies: () => undefined, log: () => undefined, configurationGit });
  assert.equal(task.branch, 'codex/cannele-v1-feature'); assert.equal(git(task.worktreePath, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'HEAD'));
  assert.ok(readFileSync(join(cwd, 'cannele.config.json'), 'utf8').includes('attacker-'));
  assert.throws(() => runStartTask({ args: ['a'.repeat(60)], cwd, environment: {}, installDependencies: () => undefined, log: () => undefined, configurationGit }), /60文字以内/);
});

test('repository config remains disabled and package QA commands route through the reviewed configuration', () => {
  const root = new URL('../', import.meta.url);
  const config = parseCakeCanneleConfiguration(JSON.parse(readFileSync(new URL('cannele.config.json', root), 'utf8')));
  assert.equal(config.enabled, false); assert.equal(config.profile?.appId, 'cake');
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  for (const name of ['deploy:preview', 'task:pr', 'qa:reserve', 'qa:status', 'qa:publish', 'qa:release', 'qa:verify', 'qa:slots', 'cannele:auth']) assert.ok(pkg.scripts[name].includes('scripts/cannele-command.ts'));
});
