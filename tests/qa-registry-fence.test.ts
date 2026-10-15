import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { NeonQueryFunction, NeonQueryFunctionInTransaction, NeonQueryInTransaction } from "@neondatabase/serverless";
import { QA_REPOSITORY } from "../lib/qa-pool";
import { applyRegistryFence, expectedFencedCatalog, expectedLegacyCatalog, inspectRegistryFence, legacyCatalogSql, LEGACY_DDL_SHA256, LEGACY_WORKFLOWS, RegistryFenceGateway } from "../scripts/qa-registry-fence";
import { NeonQaRegistryStore } from "../scripts/qa-registry-store";
import type { QaTransport } from "../scripts/qa-pool-writer";

const legacyDdl = () => readFileSync(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8");
const fenceDdl = () => readFileSync(new URL("../db/qa-registry/002_cannele_fence.sql", import.meta.url), "utf8");
const revision = "a".repeat(40);
const environment = {
  GITHUB_TOKEN: "synthetic-token", GITHUB_REPOSITORY: QA_REPOSITORY, GITHUB_REF: "refs/heads/main",
  EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ID: "123", QA_TRUSTED_MAIN_SHA: revision,
  QA_FENCE_EXPECTED_REVISION: revision, QA_FENCE_DRAIN_CONFIRMED: "true",
  CAKE_CANNELE_ENABLED: "true", CAKE_QA_REGISTRY_ENABLED: "false", CAKE_QA_POOL_ENABLED: "false",
};
const goodRun = {
  actor: { id: 10, type: "User" }, triggering_actor: { id: 10, type: "User" },
  event: "workflow_dispatch", head_branch: "main", head_sha: revision, status: "in_progress", run_attempt: 1,
  path: ".github/workflows/qa-registry-fence.yml", repository: { full_name: QA_REPOSITORY }, head_repository: { full_name: QA_REPOSITORY },
};

function authorizationTransport(run: Record<string, unknown> = goodRun, currentMain = revision): QaTransport {
  return async (method, address, token) => {
    assert.equal(method, "GET"); assert.equal(token, "synthetic-token");
    const path = new URL(address).pathname;
    if (path.endsWith("/actions/runs/123")) return { status: 200, data: run };
    if (path.endsWith("/branches/main")) return { status: 200, data: { commit: { sha: currentMain } } };
    assert.equal(path, `/repos/${QA_REPOSITORY}`);
    return { status: 200, data: { owner: { id: 10, type: "User" } } };
  };
}

test("installer authorizes only its owner, exact current reviewed main and first active run", async () => {
  assert.equal(await new RegistryFenceGateway(environment, authorizationTransport()).assertReviewedMain(), revision);
  for (const changes of [
    { actor: { id: 99, type: "User" } }, { triggering_actor: { id: 99, type: "User" } },
    { actor: { id: 10, type: "Bot" } }, { path: ".github/workflows/qa-registry.yml" }, { run_attempt: 2 },
    { head_sha: "b".repeat(40) }, { head_branch: "codex/foreign" }, { event: "pull_request_target" },
    { repository: { full_name: "other/Cake" } }, { status: "completed" },
  ]) await assert.rejects(new RegistryFenceGateway(environment, authorizationTransport({ ...goodRun, ...changes })).assertReviewedMain(), /owner-only reviewed main/);
  await assert.rejects(new RegistryFenceGateway(environment, authorizationTransport(goodRun,"b".repeat(40))).assertReviewedMain(), /owner-only reviewed main/);
});

test("disabled workflow flags and external client/session drain are explicit prerequisites", async () => {
  for (const changes of [
    { CAKE_CANNELE_ENABLED: "false" }, { CAKE_QA_REGISTRY_ENABLED: "true" }, { CAKE_QA_POOL_ENABLED: "true" },
    { CAKE_QA_REGISTRY_ENABLED: undefined }, { QA_FENCE_DRAIN_CONFIRMED: "false" },
    { QA_FENCE_EXPECTED_REVISION: "b".repeat(40) }, { GITHUB_REF: "refs/heads/foreign" },
  ]) {
    let calls=0;
    const gateway=new RegistryFenceGateway({ ...environment, ...changes }, async () => { calls++; throw new Error("must not call"); });
    await assert.rejects(gateway.assertReviewedMain(), /confirmed external writer drain/);
    assert.equal(calls,0);
  }
});

test("all four old entry and reusable workflows must have complete idle queues", async () => {
  const paths:string[]=[];
  const transport:QaTransport=async (method,address) => {
    assert.equal(method,"GET"); paths.push(new URL(address).pathname);
    return {status:200,data:{total_count:0,workflow_runs:[]}};
  };
  await new RegistryFenceGateway(environment,transport).assertAllLegacyRunsIdle();
  assert.deepEqual(paths, LEGACY_WORKFLOWS.map(workflow=>`/repos/${QA_REPOSITORY}/actions/workflows/${workflow}/runs`));
  for (const workflow of LEGACY_WORKFLOWS) for (const status of ["queued","in_progress","waiting","pending","requested"]) {
    const gateway=new RegistryFenceGateway(environment,async (_method,address) => ({status:200,data:{total_count:1,workflow_runs:[{status:new URL(address).pathname.includes(workflow)?status:"completed"}]}}));
    await assert.rejects(gateway.assertAllLegacyRunsIdle(), /confirmed external writer drain/);
  }
});

test("queue pagination checks later pages and refuses truncated or unknown responses", async () => {
  let calls=0;
  const gateway=new RegistryFenceGateway(environment,async (_method,address) => {
    const page=Number(new URL(address).searchParams.get("page")); calls++;
    return {status:200,data:{total_count:101,workflow_runs:page===1?Array.from({length:100},()=>({status:"completed"})):[{status:"queued"}]}};
  });
  await assert.rejects(gateway.assertAllLegacyRunsIdle()); assert.equal(calls,2);
  for (const data of [{total_count:1,workflow_runs:[]},{total_count:0,workflow_runs:null},{workflow_runs:[]},{total_count:1,workflow_runs:[{}]}]) {
    await assert.rejects(new RegistryFenceGateway(environment,async()=>({status:200,data})).assertAllLegacyRunsIdle());
  }
});

type BatchClient = Pick<NeonQueryFunction<false,false>,"transaction">;
type MemoryDatabase = { exec(sql:string):Promise<unknown>; query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>; close():Promise<void> };
function batchClient(run:(queries:{sql:string;params:unknown[]}[])=>Promise<void | Record<string,unknown>[][]>):BatchClient {
  return {transaction:async (build:(tx:NeonQueryFunctionInTransaction<false,false>)=>NeonQueryInTransaction[])=>{
    const queries:{sql:string;params:unknown[]}[]=[];
    const tx={query:(sql:string,params:unknown[])=>{queries.push({sql,params});return {queryData:{query:sql,params}};}} as unknown as NeonQueryFunctionInTransaction<false,false>;
    const built=build(tx); assert.equal(built.length,queries.length);
    const results=await run(queries); return results ?? queries.map(()=>[]);
  }} as unknown as BatchClient;
}
function memoryBatch(db:MemoryDatabase):BatchClient {
  return batchClient(async queries=>{
    await db.exec("BEGIN");
    try {
      const results:Record<string,unknown>[][]=[];
      for (const {sql,params} of queries) results.push((await db.query(sql,params)).rows);
      await db.exec("COMMIT"); return results;
    }
    catch(error){await db.exec("ROLLBACK");throw error;}
  });
}
async function memoryDatabase():Promise<MemoryDatabase> {
  const modulePath=process.env.CAKE_LOCAL_PGLITE_MODULE;
  const {PGlite}=await (modulePath?import(pathToFileURL(modulePath).href):import("@electric-sql/pglite"));
  return new PGlite() as MemoryDatabase;
}

test("fence DDL and its immutable source/checksum receipt share one ordered atomic batch", async()=>{
  let batches=0;
  const receipt=await applyRegistryFence(batchClient(async queries=>{
    batches++;
    const legacyLock=queries.findIndex(q=>q.sql.includes("pg_advisory_xact_lock(hashtext('cake:qa-registry:v1'))"));
    const controlLock=queries.findIndex(q=>q.sql.includes("pg_advisory_xact_lock(hashtextextended('cannele_registry:control'"));
    const manifest=queries.findIndex(q=>q.sql.includes("catalog IS NOT DISTINCT FROM $1::jsonb"));
    const ddl=queries.findIndex(q=>q.sql.startsWith("ALTER TABLE cake_qa_registry.identity"));
    const receiptWrite=queries.findIndex(q=>q.sql.startsWith("UPDATE cake_qa_registry.identity SET fence_receipt="));
    assert.ok(legacyLock>=0 && legacyLock<controlLock && controlLock<manifest && manifest<ddl && ddl<receiptWrite);
    assert.equal(queries.at(-1)?.params[0],queries[receiptWrite].params[0]);
    assert.deepEqual(JSON.parse(queries[manifest].params[0] as string),expectedLegacyCatalog(legacyDdl()));
  }),revision,legacyDdl(),fenceDdl());
  assert.equal(batches,1);
  assert.deepEqual(receipt,{protocol:"cake-qa-registry-fence/v1",version:2,revision,legacyDdlSha256:LEGACY_DDL_SHA256,
    fenceDdlSha256:createHash("sha256").update(fenceDdl()).digest("hex"),writerEpoch:1});
});

test("changed immutable 001 bytes are refused before touching any database",async()=>{
  let batches=0;
  const client=batchClient(async()=>{batches++;});
  await assert.rejects(applyRegistryFence(client,revision,legacyDdl()+"\n",fenceDdl()));
  assert.equal(batches,0);
});

test("actual installer preserves an existing loan and receipts, and leaves legacy mode active",async()=>{
  const db=await memoryDatabase();
  try{
    await db.exec(legacyDdl());
    assert.deepEqual((await db.query(legacyCatalogSql)).rows[0].catalog,expectedLegacyCatalog(legacyDdl()));
    assert.equal(await inspectRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl()),null);
    const store=new NeonQaRegistryStore(async(sql,params)=>(await db.query(sql,params)).rows);
    await store.reserve({repository:QA_REPOSITORY,base:"main",pr:42,branch:"codex/fence-test",headSha:revision,
      leaseId:"00000000-0000-4000-8000-000000000001",requestId:"00000000-0000-4000-8000-000000000002",now:"2026-10-15T00:00:00.000Z"});
    const before=await store.read();
    const requestsBefore=(await db.query("SELECT * FROM cake_qa_registry.requests")).rows;
    const receipt=await applyRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl());
    assert.deepEqual((await db.query(legacyCatalogSql)).rows[0].catalog,expectedFencedCatalog(legacyDdl(),fenceDdl()));
    assert.deepEqual(await inspectRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl()),receipt);
    await assert.rejects(inspectRegistryFence(memoryBatch(db),"c".repeat(40),legacyDdl(),fenceDdl()),/details suppressed/);
    assert.deepEqual(await store.read(),before);
    assert.deepEqual((await db.query("SELECT * FROM cake_qa_registry.requests")).rows,requestsBefore);
    assert.deepEqual((await db.query("SELECT writer_mode,writer_epoch::int,fence_receipt FROM cake_qa_registry.identity")).rows,[{writer_mode:"legacy",writer_epoch:1,fence_receipt:receipt}]);
    await assert.rejects(applyRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl()));
    assert.deepEqual(await store.read(),before);
  }finally{await db.close();}
});

