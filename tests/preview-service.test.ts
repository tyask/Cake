import test from 'node:test';
import assert from 'node:assert/strict';
import { config, protocol, type Source } from '../scripts/preview-model';
import { PreviewProvider, type Transport } from '../scripts/preview-provider';
import { boundedApplicationTransport, PreviewService, PreviewUpdateError } from '../scripts/preview-service';
const sha='a'.repeat(40), generation='10000000-0000-4000-8000-000000000001', operation='20000000-0000-4000-8000-000000000002';
const s:Source={pr:71,branch:'codex/test-preview',sha,createdAt:'2026-10-15T00:00:00Z',state:'open'};
function fixture(initial=false) {
  let state='open', lost=false, unknownCreate=false, unknownAfterCreate=false, failDelete=false, deploymentCounter=0, currentSha=sha, applicationState='READY';
  const comparison = { status:'ahead', ahead_by:1, behind_by:0, total_commits:1, base_commit:{sha}, merge_base_commit:{sha},
    commits:[{sha:'b'.repeat(40),parents:[{sha}]}],files:[{filename:'docs/acceptance.md',status:'added'}] };
  const writes:{provider:string,path:string,method:string,body:unknown}[]=[], deployments:Record<string,unknown>[]=[], branches:Record<string,unknown>[]=[], endpoints:Record<string,unknown>[]=[];
  const parent={id:config.neonParentBranchId,project_id:config.neonProjectId};
  const branch={id:'br-child',project_id:config.neonProjectId,name:`preview/${s.branch}`,parent_id:parent.id,default:false,protected:false,created_at:'2026-10-16T00:00:01Z'};
  const endpoint={id:'ep-child',project_id:config.neonProjectId,branch_id:branch.id,type:'read_write',host:'ep-child.ap-southeast-1.aws.neon.tech'};
  const make=(body:Record<string,unknown>,phase:string)=>{
    const value={id:`dpl_test${++deploymentCounter}`,url:`cake-test${deploymentCounter}.vercel.app`,projectId:config.vercelProjectId,target:null,
      gitSource:body.gitSource ?? {type:'github',repoId:config.repositoryId,ref:s.branch,sha},meta:body.meta,
      createdAt:Date.parse('2026-10-16T00:00:00Z'),readyState:phase==='provisioning'?'ERROR':applicationState};
    deployments.push(value);return value;
  };
  const api:Transport=async(provider,path,method='GET',body,missing=false)=>{
    if(method!=='GET')writes.push({provider,path,method,body});
    if(provider==='github') {
      if(path.endsWith('/pulls/71')) return {number:71,state,created_at:s.createdAt,head:{ref:s.branch,sha:currentSha,repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
      if(path.includes('/compare/'))return comparison;
      if(path.endsWith('/branches/main'))return {commit:{sha:'b'.repeat(40)}};
      if(path.includes('/contents/vercel.json'))return {type:'file',encoding:'base64',content:Buffer.from(JSON.stringify({git:{deploymentEnabled:{'**':false,main:true}}})).toString('base64')};
      if(path.endsWith('/tyask/Cake'))return {id:config.repositoryId,full_name:config.repository};
    }
    if(provider==='vercel') {
      if(path.startsWith('/v9/projects/'))return {id:config.vercelProjectId,accountId:config.vercelTeamId,link:{repoId:config.repositoryId}};
      if(path.startsWith('/v6/deployments?'))return {deployments,pagination:{next:null}};
      if(method==='POST') {
        if(unknownCreate)throw new Error('PREVIEW_VERCEL_POST_RESPONSE_UNKNOWN');
        const value=body as Record<string,unknown>,phase=(value.meta as Record<string,unknown>).cakePreviewPhase;
        if(phase==='provisioning'){branches.push(branch);endpoints.push(endpoint);}
        const result=make(value,String(phase));if(unknownAfterCreate)throw new Error('PREVIEW_VERCEL_POST_RESPONSE_UNKNOWN');return result;
      }
      const id=path.split('/').at(-1),index=deployments.findIndex(d=>d.id===id);
      if(method==='DELETE'){if(failDelete)throw new Error('PREVIEW_VERCEL_DELETE_RESPONSE_UNKNOWN');if(index>=0)deployments.splice(index,1);return null;}
      if(index>=0)return deployments[index];if(missing)return null;
    }
    if(provider==='neon') {
      if(path===`/projects/${config.neonProjectId}`)return {project:{id:config.neonProjectId}};
      if(path.endsWith(`/branches/${config.neonParentBranchId}`))return {branch:parent};
      if(path.includes('/branches?'))return {branches:lost?[]:branches,pagination:{}};
      if(path.endsWith('/endpoints'))return {endpoints:lost?[]:endpoints};
      if(method==='DELETE'){branches.length=0;endpoints.length=0;return null;}
      if(path.endsWith('/branches/br-child'))return !lost&&branches.length?{branch}:null;
      if(path.endsWith('/endpoints/ep-child'))return !lost&&endpoints.length?{endpoint}:null;
    }
    throw new Error(`Unexpected test request: ${provider} ${method} ${path}`);
  };
  if(initial){make({meta:{cakePreviewProtocol:protocol,cakePreviewRepository:config.repository,cakePreviewPr:'71',cakePreviewGeneration:generation,cakePreviewOperation:operation,cakePreviewPhase:'provisioning'}},'provisioning');branches.push(branch);endpoints.push(endpoint);}
  return {service:new PreviewService(new PreviewProvider(api),async()=>{}),api,writes,deployments,branches,endpoints,
    comparison, advance:()=>{currentSha='b'.repeat(40);return {...s,sha:currentSha};}, unknownAfter:()=>{unknownAfterCreate=true;},applicationState:(value:string)=>{applicationState=value;},
    close:()=>{state='closed';return {...s,state:'closed' as const};},lose:()=>{lost=true;},unknown:()=>{unknownCreate=true;},failDelete:()=>{failDelete=true;}};
}
test('Native provisioning precedes the application; no DB credential or fixed alias is sent',async()=>{
  const f=fixture();const r=await f.service.deploy(s,operation);
  assert.equal(r.deployment?.state,'READY');assert.equal(r.database?.branchId,'br-child');
  const creates=f.writes.filter(w=>w.method==='POST');assert.equal(creates.length,2);
  const first=creates[0].body as {env:Record<string,string>}, second=creates[1].body as {env:Record<string,string>};
  assert.equal(first.env.CAKE_PREVIEW_DATABASE_HOST_SHA256,'');assert.match(second.env.CAKE_PREVIEW_DATABASE_HOST_SHA256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(creates).includes('CAKE_TEST_DATABASE_URL'));assert.ok(!f.writes.some(w=>w.path.includes('alias')));
  const again=await f.service.deploy(s,'30000000-0000-4000-8000-000000000003');assert.equal(again.deployment?.id,r.deployment?.id);assert.equal(f.writes.length,2);
});
test('an uncertain create is never retried by the same run or a resumed run with no provider evidence',async()=>{
  const f=fixture();f.unknown();await assert.rejects(f.service.deploy(s,operation),/RESPONSE_UNKNOWN/);assert.equal(f.writes.length,1);
  await assert.rejects(f.service.deploy(s,operation,true),/RESULT_UNKNOWN/);assert.equal(f.writes.length,1);
});
test('a surviving Native branch is reused; a missing established DB stops creation',async()=>{
  const f=fixture(true);await f.service.deploy(s,'30000000-0000-4000-8000-000000000003');assert.equal(f.writes.filter(w=>w.method==='POST').length,1);
  f.lose();await assert.rejects(f.service.deploy(s,operation),/DATABASE_LOST/);assert.equal(f.writes.filter(w=>w.method==='POST').length,1);
});
test('cleanup requires closed PR and retains a provider anchor until the exact DB is gone',async()=>{
  const f=fixture();await f.service.deploy(s,operation);
  await assert.rejects(f.service.cleanup(s),/NOT_CLOSED/);
  const closed=f.close();await f.service.cleanup(closed);
  const deletes=f.writes.filter(w=>w.method==='DELETE');assert.equal(deletes.length,3);
  assert.equal(deletes[0].provider,'vercel');assert.equal(deletes[1].provider,'neon');assert.equal(deletes[2].provider,'vercel');
  assert.equal(f.deployments.length,0);assert.equal(f.branches.length,0);
  await f.service.cleanup(closed);assert.equal(f.writes.filter(w=>w.method==='DELETE').length,3);
});
test('uncertain deployment deletion preserves DB and the anchor for recovery',async()=>{
  const f=fixture();await f.service.deploy(s,operation);f.failDelete();await assert.rejects(f.service.cleanup(f.close()),/RESPONSE_UNKNOWN/);
  assert.equal(f.branches.length,1);assert.equal(f.deployments.length,2);assert.ok(!f.writes.some(w=>w.provider==='neon'&&w.method==='DELETE'));
});
test('foreign PR ownership, production deployment and protected parent are rejected without mutation',async()=>{
  for(const change of [{target:'production'},{projectId:'other'},{meta:{}},{gitSource:{type:'github',repoId:config.repositoryId,ref:s.branch,sha:'x'}}]) {
    const f=fixture(true);Object.assign(f.deployments[0],change);await assert.rejects(f.service.deploy(s,operation));assert.equal(f.writes.length,0);
  }
  const f=fixture(true);f.branches[0].id=config.neonParentBranchId;await assert.rejects(f.service.deploy(s,operation),/DATABASE_IDENTITY/);assert.equal(f.writes.length,0);
});

test('bounded update creates exactly one application retaining the original DB/generation and never provisions',async()=>{
  const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
  const result=await f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003');
  assert.equal(result.deployment?.sha,next.sha);assert.equal(result.deployment?.generation,baseline.generation);
  assert.deepEqual(result.database,baseline.database);assert.notEqual(result.deployment?.id,baseline.id);
  const writes=f.writes.slice(before);assert.equal(writes.length,1);assert.equal(writes[0].provider,'vercel');assert.equal(writes[0].method,'POST');
  assert.equal((writes[0].body as {meta:{cakePreviewPhase:string}}).meta.cakePreviewPhase,'application');
});

test('bounded update rejects non-documentation changes, more than one commit, non-descendants and truncated file lists before writes',async()=>{
  for(const change of [ {files:[{filename:'app/page.tsx',status:'modified'}]}, {files:[{filename:'docs/a.md',previous_filename:'vercel.json',status:'renamed'}]},
    {ahead_by:2,total_commits:2}, {total_commits:2}, {merge_base_commit:{sha:'c'.repeat(40)}}, {commits:[{sha:'b'.repeat(40),parents:[{sha:'c'.repeat(40)}]}]},
    {files:[]}, {files:Array.from({length:300},()=>({filename:'docs/a.md',status:'added'}))} ]) {
    const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
    Object.assign(f.comparison,change);
    await assert.rejects(f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'),/DOCS_ONLY/);
    assert.equal(f.writes.length,before);
  }
});

test('bounded update refuses missing resources and unexpected deployments without initial creation',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.deployments.length=0;f.branches.length=0;f.endpoints.length=0;},
    (f:ReturnType<typeof fixture>)=>f.lose(), (f:ReturnType<typeof fixture>)=>{f.deployments.push({...f.deployments[1],id:'dpl_foreign'});},
    (f:ReturnType<typeof fixture>)=>{f.deployments[1].readyState='ERROR';}]) {
    const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;mutate(f);
    await assert.rejects(f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'));
    assert.equal(f.writes.length,before);
  }
});

