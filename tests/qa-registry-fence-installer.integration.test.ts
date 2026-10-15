import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import type { NeonQueryFunction, NeonQueryFunctionInTransaction, NeonQueryInTransaction } from "@neondatabase/serverless";
import { applyRegistryFence, expectedLegacyCatalog, inspectRegistryFence, legacyCatalogSql } from "../scripts/qa-registry-fence";
import { applyRegistryDdl } from "../scripts/qa-registry-ddl";

const databaseUrl=process.env.CANNELE_TEST_DATABASE_URL;
if (!databaseUrl && process.env.CANNELE_REQUIRE_DATABASE_TESTS === "true") throw new Error("Disposable PostgreSQL fixture is required for the Cake fence installer.");
const legacyDdl=readFileSync(new URL("../db/qa-registry/001_registry.sql",import.meta.url),"utf8");
const fenceDdl=readFileSync(new URL("../db/qa-registry/002_cannele_fence.sql",import.meta.url),"utf8");

function clientBatch(client:pg.Client):Pick<NeonQueryFunction<false,false>,"transaction">{
  return {transaction:async(build:(tx:NeonQueryFunctionInTransaction<false,false>)=>NeonQueryInTransaction[])=>{
    const queries:{sql:string;params:unknown[]}[]=[];
    const tx={query:(sql:string,params:unknown[])=>{queries.push({sql,params});return {queryData:{query:sql,params}};}} as unknown as NeonQueryFunctionInTransaction<false,false>;
    assert.equal(build(tx).length,queries.length);
    await client.query("BEGIN");
    try {
      const results=[];
      for(const query of queries) results.push((await client.query(query.sql,query.params)).rows);
      await client.query("COMMIT"); return results;
    }catch(error){await client.query("ROLLBACK");throw error;}
  }} as unknown as Pick<NeonQueryFunction<false,false>,"transaction">;
}

async function fixture(){
  assert.ok(databaseUrl);
  const base=new URL(databaseUrl);
  assert.ok(["postgres:","postgresql:"].includes(base.protocol));
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(base.hostname));
  assert.equal(base.pathname,"/cannele_test"); assert.equal(base.search,""); assert.equal(base.hash,"");
  const name=`cannele_test_installer_${randomUUID().replaceAll("-","")}`;
  const creator=new pg.Client({connectionString:base.href,connectionTimeoutMillis:3000});
  await creator.connect(); await creator.query(`CREATE DATABASE "${name}"`);
  const child=new URL(base.href);child.pathname=`/${name}`;
  const clients:pg.Client[]=[];
  const connect=async()=>{
    const client=new pg.Client({connectionString:child.href,connectionTimeoutMillis:3000});clients.push(client);
    await client.connect();return client;
  };
  const close=async()=>{await Promise.allSettled(clients.map(client=>client.end()));try{await creator.query(`DROP DATABASE "${name}"`);}finally{await creator.end();}};
  try {const admin=await connect();await admin.query(legacyDdl);return {admin,connect,close};}
  catch(error){await close();throw error;}
}

// Validate the actual HTTPS-batch SQL against PostgreSQL, including the two-lock admission fence.
test("PostgreSQL installer waits for the control lock, retains loans, and commits a usable immutable fence receipt",{skip:!databaseUrl},async()=>{
  const f=await fixture();
  try{
    const request={repository:"tyask/Cake",base:"main",pr:42,branch:"codex/installer-fixture",headSha:"a".repeat(40),
      requestId:randomUUID(),leaseId:randomUUID(),now:"2026-10-15T00:00:00.000Z",slot:"qa1"};
    const parameters=[JSON.stringify(request),"b".repeat(64)];
    const before=(await f.admin.query("SELECT cake_qa_registry.reserve($1::jsonb,$2) AS result",parameters)).rows[0].result;
    assert.deepEqual((await f.admin.query(legacyCatalogSql)).rows[0].catalog,expectedLegacyCatalog(legacyDdl));
    assert.equal(await inspectRegistryFence(clientBatch(f.admin),"c".repeat(40),legacyDdl,fenceDdl),null);
    const holder=await f.connect();const installer=await f.connect();
    const installerPid=(await installer.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('cannele_registry:control',0))");
    const pending=applyRegistryFence(clientBatch(installer),"c".repeat(40),legacyDdl,fenceDdl);
    const deadline=Date.now()+3000;
    let ordered=false;
    while(Date.now()<deadline){
      const locks=(await f.admin.query("SELECT bool_or(granted) AS held, bool_or(NOT granted) AS waiting FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[installerPid])).rows[0];
      if(locks.held && locks.waiting){ordered=true;break;}
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    assert.equal(ordered,true,"Installer must hold the legacy lock before waiting for the control lock");
    assert.equal((await f.admin.query("SELECT count(*)::int AS count FROM pg_attribute WHERE attrelid='cake_qa_registry.identity'::regclass AND attname='writer_mode'")).rows[0].count,0);
    await holder.query("COMMIT");
    const receipt=await pending;
    assert.deepEqual(await inspectRegistryFence(clientBatch(f.admin),"c".repeat(40),legacyDdl,fenceDdl),receipt);
    assert.deepEqual((await f.admin.query("SELECT writer_mode,writer_epoch::int,fence_receipt FROM cake_qa_registry.identity")).rows,[{writer_mode:"legacy",writer_epoch:1,fence_receipt:receipt}]);
    assert.deepEqual((await f.admin.query("SELECT cake_qa_registry.reserve($1::jsonb,$2) AS result",parameters)).rows[0].result,before);
    assert.equal((await f.admin.query("SELECT count(*)::int AS count FROM cake_qa_registry.requests")).rows[0].count,1);
    await assert.rejects(f.admin.query("UPDATE cake_qa_registry.identity SET fence_receipt=NULL"),error=>{assert.equal((error as {code:string}).code,"P0001");return true;});
    // Retained Cannele schema is the persistent post-cutover refusal, even if old tables are gone.
    await f.admin.query("CREATE SCHEMA cannele_registry");
    await assert.rejects(applyRegistryDdl(clientBatch(f.admin),"BEGIN; CREATE SCHEMA forbidden_reinitialization; COMMIT;"),/transaction failed/);
    assert.equal((await f.admin.query("SELECT to_regnamespace('forbidden_reinitialization') IS NULL AS absent")).rows[0].absent,true);
  }finally{await f.close();}
});
