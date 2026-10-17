import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRetentionService, type RetentionRequest } from '../scripts/preview-retention-service';
import { PreviewService, PreviewUpdateError } from '../scripts/preview-service';
import { config, protocol, type Deployment, type Source } from '../scripts/preview-model';
import { retentionProtocol, type RetentionBrowserResult, type RetentionEvidence } from '../scripts/preview-retention-model';
import { parseRetentionReceipt, serializeRetentionReceipt, type RetentionReceipt, type RetentionResult } from '../scripts/preview-retention-receipt';
import type { Transport } from '../scripts/preview-provider';

const marker='10000000-0000-4000-8000-000000000001',op='40000000-0000-4000-8000-000000000004',control='c'.repeat(40);
const old:Source={pr:75,branch:'codex/acceptance',sha:'a'.repeat(40),createdAt:'2026-10-16T00:00:00Z',state:'open'},next={...old,sha:'b'.repeat(40)};
const database={branchId:'br-child',endpointId:'ep-child',hostDigest:'d'.repeat(64)};
const original:Deployment={id:'dpl_Original',url:'https://cake-original.vercel.app',sha:old.sha,branch:old.branch,pr:75,generation:'20000000-0000-4000-8000-000000000002',
  operation:'30000000-0000-4000-8000-000000000003',phase:'application',state:'READY',createdAt:Date.parse('2026-10-16T01:00:00Z'),database};
const updated:Deployment={...original,id:'dpl_Updated',url:'https://cake-updated.vercel.app',sha:next.sha,operation:marker,createdAt:original.createdAt+1000};
const evidence:RetentionEvidence={marker,workspaceId:'00000000-0000-4000-8000-000000000001',transactionId:'50000000-0000-4000-8000-000000000005',matchingCount:1,amountYen:1234,
  transactionCount:1,totalAmountYen:1234,contentDigest:'a'.repeat(64),collectionDigest:'b'.repeat(64),fixtureDigest:'c'.repeat(64)};
const request=(action:RetentionRequest['action'],id:string,extra:Partial<RetentionRequest>={}):RetentionRequest=>({action,source:old,expectedDeploymentId:original.id,marker,operation:action==='retention-prepare'||action==='retention-update'?marker:op,runId:id,runAttempt:1,controlSha:control,...extra});
function wire(result:RetentionResult,req:RetentionRequest):RetentionReceipt{return parseRetentionReceipt(serializeRetentionReceipt({...result,operation:req.operation,runId:req.runId,runAttempt:1,controlSha:control}));}
function history(req:RetentionRequest){return {id:Number(req.runId),workflow_id:99,head_branch:'main',head_sha:control,event:'workflow_dispatch',run_attempt:1,
  display_title:`Preview ${req.action} PR ${req.source.pr} ${req.operation}`,repository:{id:config.repositoryId,full_name:config.repository},head_repository:{id:config.repositoryId,full_name:config.repository}};}
