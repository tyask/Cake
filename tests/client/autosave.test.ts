import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledge, createAutosaveRequest, saveChanged } from '../../lib/client/autosave';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
for (const editor of ['transaction', 'rule']) {
  test(`${editor}: Enter→blur shares completion and sends once`, async () => {
    const gate = deferred();
    const started = deferred();
    const request = createAutosaveRequest();
    let base = { text: 'old', weights: { a: 1, b: 1 } };
    let draft = { ...base, text: 'new' };
    let posts = 0;
    const operation = () => saveChanged(() => ({ values: draft, base }), async values => {
      posts++; started.resolve(); await gate.promise; return values;
    }, saved => { base = saved; });
    const enter = request(operation);
    await started.promise;
    const blur = request(operation);
    assert.equal(enter, blur);
    gate.resolve(); await blur;
    assert.equal(posts, 1);
    draft = { ...base, weights: { b: 1, a: 1 } };
    await request(operation);
    assert.equal(posts, 1);
  });
  test(`${editor}: edits during save are retained and reverting skips POST`, async () => {
    const gate = deferred(); const started = deferred();
    const request = createAutosaveRequest();
    let base = { text: 'old' }; let draft = { text: 'new' };
    const sent: string[] = [];
    const operation = () => saveChanged(() => ({ values: { ...draft }, base }), async values => {
      sent.push(values.text); started.resolve(); await gate.promise; return values;
    }, saved => { base = saved; });
    const first = request(operation); await started.promise;
    draft = { text: 'later' }; request(operation);
    gate.resolve(); await first;
    assert.deepEqual(sent, ['new', 'later']);
    draft = { text: 'temporary' }; draft = { text: 'later' };
    await request(operation); assert.equal(sent.length, 2);
  });
  test(`${editor}: queue reads latest draft and external base; failure permits retry`, async () => {
    const request = createAutosaveRequest();
    let base = { text: 'old' }; let draft = { text: 'new' }; let failed = true;
    let posts = 0;
    const operation = () => saveChanged(() => ({ values: draft, base }), async values => {
      posts++; if (failed) throw new Error('offline'); return values;
    }, saved => { base = saved; });
    await assert.rejects(request(operation), /offline/);
    assert.equal(draft.text, 'new'); assert.equal(base.text, 'old');
    failed = false; await request(operation); assert.equal(posts, 2);
    const queued = request(operation); base = { text: 'external' }; draft = { text: 'external' };
    await queued; assert.equal(posts, 2);
  });
}
test('acknowledgement bridges old React props and releases when caught up', () => {
  const signature = (value: string) => value;
  const first = acknowledge('old', null, 'saved', signature);
  assert.deepEqual(first, { sources: ['old'], values: 'saved' });
  const second = acknowledge('old', first, 'latest', signature);
  assert.deepEqual(second, { sources: ['old', 'saved'], values: 'latest' });
  assert.equal(acknowledge('latest', second, 'latest', signature), null);
  assert.equal(second?.sources.includes('external'), false);
});

test('revert to the in-flight value coalesces; failure does not auto-retry blur', async () => {
  const request = createAutosaveRequest();
  const gate = deferred(); const started = deferred();
  let base = { text: 'old' }; let draft = { text: 'saved' }; let posts = 0;
  const operation = () => saveChanged(() => ({ values: { ...draft }, base }), async values => {
    posts++; started.resolve(); await gate.promise; return values;
  }, saved => { base = saved; });
  const first = request(operation); await started.promise;
  draft = { text: 'temporary' }; request(operation);
  draft = { text: 'saved' }; request(operation);
  gate.resolve(); await first;
  assert.equal(posts, 1);
  const failing = () => { posts++; return Promise.reject(new Error('offline')); };
  const failure = request(failing); request(failing);
  await assert.rejects(failure, /offline/);
  assert.equal(posts, 2);
});

test('acknowledges inside shared queue before next editor reads the base', async () => {
  let base = { text: 'old' }; const draft = { text: 'new' }; let posts = 0;
  const save = () => saveChanged(() => ({ values: draft, base }), async values => {
    posts++; return values;
  }, saved => { base = saved; });
  const queue = Promise.resolve().then(save).then(save);
  await queue; assert.equal(posts, 1);
});
