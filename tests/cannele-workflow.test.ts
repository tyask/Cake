import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Script, runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const workflow = readFileSync(new URL('.github/workflows/cannele-release.yml', root), 'utf8');
const start = workflow.indexOf("node --input-type=module <<'CANNELE_RELEASE_JS'\n");
const end = workflow.indexOf('\n          CANNELE_RELEASE_JS', start);
assert.ok(start > 0 && end > start);
const inline = workflow.slice(start + "node --input-type=module <<'CANNELE_RELEASE_JS'\n".length, end)
  .split('\n').map(line => line.replace(/^ {10}/, '')).filter(line => !line.startsWith('import ')).join('\n');

const instanceId = '00000000-0000-4000-8000-000000000001';
const leaseId = '00000000-0000-4000-8000-000000000042';
const operationId = '00000000-0000-4000-8000-000000000043';
const otherId = '00000000-0000-4000-8000-000000000099';
const sha = 'a'.repeat(40), closedAt = '2026-10-15T10:00:00.000Z';
const prefix = 'codex/cannele-generation/';
function event() {
  return { action: 'closed', repository: { full_name: 'tyask/Cake' }, pull_request: {
    number: 42, state: 'closed', closed_at: closedAt,
    head: { ref: `${prefix}task`, sha, repo: { full_name: 'tyask/Cake' } },
    base: { ref: 'main', repo: { full_name: 'tyask/Cake' } },
  }, inputs: { lease_id: leaseId } };
}
function op(revision = 1, status = 'running') {
  return { operationId, leaseId, kind: 'release', status, revision, step: 'exact_cleanup',
    nextAction: ['succeeded', 'failed'].includes(status) ? 'none' : status === 'blocked_unknown' ? 'inspect' : 'advance',
    ...(status === 'succeeded' ? { result: { lease: { leaseId, state: 'free', slot: 'qa1', version: 7 } } } : {}) };
}
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
interface Call { url: URL; method: string; headers: Headers; body: unknown }
interface HarnessOptions {
  env?: Record<string, string | undefined>;
  event?: unknown;
  eventContents?: string;
  eventReadFailure?: boolean;
  api?: (call: Call, calls: Call[], advanceClock: (milliseconds: number) => void) => Response | Promise<Response>;
}
async function execute(options: HarnessOptions = {}) {
  const env: Record<string, string | undefined> = {
    CAKE_CANNELE_ENABLED: 'true', CANNELE_API_ORIGIN: 'https://cannele.example.invalid', CANNELE_INSTANCE_ID: instanceId,
    CANNELE_FEATURE_BRANCH_PREFIX: prefix, EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: '/event.json',
    REPOSITORY: 'tyask/Cake', CONTROL_REF: 'refs/heads/main', WORKFLOW_REF: 'tyask/Cake/.github/workflows/cannele-release.yml@refs/heads/main',
    RUN_ID: '12345', RUN_ATTEMPT: '1', INPUT_LEASE_ID: leaseId, GITHUB_STEP_SUMMARY: '/summary.md',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions.githubusercontent.com/fixed/job/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'private-runner-request-credential', ...options.env,
  };
  const process = { env, exitCode: 0 };
  const calls: Call[] = [], logs: string[] = [], summaries: string[] = [], waits: number[] = [], timeouts: number[] = [];
  const eventPaths: unknown[] = [];
  let clock = 0, tokens = 0;
  class ClockDate extends Date { static override now() { return clock; } }
  const fetcher = async (input: string | URL, init: RequestInit) => {
    const call: Call = { url: new URL(String(input)), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    if (call.url.hostname === 'run-actions.githubusercontent.com') {
      assert.equal(call.url.searchParams.get('audience'), `urn:cannele:${instanceId}:release`);
      assert.ok(call.headers.get('Authorization') === 'Bearer private-runner-request-credential');
      return json({ value: `mock_header.mock_payload.mock_signature_${++tokens}` });
    }
    assert.equal(call.url.origin, 'https://cannele.example.invalid');
    assert.ok(call.headers.get('Authorization')?.startsWith('Bearer mock_header.mock_payload.mock_signature_'));
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    calls.push(call);
    return options.api ? options.api(call, calls, milliseconds => { clock += milliseconds; }) : json({ operation: op(5, 'succeeded') });
  };
  const script = new Script(`(async () => {\n${inline}\n})()`, { filename: 'cannele-release-inline.mjs' });
  await script.runInNewContext({ process, fetch: fetcher, readFile: async (path: unknown, encoding: unknown) => {
    eventPaths.push(path);
    if (path !== '/event.json' || encoding !== 'utf8' || options.eventReadFailure) throw new Error('private-event-read-error');
    return options.eventContents ?? JSON.stringify(options.event ?? event());
  },
    appendFile: async (_path: string, value: string) => { summaries.push(value); }, createHash,
    delay: async (milliseconds: number) => { waits.push(milliseconds); clock += milliseconds; },
    Date: ClockDate, URL, Response, Headers, Buffer, TextDecoder,
    AbortSignal: { timeout: (milliseconds: number) => { timeouts.push(milliseconds); return new AbortController().signal; } },
    console: { log: (value: unknown) => logs.push(String(value)), error: (value: unknown) => logs.push(String(value)) },
  });
  assert.ok(timeouts.every(value => value > 0 && value <= 60_000));
  assert.ok(waits.every(value => value > 0 && value <= 30_000));
  for (const output of [...logs, ...summaries]) {
    assert.ok(!output.includes('private-runner-request-credential'));
    assert.ok(!output.includes('mock_signature_'));
    assert.ok(!output.includes('private-provider-error'));
    assert.ok(!output.includes('private-event-read-error'));
  }
  return { process, calls, logs, summaries, waits, tokens, clock, eventPaths };
}

test('the actual inline workflow reads the runner event file for closed and dispatch events without an EVENT_PATH alias', async () => {
  assert.doesNotMatch(workflow, /^\s+EVENT_PATH:/m);
  for (const name of ['pull_request_target', 'workflow_dispatch']) {
    const result = await execute({ env: { EVENT_NAME: name } });
    assert.equal(result.process.exitCode, 0);
    assert.deepEqual(result.eventPaths, ['/event.json']);
    assert.equal(result.calls.length, 1);
    assert.ok(result.logs.at(-1)?.includes('返却済み'));
  }
});

test('missing, empty, unavailable and malformed runner event files fail closed before OIDC or API requests', async () => {
  for (const options of [
    { env: { GITHUB_EVENT_PATH: undefined, EVENT_PATH: '/event.json' } },
    { env: { GITHUB_EVENT_PATH: '', EVENT_PATH: '/event.json' } },
    { env: { GITHUB_EVENT_PATH: '/wrong-event.json', EVENT_PATH: '/event.json' } },
    { eventReadFailure: true },
    { eventContents: '{' },
    { eventContents: 'null' },
  ]) {
    const result = await execute(options);
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.tokens, 0);
    assert.equal(result.calls.length, 0);
    assert.ok(result.logs.at(-1)?.includes('(INVALID_EVENT)'));
  }
});

