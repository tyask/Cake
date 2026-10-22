import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { browserCases, browserOptions, BrowserVerificationError, developmentToken, interceptPreviewRequests, verifyBrowser, type BrowserProof, type BrowserVerificationStage } from '../../scripts/preview/preview-browser';
import { config, type Deployment, type Source } from '../../scripts/preview/preview-model';
function oidc(changes={}) {
  return 'header.'+Buffer.from(JSON.stringify({project_id:config.vercelProjectId,owner_id:config.vercelTeamId,environment:'development',exp:Math.floor(Date.now()/1000)+600,...changes})).toString('base64url')+'.signature';
}
test('OIDC must belong to this project/team, development and an unexpired interval',async()=>{
  assert.equal(await developmentToken({VERCEL_OIDC_TOKEN:oidc()}),oidc());
  for(const changes of [{project_id:'other'},{owner_id:'other'},{environment:'production'},{exp:0}]) await assert.rejects(developmentToken({VERCEL_OIDC_TOKEN:oidc(changes)}),/OIDC_UNAVAILABLE/);
});
test('OIDC retrieval accepts a read-only transport and inherited credentials avoid the API',async()=>{
  const calls:unknown[][]=[];
  const token=oidc();
  assert.equal(await developmentToken({},async(...args)=>{calls.push(args);return {env:{VERCEL_OIDC_TOKEN:token}};}),token);
  assert.deepEqual(calls,[['vercel',`/v3/env/pull/${config.vercelProjectId}/development`,'GET']]);
  assert.equal(await developmentToken({VERCEL_OIDC_TOKEN:token},async()=>{throw new Error('must not call provider');}),token);
  await assert.rejects(developmentToken({},async()=>{throw new Error('private-provider-detail');}),error=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'PREVIEW_OIDC_UNAVAILABLE');assert.equal(Object.hasOwn(error,'cause'),false);return true;
  });
});
test('browser process excludes secrets and never receives certificate-ignore switches',()=>{
  const options=browserOptions({PATH:'/bin',VERCEL_TOKEN:'private',VERCEL_OIDC_TOKEN:'private',DATABASE_URL:'private',AUTH_SECRET:'private',NODE_EXTRA_CA_CERTS:'/cloud/ca.crt',HTTPS_PROXY:'http://proxy:8080'});
  assert.ok(!JSON.stringify(options).includes('private'));assert.equal(options.env?.NODE_EXTRA_CA_CERTS,'/cloud/ca.crt');assert.deepEqual(options.proxy,{server:'http://proxy:8080'});
  assert.equal(options.args,undefined);
  assert.throws(()=>browserOptions({NODE_TLS_REJECT_UNAUTHORIZED:'0'}));
});
test('native request interception scopes credentials per redirect hop and rejects business writes',async()=>{
  type Paused={requestId:string;request:{url:string;method:string;headers:Record<string,string>}};
  let handler:(event:Paused)=>Promise<void>=async()=>{};
  const sent:{method:string;params:Record<string,unknown>}[]=[];
  const session={on:(_name:string,callback:typeof handler)=>{handler=callback;},send:async(method:string,params:Record<string,unknown>)=>{sent.push({method,params});}};
  const context={newCDPSession:async()=>session} as unknown as BrowserContext;
  const control=await interceptPreviewRequests(context,{} as Page,'https://cake-unique.vercel.app','test-private-token');
  await handler({requestId:'1',request:{url:'https://cake-unique.vercel.app/',method:'GET',headers:{Accept:'text/html'}}});
  assert.equal(sent.at(-1)?.method,'Fetch.continueRequest');assert.ok(JSON.stringify(sent.at(-1)).includes('test-private-token'));
  await handler({requestId:'2',request:{url:'https://vercel.com/auth',method:'GET',headers:{}}});
  assert.equal(sent.at(-1)?.method,'Fetch.failRequest');assert.ok(!JSON.stringify(sent.at(-1)).includes('test-private-token'));
  await handler({requestId:'3',request:{url:'https://cake-unique.vercel.app/api/app',method:'POST',headers:{}}});
  assert.equal(sent.at(-1)?.method,'Fetch.failRequest');assert.equal(control.blocked(),true);
  await handler({requestId:'4',request:{url:'https://cake-unique.vercel.app/api/auth/callback/test-login',method:'POST',headers:{}}});
  assert.equal(sent.at(-1)?.method,'Fetch.continueRequest');
});

const source:Source={pr:75,branch:'codex/notice-receipt-acceptance',sha:'a'.repeat(40),createdAt:'2026-10-16T00:00:00Z',state:'open'};
const deployment:Deployment={id:'dpl_LocalFixture',url:'https://cake-local-fixture.vercel.app',sha:source.sha,branch:source.branch,pr:source.pr,
  generation:'10000000-0000-4000-8000-000000000001',operation:'20000000-0000-4000-8000-000000000002',phase:'application',state:'READY',createdAt:Date.parse(source.createdAt),
  database:{branchId:'br-local-fixture',endpointId:'ep-local-fixture',hostDigest:'b'.repeat(64)}};
