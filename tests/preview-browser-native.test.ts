import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { interceptPreviewRequests } from '../scripts/preview-browser';

test('real Chromium sends the header to the selected origin, blocks redirect hops and business writes',async()=>{
  const secret='local-test-only-token'; let otherOriginRequests=0, authRequests=0, businessRequests=0;
  const external=createServer((_req,res)=>{otherOriginRequests++;res.end('unexpected external origin');});
  await new Promise<void>(r=>external.listen(0,'127.0.0.1',r));
  const externalOrigin=`http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:externalOrigin+'/capture'});res.end();return;}
    if(req.url==='/echo'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({matched:req.headers['x-vercel-trusted-oidc-idp-token']===secret}));return;}
    if(req.url==='/api/auth/callback/test-login')authRequests++;
    if(req.url==='/api/app')businessRequests++;
    res.setHeader('Content-Type','text/html');res.end('<html><body>Local browser fixture</body></html>');
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.CAKE_BROWSER_EXECUTABLE?{executablePath:process.env.CAKE_BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext(),page=await context.newPage();
    const control=await interceptPreviewRequests(context,page,origin,secret);
    assert.equal((await page.goto(origin))?.status(),200);
    assert.equal(await page.evaluate(async()=>{const r=await fetch('/echo');return (await r.json()).matched;}),true);
    assert.equal(await page.evaluate(async()=>{try{await fetch('/api/app',{method:'POST'});return false;}catch{return true;}}),true);
    assert.equal(businessRequests,0);assert.equal(control.blocked(),true);
    await page.evaluate(async()=>{await fetch('/api/auth/callback/test-login',{method:'POST'});});assert.equal(authRequests,1);
    await assert.rejects(page.goto(origin+'/redirect'));
    assert.equal(otherOriginRequests,0);
    await context.close();
  }finally{
    if(browser)await browser.close();
    await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>external.close(()=>r()))]);
  }
});
