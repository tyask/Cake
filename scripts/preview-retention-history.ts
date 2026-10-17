import { config, object } from './preview-model';
import { previewWorkflow, type PreviewGet } from './preview-checks';
import { fullSha } from './task-workflow';
import { isRetentionMarker } from './preview-retention-model';

type WriteHistoryRequest = { action: 'retention-prepare' | 'retention-update'; pr: number; marker: string; runId?: string; controlSha?: string; prepareRunId?: string };
/** Failed, cancelled and unfinished writes lock the same scope too. Missing
 * pages or an ambiguous title never authorize another attempt. */
export async function assertRetentionWriteHistory(get: PreviewGet, expected: WriteHistoryRequest): Promise<void> {
  if (!Number.isSafeInteger(expected.pr) || expected.pr < 1 || !isRetentionMarker(expected.marker)) throw new Error('PREVIEW_RETENTION_REPLAY');
  const workflow = await previewWorkflow(get), seen = new Set<number>();
  let count: number | undefined, own = false, preparations = 0;
  for (let page = 1; page <= 100; page++) {
    const response = object(await get(`actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`));
    if (!Number.isSafeInteger(response.total_count) || Number(response.total_count) < 0 || Number(response.total_count) > 10_000
      || count !== undefined && response.total_count !== count || !Array.isArray(response.workflow_runs) || response.workflow_runs.length > 100) throw new Error('PREVIEW_RETENTION_REPLAY');
    count = Number(response.total_count);
    for (const value of response.workflow_runs) {
      const run = object(value);
      if (!Number.isSafeInteger(run.id) || Number(run.id) < 1 || seen.has(Number(run.id))) throw new Error('PREVIEW_RETENTION_REPLAY');
      seen.add(Number(run.id));
      const title = String(run.display_title ?? '');
      const relevant = title.startsWith(`Preview retention-prepare PR ${expected.pr} `) || title.startsWith(`Preview retention-update PR ${expected.pr} `);
      if (!relevant && String(run.id) !== expected.runId) continue;
      const match = /^Preview (retention-prepare|retention-update) PR ([1-9][0-9]*) ([a-f0-9-]+)$/.exec(title);
      if (!match || !isRetentionMarker(match[3]) || run.workflow_id !== workflow.id || run.head_branch !== 'main' || run.event !== 'workflow_dispatch'
        || !fullSha(run.head_sha) || object(run.repository).full_name !== config.repository || object(run.repository).id !== config.repositoryId
        || object(run.head_repository).full_name !== config.repository || object(run.head_repository).id !== config.repositoryId) throw new Error('PREVIEW_RETENTION_REPLAY');
      if (String(run.id) === expected.runId) {
        if (own || run.run_attempt !== 1 || match[1] !== expected.action || Number(match[2]) !== expected.pr || match[3] !== expected.marker
          || run.head_sha !== expected.controlSha) throw new Error('PREVIEW_RETENTION_REPLAY');
        own = true; continue;
      }
      // Never choose another marker after any prepare for this acceptance PR.
      if (match[1] === 'retention-prepare' && (expected.action === 'retention-prepare' || match[3] !== expected.marker)
        || match[1] === 'retention-update') throw new Error('PREVIEW_RETENTION_REPLAY');
      if (match[1] === 'retention-prepare') {
        preparations++;
        if (preparations > 1 || expected.prepareRunId !== undefined && String(run.id) !== expected.prepareRunId) throw new Error('PREVIEW_RETENTION_REPLAY');
      }
    }
    if (seen.size > count || seen.size < count && response.workflow_runs.length !== 100) throw new Error('PREVIEW_RETENTION_REPLAY');
    if (seen.size === count) {
      if (expected.runId && !own || expected.action === 'retention-update' && preparations !== 1) throw new Error('PREVIEW_RETENTION_REPLAY');
      return;
    }
  }
  throw new Error('PREVIEW_RETENTION_REPLAY');
}