test('an update POST with unknown response is never resent; GET-only reconcile finds the original application',async()=>{
  const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
  f.unknownAfter();
  await assert.rejects(f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/RESPONSE_UNKNOWN/);assert.ok(!(error instanceof PreviewUpdateError));return true;
  });
  assert.equal(f.writes.length,before+1);
  const recovered=await f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003',true);
  assert.equal(recovered.deployment?.sha,next.sha);assert.equal(f.writes.length,before+1);
  await assert.rejects(f.service.updateOnly(next,baseline,'40000000-0000-4000-8000-000000000004',true));
  assert.equal(f.writes.length,before+1);
});

test('update retains the new deployment immutable metadata from POST through settling',async()=>{
  const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
  const service=new PreviewService(new PreviewProvider(async(provider,path,method='GET',body,missing)=>{
    const result=await f.api(provider,path,method,body,missing);
    return method==='GET'&&path.endsWith('/dpl_test3')?{...(result as Record<string,unknown>),url:'cake-changed.vercel.app'}:result;
  }),async()=>{});
  await assert.rejects(service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'),error=>{
    assert.ok(error instanceof PreviewUpdateError);assert.equal(error.deploymentId,'dpl_test3');assert.equal(error.message,'PREVIEW_UPDATE_FAILED');return true;
  });
  assert.equal(f.writes.length,before+1);
});