const privateDetail='private-provider-cookie-detail';
function fakeBrowser(fail?:BrowserVerificationStage|'context-close'|'browser-close',alsoFailClose=false) {
  let contextClosures=0,browserClosures=0;
  const failIf=(stage:typeof fail)=>{if(fail===stage)throw new Error(privateDetail);};
  const browser={
    newContext:async()=>{
      let runtimeCalls=0;
      const waitFor=async()=>{};
      const context={
        newCDPSession:async()=>({on:()=>{},send:async()=>{}}),
        newPage:async()=>({
          setDefaultTimeout:()=>{},
          goto:async()=>{failIf('navigation');return {status:()=>200};},
          title:async()=>'Cake',
          url:()=>fail==='boundary'&&runtimeCalls===2?'https://outside.invalid/':deployment.url,
          evaluate:async(_fn:unknown,value:string)=>{
            if(value.length===43){
              runtimeCalls++;failIf(runtimeCalls===1?'runtime-before':'runtime-after');
              return {protocol:config.protocol,nonce:value,deploymentId:deployment.id,pr:source.pr,sha:source.sha,branch:source.branch,
                generation:deployment.generation,database:deployment.database,connectionVerified:true};
            }
            failIf('session-app');return true;
          },
          getByRole:(role:string)=>role==='button'?{click:async()=>{failIf('login');}}:{waitFor},
          locator:()=>({waitFor,getByRole:()=>({click:async()=>{failIf('navigation-clicks');}})}),
          waitForLoadState:async()=>{},screenshot:async()=>{},
        }),
        close:async()=>{contextClosures++;if(alsoFailClose)throw new Error(privateDetail);failIf('context-close');},
      };
      return context;
    },
    close:async()=>{browserClosures++;failIf('browser-close');},
  } as unknown as Browser;
  return {browser,contextClosures:()=>contextClosures,browserClosures:()=>browserClosures};
}
test('browser proof records all twelve observations and preserves the existing sixteen clicks',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cake-browser-proof-')),fixture=fakeBrowser();
  try{
    const proof=await verifyBrowser(source,deployment,directory,{VERCEL_OIDC_TOKEN:oidc()},async()=>fixture.browser);
    assert.equal(proof.success,true);assert.deepEqual(proof.cases,browserCases);assert.equal(proof.clicks.length,16);
    assert.equal(proof.observations?.length,12);
    for(const c of browserCases.filter(c=>c!=='read-api')){
      assert.deepEqual(proof.observations?.filter(o=>o.case===c).map(o=>o.kind),['runtime-before','session-app','runtime-after']);
    }
    for(const event of [...proof.clicks,...proof.observations!])assert.ok(Date.parse(event.at)<=Date.parse(proof.verifiedAt));
    assert.deepEqual(JSON.parse(await readFile(join(directory,'.cake/verification.json'),'utf8')),proof);
    assert.equal(fixture.contextClosures(),4);assert.equal(fixture.browserClosures(),1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('each browser failure exposes only a fixed stage and persists a failed partial proof',async(t)=>{
  const stages:BrowserVerificationStage[]=['oidc','launch','navigation','runtime-before','login','session-app','navigation-clicks','runtime-after','boundary'];
  for(const expected of stages)await t.test(expected,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'cake-browser-failure-')),fixture=fakeBrowser(expected);
    try{
      let failedProof:BrowserVerificationError['proof']|undefined;
      await assert.rejects(verifyBrowser(source,deployment,directory,{VERCEL_OIDC_TOKEN:expected==='oidc'?privateDetail:oidc()},async()=>{
        if(expected==='launch')throw new Error(privateDetail);return fixture.browser;
      }),error=>{
        assert.ok(error instanceof BrowserVerificationError);assert.equal(error.code,'PREVIEW_BROWSER_FAILED');assert.equal(error.message,'PREVIEW_BROWSER_FAILED');
        assert.equal(error.stage,expected);assert.equal(error.proof.success,false);assert.equal(Object.hasOwn(error,'cause'),false);
        assert.ok(!JSON.stringify(error).includes(privateDetail));
        failedProof=error.proof;
        return true;
      });
      const saved:BrowserProof=JSON.parse(await readFile(join(directory,'.cake/verification.json'),'utf8'));assert.deepEqual(saved,failedProof);
      for(const event of [...saved.clicks,...(saved.observations??[])])assert.ok(Date.parse(event.at)<=Date.parse(saved.verifiedAt));
      if(!['oidc','launch'].includes(expected))assert.equal(fixture.browserClosures(),1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
test('cleanup failures cannot return success or replace an earlier safe browser failure',async(t)=>{
  for(const fail of ['context-close','browser-close','navigation'] as const)await t.test(fail,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'cake-browser-close-')),fixture=fakeBrowser(fail,fail==='navigation');
    try{
      await assert.rejects(verifyBrowser(source,deployment,directory,{VERCEL_OIDC_TOKEN:oidc()},async()=>fixture.browser),error=>{
        assert.ok(error instanceof BrowserVerificationError);assert.equal(error.stage,fail==='navigation'?'navigation':'boundary');
        assert.equal(error.proof.success,false);assert.ok(!String(error).includes(privateDetail));return true;
      });
      assert.equal(JSON.parse(await readFile(join(directory,'.cake/verification.json'),'utf8')).success,false);
      assert.equal(fixture.browserClosures(),1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
test('proof storage errors remain safe boundary failures',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cake-browser-storage-'));
  try{
    await writeFile(join(directory,'.cake'),'block-directory');
    await assert.rejects(verifyBrowser(source,deployment,directory,{VERCEL_OIDC_TOKEN:oidc()},async()=>{throw new Error('must not launch');}),error=>{
      assert.ok(error instanceof BrowserVerificationError);assert.equal(error.stage,'boundary');assert.equal(error.proof.success,false);
      assert.equal(error.message,'PREVIEW_BROWSER_FAILED');assert.equal(Object.hasOwn(error,'cause'),false);return true;
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});
