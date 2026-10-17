import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { browserOptions } from '../scripts/preview-browser';
import { interceptRetentionRequests } from '../scripts/preview-retention-browser';
import { retentionPayload } from '../scripts/preview-retention-model';
import { retentionMarker } from './preview-retention-browser-fixture';

test('real Chromium sends one fixed POST, blocks subsequent/redirected writes and never leaks the token across origins', async () => {
  let posts = 0, externalRequests = 0, wrongCredentials = 0;
  const secret = 'local-retention-test-token';
  const external = createServer((_req, res) => { externalRequests++; res.end('unexpected external request'); });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  const externalOrigin = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  const server = createServer((req, res) => {
    if (req.headers['x-vercel-trusted-oidc-idp-token'] !== secret) wrongCredentials++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: externalOrigin }); res.end(); return; }
    if (req.method === 'POST') {
      posts++;
      // A same-origin 307 would repeat the POST if the gate did not consume its
      // allowance before the initial request was sent.
      res.writeHead(307, { Location: '/api/app' }); res.end(); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><body>Local retention boundary fixture</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser;
  try {
    // This fixture only talks to loopback servers. Keep the test process free
    // of inherited provider credentials and external proxy configuration.
    browser = await chromium.launch(browserOptions({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CAKE_BROWSER_EXECUTABLE: process.env.CAKE_BROWSER_EXECUTABLE, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }));
    const context = await browser.newContext(), page = await context.newPage();
    const gate = await interceptRetentionRequests(context, page, origin, retentionMarker, true); gate.authenticate(secret);
    assert.equal((await page.goto(origin))?.status(), 200);
    gate.arm();
    const post = () => page.evaluate(async payload => {
      try { await fetch('/api/app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return false; }
      catch { return true; }
    }, retentionPayload(retentionMarker));
    assert.equal(await post(), true); assert.equal(posts, 1); assert.equal(gate.writeAttempts(), 1);
    assert.equal(await post(), true); assert.equal(posts, 1);
    await assert.rejects(page.goto(origin + '/redirect'));
    assert.equal(externalRequests, 0); assert.equal(wrongCredentials, 0); assert.equal(gate.blocked(), true);
    await context.close();
  } finally {
    if (browser) await browser.close();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => external.close(() => resolve()))]);
  }
});