test("a committed fence with a lost response is verified read-only, and installed function drift is rejected",async()=>{
  const db=await memoryDatabase();
  try{
    await db.exec(legacyDdl());
    const normal=memoryBatch(db);
    const lost={transaction:async(...args:Parameters<BatchClient["transaction"]>)=>{
      await normal.transaction(...args);throw new Error("synthetic response lost after commit");
    }} as BatchClient;
    await assert.rejects(applyRegistryFence(lost,revision,legacyDdl(),fenceDdl()),/details suppressed/);
    const receipt=await inspectRegistryFence(normal,revision,legacyDdl(),fenceDdl());
    assert.ok(receipt);
    const readOnly=batchClient(async queries=>{
      assert.equal(queries.some(query=>/^(?:CREATE|ALTER|DROP|UPDATE|INSERT|DELETE|TRUNCATE)\b/i.test(query.sql)),false);
    });
    // This shape models the already committed read-only projection from the real SQL above.
    const inspection={transaction:async(...args:Parameters<BatchClient["transaction"]>)=>{
      await readOnly.transaction(...args);
      return [[{identity:(await db.query("SELECT to_jsonb(i) AS identity FROM cake_qa_registry.identity i")).rows[0].identity,
        catalog:(await db.query(legacyCatalogSql)).rows[0].catalog}]];
    }} as unknown as BatchClient;
    assert.deepEqual(await inspectRegistryFence(inspection,revision,legacyDdl(),fenceDdl()),receipt);
    await db.exec("CREATE OR REPLACE FUNCTION cake_qa_registry.reserve(input jsonb,digest text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
    await assert.rejects(inspectRegistryFence(normal,revision,legacyDdl(),fenceDdl()),/details suppressed/);
  }finally{await db.close();}
});

test("unknown legacy object, function or constraint drift fails closed before fence installation",async()=>{
  for(const drift of [
    "CREATE TABLE cake_qa_registry.unreviewed (id int)",
    "ALTER TABLE cake_qa_registry.slots DROP CONSTRAINT slots_version_check",
    'CREATE COLLATION cake_qa_registry.unreviewed FROM pg_catalog."C"',
    'ALTER TABLE cake_qa_registry.slots ALTER COLUMN branch TYPE text COLLATE pg_catalog."C"',
    "CREATE OR REPLACE FUNCTION cake_qa_registry.assert_identity() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$",
  ]){
    const db=await memoryDatabase();
    try{
      await db.exec(legacyDdl());await db.exec(drift);
      const before=(await db.query(legacyCatalogSql)).rows[0].catalog;
      await assert.rejects(applyRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl()),/details suppressed/);
      assert.deepEqual((await db.query(legacyCatalogSql)).rows[0].catalog,before);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_attribute WHERE attrelid='cake_qa_registry.identity'::regclass AND attname='writer_mode'")).rows[0].count,0);
    }finally{await db.close();}
  }
});

