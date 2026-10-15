import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { NeonQueryFunction, NeonQueryFunctionInTransaction, NeonQueryInTransaction } from "@neondatabase/serverless";
import { collectReadiness, inspectReadinessDatabase, readinessContext, ReadinessGateway, type PrivateSnapshot, type ReadinessSource } from "../scripts/cannele-readiness";
import type { QaTransport } from "../scripts/qa-pool-writer";
import { registryDdlStatements } from "../scripts/qa-registry-ddl";
import { registryFenceReceipt } from "../scripts/qa-registry-fence";

const revision="a".repeat(40),requestId=randomUUID(),repository="tyask/Cake",project="prj_Z37vquodhpRd08ZTAtYnP0qa59jD",team="team_D1Mcx2TdFWPKcypfu8KzNMub",neonProject="misty-meadow-88903426",parent="br-lively-frog-b3y2mauu";
const workflow=Buffer.from("name: synthetic caller\n"),helper=Buffer.from("name: synthetic helper\n");
const blob=(bytes:Buffer)=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const source:ReadinessSource={revision,workflowBlobSha:blob(workflow),helperBlobSha:blob(helper),canneleRevision:"b".repeat(40)};
const environment={EVENT_NAME:"workflow_dispatch",GITHUB_TOKEN:"synthetic-github-token",VERCEL_TOKEN:"synthetic-vercel-token",NEON_API_KEY:"synthetic-neon-token",GITHUB_REPOSITORY:repository,GITHUB_REF:"refs/heads/main",GITHUB_RUN_ID:"123",
  GITHUB_WORKFLOW_REF:"tyask/Cake/.github/workflows/cannele-readiness.yml@refs/heads/main",GITHUB_WORKFLOW_SHA:revision,QA_TRUSTED_MAIN_SHA:revision,CANNELE_READINESS_EXPECTED_REVISION:revision,CANNELE_READINESS_REQUEST_ID:requestId,
  CAKE_CANNELE_ENABLED:"true",CAKE_QA_POOL_ENABLED:"false",CAKE_QA_REGISTRY_ENABLED:"false",CAKE_QA_PARENT_BRANCH_ID:parent,CAKE_QA_PRODUCTION_DATABASE_HOST:"ep-production-fixture.mock.aws.neon.tech"};
const run={id:123,repository:{full_name:repository},head_repository:{full_name:repository},actor:{id:16447050,type:"User"},triggering_actor:{id:16447050,type:"User"},path:".github/workflows/cannele-readiness.yml",head_branch:"main",head_sha:revision,run_attempt:1,event:"workflow_dispatch",status:"in_progress",
  referenced_workflows:[{path:"tyask/Cake/.github/workflows/cannele-readiness-run.yml@refs/heads/main",sha:revision}]};
const fixtureSnapshot=():PrivateSnapshot=>({hostDigest:"c".repeat(64),deployments:new Set(),branches:new Set(),endpoints:new Set(),hosts:new Set(),summary:{dedicatedIdentity:true,name:"synthetic_registry",hostDigest:"d".repeat(64),postgresVersion:"17.10",catalog:"002",catalogDigest:"e".repeat(64),stateDigest:"f".repeat(64),fence:{mode:"legacy",epoch:1,receiptRevision:revision},
  roleCapabilities:{login:true,superuser:false,createRole:true,createDatabase:false,replication:false,bypassRls:false,ownsDatabase:true,ownsLegacySchema:true,schemaOwnerMember:true,publicSchemaCreateForPublic:false,hasMembership:false},otherSessions:0,
  slots:["qa1","qa2","qa3"].map(slot=>({slot,state:"free",version:0})),allSlotsFree:true,requestsSettled:true,leasesSettled:true,historicalRows:0}});

