import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeploymentRetentionService, type RetentionReceipt } from './deployment-retention';
import { StagingProvider } from './staging-service';
import { transport } from './preview-provider';
import { config, object } from './preview-model';
import { fullSha } from '../task/task-workflow';

type Environment = Readonly<Record<string, string | undefined>>;
type Mode = 'plan' | 'apply';
type Audit = { action: 'plan' | 'deleting' | 'deleted'; ids: readonly string[] };
type Service = { run(mode: Mode, expectedSha: string): Promise<RetentionReceipt> };
type ServiceFactory = (audit: (event: Audit) => void) => Service;

/** Project only public IDs; provider objects and credentials never enter notices. */
export function retentionNotices(event: Record<string, unknown>, emit = console.log): void {
  const ids = event.ids as readonly string[] | undefined;
  if (ids && (!Array.isArray(ids) || ids.some(id => !/^dpl_[A-Za-z0-9]+$/.test(id))))
    throw new Error('PREVIEW_RETENTION_INVALID_RECEIPT');
  const parts = Math.max(1, Math.ceil((ids?.length ?? 0) / 30));
  for (let part = 0; part < parts; part++) {
    const text = JSON.stringify({ ...event, ...(ids ? { ids: ids.slice(part * 30, (part + 1) * 30) } : {}), part: part + 1, parts });
    if (Buffer.byteLength(text) > 4096) throw new Error('PREVIEW_RETENTION_RECEIPT_TOO_LARGE');
    emit(`::notice title=cake-deployment-retention/v1::${text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  }
}

export async function runRetentionWorkflow(env: Environment = process.env,
  factory?: ServiceFactory, emit = console.log): Promise<RetentionReceipt> {
  if (env.GITHUB_REPOSITORY !== config.repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_WORKFLOW_REF !== `${config.repository}/.github/workflows/deployment-retention.yml@refs/heads/main`
    || !fullSha(env.GITHUB_SHA) || !env.GITHUB_EVENT_PATH
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID))
    || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)))
    throw new Error('PREVIEW_RETENTION_UNTRUSTED_WORKFLOW');
  const event = object(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  if (object(event.repository).id !== config.repositoryId || object(event.repository).full_name !== config.repository)
    throw new Error('PREVIEW_RETENTION_UNTRUSTED_EVENT');
  let mode: Mode;
  if (env.GITHUB_EVENT_NAME === 'schedule' && event.schedule === '17 3 * * *') mode = 'apply';
  else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const input = object(event.inputs ?? {}).mode ?? 'plan';
    if (input !== 'plan' && input !== 'apply') throw new Error('PREVIEW_RETENTION_INVALID_MODE');
    mode = input;
  } else throw new Error('PREVIEW_RETENTION_UNTRUSTED_EVENT');
  // An uncertain DELETE must be reconciled with a new plan, not a blind rerun.
  if (mode === 'apply' && env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('PREVIEW_RETENTION_APPLY_RERUN_UNSUPPORTED');
  if (['VERCEL_TOKEN', 'NEON_API_KEY', 'GH_TOKEN'].some(name => !env[name]?.trim()))
    throw new Error('PREVIEW_RETENTION_CREDENTIALS_MISSING');
  const context = { protocol: 'cake-deployment-retention/v1', mode, runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), controlSha: env.GITHUB_SHA };
  const auditEvents: Audit[] = [];
  const audit = (event: Audit) => {
    auditEvents.push({ action: event.action, ids: [...event.ids] });
    retentionNotices({ ...context, action: event.action, ids: event.ids }, emit);
  };
  const service = factory ? factory(audit)
    : new DeploymentRetentionService(new StagingProvider(transport(env)), Date.now, audit);
  let result: RetentionReceipt | undefined;
  try {
    result = await service.run(mode, env.GITHUB_SHA);
    retentionNotices({ ...context, action: 'complete', sourceSha: result.sourceSha, checkedAt: result.checkedAt,
      success: true, planned: result.planned.length, deleted: result.deleted.length, retained: result.retained,
      ids: result.skipped }, emit);
    return result;
  } finally {
    if (env.GITHUB_STEP_SUMMARY) {
      const lines = [`Deployment retention ${mode}: ${result ? '成功' : '未完了'}`, '', `SHA: ${env.GITHUB_SHA}`, '',
        'DB・branch・aliasは削除しません。候補と削除確認済みIDは別に記録します。', ''];
      for (const event of auditEvents) {
        lines.push(event.action === 'plan' ? '削除候補:' : event.action === 'deleting' ? '削除要求対象（不在確認前）:' : '削除確認済み:');
        lines.push(...event.ids.map(id => `- ${id}`), '');
      }
      if (result) lines.push(`保持: ${result.retained}件 / 直前再照合で保持: ${result.skipped.length}件`,
        ...result.skipped.map(id => `- ${id}`), '');
      await appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRetentionWorkflow().catch(error => {
    const code = error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message) ? error.message : 'PREVIEW_RETENTION_FAILED';
    console.error(`Cake: ${code}。候補・削除確認済みID・現用資源を再照合してください。外部応答・秘密値は表示しません。`);
    process.exitCode = 1;
  });
}