test('known ERROR or timeout retains the verified attempted ID; GET reconcile returns the same ID without POST two',async()=>{
  for(const [state,code] of [['ERROR','PREVIEW_BUILD_FAILED'],['BUILDING','PREVIEW_BUILD_TIMEOUT']] as const){
    const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
    f.applicationState(state);
    const exact=(error:unknown)=>{assert.ok(error instanceof PreviewUpdateError);assert.equal(error.deploymentId,'dpl_test3');assert.equal(error.message,code);return true;};
    await assert.rejects(f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'),exact);
    assert.equal(f.writes.length,before+1);
    await assert.rejects(f.service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003',true),exact);
    assert.equal(f.writes.length,before+1);
  }
});

test('unverified response scope never exposes its Deployment ID as an attempted resource',async()=>{
  const f=fixture(),baseline=(await f.service.deploy(s,operation)).deployment!,next=f.advance(),before=f.writes.length;
  const service=new PreviewService(new PreviewProvider(async(provider,path,method='GET',body,missing)=>{
    const result=await f.api(provider,path,method,body,missing);
    return method==='POST'?{...(result as Record<string,unknown>),meta:{...((result as {meta:Record<string,unknown>}).meta),cakePreviewOperation:'40000000-0000-4000-8000-000000000004'}}:result;
  }),async()=>{});
  await assert.rejects(service.updateOnly(next,baseline,'30000000-0000-4000-8000-000000000003'),error=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'PREVIEW_DEPLOYMENT_CHANGED');assert.ok(!(error instanceof PreviewUpdateError));return true;
  });
  assert.equal(f.writes.length,before+1);
});

test('bounded transport reserves before awaiting and blocks parallel writes, wrong bodies and every other mutation',async()=>{
  let posts=0,release:()=>void=()=>{};
  const blocked=new Promise<void>(resolve=>{release=resolve;});const body={fixed:'application'};
  const api=boundedApplicationTransport(async(_provider,_path,method='GET')=>{if(method==='POST')posts++;return null;},body,()=>blocked);
  const first=api('vercel','/v13/deployments?forceNew=1','POST',body);
  await assert.rejects(api('vercel','/v13/deployments?forceNew=1','POST',body),/WRITE_BUDGET/);
  release();await first;assert.equal(posts,1);
  for(const [provider,path,method,payload] of [['neon','/projects/test/branches','POST',body],['vercel','/v13/deployments?forceNew=1','DELETE',body],
    ['vercel','/v13/deployments?forceNew=1','POST',{fixed:'provisioning'}],['github','/repos/test','GET',body]] as const) {
    const fresh=boundedApplicationTransport(async()=>{assert.fail('must not reach transport');},body,async()=>{});
    await assert.rejects(fresh(provider,path,method,payload),/WRITE_BUDGET/);
  }
});
