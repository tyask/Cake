import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';
import { interceptCloudRequests } from '../../scripts/cloud/verify-cloud';

const origin = 'http://localhost:3000';
const staleContinuation = 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.';

async function fixture(failure?: { command: string; message: string }, beforeReply?: (name: string) => Promise<void> | undefined) {
  const events = new EventEmitter();
  const commands: Array<{ name: string; params: Record<string, unknown> }> = [];
  let blocked = 0;
  const context = {
    newCDPSession: async () => ({
      on: events.on.bind(events),
      async send(name: string, params: Record<string, unknown>) {
        commands.push({ name, params });
        await beforeReply?.(name);
        if (failure?.command === name && params.errorReason !== 'Failed') throw new Error(failure.message);
      },
    }),
  } as unknown as BrowserContext;
  const verify = await interceptCloudRequests(context, {} as Page, origin, () => { blocked++; });
  return {
    verify,
    commands,
    blocked: () => blocked,
    request: (url: string, networkId?: string) => events.emit('Fetch.requestPaused', {
      requestId: 'interception-1', networkId, request: { url },
    }),
    failed: (requestId: string, canceled: boolean) => events.emit('Network.loadingFailed', { requestId, canceled }),
  };
}

test('Cloud QA は境界判定の待機中に到着した要求の処理も確認する', async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const continuations = [first.promise, second.promise];
  const state = await fixture(undefined, name => name === 'Fetch.continueRequest' ? continuations.shift() : undefined);
  state.request(`${origin}/api/home`, 'network-1');
  const verification = state.verify();
  state.request(`${origin}/api/home`, 'network-2');
  first.resolve();
  await setImmediate();
  second.resolve();
  assert.equal(await verification, true);
});

test('Cloud QA は同一要求の中断を確認できた再開エラーだけを許容する', async () => {
  const failure = { command: 'Fetch.continueRequest', message: staleContinuation };
  const before = await fixture(failure);
  before.failed('network-1', true);
  before.request(`${origin}/api/home`, 'network-1');
  assert.equal(await before.verify(), true);
  assert.deepEqual(before.commands.map(command => command.name), ['Network.enable', 'Fetch.enable', 'Fetch.continueRequest']);

  const after = await fixture(failure);
  after.request(`${origin}/api/home`, 'network-1');
  assert.equal(await after.verify(), false);
  after.failed('network-1', true);
  assert.equal(await after.verify(), true);
  assert.equal(after.blocked(), 0);
});

test('Cloud QA は別要求の中断、ID の欠落、中断以外のエラーを失敗として扱う', async () => {
  const failure = { command: 'Fetch.continueRequest', message: staleContinuation };
  for (const { networkId, canceledId, canceled } of [
    { networkId: 'network-1', canceledId: 'network-2', canceled: true },
    { networkId: undefined, canceledId: 'network-1', canceled: true },
    { networkId: 'network-1', canceledId: 'network-1', canceled: false },
  ]) {
    const state = await fixture(failure);
    state.failed(canceledId, canceled);
    state.request(`${origin}/api/home`, networkId);
    assert.equal(await state.verify(), false);
  }

  const otherError = await fixture({ ...failure, message: 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid parameters' });
  otherError.failed('network-1', true);
  otherError.request(`${origin}/api/home`, 'network-1');
  assert.equal(await otherError.verify(), false);
  assert.deepEqual(otherError.commands.at(-1), {
    name: 'Fetch.failRequest', params: { requestId: 'interception-1', errorReason: 'Failed' },
  });
});

test('Cloud QA は外部通信を遮断し、遮断コマンドのエラーも失敗として扱う', async () => {
  const external = 'https://other.example/redirect';
  const state = await fixture();
  state.request(external, 'network-1');
  assert.equal(await state.verify(), true);
  assert.equal(state.blocked(), 1);
  assert.deepEqual(state.commands.slice(2), [{
    name: 'Fetch.failRequest', params: { requestId: 'interception-1', errorReason: 'BlockedByClient' },
  }]);

  const failure = await fixture({
    command: 'Fetch.failRequest',
    message: 'cdpSession.send: Protocol error (Fetch.failRequest): Invalid InterceptionId.',
  });
  failure.failed('network-1', true);
  failure.request(external, 'network-1');
  assert.equal(await failure.verify(), false);
  assert.equal(failure.blocked(), 1);
  assert.deepEqual(failure.commands.slice(2).map(command => command.name), ['Fetch.failRequest', 'Fetch.failRequest']);
});