test('the actual inline workflow retries an unknown advance response with the same key and refreshes OIDC per request', async () => {
  let advanced = 0;
  const result = await execute({ api: (call) => {
    if (call.url.pathname === '/v1/prs/42/releases') return json({ operation: op() }, 202);
    if (call.method === 'GET') return json({ operation: op(advanced > 0 ? 3 : 1) });
    if (++advanced === 1) throw new Error('private-provider-error');
    return advanced === 2 ? json({ operation: op(3, 'awaiting_provider') }, 202, { 'retry-after': '2' }) : json({ operation: op(5, 'succeeded') });
  } });
  assert.equal(result.process.exitCode, 0);
  const posts = result.calls.filter(call => call.url.pathname.endsWith('/advance'));
  assert.equal(posts.length, 3);
  assert.equal(posts[0]!.headers.get('Idempotency-Key'), posts[1]!.headers.get('Idempotency-Key'));
  assert.deepEqual(posts[0]!.body, posts[1]!.body);
  assert.notEqual(posts[1]!.headers.get('Idempotency-Key'), posts[2]!.headers.get('Idempotency-Key'));
  assert.equal(result.tokens, result.calls.length);
  assert.ok(result.calls.filter(call => call.method === 'GET').every(call => call.headers.get('Idempotency-Key') === null && call.body === undefined));
  assert.ok(result.summaries.join('').includes('qa1')); assert.ok(result.logs.at(-1)?.includes('返却済み'));
});

