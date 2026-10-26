import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreviewWorkflow, emitPreviewReceipt, missingPreviewCredentials } from '../../scripts/preview/preview-workflow';
import { PreviewService } from '../../scripts/preview/preview-service';
import { PreviewProvider } from '../../scripts/preview/preview-provider';
import { config, protocol, type Source } from '../../scripts/preview/preview-model';
import { parseReceipt, receiptMaxBytes, receiptNoticeTitle } from '../../scripts/preview/preview-receipt';
import { PreviewVerifyService } from '../../scripts/preview/preview-verify-service';
import { parseVerifyReceipt, verifyReceiptNoticeTitle, verifyReceiptProtocol } from '../../scripts/preview/preview-verify-receipt';

test('workflow refuses untrusted ref/event, fork PR and stale source before any provider write',async(t)=>{
  t.mock.method(console,'error',()=>{});
  const directory=await mkdtemp(join(tmpdir(),'cake-preview-event-'));
  const eventPath=join(directory,'event.json');let calls=0;
  const pr={number:71,state:'open',created_at:'2026-10-16T00:00:00Z',head:{ref:'codex/test',sha:'a'.repeat(40),repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
  const service=new PreviewService(new PreviewProvider(async(_provider,_path,method='GET')=>{assert.equal(method,'GET');calls++;return pr;}));
  const env:NodeJS.ProcessEnv={NODE_ENV:'test',VERCEL_TOKEN:'test-only',NEON_API_KEY:'test-only',GITHUB_REPOSITORY:config.repository,GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:`${config.repository}/.github/workflows/preview.yml@refs/heads/main`,GITHUB_EVENT_PATH:eventPath,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'c'.repeat(40),GITHUB_EVENT_NAME:'workflow_dispatch'};
  try{
    const event={repository:{full_name:config.repository},inputs:{pr:'71',sha:'b'.repeat(40),action:'deploy',operation:'20000000-0000-4000-8000-000000000002',controlSha:env.GITHUB_SHA}};
    await writeFile(eventPath,JSON.stringify(event));
    await assert.rejects(runPreviewWorkflow({...env,GITHUB_REF:'refs/heads/codex/test'},service),/UNTRUSTED_WORKFLOW/);assert.equal(calls,0);
    for (const change of [{GITHUB_SHA:undefined},{GITHUB_SHA:'short'},{GITHUB_RUN_ID:'0'},{GITHUB_RUN_ID:'9007199254740992'},
      {GITHUB_RUN_ATTEMPT:'01'},{GITHUB_RUN_ATTEMPT:'1.1'},{GITHUB_RUN_ATTEMPT:'9007199254740992'}]) {
      await assert.rejects(runPreviewWorkflow({...env,...change},service),/UNTRUSTED_WORKFLOW/);assert.equal(calls,0);
    }
    for (const controlSha of [undefined,'short','b'.repeat(40),'d'.repeat(40)]) {
      await writeFile(eventPath,JSON.stringify({...event,inputs:{...event.inputs,controlSha}}));
      await assert.rejects(runPreviewWorkflow({...env,VERCEL_TOKEN:'',NEON_API_KEY:''},service),/UNTRUSTED_WORKFLOW/);assert.equal(calls,0);
    }
    await writeFile(eventPath,JSON.stringify(event));
    await assert.rejects(runPreviewWorkflow(env,service),/PR_CHANGED/);assert.equal(calls,1);
    await assert.rejects(runPreviewWorkflow({...env,VERCEL_TOKEN:'',NEON_API_KEY:''},service),/CREDENTIALS_MISSING/);assert.equal(calls,1);
    await writeFile(eventPath,JSON.stringify({repository:{full_name:config.repository},action:'closed',pull_request:{...pr,state:'closed',head:{...pr.head,repo:{full_name:'other/fork'}}}}));
    await assert.rejects(runPreviewWorkflow({...env,GITHUB_EVENT_NAME:'pull_request_target'},service),/UNTRUSTED_EVENT/);assert.equal(calls,1);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('workflow writes only projected receipt and a separate credential-free step emits exactly one notice',async(t)=>{
  const directory=await mkdtemp(join(tmpdir(),'cake-preview-notice-')),previous=process.cwd();
  const eventPath=join(directory,'event.json'),summary=join(directory,'summary.md');
  const head='a'.repeat(40),operation='20000000-0000-4000-8000-000000000002';
  const raw={number:71,state:'open',created_at:'2026-10-16T00:00:00Z',head:{ref:'codex/test',sha:head,repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
  const source:Source={pr:71,branch:'codex/test',sha:head,createdAt:raw.created_at,state:'open'};
  let method='';
  const service=new PreviewService(new PreviewProvider(async(_provider,_path,httpMethod='GET')=>{assert.equal(httpMethod,'GET');return raw;}));
  const database={branchId:'br-test',endpointId:'ep-test',hostDigest:'b'.repeat(64)};
  const common={protocol,checkedAt:'2026-10-16T00:05:00Z',success:true as const};
  const secret='private-do-not-log';
  t.mock.method(service,'deploy',async(s:Source,op:string,resume?:boolean)=>{
    method='deploy';assert.deepEqual(s,source);assert.equal(op,operation);assert.equal(resume,true);
    return {...common,action:'deploy',source:{...s,private:secret},token:secret,database:{...database,connectionString:secret},deployment:{
      id:'dpl_Test',url:'https://cake-test.vercel.app',sha:head,branch:s.branch,pr:s.pr,generation:operation,operation:op,
      phase:'application' as const,state:'READY',createdAt:Date.parse('2026-10-16T00:02:00Z'),database:{...database,password:secret},env:secret,
    }};
  });
  t.mock.method(service,'status',async(s:Source)=>{method='status';return {...common,action:'status',source:s};});
  t.mock.method(service,'cleanup',async(s:Source)=>{method='cleanup';return {...common,action:'cleanup',source:s};});
  const env:NodeJS.ProcessEnv={NODE_ENV:'test',VERCEL_TOKEN:'test-only',NEON_API_KEY:'test-only',GITHUB_REPOSITORY:config.repository,GITHUB_REF:'refs/heads/main',
    GITHUB_WORKFLOW_REF:`${config.repository}/.github/workflows/preview.yml@refs/heads/main`,GITHUB_EVENT_PATH:eventPath,
    GITHUB_RUN_ID:'38896088643',GITHUB_RUN_ATTEMPT:'2',GITHUB_SHA:'c'.repeat(40),GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_STEP_SUMMARY:summary};
  try{
    process.chdir(directory);
    for(const action of ['deploy','status','cleanup']){
      raw.state=action==='cleanup'?'closed':'open';
      await writeFile(eventPath,JSON.stringify({repository:{full_name:config.repository},inputs:{pr:'71',sha:head,action,operation,controlSha:env.GITHUB_SHA}}));
      await runPreviewWorkflow(env,service);assert.equal(method,action);
      const text=await readFile(join(directory,'preview-result.json'),'utf8'),receipt=parseReceipt(text);
      assert.ok(!text.includes(secret));assert.equal(receipt.action,action);assert.equal(receipt.operation,operation);
      assert.equal(receipt.runAttempt,2);assert.equal(receipt.controlSha,env.GITHUB_SHA);
      const emitted:string[]=[];
      await emitPreviewReceipt(undefined,line=>emitted.push(line));
      assert.equal(emitted.length,1);assert.equal(emitted[0],`::notice title=${receiptNoticeTitle}::${text}`);
    }
    raw.state='closed';
    await writeFile(eventPath,JSON.stringify({repository:{full_name:config.repository},action:'closed',pull_request:raw}));
    await runPreviewWorkflow({...env,GITHUB_EVENT_NAME:'pull_request_target'},service);
    assert.equal(parseReceipt(await readFile(join(directory,'preview-result.json'),'utf8')).operation,null);
    assert.ok(!(await readFile(summary,'utf8')).includes(secret));
    assert.ok(!(await readFile(summary,'utf8')).includes('::notice'));
  }finally{process.chdir(previous);await rm(directory,{recursive:true,force:true});}
});

test('notice step fails without emitting when result file is absent, malformed, masked or oversized',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cake-preview-notice-invalid-')),path=join(directory,'preview-result.json');
  const emitted:string[]=[];
  try{
    await assert.rejects(emitPreviewReceipt(path,line=>emitted.push(line)),/ENOENT/);
    for(const text of ['{"operation":"***"}', '{', ' '.repeat(receiptMaxBytes+1)]){
      await writeFile(path,text);
      await assert.rejects(emitPreviewReceipt(path,line=>emitted.push(line)),/PREVIEW_RECEIPT_(INVALID|TOO_LARGE)/);
    }
    assert.deepEqual(emitted,[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('credential preflight reports both missing names without returning values',()=>{
  assert.deepEqual(missingPreviewCredentials({}),['VERCEL_TOKEN','NEON_API_KEY']);
  assert.deepEqual(missingPreviewCredentials({VERCEL_TOKEN:'private-value',NEON_API_KEY:' '}),['NEON_API_KEY']);
  assert.deepEqual(missingPreviewCredentials({VERCEL_TOKEN:'private-value',NEON_API_KEY:'private-neon'}),[]);
});

test('verify rejects untrusted targets and reruns before provider reads, and erases any stale success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cake-verify-input-')), previous = process.cwd();
  const eventPath = join(directory, 'event.json'), resultPath = join(directory, 'preview-result.json');
  let calls = 0;
  const verifier = new PreviewVerifyService(async () => { calls++; assert.fail('untrusted inputs must not read providers'); });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', VERCEL_TOKEN: 'test-only', NEON_API_KEY: 'test-only', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`, GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const inputs = { action: 'verify', pr: '71', sha: 'a'.repeat(40), operation: '20000000-0000-4000-8000-000000000002', controlSha: env.GITHUB_SHA, deploymentId: 'dpl_Test' };
  try {
    process.chdir(directory);
    for (const changes of [{ deploymentId: undefined }, { deploymentId: 'https://cake-test.vercel.app' }, { deploymentId: 'dpl_Test?other' },
      { pr: '071' }, { pr: '-1' }, { pr: '9007199254740992' }, { sha: 'short' }, { controlSha: 'd'.repeat(40) }]) {
      await writeFile(resultPath, 'stale-success');
      await writeFile(eventPath, JSON.stringify({ repository: { full_name: config.repository }, inputs: { ...inputs, ...changes } }));
      await assert.rejects(runPreviewWorkflow(env, undefined, verifier), /PREVIEW_(VERIFY_INVALID_TARGET|UNTRUSTED_WORKFLOW)/);
      await assert.rejects(readFile(resultPath), /ENOENT/);
    }
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: config.repository }, inputs }));
    await assert.rejects(runPreviewWorkflow({ ...env, GITHUB_RUN_ATTEMPT: '2' }, undefined, verifier), /VERIFY_RERUN_UNSUPPORTED/);
    await assert.rejects(runPreviewWorkflow({ ...env, GITHUB_REF: 'refs/heads/codex/untrusted' }, undefined, verifier), /UNTRUSTED_WORKFLOW/);
    assert.equal(calls, 0);
  } finally { process.chdir(previous); await rm(directory, { recursive: true, force: true }); }
});

test('verify writes a failure receipt before failing the job, and notice is emitted by the credential-free step', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cake-verify-failure-notice-')), previous = process.cwd();
  const eventPath = join(directory, 'event.json'), summaryPath = join(directory, 'summary.md');
  const head = 'a'.repeat(40), operation = '20000000-0000-4000-8000-000000000002';
  const raw = { number: 71, state: 'open', created_at: '2026-10-16T00:00:00Z', head: { ref: 'codex/test', sha: head, repo: { full_name: config.repository } }, base: { ref: 'main', repo: { full_name: config.repository } } };
  let verifies = 0;
  const verifier = new PreviewVerifyService(async (provider, path, method = 'GET', body) => {
    assert.equal(provider, 'github'); assert.match(path, /\/pulls\/71$/); assert.equal(method, 'GET'); assert.equal(body, undefined); return raw;
  });
  t.mock.method(verifier, 'verify', async (source: Source, expectedDeploymentId: string) => {
    verifies++;
    return { protocol: verifyReceiptProtocol, action: 'verify' as const, source, expectedDeploymentId, checkedAt: new Date().toISOString(), success: false,
      failure: { stage: 'preflight' as const, code: 'PREVIEW_VERIFY_STATUS_FAILED' as const }, private: 'must-not-leak' };
  });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', VERCEL_TOKEN: 'test-only', NEON_API_KEY: 'test-only', GITHUB_REPOSITORY: config.repository,
    GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/preview.yml@refs/heads/main`, GITHUB_EVENT_PATH: eventPath,
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'c'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: summaryPath };
  try {
    process.chdir(directory);
    const inputs = { pr: '71', sha: head, action: 'verify', operation, controlSha: env.GITHUB_SHA, deploymentId: 'dpl_Test' };
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: config.repository }, inputs }));
    await assert.rejects(runPreviewWorkflow(env, undefined, verifier), /PREVIEW_VERIFY_STATUS_FAILED/);
    const text = await readFile(join(directory, 'preview-result.json'), 'utf8'), result = parseVerifyReceipt(text);
    assert.equal(result.success, false); assert.equal(result.runAttempt, 1); assert.equal(result.controlSha, env.GITHUB_SHA);
    assert.equal(result.expectedDeploymentId, 'dpl_Test'); assert.equal(result.operation, operation); assert.ok(!text.includes('must-not-leak'));
    const notices: string[] = []; await emitPreviewReceipt(undefined, notice => notices.push(notice));
    assert.deepEqual(notices, [`::notice title=${verifyReceiptNoticeTitle}::${text}`]);
    assert.match(await readFile(summaryPath, 'utf8'), /verify: 失敗/);
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: config.repository }, inputs: { ...inputs, sha: 'b'.repeat(40) } }));
    await assert.rejects(runPreviewWorkflow(env, undefined, verifier), /PR_CHANGED/);
    assert.equal(verifies, 1); await assert.rejects(readFile(join(directory, 'preview-result.json')), /ENOENT/);
  } finally { process.chdir(previous); await rm(directory, { recursive: true, force: true }); }
});

test('verify has a pinned browser container while management stays on the host with main-only permissions and isolated notices', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/preview.yml', import.meta.url), 'utf8');
  const management = workflow.split('\n  preview:\n')[1]?.split('\n  preview-verify:\n')[0];
  const verification = workflow.split('\n  preview-verify:\n')[1];
  assert.ok(management && verification);
  assert.match(workflow, /options: \[deploy, status, cleanup, verify\]/);
  assert.match(workflow, /deploymentId:[\s\S]*?required: false/);
  assert.match(workflow, /concurrency:\s*group: cake-preview-\$\{\{ inputs\.pr \|\| github\.event\.pull_request\.number \}\}\s*cancel-in-progress: false/);
  assert.match(management, /github\.event_name == 'workflow_dispatch' && inputs\.action != 'verify'/);
  assert.match(verification, /github\.event_name == 'workflow_dispatch' && inputs\.action == 'verify'/);
  assert.ok(!management.includes('container:'));
  assert.ok(!workflow.includes('playwright install'));
  assert.ok(!/id-token:|checks: write|pull_request:\s|\bpush:/.test(workflow));
  for (const job of [management, verification]) {
    assert.match(job, /github\.ref == 'refs\/heads\/main'/);
    assert.match(job, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /permissions:\s*contents: read\s*pull-requests: read/);
    const noticeIndex = job.indexOf('- name: Publish public operation receipt notice');
    assert.ok(noticeIndex >= 0);
    const notice = job.slice(noticeIndex);
    assert.ok(!notice.includes('env:')); assert.ok(!notice.includes('TOKEN'));
  }
  assert.match(verification, /if: success\(\) \|\| \(always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.action == 'verify'\)/);
  assert.ok(!workflow.includes('upload-artifact'));

  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const version = lock.packages['node_modules/playwright'].version as string;
  const image = new RegExp(`image: mcr\\.microsoft\\.com/playwright:v${version.replaceAll('.', '\\.')}-noble@sha256:[a-f0-9]{64}`);
  const staging = await readFile(new URL('../../.github/workflows/staging.yml', import.meta.url), 'utf8');
  const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const pinnedImage = ci.match(image)?.[0];
  assert.ok(pinnedImage);
  for (const browserJob of [verification, staging, ci]) {
    assert.equal(browserJob.match(image)?.[0], pinnedImage);
    assert.match(browserJob, /options: --init --user 1001:1001/);
    assert.match(browserJob, /PLAYWRIGHT_BROWSERS_PATH: \/ms-playwright/);
    assert.match(browserJob, /node-version-file: \.node-version/);
    assert.ok(!browserJob.includes('playwright install'));
  }
});
