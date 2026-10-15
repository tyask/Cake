import { spawnSync } from 'node:child_process';

export interface CanneleProfile {
  origin: string; instanceId: string; appId: string; configDigest: string;
  repository: { id: number; fullName: 'tyask/Cake' }; baseBranch: 'main';
  vercelProjectId: string; vercelTeamId: string; neonProjectId: string; registrySchemaVersion: number;
  featureBranchPrefix: string; acceptedPrCreatedAfter: string | null; requiredFeatures: string[];
}
export interface CakeCanneleConfiguration {
  protocol: 'cake-cannele/v1'; enabled: boolean; sourceRevision: string | null; profile: CanneleProfile | null;
}
export class CanneleIntegrationError extends Error {
  constructor(readonly code: string) { super('Canneleの設定・実行を確認できませんでした。秘密情報や外部エラーは表示しません。'); this.name = 'CanneleIntegrationError'; }
}
export interface GitResult { status: number | null; stdout: string }
export type ConfigurationGit = (cwd: string, args: readonly string[]) => GitResult;
export const executeConfigurationGit: ConfigurationGit = (cwd, args) => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 1_000_000 });
  if (result.error || result.signal) throw new CanneleIntegrationError('CANNELE_GIT_UNAVAILABLE');
  return { status: result.status, stdout: result.stdout };
};

const disabled: CakeCanneleConfiguration = { protocol: 'cake-cannele/v1', enabled: false, sourceRevision: null, profile: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new CanneleIntegrationError('CANNELE_CONFIG_INVALID'); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) return invalid();
  return result;
}
function text(value: unknown, pattern: RegExp, maximum = 255): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || !pattern.test(value)) return invalid();
  return value;
}
function positive(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 1) return invalid(); return Number(value); }

export function parseCakeCanneleConfiguration(value: unknown): CakeCanneleConfiguration {
  const config = object(value, ['protocol', 'enabled', 'sourceRevision', 'profile']);
  if (config.protocol !== 'cake-cannele/v1' || typeof config.enabled !== 'boolean') return invalid();
  const sourceRevision = config.sourceRevision === null ? null : text(config.sourceRevision, /^[0-9a-f]{40}$/);
  let profile: CanneleProfile | null = null;
  if (config.profile !== null) {
    const p = object(config.profile, ['origin', 'instanceId', 'appId', 'configDigest', 'repository', 'baseBranch', 'vercelProjectId', 'vercelTeamId',
      'neonProjectId', 'registrySchemaVersion', 'featureBranchPrefix', 'acceptedPrCreatedAfter', 'requiredFeatures']);
    const origin = text(p.origin, /^https:\/\//, 2048);
    let url: URL; try { url = new URL(origin); } catch { return invalid(); }
    if (url.origin !== origin || url.username || url.password || url.hash || url.search) return invalid();
    const repository = object(p.repository, ['id', 'fullName']);
    if (repository.fullName !== 'tyask/Cake' || p.baseBranch !== 'main' || p.vercelProjectId !== 'prj_Z37vquodhpRd08ZTAtYnP0qa59jD'
      || p.vercelTeamId !== 'team_D1Mcx2TdFWPKcypfu8KzNMub' || p.neonProjectId !== 'misty-meadow-88903426') return invalid();
    const acceptedPrCreatedAfter = p.acceptedPrCreatedAfter === null ? null : text(p.acceptedPrCreatedAfter, /^\d{4}-\d{2}-\d{2}T/);
    if (acceptedPrCreatedAfter !== null && !Number.isFinite(Date.parse(acceptedPrCreatedAfter))) return invalid();
    const features = p.requiredFeatures;
    if (!Array.isArray(features) || features.length < 1 || features.length > 32 || new Set(features).size !== features.length) return invalid();
    profile = { origin, instanceId: text(p.instanceId, UUID), appId: text(p.appId, /^[a-z0-9-]+$/, 64), configDigest: text(p.configDigest, /^[0-9a-f]{64}$/),
      repository: { id: positive(repository.id), fullName: 'tyask/Cake' }, baseBranch: 'main', vercelProjectId: String(p.vercelProjectId), vercelTeamId: String(p.vercelTeamId),
      neonProjectId: String(p.neonProjectId), registrySchemaVersion: positive(p.registrySchemaVersion),
      featureBranchPrefix: text(p.featureBranchPrefix, /^codex\/[a-z0-9]+(?:-[a-z0-9]+)*-$/, 64), acceptedPrCreatedAfter,
      requiredFeatures: features.map(feature => text(feature, /^[a-z][a-z0-9_-]*$/, 64)) };
  }
  if (config.enabled && (!sourceRevision || !profile)) return invalid();
  return { protocol: config.protocol, enabled: config.enabled, sourceRevision, profile };
}

export function gitOutput(git: ConfigurationGit, cwd: string, args: readonly string[]): string {
  let result: GitResult;
  try { result = git(cwd, args); } catch { throw new CanneleIntegrationError('CANNELE_GIT_UNAVAILABLE'); }
  if (result.status !== 0) throw new CanneleIntegrationError('CANNELE_GIT_UNAVAILABLE');
  return result.stdout.trim();
}

/** The feature checkout's JSON is never authoritative. Fetch failure, malformed
 * configuration and a nonregular main blob cannot fall back to legacy writes. */
export function loadReviewedCanneleConfiguration({ cwd, fetch = true, git = executeConfigurationGit }:
  { cwd: string; fetch?: boolean; git?: ConfigurationGit }): CakeCanneleConfiguration {
  if (fetch) gitOutput(git, cwd, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const main = gitOutput(git, cwd, ['rev-parse', '--verify', 'refs/remotes/origin/main']);
  if (!/^[0-9a-f]{40}$/.test(main)) throw new CanneleIntegrationError('CANNELE_GIT_UNAVAILABLE');
  const tree = gitOutput(git, cwd, ['ls-tree', main, '--', 'cannele.config.json']);
  if (!tree) return { ...disabled };
  if (!/^100644 blob [0-9a-f]{40}\tcannele\.config\.json$/.test(tree)) return invalid();
  const remote = gitOutput(git, cwd, ['remote', 'get-url', 'origin']);
  if (!/^(?:https:\/\/github\.com\/tyask\/Cake(?:\.git)?|git@github\.com:tyask\/Cake(?:\.git)?|ssh:\/\/git@github\.com\/tyask\/Cake(?:\.git)?)$/.test(remote)) throw new CanneleIntegrationError('CANNELE_ORIGIN_UNTRUSTED');
  const contents = gitOutput(git, cwd, ['show', `${main}:cannele.config.json`]);
  if (Buffer.byteLength(contents) > 65_536) return invalid();
  try { return parseCakeCanneleConfiguration(JSON.parse(contents)); }
  catch (error) { if (error instanceof CanneleIntegrationError) throw error; return invalid(); }
}