test('a closed PR with no lease completes without operation reads or advances', async () => {
  const result = await execute({ api: () => json({ prNumber: 42, sourceSha: sha, closedAt, lease: null }) });
  assert.equal(result.process.exitCode, 0); assert.equal(result.calls.length, 1); assert.ok(result.logs[0]?.includes('貸出なし'));
});

test('a response body lost after admission headers retries the same saved release request', async () => {
  let received = false;
  const result = await execute({ api: () => {
    if (!received) {
      received = true;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-provider-error')); } }),
        { status: 202, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return json({ prNumber: 42, sourceSha: sha, closedAt, lease: null });
  } });
  assert.equal(result.process.exitCode, 0); assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0]!.headers.get('Idempotency-Key'), result.calls[1]!.headers.get('Idempotency-Key'));
  assert.deepEqual(result.calls[0]!.body, result.calls[1]!.body);
});

test('manual recovery sends only the exact lease route and closed reason, without pre-reading another lease', async () => {
  const result = await execute({ env: { EVENT_NAME: 'workflow_dispatch' }, api: () => json({ lease: { leaseId, slot: 'qa2', state: 'free', version: 9 }, operationId }) });
  assert.equal(result.process.exitCode, 0); assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]!.url.pathname, `/v1/leases/${leaseId}/releases`); assert.deepEqual(result.calls[0]!.body, { reason: 'closed' });
});

test('untrusted origins, forks, base branches, prefixes, workflow refs and missing exact dispatch IDs stop before OIDC', async () => {
  const fork = event(); fork.pull_request.head.repo.full_name = 'attacker/fork';
  const base = event(); base.pull_request.base.ref = 'feature';
  const branch = event(); branch.pull_request.head.ref = 'codex/old-generation/task';
  for (const options of [
    { event: fork }, { event: base }, { event: branch }, { env: { CAKE_CANNELE_ENABLED: '' } },
    { env: { CONTROL_REF: 'refs/heads/feature' } }, { env: { WORKFLOW_REF: 'tyask/Cake/.github/workflows/other.yml@refs/heads/main' } },
    { env: { EVENT_NAME: 'workflow_dispatch', INPUT_LEASE_ID: '' } }, { env: { CANNELE_API_ORIGIN: 'http://cannele.example.invalid' } },
    { env: { CANNELE_INSTANCE_ID: 'wrong-instance' } }, { env: { CANNELE_FEATURE_BRANCH_PREFIX: '' } },
  ]) {
    const result = await execute(options);
    assert.equal(result.process.exitCode, 1); assert.equal(result.tokens, 0); assert.equal(result.calls.length, 0);
  }
});

test('blocked inspection stops automatic advance and reports only safe loan and operation identifiers', async () => {
  const result = await execute({ api: () => json({ operation: op(3, 'blocked_unknown') }, 202) });
  assert.equal(result.process.exitCode, 1); assert.equal(result.calls.length, 1);
  assert.ok(result.logs.at(-1)?.includes('RELEASE_BLOCKED_UNKNOWN')); assert.ok(result.summaries.join('').includes(leaseId));
});

test('operation and lease identity changes cannot advance a different cleanup target', async () => {
  for (const changed of [{ operationId: otherId }, { leaseId: otherId }]) {
    const result = await execute({ api: call => call.method === 'POST' ? json({ operation: op() }, 202) : json({ operation: { ...op(), ...changed } }) });
    assert.equal(result.process.exitCode, 1); assert.equal(result.calls.filter(call => call.url.pathname.endsWith('/advance')).length, 0);
  }
});

