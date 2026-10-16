import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestReceipt } from '../scripts/preview-command';
import { config,protocol,type Source } from '../scripts/preview-model';
import type { WorkflowExecutor } from '../scripts/task-workflow';
const s:Source={pr:71,branch:'codex/test',sha:'a'.repeat(40),createdAt:'2026-10-16T00:00:00Z',state:'open'};
function fixture(stale=false){
  let operation='',action='',downloads=0;
  const execute:WorkflowExecutor=async(_command,args)=>{
    let value:unknown='';
    if(args[0]==='api'){
      if(args.includes('POST')){const request=JSON.parse(await readFile(args[args.indexOf('--input')+1],'utf8'));operation=request.inputs.operation;action=request.inputs.action;}
      else if(args[1].includes('/pulls/'))value={number:s.pr,state:s.state,created_at:s.createdAt,head:{ref:s.branch,sha:s.sha,repo:{full_name:config.repository}},base:{ref:'main',repo:{full_name:config.repository}}};
      else if(args[1].endsWith('/branches/main'))value={commit:{sha:'b'.repeat(40)}};
      else value={encoding:'base64',content:Buffer.from(JSON.stringify(config)).toString('base64')};
    }else if(args[1]==='list')value=[{databaseId:123,displayTitle:`Preview ${action} PR ${s.pr} ${operation}`,headSha:stale?'c'.repeat(40):'b'.repeat(40),status:'completed',conclusion:'success',event:'workflow_dispatch',attempt:1}];
    else if(args[1]==='download'){
      downloads++;await writeFile(join(args[args.indexOf('--dir')+1],'preview-result.json'),JSON.stringify({protocol,success:true,action,source:s,checkedAt:new Date().toISOString(),operation,controlSha:'b'.repeat(40),runId:'123'}));
    }
    return {status:0,signal:null,stdout:typeof value==='string'?value:JSON.stringify(value)};
  };
  return {execute,downloads:()=>downloads};
}
test('CLI binds an operation receipt to the exact main workflow run and request',async()=>{
  const f=fixture();const result=await requestReceipt('status',s,'/tmp',f.execute,async()=>{},()=>{});assert.equal(result.source.sha,s.sha);assert.equal(f.downloads(),1);
  const stale=fixture(true);await assert.rejects(requestReceipt('status',s,'/tmp',stale.execute,async()=>{},()=>{}),/RUN_CHANGED/);assert.equal(stale.downloads(),0);
});