test("DDL mid-batch failure rolls back all new fence objects and its receipt",async()=>{
  const db=await memoryDatabase();
  try{
    await db.exec(legacyDdl());
    const before=(await db.query(legacyCatalogSql)).rows[0].catalog;
    await assert.rejects(applyRegistryFence(memoryBatch(db),revision,legacyDdl(),fenceDdl().replace(/COMMIT;\s*$/,"SELECT missing_private_column FROM cake_qa_registry.identity; COMMIT;")),/details suppressed/);
    assert.deepEqual((await db.query(legacyCatalogSql)).rows[0].catalog,before);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM cake_qa_registry.identity")).rows[0].count,1);
  }finally{await db.close();}
});

test("installer diagnostics do not expose DB errors, SQL or credentials",async()=>{
  await assert.rejects(applyRegistryFence(batchClient(async()=>{throw new Error("postgresql://user:private@host/registry private SQL");}),revision,legacyDdl(),fenceDdl()),error=>{
    assert.match(String(error),/details suppressed/);assert.doesNotMatch(String(error),/postgresql|private|SQL/);return true;
  });
});

test("main admin workflow carries only the registry connection and all legacy jobs have the retirement gate",()=>{
  const workflow=readFileSync(new URL("../.github/workflows/qa-registry-fence.yml",import.meta.url),"utf8");
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/pull_request|schedule:|VERCEL_TOKEN|NEON_API_KEY|upload-artifact|secrets: inherit/);
  assert.match(workflow,/confirm_legacy_drain:/);assert.match(workflow,/CAKE_QA_REGISTRY_DATABASE_HOST/);
  assert.match(workflow,/ref: refs\/heads\/main/);assert.match(workflow,/persist-credentials: false/);
  for(const file of LEGACY_WORKFLOWS){
    const source=readFileSync(new URL(`../.github/workflows/${file}`,import.meta.url),"utf8");
    const jobs=source.split("\njobs:\n")[1].split(/^  [a-zA-Z_-]+:\s*$/m).slice(1);
    assert.ok(jobs.length>0);
    for (const job of jobs) assert.match(job.split(/\n    (?:runs-on|permissions|uses):/)[0],/vars\.CAKE_CANNELE_ENABLED != 'true'/);
  }
});
