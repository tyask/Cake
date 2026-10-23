import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { previewRuntimeProofHandler } from '../../lib/server/preview/preview-runtime-proof';
const digest=createHash('sha256').update('ep-child.ap-southeast-1.aws.neon.tech').digest('hex');
const env={VERCEL_ENV:'preview',AUTH_MODE:'test',CAKE_PREVIEW_PHASE:'application',CAKE_PREVIEW_REPOSITORY:'tyask/Cake',CAKE_PREVIEW_PR:'71',
  CAKE_PREVIEW_GENERATION:'10000000-0000-4000-8000-000000000001',CAKE_PREVIEW_SOURCE_BRANCH:'codex/test',CAKE_PREVIEW_SOURCE_SHA:'a'.repeat(40),
  VERCEL_GIT_COMMIT_REF:'codex/test',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),VERCEL_DEPLOYMENT_ID:'dpl_test',CAKE_PREVIEW_DATABASE_BRANCH_ID:'br-child',
  CAKE_TEST_DATABASE_URL:'postgresql://user:private@ep-child.ap-southeast-1.aws.neon.tech/cake',CAKE_PREVIEW_DATABASE_HOST_SHA256:digest,CAKE_PREVIEW_PRODUCTION_HOST_SHA256:'b'.repeat(64)};
const request=()=>new Request('https://cake-unique.vercel.app/api/qa/preview?nonce='+'a'.repeat(43));
test('runtime proof reads the actual application client and exposes no credentials or rows',async()=>{
  let queries=0;
  const handler=previewRuntimeProofHandler({environment:()=>env,database:()=>({query:async(statement,params)=>{queries++;assert.match(statement,/version = 2/);assert.ok(params.includes(env.CAKE_PREVIEW_GENERATION));return [{verified:1}];}})});
  const r=await handler(request()),d=await r.json();assert.equal(r.status,200);assert.equal(queries,1);assert.equal(d.connectionVerified,true);assert.equal(d.database.hostDigest,digest);
  assert.ok(!JSON.stringify(d).includes('private'));assert.equal(r.headers.get('cache-control'),'no-store');
});
test('Production/invalid ownership never opens the DB client; a missing marker never passes',async()=>{
  let clients=0;
  for(const change of [{VERCEL_ENV:'production'},{CAKE_PREVIEW_GENERATION:'bad'},{CAKE_PREVIEW_DATABASE_HOST_SHA256:'c'.repeat(64)}]) {
    const h=previewRuntimeProofHandler({environment:()=>({...env,...change}),database:()=>{clients++;throw new Error('private');}});
    assert.ok((await h(request())).status>=400);
  }
  assert.equal(clients,0);
  const h=previewRuntimeProofHandler({environment:()=>env,database:()=>({query:async()=>[]})});assert.equal((await h(request())).status,503);
});
