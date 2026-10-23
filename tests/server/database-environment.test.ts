import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { databaseConnectionString, previewDatabaseIdentity } from '../../lib/server/database/database-environment';
const hash = (h:string) => createHash('sha256').update(h).digest('hex');
const preview = { VERCEL_ENV:'preview',AUTH_MODE:'test',CAKE_PREVIEW_PHASE:'application',CAKE_PREVIEW_REPOSITORY:'tyask/Cake',CAKE_PREVIEW_PR:'34',
  CAKE_PREVIEW_GENERATION:'00000000-0000-4000-8000-000000000001',CAKE_PREVIEW_DATABASE_BRANCH_ID:'br-preview',
  VERCEL_GIT_COMMIT_REF:'codex/feature',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40),CAKE_PREVIEW_SOURCE_BRANCH:'codex/feature',CAKE_PREVIEW_SOURCE_SHA:'a'.repeat(40),
  CAKE_TEST_DATABASE_URL:'postgresql://user:private@ep-preview-pooler.ap-southeast-1.aws.neon.tech/cake',
  CAKE_PREVIEW_DATABASE_HOST_SHA256:hash('ep-preview.ap-southeast-1.aws.neon.tech'),CAKE_PREVIEW_PRODUCTION_HOST_SHA256:hash('ep-production.ap-southeast-1.aws.neon.tech') };
test('Preview never falls back to production and requires every ownership field before connecting',()=>{
  assert.equal(databaseConnectionString(preview),preview.CAKE_TEST_DATABASE_URL);
  for(const key of Object.keys(preview).filter(k=>k!=='VERCEL_ENV')) assert.throws(()=>databaseConnectionString({...preview,[key]:undefined,VERCEL_ENV:'preview'}));
  for(const change of [{CAKE_PREVIEW_PHASE:'provisioning'},{CAKE_PREVIEW_REPOSITORY:'other/repo'},{CAKE_PREVIEW_PR:'0'},
    {CAKE_PREVIEW_GENERATION:'wrong'},{CAKE_PREVIEW_DATABASE_BRANCH_ID:'br'},{CAKE_PREVIEW_SOURCE_SHA:'b'.repeat(40)},
    {CAKE_PREVIEW_SOURCE_BRANCH:'main'},{CAKE_PREVIEW_DATABASE_HOST_SHA256:hash('ep-other.example.neon.tech')},
    {CAKE_PREVIEW_PRODUCTION_HOST_SHA256:preview.CAKE_PREVIEW_DATABASE_HOST_SHA256},{DATABASE_URL:preview.CAKE_TEST_DATABASE_URL}]) {
    assert.throws(()=>databaseConnectionString({...preview,...change}),e=>{ assert.match(String(e),/PreviewとDB/);assert.doesNotMatch(String(e),/private|postgresql:\/\//);return true; });
  }
});
test('Preview rejects connection parameter overrides and accepts only required TLS options',()=>{
  for(const suffix of ['?host=production','?options=-c%20search_path=other','?hostaddr=127.0.0.1','?user=other','?sslmode=disable','?sslmode=require&sslmode=require','#private'])
    assert.throws(()=>databaseConnectionString({...preview,CAKE_TEST_DATABASE_URL:preview.CAKE_TEST_DATABASE_URL+suffix}));
  assert.equal(databaseConnectionString({...preview,CAKE_TEST_DATABASE_URL:preview.CAKE_TEST_DATABASE_URL+'?sslmode=require&channel_binding=require'}),preview.CAKE_TEST_DATABASE_URL+'?sslmode=require&channel_binding=require');
});
test('same PR commits preserve identity; another PR, generation or Native branch changes identity',()=>{
  const initial=previewDatabaseIdentity(preview);
  assert.deepEqual(previewDatabaseIdentity({...preview,VERCEL_GIT_COMMIT_SHA:'b'.repeat(40),CAKE_PREVIEW_SOURCE_SHA:'b'.repeat(40)}),initial);
  for(const change of [{CAKE_PREVIEW_PR:'35'},{CAKE_PREVIEW_GENERATION:'00000000-0000-4000-8000-000000000002'},{CAKE_PREVIEW_DATABASE_BRANCH_ID:'br-other'}]) assert.notDeepEqual(previewDatabaseIdentity({...preview,...change}),initial);
});
test('Production and local use DATABASE_URL and reject misplaced Preview metadata',()=>{
  for(const VERCEL_ENV of ['production','development',undefined]) {
    assert.equal(databaseConnectionString({VERCEL_ENV,DATABASE_URL:'configured-db',CAKE_TEST_DATABASE_URL:'unused'}),'configured-db');
    assert.throws(()=>databaseConnectionString({...preview,VERCEL_ENV,DATABASE_URL:'configured-db'}));
  }
});