test('redirects never forward OIDC and oversized provider bodies are never printed', async () => {
  const redirect = await execute({ api: () => new Response('', { status: 302, headers: { location: 'https://attacker.example.invalid/private-provider-error' } }) });
  assert.equal(redirect.process.exitCode, 1); assert.equal(redirect.calls.length, 1); assert.ok(redirect.logs.at(-1)?.includes('API_REDIRECT_REJECTED'));
  const oversized = await execute({ api: () => new Response('x'.repeat(70_000), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) });
  assert.equal(oversized.process.exitCode, 1); assert.ok(oversized.logs.at(-1)?.includes('INVALID_RESPONSE'));
});

test('transient retries and total cleanup time have finite budgets', async () => {
  const unavailable = await execute({ api: () => json({ code: 'UNAVAILABLE' }, 503, { 'retry-after': '999999' }) });
  assert.equal(unavailable.process.exitCode, 1); assert.equal(unavailable.calls.length, 3); assert.deepEqual(unavailable.waits, [30_000, 30_000]);
  let revision = 1;
  const exhausted = await execute({ api: (call, _calls, advanceClock) => {
    if (call.url.pathname === '/v1/prs/42/releases') return json({ operation: op() }, 202);
    if (call.method === 'GET') return json({ operation: op(revision) });
    advanceClock(100_000); revision += 2; return json({ operation: op(revision) }, 202);
  } });
  assert.equal(exhausted.process.exitCode, 1); assert.ok(exhausted.calls.length < 20); assert.ok(exhausted.clock < 700_000);
});

function condition(source: string, name: string) {
  const job = source.slice(source.indexOf(`\n  ${name}:\n`));
  const block = /\n    if: >-\n((?: {6,}[^\n]+\n)+)/.exec(job);
  if (block) return block[1]!.split('\n').map(line => line.trim()).join(' ');
  const single = /\n    if: ([^\n]+)/.exec(job); assert.ok(single); return single[1]!;
}
test('enabling Cannele disables every legacy QA entry and reusable writer while missing flags preserve the old mode', () => {
  const sources = [
    ['qa-registry.yml', 'registry'], ['qa-registry-run.yml', 'registry'], ['qa-pool.yml', 'writer'], ['qa-pool.yml', 'inspect'], ['qa-private-run.yml', 'pool'],
  ] as const;
  const github = { repository: 'tyask/Cake', ref: 'refs/heads/main', event_name: 'workflow_dispatch', event: event() };
  for (const [file, name] of sources) {
    const expression = condition(readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8'), name);
    const base = { github, inputs: { action: name === 'inspect' ? 'preflight' : 'initialize', mode: 'pool' },
      vars: { CAKE_CANNELE_ENABLED: '', CAKE_QA_REGISTRY_ENABLED: file === 'qa-pool.yml' || file === 'qa-private-run.yml' ? '' : 'true', CAKE_QA_POOL_ENABLED: 'true' },
      startsWith: (value: string, prefix: string) => value.startsWith(prefix), fromJSON: JSON.parse, contains: (values: string[], value: string) => values.includes(value) };
    assert.equal(runInNewContext(expression, base), true, `${file}/${name} retains its default mode`);
    assert.equal(runInNewContext(expression, { ...base, vars: { ...base.vars, CAKE_CANNELE_ENABLED: 'true' } }), false);
  }
});

test('the release workflow uses no checkout, package install, provider/database secret, artifact or schedule', () => {
  assert.match(workflow, /types: \[closed\]/); assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /id-token: write/); assert.match(workflow, /lease_id:\s+description:[^\n]+\s+required: true/);
  assert.doesNotMatch(workflow, /uses:|checkout|npm (?:ci|install)|npx|secrets\.|VERCEL_TOKEN|NEON_API_KEY|DATABASE_URL|upload-artifact|schedule:|cron:/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf('        run: |')), /\$\{\{/);
});