function harness(t:TestContext){
  let current=original,unknown=false,knownFailure:'PREVIEW_BUILD_FAILED'|'PREVIEW_BUILD_TIMEOUT'|undefined,absent=false,browserCalls=0;
  const receipts=new Map<number,RetentionReceipt>(),missing=new Map<number,RetentionRequest>(),runs:ReturnType<typeof history>[]=[],writes:unknown[]=[];
  const api:Transport=async(provider,path,method='GET',body)=>{
    if(method!=='GET'){assert.equal(provider,'vercel');assert.equal(path,'/v13/deployments?forceNew=1');assert.equal(method,'POST');writes.push(body);current=updated;if(unknown)throw new Error('PREVIEW_VERCEL_POST_RESPONSE_UNKNOWN');return null;}
    assert.equal(provider,'github');
    if(path.endsWith('actions/workflows/preview.yml'))return{id:99,path:'.github/workflows/preview.yml',state:'active',url:`https://api.github.com/repos/${config.repository}/actions/workflows/99`};
    if(path.includes('/runs?'))return{total_count:runs.length,workflow_runs:runs};
    throw new Error('UNEXPECTED_TEST_GET');
  };
  const service=new PreviewRetentionService(api,async(_s,_d,_dir,input)=>{
    browserCalls++;const at=new Date().toISOString();
    return{success:!absent,outcome:absent?'absent':'present',writeAttempts:input.mode==='prepare'?1:0,evidence:absent?undefined:evidence,
      observedAt:at,runtimeBeforeAt:at,runtimeAfterAt:at,...(absent?{failureStage:'read-after' as const}:{})} as RetentionBrowserResult;
  },{receipt:async(_get,id)=>{const r=receipts.get(id);if(!r)throw new Error('PREVIEW_RETENTION_RECEIPT_MISSING');return r;},
    original:async(_get,id)=>{const r=receipts.get(id),req=missing.get(id);if(!r&&!req)throw new Error('MISSING_TEST_RUN');const x=r??req!;
      return{run:{action:x.action,pr:x.source.pr,operation:x.operation,runId:String(id),runAttempt:1,controlSha:control,workflowId:99,status:'completed',conclusion:r?.success?'success':'failure'},...(r?{receipt:r}:{})};}},async()=>{});
  t.mock.method(service.statusService,'status',async(source:Source)=>({protocol,action:'status',source,deployment:current,database,checkedAt:new Date().toISOString(),success:true as const}));
  t.mock.method(PreviewService.prototype,'updateOnly',async function(this:PreviewService,source:Source,baseline:Deployment,operation:string,reconcile=false){
    assert.equal(source.sha,next.sha);assert.deepEqual(baseline,original);assert.equal(operation,marker);
    if(!reconcile)await this.provider.api('vercel','/v13/deployments?forceNew=1','POST',{fixed:'application'});
    if(knownFailure)throw new PreviewUpdateError(updated.id,knownFailure);
    if(current.id!==updated.id)throw new Error('PREVIEW_CREATE_RESULT_UNKNOWN');
    return{protocol,action:'deploy',source,deployment:current,database,checkedAt:new Date().toISOString(),success:true as const};
  });
  return{service,receipts,missing,runs,writes,browserCalls:()=>browserCalls,set:(d:Deployment)=>{current=d;},unknown:()=>{unknown=true;},buildFailure:(code:'PREVIEW_BUILD_FAILED'|'PREVIEW_BUILD_TIMEOUT'='PREVIEW_BUILD_FAILED')=>{knownFailure=code;},absent:()=>{absent=true;}};
}

test('stubbed prepare → one docs update → retained record check uses original notices, same DB and bounded writes',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');f.runs.push(history(prepare));
  const saved=wire(await f.service.run(prepare,{}),prepare);assert.equal(saved.success,true);assert.equal(saved.writeAttempts,1);assert.deepEqual(saved.evidence,evidence);f.receipts.set(10,saved);
  const update=request('retention-update','20',{source:next,baselineRunId:'10'});f.runs.push(history(update));
  const deployed=wire(await f.service.run(update,{}),update);assert.equal(deployed.success,true);assert.equal(deployed.writeAttempts,1);assert.deepEqual(deployed.database,database);f.receipts.set(20,deployed);
  const check=request('retention-check','30',{source:next,expectedDeploymentId:updated.id,baselineRunId:'10',updateRunId:'20'});
  const retained=wire(await f.service.run(check,{}),check);assert.equal(retained.success,true);assert.deepEqual(retained.evidence,saved.evidence);
  assert.equal(retained.writeAttempts,0);assert.equal(f.writes.length,1);assert.equal(f.browserCalls(),2);
});

test('unknown update response consumes its write; GET reconcile and check use the original update chain without another POST',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');f.runs.push(history(prepare));f.receipts.set(10,wire(await f.service.run(prepare,{}),prepare));
  const update=request('retention-update','20',{source:next,baselineRunId:'10'});f.runs.push(history(update));f.unknown();
  const failed=wire(await f.service.run(update,{}),update);assert.equal(failed.success,false);assert.equal(failed.failure?.code,'PREVIEW_RETENTION_UPDATE_UNKNOWN');assert.equal(failed.writeAttempts,1);assert.equal(failed.attemptedDeploymentId,undefined);f.receipts.set(20,failed);
  const recovery=request('retention-reconcile','21',{source:next,baselineRunId:'10',updateRunId:'20'});
  const recovered=wire(await f.service.run(recovery,{}),recovery);assert.equal(recovered.success,true);assert.equal(recovered.writeAttempts,0);f.receipts.set(21,recovered);
  const check=request('retention-check','30',{source:next,expectedDeploymentId:updated.id,baselineRunId:'10',updateRunId:'21'});
  assert.equal((await f.service.run(check,{})).success,true);assert.equal(f.writes.length,1);
});

