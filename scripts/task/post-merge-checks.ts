import { config, object, array, sameDatabase } from '../preview/preview-model';
import { PreviewProvider, type Transport } from '../preview/preview-provider';
import { PreviewService } from '../preview/preview-service';
import { StagingProvider } from '../preview/staging-service';
import { parseReceipt, assertReceipt, receiptNoticeTitle } from '../preview/preview-receipt';
import { fullSha } from './task-workflow';
import { positiveId, isoTime, failPostMerge, type MergedTask, type PostMergeCheck, type CheckName } from './post-merge-model';
import staging from '../../staging.config.json';

const prefix = `/repos/${config.repository}/`;
const pending = (code: string): PostMergeCheck => ({ status: 'pending', code });
const success = (code: string, extra: Partial<PostMergeCheck> = {}): PostMergeCheck => ({ status: 'success', code, ...extra });
const failure = (code: string, extra: Partial<PostMergeCheck> = {}): PostMergeCheck => ({ status: 'failure', code, ...extra });
const runUrl = (id: number) => `https://api.github.com${prefix}actions/runs/${id}`;

export class PostMergeChecks {
  constructor(readonly api: Transport) {}
  private async gh(path: string): Promise<unknown> { return this.api('github', prefix + path); }
  async mainSha(): Promise<string> {
    const branch = object(await this.gh('branches/main')), sha = object(branch.commit).sha;
    if (branch.name !== 'main' || !fullSha(sha)) return failPostMerge('MAIN_INVALID');
    return sha;
  }
  async assertBindings(): Promise<void> { await new PreviewProvider(this.api).assertBindings(); }

