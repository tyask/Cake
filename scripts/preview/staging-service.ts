import { config, object, text, type Source, type Deployment } from './preview-model';
import { fullSha } from '../task/task-workflow';
import { PreviewProvider } from './preview-provider';
import { PreviewService } from './preview-service';
import staging from '../../staging.config.json';

/** A reserved mirror of main. PR APIs and cleanup never accept this source. */
export class StagingProvider extends PreviewProvider {
  async main(): Promise<Source> {
    const repository = object(await this.api('github', `/repos/${config.repository}`));
    const ref = object(await this.api('github', `/repos/${config.repository}/git/ref/heads/main`));
    const sha = object(ref.object).sha;
    if (repository.id !== config.repositoryId || repository.full_name !== config.repository || !fullSha(sha)
      || !Number.isFinite(Date.parse(String(repository.created_at)))) throw new Error('PREVIEW_STAGING_SOURCE');
    return { pr: 0, branch: staging.branch, sha, state: 'open', createdAt: text(repository.created_at) };
  }
  override async pr(): Promise<Source> { throw new Error('PREVIEW_STAGING_NO_PR'); }
  override async assertSource(expected: Source, state = expected.state): Promise<void> {
    const current = await this.main();
    const ref = object(await this.api('github', `/repos/${config.repository}/git/ref/heads/${staging.branch}`));
    if (state !== 'open' || expected.pr !== 0 || expected.branch !== staging.branch || expected.sha !== current.sha
      || expected.createdAt !== current.createdAt || object(ref.object).sha !== expected.sha) throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
  }
  async assertProtection(): Promise<void> {
    const project = object(await this.api('vercel', `/v9/projects/${config.vercelProjectId}`));
    if (!['all_except_custom_domains', 'prod_deployment_urls_and_all_previews', 'all'].includes(String(object(project.ssoProtection).deploymentType)))
      throw new Error('PREVIEW_STAGING_PROTECTION_REQUIRED');
  }
  async sync(expected: Source): Promise<void> {
    await this.assertBindings(); await this.assertProtection();
    if ((await this.main()).sha !== expected.sha || expected.pr !== 0 || expected.branch !== staging.branch) throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
    const path = `/repos/${config.repository}/git/refs/heads/${staging.branch}`;
    const value = await this.api('github', `/repos/${config.repository}/git/ref/heads/${staging.branch}`, 'GET', undefined, true);
    if (value === null) {
      // Never adopt a database/deployment left behind after somebody deleted the mirror.
      if ((await this.deployments(expected)).length || await this.database(expected, 0)) throw new Error('PREVIEW_STAGING_UNOWNED');
      await this.api('github', `/repos/${config.repository}/git/refs`, 'POST', { ref: `refs/heads/${staging.branch}`, sha: expected.sha });
    } else {
      const previous = text(object(object(value).object).sha);
      if (previous !== expected.sha) {
        // A first run may have created the mirror but stopped before its first
        // Deployment. Permit recovery only along main history, without force.
        const deployments = await this.deployments(expected);
        if (!deployments.length && await this.database(expected, 0)) throw new Error('PREVIEW_STAGING_UNOWNED');
        const comparison = object(await this.api('github', `/repos/${config.repository}/compare/${previous}...${expected.sha}`));
        if (comparison.status !== 'ahead') throw new Error('PREVIEW_STAGING_NON_FAST_FORWARD');
        await this.api('github', path, 'PATCH', { sha: expected.sha, force: false });
      }
    }
    await this.assertSource(expected);
  }
  async alias(expected: Source, deployment: Deployment): Promise<void> {
    await this.assertSource(expected); await this.assertProtection();
    const current = await new PreviewService(this).status(expected);
    if (current.deployment?.id !== deployment.id) throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
    const path = `/v4/aliases/${staging.alias}`;
    const existing = await this.api('vercel', path, 'GET', undefined, true);
    if (existing !== null) {
      const value = object(existing);
      const previous = value.deploymentId;
      const inventory = await this.deployments(expected);
      if (value.projectId !== config.vercelProjectId || !inventory.some(d => d.id === previous)) throw new Error('PREVIEW_STAGING_ALIAS_CONFLICT');
      if (previous === deployment.id) return;
    }
    await this.api('vercel', `/v2/deployments/${deployment.id}/aliases`, 'POST', { alias: staging.alias });
    const result = object(await this.api('vercel', path));
    if (result.projectId !== config.vercelProjectId || result.deploymentId !== deployment.id) throw new Error('PREVIEW_STAGING_ALIAS_UNCONFIRMED');
    await this.assertSource(expected);
  }
}