type Options={run?:Record<string,unknown>;main?:string;orphan?:boolean;taggedProduction?:boolean;vercelPagination?:Record<string,unknown>;neonPagination?:Record<string,unknown>;total?:unknown;calls?:string[]};
function transport(options:Options={}):QaTransport{
  return async(method,address,token)=>{
    assert.equal(method,"GET");const url=new URL(address);const path=url.pathname;options.calls?.push(address);
    assert.ok(!path.includes("/deployments") || url.hostname!=="api.github.com","Never reads the GitHub Deployment ledger");
    if(url.hostname==="api.github.com"){
      assert.equal(token,"synthetic-github-token");
      if(path===`/repos/${repository}`)return{status:200,data:{id:1318171856,full_name:repository,owner:{id:16447050,type:"User"}}};
      if(path.endsWith("/actions/runs/123"))return{status:200,data:options.run??run};
      if(path.endsWith("/branches/main"))return{status:200,data:{commit:{sha:options.main??revision}}};
      if(path.includes("/contents/")){const bytes=path.endsWith("cannele-readiness-run.yml")?helper:workflow;return{status:200,data:{type:"file",encoding:"base64",sha:blob(bytes),content:bytes.toString("base64")}};}
      if(path.endsWith("/runs"))return{status:200,data:{total_count:options.total===undefined?0:options.total,workflow_runs:[]}};
      assert.fail("Unexpected GitHub read");
    }
    if(url.hostname==="api.vercel.com"){
      assert.equal(token,"synthetic-vercel-token");
      if(path===`/v9/projects/${project}`)return{status:200,data:{id:project,accountId:team,link:{type:"github",repoId:1318171856,org:"tyask",repo:"Cake"}}};
      if(path.startsWith("/v4/aliases/"))return{status:404,data:null};
      if(path==="/v6/deployments")return{status:200,data:{deployments:[{uid:"dpl_production"},...(options.orphan?[{uid:"dpl_orphan"}]:[])],pagination:options.vercelPagination??{next:null}}};
      if(path==="/v13/deployments/dpl_production")return{status:200,data:{id:"dpl_production",projectId:project,accountId:team,target:"production",qaTagged:options.taggedProduction??false,meta:{}}};
      if(path==="/v13/deployments/dpl_orphan")return{status:200,data:{id:"dpl_orphan",projectId:project,target:null,meta:{githubCommitRef:"preview"}}};
      if(path.startsWith("/v13/deployments/dpl_historical"))return{status:404,data:null};
      assert.fail("Unexpected Vercel read");
    }
    assert.equal(url.hostname,"console.neon.tech");assert.equal(token,"synthetic-neon-token");
    if(path===`/api/v2/projects/${neonProject}`)return{status:200,data:{project:{id:neonProject,name:"cake-preview"}}};
    const branch={id:parent,project_id:neonProject,parent_id:null,name:"parent",default:true,protected:true};
    if(path===`/api/v2/projects/${neonProject}/branches/${parent}`)return{status:200,data:{branch}};
    if(path===`/api/v2/projects/${neonProject}/branches`)return{status:200,data:{branches:[branch],...(options.neonPagination?{pagination:options.neonPagination}:{})}};
    if(path===`/api/v2/projects/${neonProject}/endpoints`)return{status:200,data:{endpoints:[{id:"ep-qa-parent",project_id:neonProject,branch_id:parent,host:"ep-qa-parent.mock.aws.neon.tech"}]}};
    if(path.endsWith("/branches/br-historical")||path.endsWith("/endpoints/ep-historical"))return{status:404,data:null};
    assert.fail("Unexpected Neon read");
  };
}

