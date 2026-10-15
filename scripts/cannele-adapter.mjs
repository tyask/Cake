import { tsImport } from 'tsx/esm/api';

const failure = code => { const error = new Error('CakeのQA手順を完了できませんでした。'); error.code = code; return error; };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Loaded only by the reviewed, enabled Cannele configuration. No credentials
 * are returned to the shared workflow or included in deployment overrides.
 */
export async function createApplicationAdapter({ profile, cwd, readyOptions, execute, environment = process.env }) {
  const task = await tsImport('./task-workflow.ts', import.meta.url);
  const run = execute ?? task.executeWorkflowCommand;
  if (profile.repository.fullName !== task.CAKE_REPOSITORY || profile.vercelProjectId !== task.CAKE_VERCEL_PROJECT
    || profile.vercelTeamId !== 'team_D1Mcx2TdFWPKcypfu8KzNMub' || profile.neonProjectId !== 'misty-meadow-88903426'
    || profile.baseBranch !== 'main') throw failure('CAKE_BINDING_MISMATCH');
  const source = async () => {
    const head = await task.cleanTaskHead(cwd, run); const mainSha = await task.assertTaskGitGate(head, run);
    const base = await task.commandOutput(run, 'git', ['merge-base', head.sha, mainSha], head.cwd, failure('CAKE_BASE_STALE').message);
    if (base !== mainSha) throw failure('CAKE_BASE_STALE');
    const remote = await task.commandOutput(run, 'git', ['ls-remote', '--heads', 'origin', `refs/heads/${head.branch}`], head.cwd, failure('CAKE_PUSH_MISMATCH').message);
    if (remote !== `${head.sha}\trefs/heads/${head.branch}`) throw failure('CAKE_PUSH_MISMATCH');
    const pr = (await task.taskPullRequests(head, run))[0];
    if (!pr || pr.headRefOid !== head.sha || !head.branch.startsWith(profile.featureBranchPrefix)) throw failure('CAKE_PR_MISMATCH');
    return { cwd: head.cwd, branch: head.branch, sourceSha: head.sha, prNumber: pr.number, draft: pr.isDraft };
  };
  const adapter = {
    source,
    async assertSource(expected) {
      const current = await source();
      if (['cwd', 'branch', 'sourceSha', 'prNumber'].some(key => current[key] !== expected[key])) throw failure('CAKE_SOURCE_CHANGED');
    },
    deploymentEnvironment({ profile: actual, source: head, lease, attemptId, phase }) {
      if (actual.instanceId !== profile.instanceId || lease.prNumber !== head.prNumber || lease.branch !== head.branch
        || lease.sourceSha !== head.sourceSha || lease.state !== 'reserved' || !digest(lease.productionHostDigest)
        || phase === 'application' && (!lease.database || !digest(lease.databaseHostDigest)
          || lease.databaseHostDigest === lease.productionHostDigest || lease.database.projectId !== profile.neonProjectId)) throw failure('CAKE_DATABASE_GUARD_UNCONFIRMED');
      return { AUTH_MODE: 'test', CAKE_QA_SLOT: lease.slot, CAKE_QA_PR: String(head.prNumber), CAKE_QA_LEASE_TOKEN: lease.leaseId,
        CAKE_QA_SOURCE_BRANCH: head.branch, CAKE_QA_SOURCE_SHA: head.sourceSha,
        CAKE_QA_DATABASE_HOST_SHA256: phase === 'application' ? lease.databaseHostDigest : '',
        CAKE_QA_PRODUCTION_DATABASE_HOST_SHA256: lease.productionHostDigest,
        CANNELE_INSTANCE_ID: profile.instanceId, CANNELE_ATTEMPT_ID: attemptId, CANNELE_PHASE: phase };
    },
    async verify(proof) {
      const head = await source();
      if (proof.prNumber !== head.prNumber || proof.sourceSha !== head.sourceSha || proof.database.projectId !== profile.neonProjectId
        || !digest(proof.databaseHostDigest) || !digest(proof.productionHostDigest) || proof.databaseHostDigest === proof.productionHostDigest) throw failure('CAKE_PROOF_MISMATCH');
      const browser = await import('./cannele-browser.mjs');
      return browser.verifyCakeBrowser(proof, { profile, cwd: head.cwd, source: head, environment });
    },
  };
  if (readyOptions) adapter.ready = async context => {
    const ready = await tsImport('./cannele-ready.ts', import.meta.url);
    await ready.runCanneleReady({ ...context, ...readyOptions, cwd, execute: run });
  };
  return adapter;
}
