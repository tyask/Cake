import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { browserCases, sameVerifiedDeployment, type BrowserProof } from './preview-browser';
import { config, type Source } from './preview-model';
import { commandOutput, type WorkflowExecutor } from './task-workflow';
import { requestReceipt } from './preview-command';
import { revalidateRemotePreviewProof } from './preview-remote-proof';
import { exactDeploymentIdentity } from './preview-verify-receipt';
export async function assertPreviewCi(s: Source, cwd: string, execute: WorkflowExecutor): Promise<void> {
  const pages = JSON.parse(await commandOutput(execute,'gh',['api','--paginate','--slurp',`repos/${config.repository}/actions/workflows/ci.yml/runs?head_sha=${s.sha}&per_page=100`],cwd));
  if (!Array.isArray(pages) || !pages.length || pages.some(p=>!Array.isArray(p.workflow_runs))) throw new Error('PREVIEW_CI_INCOMPLETE');
  const runs = pages.flatMap(p=>p.workflow_runs);
  for (const event of ['push','pull_request']) {
    const matches = runs.filter(r=>r.event===event && r.head_sha===s.sha && r.head_branch===s.branch && r.head_repository?.full_name===config.repository
      && r.path==='.github/workflows/ci.yml' && (event==='push'||Array.isArray(r.pull_requests)&&r.pull_requests.some((p:{number:number})=>p.number===s.pr)));
    if (!matches.length || matches.some(r=>!Number.isSafeInteger(r.run_number)||!Number.isSafeInteger(r.run_attempt))) throw new Error('PREVIEW_CI_INCOMPLETE');
    matches.sort((a,b)=>b.run_number-a.run_number||b.run_attempt-a.run_attempt);
    if (matches[1]?.run_number === matches[0].run_number && matches[1]?.run_attempt === matches[0].run_attempt) throw new Error('PREVIEW_CI_AMBIGUOUS');
    if (matches[0].status!=='completed'||matches[0].conclusion!=='success') throw new Error('PREVIEW_CI_NOT_SUCCESSFUL');
  }
}
export async function readyPreview(s: Source,cwd: string,execute: WorkflowExecutor,remoteProofPath?: string): Promise<BrowserProof> {
  if (remoteProofPath) {
    const get = async (path: string) => {
      try { return JSON.parse(await commandOutput(execute,'gh',['api',`repos/${config.repository}/${path}`],cwd)); }
      catch { throw new Error('PREVIEW_API_UNAVAILABLE'); }
    };
    const proof = await revalidateRemotePreviewProof(resolve(cwd,remoteProofPath),s,get);
    const current = await requestReceipt('status',s,cwd,execute);
    if (!current.deployment || !exactDeploymentIdentity(proof.deployment,current.deployment)) throw new Error('PREVIEW_PROOF_STALE');
    await assertPreviewCi(s,cwd,execute);
    return proof;
  }
  const path=resolve(cwd,'.cake/verification.json'), meta=await lstat(path);
  if (!meta.isFile()||meta.isSymbolicLink()||meta.size>100_000) throw new Error('PREVIEW_BROWSER_PROOF_REQUIRED');
  const proof:BrowserProof=JSON.parse(await readFile(path,'utf8'));
  if (proof.protocol!=='cake-preview-browser/v1'||proof.success!==true||JSON.stringify(proof.source)!==JSON.stringify(s)
    ||JSON.stringify(proof.cases)!==JSON.stringify(browserCases)||!Number.isFinite(Date.parse(proof.verifiedAt))
    ||!Array.isArray(proof.clicks)||proof.clicks.length!==16) throw new Error('PREVIEW_BROWSER_PROOF_REQUIRED');
  for (const c of browserCases.filter(c => c !== 'read-api')) {
    const expected = ['ログイン'+c.at(-1)!.toUpperCase(),'取引明細','設定','ホーム'];
    const clicks = proof.clicks.filter(click => click.case === c);
    if (JSON.stringify(clicks.map(click => click.target)) !== JSON.stringify(expected) || clicks.some(click => !Number.isFinite(Date.parse(click.at)) || Date.parse(click.at) > Date.parse(proof.verifiedAt))) throw new Error('PREVIEW_BROWSER_PROOF_REQUIRED');
  }
  const current=await requestReceipt('status',s,cwd,execute);
  if (!current.deployment||!sameVerifiedDeployment(proof.deployment,current.deployment)) throw new Error('PREVIEW_PROOF_STALE');
  await assertPreviewCi(s,cwd,execute);
  return proof;
}
