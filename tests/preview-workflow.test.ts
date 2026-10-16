import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreviewWorkflow, missingPreviewCredentials } from '../scripts/preview-workflow';
import { PreviewService } from '../scripts/preview-service';
import { PreviewProvider } from '../scripts/preview-provider';
import { config } from '../scripts/preview-model';

test('workflow refuses untrusted ref/event, fork PR and stale source before any provider write',async(t)=>{
  t.mock.method(console,'error',()=>{});
  const directory=await mkdtemp(join(tmpdir(),'cake-preview-event-'));
  const eventPath=join(directory,'event.json');let calls=0;
  const pr={number:71,state:'open',created_at:'2026-10-16T00:00:00Z',head:{ref:'codex/test',sha:'a'.repeat(40),repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
  const service=new PreviewService(new PreviewProvider(async(_provider,_path,method='GET')=>{assert.equal(method,'GET');calls++;return pr;}));
  const env:NodeJS.ProcessEnv={NODE_ENV:'test',VERCEL_TOKEN:'test-only',NEON_API_KEY:'test-only',GITHUB_REPOSITORY:config.repository,GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:`${config.repository}/.github/workflows/preview.yml@refs/heads/main`,GITHUB_EVENT_PATH:eventPath,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'workflow_dispatch'};
  try{
    const event={repository:{full_name:config.repository},inputs:{pr:'71',sha:'b'.repeat(40),action:'deploy',operation:'20000000-0000-4000-8000-000000000002'}};
    await writeFile(eventPath,JSON.stringify(event));
    await assert.rejects(runPreviewWorkflow({...env,GITHUB_REF:'refs/heads/codex/test'},service),/UNTRUSTED_WORKFLOW/);assert.equal(calls,0);
    await assert.rejects(runPreviewWorkflow(env,service),/PR_CHANGED/);assert.equal(calls,1);
    await assert.rejects(runPreviewWorkflow({...env,VERCEL_TOKEN:'',NEON_API_KEY:''},service),/CREDENTIALS_MISSING/);assert.equal(calls,1);
    await writeFile(eventPath,JSON.stringify({repository:{full_name:config.repository},action:'closed',pull_request:{...pr,state:'closed',head:{...pr.head,repo:{full_name:'other/fork'}}}}));
    await assert.rejects(runPreviewWorkflow({...env,GITHUB_EVENT_NAME:'pull_request_target'},service),/UNTRUSTED_EVENT/);assert.equal(calls,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('credential preflight reports both missing names without returning values',()=>{
  assert.deepEqual(missingPreviewCredentials({}),['VERCEL_TOKEN','NEON_API_KEY']);
  assert.deepEqual(missingPreviewCredentials({VERCEL_TOKEN:'private-value',NEON_API_KEY:' '}),['NEON_API_KEY']);
  assert.deepEqual(missingPreviewCredentials({VERCEL_TOKEN:'private-value',NEON_API_KEY:'private-neon'}),[]);
});