test('known ERROR/timeout publishes its attempted ID and GET recovery preserves the ID without POST two',async(t)=>{
  for(const code of ['PREVIEW_BUILD_FAILED','PREVIEW_BUILD_TIMEOUT'] as const){
    const f=harness(t),prepare=request('retention-prepare','10');f.runs.push(history(prepare));f.receipts.set(10,wire(await f.service.run(prepare,{}),prepare));
    const update=request('retention-update','20',{source:next,baselineRunId:'10'});f.runs.push(history(update));f.buildFailure(code);
    const failed=wire(await f.service.run(update,{}),update);assert.equal(failed.success,false);assert.equal(failed.writeAttempts,1);
    assert.equal(failed.attemptedDeploymentId,updated.id);assert.equal(failed.failure?.code,code==='PREVIEW_BUILD_FAILED'?'PREVIEW_RETENTION_UPDATE_FAILED':'PREVIEW_RETENTION_UPDATE_UNKNOWN');
    assert.equal(f.writes.length,1);f.receipts.set(20,failed);
    const recovery=request('retention-reconcile','21',{source:next,baselineRunId:'10',updateRunId:'20'});
    const recovered=wire(await f.service.run(recovery,{}),recovery);assert.equal(recovered.success,false);assert.equal(recovered.writeAttempts,0);
    assert.equal(recovered.attemptedDeploymentId,updated.id);assert.equal(f.writes.length,1);
  }
});

test('failed prepare with one uncertain write can become an accepted baseline only through present inspect',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');
  const at=new Date().toISOString();
  f.receipts.set(10,wire({protocol:retentionProtocol,action:prepare.action,source:old,expectedDeploymentId:original.id,marker,outcome:'unknown',writeAttempts:1,
    deployment:original,database,checkedAt:at,success:false,failure:{stage:'write',code:'PREVIEW_RETENTION_WRITE_UNKNOWN'}},prepare));
  const inspect=request('retention-inspect','11',{baselineRunId:'10'}),result=wire(await f.service.run(inspect,{}),inspect);
  assert.equal(result.success,true);assert.deepEqual(result.evidence,evidence);assert.equal(result.writeAttempts,0);assert.equal(f.writes.length,0);
});

test('missing original notice stays uncertain even when GET inspection finds the record, and absent data never authorizes an update',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');f.missing.set(10,prepare);
  const inspect=request('retention-inspect','11',{baselineRunId:'10'});
  const diagnostic=wire(await f.service.run(inspect,{}),inspect);assert.equal(diagnostic.success,false);assert.equal(diagnostic.failure?.code,'PREVIEW_RETENTION_WRITE_UNKNOWN');assert.equal(diagnostic.outcome,'present');assert.equal(f.writes.length,0);
  f.absent();const absent=wire(await f.service.run(inspect,{}),inspect);assert.equal(absent.success,false);assert.equal(absent.outcome,'absent');
});

test('changing source scope, target or original write count cannot authorize update/recovery',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');f.runs.push(history(prepare));const baseline=wire(await f.service.run(prepare,{}),prepare);f.receipts.set(10,baseline);
  for(const extra of [{source:{...next,branch:'codex/other'}},{source:{...next,createdAt:'2026-10-15T00:00:00Z'}},{expectedDeploymentId:'dpl_Other'},{marker:op}]){
    const req=request('retention-update','20',{source:next,baselineRunId:'10',...extra});const r=await f.service.run({...req,operation:req.marker},{});assert.equal(r.success,false);assert.equal(r.failure?.stage,'baseline');
  }
  f.receipts.set(10,{...baseline,success:false,writeAttempts:0,outcome:'unknown',evidence:undefined,failure:{stage:'launch',code:'PREVIEW_RETENTION_BROWSER_FAILED'}});
  const inspect=await f.service.run(request('retention-inspect','11',{baselineRunId:'10'}),{});assert.equal(inspect.success,false);
  assert.equal(f.writes.length,0);
});

test('write replay, changed marker and attempt two stop before browser or provider writes',async(t)=>{
  const f=harness(t),prepare=request('retention-prepare','10');f.runs.push(history(prepare));
  const repeated=request('retention-prepare','11');f.runs.push(history(repeated));
  const replay=await f.service.run(repeated,{});assert.equal(replay.success,false);assert.equal(replay.failure?.code,'PREVIEW_RETENTION_REPLAY');
  const changed=request('retention-prepare','12',{marker:op,operation:op});f.runs.push(history(changed));
  assert.equal((await f.service.run(changed,{})).failure?.code,'PREVIEW_RETENTION_REPLAY');
  await assert.rejects(f.service.run({...prepare,runAttempt:2},{}),/INVALID_REQUEST/);
  assert.equal(f.browserCalls(),0);assert.equal(f.writes.length,0);
});