test("owner/main/caller/helper provenance must pass before any DB or provider access",async()=>{
  for(const changes of [{GITHUB_WORKFLOW_REF:"tyask/Cake/.github/workflows/other.yml@refs/heads/main"},{GITHUB_WORKFLOW_SHA:"b".repeat(40)},{GITHUB_REF:"refs/heads/codex/foreign"},{CANNELE_READINESS_REQUEST_ID:"bad"}]){
    let db=0;const calls:string[]=[];
    await assert.rejects(collectReadiness({...environment,...changes},{source,transport:transport({calls}),database:async()=>{db++;return fixtureSnapshot();}}),/private details suppressed/);
    assert.equal(db,0);assert.equal(calls.length,0);
  }
  for(const change of [{actor:{id:999,type:"User"}},{triggering_actor:{id:999,type:"User"}},{path:".github/workflows/other.yml"},{run_attempt:2},{status:"completed"},{referenced_workflows:[]},
    {referenced_workflows:[{path:"other/Cake/.github/workflows/cannele-readiness-run.yml@main",sha:revision}]}]){
    let db=0;const calls:string[]=[];
    await assert.rejects(collectReadiness(environment,{source,transport:transport({run:{...run,...change},calls}),database:async()=>{db++;return fixtureSnapshot();}}));
    assert.equal(db,0);assert.equal(calls.every(address=>new URL(address).hostname==="api.github.com"),true);
  }
  let db=0;await assert.rejects(collectReadiness(environment,{source,transport:transport({main:"b".repeat(40)}),database:async()=>{db++;return fixtureSnapshot();}}));assert.equal(db,0);
});

test("exact SQL inventory proof produces a closed public receipt without hosts, credentials, role names or raw provider data",async()=>{
  const receipt=await collectReadiness(environment,{source,transport:transport(),database:async()=>fixtureSnapshot()});
  assert.equal(receipt.observedConditionsSatisfied,true);assert.equal(receipt.externalActorAndCredentialDrain,"unconfirmed");
  assert.deepEqual(receipt.database?.slots.map(slot=>slot.slot),["qa1","qa2","qa3"]);assert.equal(receipt.providers?.neon.parentId,parent);
  const output=JSON.stringify(receipt);
  for(const secret of ["synthetic-github-token","synthetic-vercel-token","synthetic-neon-token",environment.CAKE_QA_PRODUCTION_DATABASE_HOST,"ep-qa-parent.mock.aws.neon.tech","neondb_owner","postgresql://","https://","meta","githubCommitRef"]){assert.equal(output.includes(secret),false);}
  assert.deepEqual(Object.keys(receipt).sort(),["protocol","requestId","source","run","checkedAt","context","database","providers","legacyRuns","observedConditionsSatisfied","externalActorAndCredentialDrain","blockers"].sort());
});

test("an untracked Preview or qaTagged Production is a blocker, with safe current deployment ID",async()=>{
  for(const options of [{orphan:true},{taggedProduction:true}]){
    const receipt=await collectReadiness(environment,{source,transport:transport(options),database:async()=>fixtureSnapshot()});
    assert.equal(receipt.observedConditionsSatisfied,false);assert.ok(receipt.blockers.includes("PROVIDER_RESOURCES_PRESENT"));
    assert.equal(receipt.providers?.deployments.nonProductionOrQaTagged,1);
    assert.deepEqual(receipt.providers?.deployments.blockerIds,options.orphan?["dpl_orphan"]:["dpl_production"]);
  }
});

test("partial or unknown provider pagination and malformed total counts never become empty-inventory proof",async()=>{
  for(const options of [{vercelPagination:{next:null,cursor:"remaining"}},{neonPagination:{next:null,next_cursor:"remaining"}},... [null,"",false].map(total=>({total}))]){
    const receipt=await collectReadiness(environment,{source,transport:transport(options),database:async()=>fixtureSnapshot()});
    assert.equal(receipt.observedConditionsSatisfied,false);assert.ok(receipt.blockers.some(code=>["READINESS_RESPONSE_INVALID","READINESS_INVENTORY_INCOMPLETE"].includes(code)));
  }
});

test("nonfree SQL slots and unconfirmed DB/provider reads remain blocked; old ledger cannot substitute",async()=>{
  const value=fixtureSnapshot();value.summary.slots[0].state="reserved";value.summary.allSlotsFree=false;value.summary.leasesSettled=false;
  const occupied=await collectReadiness(environment,{source,transport:transport(),database:async()=>value});
  assert.ok(occupied.blockers.includes("REGISTRY_POOL_OCCUPIED"));assert.ok(occupied.blockers.includes("REGISTRY_HISTORY_UNSETTLED"));
  const unknown=await collectReadiness(environment,{source,transport:transport(),database:async()=>{throw new Error("private database error postgresql://user:secret@host/db");}});
  assert.equal(unknown.database,null);assert.equal(unknown.providers,null);assert.equal(unknown.observedConditionsSatisfied,false);
  assert.doesNotMatch(JSON.stringify(unknown),/private database|postgresql|secret@host/);
  assert.throws(()=>readinessContext({...environment,CAKE_QA_POOL_ENABLED:"FALSE"}));
  await assert.rejects(new ReadinessGateway(environment,transport()).providers(fixtureSnapshot(),readinessContext(environment)));
});

