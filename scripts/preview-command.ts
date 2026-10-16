import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanTaskHead, commandOutput, executeWorkflowCommand, previewUrl, taskPullRequests, type WorkflowExecutor } from './task-workflow';
import { config, object, protocol, sameDatabase, source, uuid, type Source } from './preview-model';
import { sameVerifiedDeployment, verifyBrowser } from './preview-browser';
import type { Receipt } from './preview-service';
export async function requestReceipt(action: 'deploy' | 'status' | 'cleanup', expected: Source, cwd: string,
  execute = executeWorkflowCommand, wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r,ms)), log = console.log): Promise<Receipt> {
  const api = async (path: string) => JSON.parse(await commandOutput(execute,'gh',['api',`repos/${config.repository}/${path}`],cwd));
  const current = source(await api(`pulls/${expected.pr}`));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('PREVIEW_PR_CHANGED');
  const main = object(await api('branches/main')), mainSha = object(main.commit).sha;
  if (typeof mainSha !== 'string' || !/^[a-f0-9]{40}$/.test(mainSha)) throw new Error('PREVIEW_MAIN_UNAVAILABLE');
  const remote = object(await api(`contents/preview.config.json?ref=${mainSha}`));
  if (remote.encoding !== 'base64' || JSON.stringify(JSON.parse(Buffer.from(String(remote.content),'base64').toString())) !== JSON.stringify(config)) throw new Error('PREVIEW_NOT_INSTALLED_ON_MAIN');
  const operation = randomUUID(), directory = await mkdtemp(join(tmpdir(),'cake-preview-'));
  try {
    const file = join(directory,'request.json');
    await writeFile(file,JSON.stringify({ ref:'main',inputs:{ action,pr:String(expected.pr),sha:expected.sha,operation } }),{ mode:0o600 });
    await commandOutput(execute,'gh',['api',`repos/${config.repository}/actions/workflows/preview.yml/dispatches`,'--method','POST','--input',file],cwd);
    let run: Record<string,unknown> | undefined;
    for (let i=0;i<300;i++) {
      const runs = JSON.parse(await commandOutput(execute,'gh',['run','list','--repo',config.repository,'--workflow','preview.yml','--branch','main','--event','workflow_dispatch','--limit','100','--json','databaseId,displayTitle,headSha,status,conclusion,url,event,createdAt,attempt'],cwd));
      if (!Array.isArray(runs)) throw new Error('PREVIEW_RUN_UNAVAILABLE');
      const matches = runs.filter(r => r.displayTitle === `Preview ${action} PR ${expected.pr} ${operation}`);
      if (matches.length > 1) throw new Error('PREVIEW_RUN_AMBIGUOUS');
      if (matches.length) {
        run = matches[0];
        if (run!.headSha !== mainSha || run!.event !== 'workflow_dispatch' || run!.attempt !== 1) throw new Error('PREVIEW_RUN_CHANGED');
        if (run!.status === 'completed') break;
      }
      if (i % 6 === 0) log(`Cake: Preview ${action} の完了を確認しています。request ${operation}`);
      await wait(5000);
    }
    if (!run || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('PREVIEW_RUN_INCOMPLETE');
    await commandOutput(execute,'gh',['run','download',String(run.databaseId),'--repo',config.repository,'--name',`preview-${run.databaseId}`,'--dir',directory],cwd);
    const resultPath = join(directory,'preview-result.json'), metadata = await lstat(resultPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65_536) throw new Error('PREVIEW_RECEIPT_INVALID');
    const receipt = JSON.parse(await readFile(resultPath,'utf8'));
    if (receipt.protocol !== protocol || receipt.success !== true || receipt.action !== action || receipt.operation !== operation || receipt.runId !== String(run.databaseId)
      || receipt.controlSha !== mainSha || JSON.stringify(receipt.source) !== JSON.stringify(expected) || !Number.isFinite(Date.parse(receipt.checkedAt))) throw new Error('PREVIEW_RECEIPT_INVALID');
    if (receipt.deployment) {
      const d = receipt.deployment;
      if (d.url !== previewUrl(d.url) || !/^dpl_[A-Za-z0-9]+$/.test(d.id) || !uuid(d.generation) || !uuid(d.operation)
        || d.pr !== expected.pr || d.branch !== expected.branch || d.sha !== expected.sha || d.state !== 'READY' || d.phase !== 'application'
        || !d.database || !receipt.database || !sameDatabase(d.database,receipt.database)
        || !/^br-[a-z0-9-]+$/.test(d.database.branchId) || !/^ep-[a-z0-9-]+$/.test(d.database.endpointId)
        || !/^[a-f0-9]{64}$/.test(d.database.hostDigest) || d.database.hostDigest === config.productionHostDigest) throw new Error('PREVIEW_RECEIPT_INVALID');
    }
    return receipt;
  } finally { await rm(directory,{ recursive:true,force:true }); }
}
export async function runPreviewCommand(command: string, args: string[], cwd = process.cwd(), execute: WorkflowExecutor = executeWorkflowCommand): Promise<void> {
  if (!['deploy','status','verify','cleanup'].includes(command)) throw new Error('PREVIEW_INVALID_COMMAND');
  let expected: Source;
  if (command === 'cleanup') {
    if (args.length !== 2 || args[0] !== '--pr' || !/^[1-9][0-9]*$/.test(args[1])) throw new Error('PREVIEW_SPECIFY_CLOSED_PR');
    expected = source(JSON.parse(await commandOutput(execute,'gh',['api',`repos/${config.repository}/pulls/${args[1]}`],cwd)));
    if (expected.state !== 'closed') throw new Error('PREVIEW_PR_NOT_CLOSED');
  } else {
    if (args.length) throw new Error('PREVIEW_UNEXPECTED_ARGUMENT');
    const head = await cleanTaskHead(cwd,execute), requests = await taskPullRequests(head,execute);
    if (!requests[0] || requests[0].headRefOid !== head.sha) throw new Error('PREVIEW_CURRENT_DRAFT_PR_REQUIRED');
    expected = source(JSON.parse(await commandOutput(execute,'gh',['api',`repos/${config.repository}/pulls/${requests[0].number}`],cwd)));
    if (expected.branch !== head.branch || expected.sha !== head.sha || expected.state !== 'open') throw new Error('PREVIEW_PR_CHANGED');
  }
  if (command === 'verify') await rm(resolve(cwd,'.cake/verification.json'), { force:true });
  const receipt = await requestReceipt(command === 'verify' ? 'status' : command as 'deploy'|'status'|'cleanup',expected,cwd,execute);
  if (command === 'verify') {
    if (!receipt.deployment || !receipt.database) throw new Error('PREVIEW_READY_REQUIRED');
    const proof = await verifyBrowser(expected,receipt.deployment,cwd);
    try {
      const after = await requestReceipt('status',expected,cwd,execute);
      const head = await cleanTaskHead(cwd,execute);
      if (!after.deployment || !sameVerifiedDeployment(proof.deployment,after.deployment) || head.branch !== expected.branch || head.sha !== expected.sha) throw new Error();
    } catch {
      await writeFile(resolve(cwd,'.cake/verification.json'),JSON.stringify({ ...proof,success:false }),{ mode:0o600 });
      throw new Error('PREVIEW_CHANGED_DURING_VERIFICATION');
    }
  }
  await mkdir(resolve(cwd,'.cake'),{ recursive:true,mode:0o700 });
  await writeFile(resolve(cwd,'.cake/preview.json'),JSON.stringify(receipt,null,2)+'\n',{ mode:0o600 });
  console.log(`Cake: Preview ${command} 成功${receipt.deployment ? `: ${receipt.deployment.url} / ${receipt.deployment.id}` : ''}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runPreviewCommand(process.argv[2],process.argv.slice(3)).catch(error => {
  const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_COMMAND_FAILED';
  console.error(`Cake: ${code}。対象PRのActionsと資源状態を確認してください。`); process.exitCode=1;
});
