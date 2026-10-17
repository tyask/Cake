import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRetentionWriteHistory } from '../scripts/preview-retention-history';
import { config } from '../scripts/preview-model';
const marker='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',control='a'.repeat(40);
function run(id:number,action='retention-prepare',scope=marker){return{id,workflow_id:99,run_attempt:1,event:'workflow_dispatch',head_branch:'main',head_sha:control,
  display_title:`Preview ${action} PR 75 ${scope}`,repository:{id:config.repositoryId,full_name:config.repository},head_repository:{id:config.repositoryId,full_name:config.repository},status:'completed',conclusion:'failure'};}
function getFor(runs:unknown[],pageSize=100){return async(path:string)=>path==='actions/workflows/preview.yml'
  ?{id:99,path:'.github/workflows/preview.yml',state:'active',url:`https://api.github.com/repos/${config.repository}/actions/workflows/99`}
  :{total_count:runs.length,workflow_runs:runs.slice((Number(new URL(`https://github.test/${path}`).searchParams.get('page'))-1)*pageSize,Number(new URL(`https://github.test/${path}`).searchParams.get('page'))*pageSize)};}
test('history scans all pages before accepting the current initial run',async()=>{
  const unrelated=Array.from({length:100},(_,i)=>({...run(i+1,'status'),display_title:`Preview status PR 99 ${marker}`}));
  await assertRetentionWriteHistory(getFor([...unrelated,run(101)]),{action:'retention-prepare',pr:75,marker,runId:'101',controlSha:control});
  await assert.rejects(assertRetentionWriteHistory(getFor([run(1),...unrelated.map((r,i)=>({...r,id:i+2})),run(102)]),{action:'retention-prepare',pr:75,marker,runId:'102',controlSha:control}),/REPLAY/);
});
test('failed, cancelled, pending and alternate-marker preparations all lock a later write',async()=>{
  for(const status of ['failure','cancelled','pending']){
    const earlier={...run(1),conclusion:status,status:status==='pending'?'in_progress':'completed'};
    await assert.rejects(assertRetentionWriteHistory(getFor([earlier,run(2)]),{action:'retention-prepare',pr:75,marker,runId:'2',controlSha:control}),/REPLAY/);
    await assert.rejects(assertRetentionWriteHistory(getFor([earlier,run(2,'retention-prepare',other)]),{action:'retention-prepare',pr:75,marker:other,runId:'2',controlSha:control}),/REPLAY/);
  }
});
test('a single prepare permits the first update, while an earlier update or rerun blocks it',async()=>{
  await assertRetentionWriteHistory(getFor([run(1),run(2,'retention-update')]),{action:'retention-update',pr:75,marker,runId:'2',controlSha:control});
  await assert.rejects(assertRetentionWriteHistory(getFor([run(1),run(2,'retention-update'),run(3,'retention-update')]),{action:'retention-update',pr:75,marker,runId:'3',controlSha:control}),/REPLAY/);
  await assert.rejects(assertRetentionWriteHistory(getFor([{...run(1),run_attempt:2}]),{action:'retention-prepare',pr:75,marker,runId:'1',controlSha:control}),/REPLAY/);
});
test('missing pages, duplicated run IDs and missing current run fail closed',async()=>{
  for(const list of [[run(1),run(1)],[]])await assert.rejects(assertRetentionWriteHistory(getFor(list),{action:'retention-prepare',pr:75,marker,runId:'2',controlSha:control}),/REPLAY/);
  const get=getFor([run(1)]);
  await assert.rejects(assertRetentionWriteHistory(async p=>{const r=await get(p);return p.includes('/runs?')?{...r,total_count:101}:r;},{action:'retention-prepare',pr:75,marker,runId:'1',controlSha:control}),/REPLAY/);
});