const legacyDdl=readFileSync(new URL("../db/qa-registry/001_registry.sql",import.meta.url),"utf8"),fenceDdl=readFileSync(new URL("../db/qa-registry/002_cannele_fence.sql",import.meta.url),"utf8");
const databaseUrl=process.env.CAKE_REGISTRY_FENCE_TEST_DATABASE_URL;
if(!databaseUrl&&process.env.CAKE_REGISTRY_FENCE_REQUIRE_DATABASE_TESTS==="true")throw new Error("Disposable PostgreSQL fixture is required for readiness tests.");
type Batch=Pick<NeonQueryFunction<false,false>,"transaction">;
function postgresBatch(client:pg.Client):Batch{
  return{transaction:async(build:(tx:NeonQueryFunctionInTransaction<false,false>)=>NeonQueryInTransaction[],options?:{readOnly?:boolean;isolationLevel?:string})=>{
    assert.equal(options?.readOnly,true);assert.equal(options?.isolationLevel,"RepeatableRead");
    const queries:{sql:string;params:unknown[]}[]=[];
    const tx={query:(sql:string,params:unknown[])=>{assert.doesNotMatch(sql,/pg_advisory|FOR (?:UPDATE|SHARE)|assert_identity\(/);queries.push({sql,params});return{queryData:{query:sql,params}};}} as unknown as NeonQueryFunctionInTransaction<false,false>;
    assert.equal(build(tx).length,queries.length);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try{
      assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,"on");
      await client.query("SAVEPOINT forbidden_write");
      await assert.rejects(client.query("INSERT INTO cake_qa_registry.requests VALUES ($1,$2,NULL,now())",[randomUUID(),"f".repeat(64)]),error=>{assert.equal((error as {code:string}).code,"25006");return true;});
      await client.query("ROLLBACK TO SAVEPOINT forbidden_write");
      const results=[];for(const query of queries)results.push((await client.query(query.sql,query.params)).rows);await client.query("COMMIT");return results;
    }catch(error){await client.query("ROLLBACK");throw error;}
  }} as unknown as Batch;
}

async function fixture(){
  assert.ok(databaseUrl);const base=new URL(databaseUrl);assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname));assert.equal(base.pathname,"/cannele_test");assert.equal(base.search,"");assert.equal(base.hash,"");
  const name="cannele_test_readiness_"+randomUUID().replaceAll("-","");const creator=new pg.Client({connectionString:base.href});await creator.connect();await creator.query(`CREATE DATABASE "${name}"`);
  const child=new URL(base.href);child.pathname=`/${name}`;const client=new pg.Client({connectionString:child.href});
  const close=async()=>{await client.end();try{await creator.query(`DROP DATABASE "${name}"`);}finally{await creator.end();}};
  try{await client.connect();await client.query(legacyDdl);return{client,close};}catch(error){await close();throw error;}
}

