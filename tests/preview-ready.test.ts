import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPreviewCi } from '../scripts/preview-ready';
import type { WorkflowExecutor } from '../scripts/task-workflow';
import type { Source } from '../scripts/preview-model';
const s:Source={pr:71,sha:'a'.repeat(40),branch:'codex/test',createdAt:'2026-10-16T00:00:00Z',state:'open'};
function run(event:string,number:number,conclusion='success',attempt=1){return {event,run_number:number,run_attempt:attempt,head_sha:s.sha,head_branch:s.branch,head_repository:{full_name:'tyask/Cake'},path:'.github/workflows/ci.yml',pull_requests:[{number:s.pr}],status:'completed',conclusion};}
const execute=(runs:unknown[]):WorkflowExecutor=>async()=>({status:0,signal:null,stdout:JSON.stringify([{workflow_runs:runs}])});
test('Ready requires current push and PR CI; an older success cannot mask a failed latest run/attempt',async()=>{
  await assertPreviewCi(s,'/tmp',execute([run('push',1),run('pull_request',2)]));
  for(const runs of [[run('push',1)],[run('push',1),run('push',3,'failure'),run('pull_request',2)],
    [run('push',1),run('pull_request',2),run('pull_request',2,'failure',2)],
    [run('push',1),{...run('pull_request',2),head_sha:'b'.repeat(40)}]]) await assert.rejects(assertPreviewCi(s,'/tmp',execute(runs)));
});
