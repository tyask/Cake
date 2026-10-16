import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, object, uuid } from './preview-model';
import { PreviewService } from './preview-service';
export async function runPreviewWorkflow(env = process.env, service = new PreviewService()): Promise<void> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/preview.yml@refs/heads/main`
    || !env.GITHUB_EVENT_PATH || !env.GITHUB_RUN_ID || !env.GITHUB_RUN_ATTEMPT) throw new Error('PREVIEW_UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).full_name !== config.repository) throw new Error('PREVIEW_UNTRUSTED_EVENT');
  let pr: number, action: string, operation: string | undefined, sha: string | undefined;
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    const p = object(event.pull_request);
    if (event.action !== 'closed' || p.state !== 'closed' || object(object(p.head).repo).full_name !== config.repository
      || object(p.base).ref !== 'main') throw new Error('PREVIEW_UNTRUSTED_EVENT');
    pr = Number(p.number); action = 'cleanup'; sha = String(object(p.head).sha);
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const inputs = object(event.inputs);
    pr = Number(inputs.pr); action = String(inputs.action); operation = String(inputs.operation); sha = String(inputs.sha);
    if (!uuid(operation)) throw new Error('PREVIEW_INVALID_OPERATION');
  } else throw new Error('PREVIEW_UNTRUSTED_EVENT');
  const source = await service.provider.pr(pr);
  if (source.sha !== sha || !['deploy','status','cleanup'].includes(action)) throw new Error('PREVIEW_PR_CHANGED');
  const receipt = action === 'deploy' ? await service.deploy(source, operation!, Number(env.GITHUB_RUN_ATTEMPT) > 1)
    : action === 'cleanup' ? await service.cleanup(source) : await service.status(source);
  const result = { ...receipt, operation: operation ?? null, runId: env.GITHUB_RUN_ID, controlSha: env.GITHUB_SHA };
  await writeFile(resolve('preview-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `Preview ${action}: 成功 / PR #${source.pr}\n\nCommit: ${source.sha}\n\n${receipt.deployment ? `Deployment: ${receipt.deployment.id}\n\nURL: ${receipt.deployment.url}\n` : ''}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runPreviewWorkflow().catch(error => {
    const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_OPERATION_FAILED';
    console.error(`Cake: ${code}。資源状態を再照合してください。外部応答・秘密値は表示しません。`); process.exitCode = 1;
  });
}