test("actual PG17 readonly snapshot preserves 001/002 loans and recognizes superseded intent receipts as settled",{skip:!databaseUrl},async()=>{
  const f=await fixture();
  try{
    const connection="postgresql://synthetic-user:synthetic-password@ep-registry-fixture-pooler.mock.aws.neon.tech/synthetic_registry";
    const baseline=await inspectReadinessDatabase(postgresBatch(f.client),connection,legacyDdl,fenceDdl);assert.equal(baseline.summary.catalog,"001");assert.equal(baseline.summary.allSlotsFree,true);
    assert.match(baseline.summary.postgresVersion,/^17\.[0-9]+$/,"Numeric server version excludes distribution/build suffixes on the real PG17 fixture");
    const first={repository,base:"main",pr:42,branch:"codex/readiness-fixture",headSha:revision,requestId:randomUUID(),leaseId:randomUUID(),now:"2026-10-15T00:00:00.000Z",slot:"qa1"};
    let record=(await f.client.query("SELECT cake_qa_registry.reserve($1::jsonb,$2) AS value",[JSON.stringify(first),"a".repeat(64)])).rows[0].value;
    const repeated={...first,requestId:randomUUID(),leaseId:randomUUID()};
    assert.deepEqual((await f.client.query("SELECT cake_qa_registry.reserve($1::jsonb,$2) AS value",[JSON.stringify(repeated),"a".repeat(64)])).rows[0].value,record);
    const update=async(changes:Record<string,unknown>)=>{const next={...record,...changes,requestId:randomUUID(),version:record.version+1};record=(await f.client.query("SELECT cake_qa_registry.write_snapshot('qa1',$1,$2,$3::jsonb,$4) AS value",[record.leaseId,record.version,JSON.stringify(next),"b".repeat(64)])).rows[0].value;};
    await update({intent:{sha:revision,phase:"provisioning",attemptId:randomUUID(),startedAt:first.now}});
    const database={projectId:neonProject,branchId:"br-historical",endpointId:"ep-historical",host:"ep-historical.mock.aws.neon.tech"};
    await update({intent:undefined,database,deployments:[{id:"dpl_historical",sha:revision,phase:"provisioning"}]});await update({state:"deleting"});await update({state:"free",retiredDatabases:[database]});
    await f.client.query("BEGIN");for(const sql of registryDdlStatements(fenceDdl))await f.client.query(sql);await f.client.query("UPDATE cake_qa_registry.identity SET fence_receipt=$1::jsonb",[JSON.stringify(registryFenceReceipt(revision,legacyDdl,fenceDdl))]);await f.client.query("COMMIT");
    const before=(await f.client.query("SELECT jsonb_build_object('identity',(SELECT jsonb_agg(to_jsonb(i)) FROM cake_qa_registry.identity i),'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot) FROM cake_qa_registry.slots s),'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY version) FROM cake_qa_registry.history h),'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM cake_qa_registry.requests r)) AS state")).rows[0].state;
    const snapshot=await inspectReadinessDatabase(postgresBatch(f.client),connection,legacyDdl,fenceDdl);
    assert.equal(snapshot.summary.catalog,"002");assert.equal(snapshot.summary.allSlotsFree,true);assert.equal(snapshot.summary.requestsSettled,true);assert.equal(snapshot.summary.leasesSettled,true);
    assert.ok(snapshot.deployments.has("dpl_historical"));assert.ok(snapshot.branches.has("br-historical"));assert.ok(snapshot.endpoints.has("ep-historical"));assert.equal(snapshot.hosts.size,1);
    assert.equal(snapshot.summary.hostDigest,createHash("sha256").update("ep-registry-fixture-pooler.mock.aws.neon.tech").digest("hex"));assert.notEqual(snapshot.summary.hostDigest,snapshot.hostDigest);
    const receipt=await collectReadiness(environment,{source,transport:transport(),database:async()=>snapshot});assert.equal(receipt.providers?.historicalResources.deploymentAbsent,1);assert.equal(receipt.providers?.historicalResources.branchAbsent,1);
    assert.doesNotMatch(JSON.stringify(receipt),/dpl_historical|br-historical|ep-historical|synthetic-password|neondb_owner/);
    const after=(await f.client.query("SELECT jsonb_build_object('identity',(SELECT jsonb_agg(to_jsonb(i)) FROM cake_qa_registry.identity i),'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot) FROM cake_qa_registry.slots s),'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY version) FROM cake_qa_registry.history h),'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM cake_qa_registry.requests r)) AS state")).rows[0].state;
    assert.deepEqual(after,before);
  }finally{await f.close();}
});
