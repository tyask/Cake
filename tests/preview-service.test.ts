import test from 'node:test';
import assert from 'node:assert/strict';
import { config, protocol, type Source } from '../scripts/preview-model';
import { PreviewProvider, type Transport } from '../scripts/preview-provider';
import { PreviewService } from '../scripts/preview-service';
const sha='a'.repeat(40), generation='10000000-0000-4000-8000-000000000001', operation='20000000-0000-4000-8000-000000000002';
const s:Source={pr:71,branch:'codex/test-preview',sha,createdAt:'2026-10-15T00:00:00Z',state:'open'};
function fixture(initial=false) {
  let state='open', lost=false, unknownCreate=false, failDelete=false, deploymentCounter=0;
  const writes:{provider:string,path:string,method:string,body:unknown}[]=[], deployments:Record<string,unknown>[]=[], branches:Record<string,unknown>[]=[], endpoints:Record<string,unknown>[]=[];
  const parent={id:config.neonParentBranchId,project_id:config.neonProjectId};
  const branch={id:'br-child',project_id:config.neonProjectId,name:`preview/${s.branch}`,parent_id:parent.id,default:false,protected:false,created_at:'2026-10-16T00:00:01Z'};
  const endpoint={id:'ep-child',project_id:config.neonProjectId,branch_id:branch.id,type:'read_write',host:'ep-child.ap-southeast-1.aws.neon.tech'};
  const make=(body:Record<string,unknown>,phase:string)=>{
    const value={id:`dpl_test${++deploymentCounter}`,url:`cake-test${deploymentCounter}.vercel.app`,projectId:config.vercelProjectId,target:null,
      gitSource:{type:'github',repoId:config.repositoryId,ref:s.branch,sha},meta:body.meta,
      createdAt:Date.parse('2026-10-16T00:00:00Z'),readyState:phase==='provisioning'?'ERROR':'READY'};
    deployments.push(value);return value;
  };
  const api:Transport=async(provider,path,method='GET',body,missing=false)=>{
    if(method!=='GET')writes.push({provider,path,method,body});
    if(provider==='github') {
      if(path.endsWith('/pulls/71')) return {number:71,state,created_at:s.createdAt,head:{ref:s.branch,sha,repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
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
        return make(value,String(phase));
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