  private async latestRun(file: string, accepts: (run: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
    const workflow = object(await this.gh(`actions/workflows/${file}`));
    if (!positiveId(workflow.id) || workflow.path !== `.github/workflows/${file}` || workflow.state !== 'active') return failPostMerge('WORKFLOW_INVALID');
    const runs: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = object(await this.gh(`actions/workflows/${file}/runs?per_page=100&page=${page}`));
      const batch = array(result.workflow_runs).map(object);
      if (!Number.isSafeInteger(result.total_count) || Number(result.total_count) < 0 || batch.length > 100) return failPostMerge('RUNS_INVALID');
      runs.push(...batch);
      if (batch.some(accepts)) break;
      if (runs.length >= Number(result.total_count) || batch.length < 100) break;
      if (page === 10) return failPostMerge('RUNS_INCOMPLETE');
    }
    const selected = runs.filter(accepts).sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!selected) return undefined;
    if (!positiveId(selected.id)) return failPostMerge('RUN_INVALID');
    const run = object(await this.gh(`actions/runs/${selected.id}`));
    for (const repo of [run.repository, run.head_repository]) {
      if (object(repo).id !== config.repositoryId || object(repo).full_name !== config.repository) return failPostMerge('RUN_INVALID');
    }
    if (!positiveId(run.id) || run.id !== selected.id || !positiveId(run.run_attempt) || !positiveId(run.check_suite_id)
      || run.workflow_id !== workflow.id || run.path !== workflow.path || !fullSha(run.head_sha)
      || run.url !== runUrl(run.id) || !isoTime(run.created_at) || !isoTime(run.updated_at) || !accepts(run)) return failPostMerge('RUN_INVALID');
    return run;
  }

  private runState(run: Record<string, unknown> | undefined): PostMergeCheck | undefined {
    if (!run) return pending('RUN_NOT_CREATED');
    if (run.status !== 'completed') return pending('RUN_PENDING');
    if (run.conclusion !== 'success') return failure('RUN_NOT_SUCCESSFUL', { runId: Number(run.id) });
    return undefined;
  }

  /** Read only GitHub's official job check annotation, never job logs or arbitrary artifact URLs. */
  private async notice(run: Record<string, unknown>, jobName: string, title: string): Promise<string> {
    const response = object(await this.gh(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`));
    const jobs = array(response.jobs).map(object);
    if (jobs.length !== response.total_count || jobs.length > 100) return failPostMerge('JOBS_INCOMPLETE');
    const matches = jobs.filter(job => job.name === jobName);
    if (matches.length !== 1) return failPostMerge('JOB_INVALID');
    const job = matches[0], checkPrefix = `https://api.github.com${prefix}check-runs/`;
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha || job.head_branch !== run.head_branch
      || job.status !== 'completed' || job.conclusion !== 'success' || !positiveId(job.id)
      || typeof job.check_run_url !== 'string' || !job.check_run_url.startsWith(checkPrefix)) return failPostMerge('JOB_INVALID');
    const id = job.check_run_url.slice(checkPrefix.length);
    if (!/^[1-9][0-9]*$/.test(id) || !positiveId(Number(id))) return failPostMerge('CHECK_INVALID');
    const check = object(await this.gh(`check-runs/${id}`));
    if (check.id !== Number(id) || check.name !== jobName || check.url !== job.check_run_url || check.head_sha !== run.head_sha
      || object(check.check_suite).id !== run.check_suite_id || object(check.app).slug !== 'github-actions'
      || object(check.app).html_url !== 'https://github.com/apps/github-actions' || check.status !== 'completed' || check.conclusion !== 'success') return failPostMerge('CHECK_INVALID');
    const count = object(check.output).annotations_count;
    if (!positiveId(count) || Number(count) > 1000) return failPostMerge('ANNOTATIONS_INVALID');
    const annotations: Record<string, unknown>[] = [];
    for (let page = 1; annotations.length < Number(count); page++) {
      const batch = array(await this.gh(`check-runs/${id}/annotations?per_page=100&page=${page}`)).map(object);
      if (!batch.length || batch.length > 100) return failPostMerge('ANNOTATIONS_INVALID');
      annotations.push(...batch);
      if (annotations.length > Number(count)) return failPostMerge('ANNOTATIONS_INVALID');
    }
    const notices = annotations.filter(annotation => annotation.title === title);
    if (notices.length !== 1 || notices[0].annotation_level !== 'notice' || typeof notices[0].message !== 'string'
      || Buffer.byteLength(notices[0].message) > 4096 || notices[0].message.includes('***')) return failPostMerge('RECEIPT_INVALID');
    const fresh = object(await this.gh(`actions/runs/${run.id}`));
    if (['run_attempt', 'status', 'conclusion', 'updated_at', 'head_sha'].some(key => fresh[key] !== run[key])) return failPostMerge('RUN_CHANGED');
    return notices[0].message;
  }

  async ci(task: MergedTask): Promise<PostMergeCheck> {
    const run = await this.latestRun('ci.yml', run => run.head_sha === task.mergeSha && run.event === 'push' && run.head_branch === 'main');
    return this.runState(run) ?? success('CI_VERIFIED', { runId: Number(run!.id) });
  }

  async production(task: MergedTask): Promise<PostMergeCheck> {
    const project = object(await this.api('vercel', `/v9/projects/${config.vercelProjectId}`));
    if (project.id !== config.vercelProjectId || project.accountId !== config.vercelTeamId || object(project.link).repoId != config.repositoryId) return failPostMerge('PRODUCTION_BINDING');
    const rawTarget = object(project.targets).production;
    if (rawTarget == null) return pending('PRODUCTION_PENDING');
    const target = object(rawTarget), id = target.id;
    if (typeof id !== 'string' || !/^dpl_[A-Za-z0-9]+$/.test(id)) return pending('PRODUCTION_PENDING');
    const deployment = object(await this.api('vercel', `/v13/deployments/${id}`));
    const git = object(deployment.gitSource), meta = object(deployment.meta), [owner, repo] = config.repository.split('/');
    if (deployment.id !== id && deployment.uid !== id || deployment.projectId !== config.vercelProjectId || deployment.ownerId !== config.vercelTeamId
      || deployment.target !== 'production' || git.type !== 'github' || String(git.repoId) !== String(config.repositoryId)
      || git.ref !== 'main' || meta.githubCommitRef !== 'main' || meta.githubCommitOrg !== owner || meta.githubCommitRepo !== repo
      || meta.githubCommitSha !== git.sha || String(meta.githubRepoId) !== String(config.repositoryId)
      || !fullSha(git.sha) || Object.keys(meta).some(key => key.startsWith('cakePreview'))) return failPostMerge('PRODUCTION_IDENTITY');
    if (git.sha !== task.mergeSha) return pending('PRODUCTION_SHA_PENDING');
    const state = deployment.readyState ?? deployment.state;
    if (state === 'ERROR' || state === 'CANCELED') return failure('PRODUCTION_FAILED', { deploymentId: id });
    if (state !== 'READY') return pending('PRODUCTION_PENDING');
    const aliases = deployment.alias;
    if (deployment.aliasAssigned !== true || !Array.isArray(aliases) || !aliases.length || aliases.length > 100
      || !Array.isArray(target.alias) || !target.alias.length
      || target.alias.some(name => !aliases.includes(name))) return pending('PRODUCTION_ALIAS_PENDING');
    for (const name of aliases) {
      if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || name.length > 253) return failPostMerge('PRODUCTION_DOMAIN_INVALID');
      const alias = object(await this.api('vercel', `/v4/aliases/${encodeURIComponent(name)}`));
      if (alias.projectId !== config.vercelProjectId || alias.deploymentId !== id) return pending('PRODUCTION_ALIAS_PENDING');
    }
    return success('PRODUCTION_VERIFIED', { deploymentId: id });
  }

  async staging(task: MergedTask): Promise<PostMergeCheck> {
    const run = await this.latestRun('staging.yml', run => run.head_sha === task.mergeSha && run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(String(run.event)));
    const state = this.runState(run); if (state) return state;
    const receipt = object(JSON.parse(await this.notice(run!, 'staging', 'cake-staging/v1')));
    const provider = new StagingProvider(this.api), expected = await provider.main();
    const proofSource = object(receipt.source), browser = object(receipt.browser), deployed = object(receipt.deployment);
    if (receipt.protocol !== 'cake-staging/v1' || receipt.action !== 'deploy' || receipt.success !== true || receipt.controlSha !== task.mergeSha
      || receipt.runId !== String(run!.id) || receipt.runAttempt !== run!.run_attempt || receipt.alias !== `https://${staging.alias}`
      || JSON.stringify(proofSource) !== JSON.stringify(expected) || !isoTime(receipt.checkedAt)
      || !isoTime(browser.verifiedAt) || Date.parse(browser.verifiedAt) > Date.parse(receipt.checkedAt)
      || JSON.stringify(browser.cases) !== JSON.stringify(['desktop-a', 'desktop-b', 'mobile-a', 'mobile-b', 'read-api'])
      || !Array.isArray(browser.clicks) || browser.clicks.length !== 16 || !Array.isArray(browser.checks) || browser.checks.length !== 12) return failPostMerge('STAGING_RECEIPT_INVALID');
    for (const [rows, width] of [[browser.clicks, 4], [browser.checks, 3]] as const) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!Array.isArray(row) || row.length !== 3 || row[0] !== Math.floor(i / width) || row[1] !== i % width || !isoTime(row[2])
          || Date.parse(row[2]) > Date.parse(browser.verifiedAt)) return failPostMerge('STAGING_BROWSER_INVALID');
      }
    }
    const current = await new PreviewService(provider).status(expected), deployment = current.deployment;
    if (!deployment || !current.database || !sameDatabase(object(receipt.database) as typeof current.database, current.database)
      || JSON.stringify(deployed) !== JSON.stringify(deployment)) return failPostMerge('STAGING_CHANGED');
    const alias = object(await this.api('vercel', `/v4/aliases/${staging.alias}`));
    if (alias.projectId !== config.vercelProjectId || alias.deploymentId !== deployment.id) return failPostMerge('STAGING_ALIAS_CHANGED');
    return success('STAGING_VERIFIED', { runId: Number(run!.id), deploymentId: deployment.id });
  }

  async cleanup(task: MergedTask): Promise<PostMergeCheck> {
    const run = await this.latestRun('preview.yml', run =>
      run.head_branch === 'main' && (run.event === 'push' && run.head_sha === task.mergeSha
        || run.event === 'workflow_dispatch' && typeof run.display_title === 'string'
          && run.display_title.startsWith(`Preview cleanup PR ${task.source.pr} `)));
    // A failed sibling matrix job does not invalidate this PR's own proof.
    const state = run?.event === 'push'
      ? run.status !== 'completed' ? pending('RUN_PENDING')
        : !['success', 'failure'].includes(String(run.conclusion)) ? failure('RUN_NOT_SUCCESSFUL', { runId: Number(run.id) }) : undefined
      : this.runState(run);
    if (state) return state;
    const receipt = parseReceipt(await this.notice(run!, run!.event === 'push' ? `preview-cleanup-${task.source.pr}` : 'preview', run!.event === 'push'
      ? `cake-preview/v1 PR ${task.source.pr}` : receiptNoticeTitle));
    assertReceipt(receipt, { action: 'cleanup', source: task.source, operation: receipt.operation,
      runId: String(run!.id), runAttempt: Number(run!.run_attempt), controlSha: receipt.controlSha,
      notBefore: task.mergedAt, notAfter: new Date(Date.parse(String(run!.updated_at)) + 60_000).toISOString() });
    if (run!.event === 'push' && (receipt.operation !== null || receipt.controlSha !== task.mergeSha || receipt.controlSha !== run!.head_sha)
      || run!.event === 'workflow_dispatch' && (receipt.controlSha !== run!.head_sha || !receipt.operation
        || !String(run!.display_title).endsWith(receipt.operation))) return failPostMerge('CLEANUP_RECEIPT_INVALID');
    if (receipt.controlSha !== task.mergeSha) {
      const comparison = object(await this.gh(`compare/${receipt.controlSha}...${task.mergeSha}`));
      if (comparison.status !== 'ahead' && comparison.status !== 'identical') return failPostMerge('CLEANUP_CONTROL_CHANGED');
    }
    const provider = new PreviewProvider(this.api), current = await new PreviewService(provider).status(task.source);
    if (current.database || current.deployment || (await provider.deployments(task.source)).length) return failPostMerge('CLEANUP_RESOURCES_REMAIN');
    return success('CLEANUP_VERIFIED', { runId: Number(run!.id) });
  }

  async all(task: MergedTask): Promise<Record<CheckName, PostMergeCheck>> {
    const names = ['ci', 'production', 'staging', 'cleanup'] as const;
    const values = await Promise.all(names.map(async name => {
      try { return await this[name](task); }
      catch { return failure(`${name.toUpperCase()}_CHECK_FAILED`); }
    }));
    return Object.fromEntries(names.map((name, i) => [name, values[i]])) as Record<CheckName, PostMergeCheck>;
  }
}
