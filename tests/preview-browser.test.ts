import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { browserOptions, developmentToken, interceptPreviewRequests } from '../scripts/preview-browser';
import { config } from '../scripts/preview-model';
function oidc(changes={}) {
  return 'header.'+Buffer.from(JSON.stringify({project_id:config.vercelProjectId,owner_id:config.vercelTeamId,environment:'development',exp:Math.floor(Date.now()/1000)+600,...changes})).toString('base64url')+'.signature';
}
test('OIDC must belong to this project/team, development and an unexpired interval',async()=>{
  assert.equal(await developmentToken({VERCEL_OIDC_TOKEN:oidc()}),oidc());
  for(const changes of [{project_id:'other'},{owner_id:'other'},{environment:'production'},{exp:0}]) await assert.rejects(developmentToken({VERCEL_OIDC_TOKEN:oidc(changes)}),/OIDC_UNAVAILABLE/);
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
