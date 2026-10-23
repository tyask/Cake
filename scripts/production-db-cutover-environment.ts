import { databaseConnectionString, previewDatabaseIdentity } from '../lib/database-connection.mjs';
import { config, hash, parseConnection, type Api, type Binding } from './production-db-migration-provider';

const scopes = ['DEFAULT', 'MAIN', 'BUILD', 'RUNTIME'] as const;
const reasons = ['SHAPE', 'VALUE_TYPE', 'CONTEXT', 'TEST_AUTH', 'TLS', 'PREVIEW', 'DATABASE_MISSING', 'DATABASE_EMPTY',
  'DATABASE_REDACTED', 'URI_INVALID', 'ROLE_MISMATCH', 'DATABASE_MISMATCH', 'ENDPOINT_MISMATCH', 'HOST_MISMATCH',
  'PASSWORD', 'PORT', 'SSLMODE', 'URL_OPTIONS', 'CONNECTION', 'SECRET_METADATA'] as const;
export type ProductionEnvironmentScope = typeof scopes[number];
export type ProductionEnvironmentReason = typeof reasons[number];
export type EnvironmentFailureCode = `ENVIRONMENT_${ProductionEnvironmentScope}_${ProductionEnvironmentReason}`;
export const environmentFailureCodes: readonly EnvironmentFailureCode[] = Object.freeze(scopes.flatMap(scope =>
  reasons.map(reason => `ENVIRONMENT_${scope}_${reason}` as EnvironmentFailureCode)));

/** Only fixed labels enter an error; raw environment values and original exceptions are never retained. */
export class ProductionEnvironmentError extends Error {
  readonly code: EnvironmentFailureCode;
  constructor(scope: ProductionEnvironmentScope, reason: ProductionEnvironmentReason) {
    const code: EnvironmentFailureCode = scopes.includes(scope) && reasons.includes(reason)
      ? `ENVIRONMENT_${scope}_${reason}` : 'ENVIRONMENT_DEFAULT_SHAPE';
    super(code); this.name = 'ProductionEnvironmentError'; this.code = code;
  }
}

/** Validate resolved Production values in memory, without returning a URI or decoded credential. */
export function validateProductionEnvironment(value: unknown, expected: Binding, scope: ProductionEnvironmentScope, requireDatabase = true): void {
  const fail = (reason: ProductionEnvironmentReason): never => { throw new ProductionEnvironmentError(scope, reason); };
  try {
    if (!scopes.includes(scope)) return fail('CONTEXT');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('SHAPE');
    const variables = value as Record<string, unknown>;
    if (Object.values(variables).some(item => typeof item !== 'string')) return fail('VALUE_TYPE');
    if (variables.VERCEL_ENV !== undefined && variables.VERCEL_ENV !== 'production') return fail('CONTEXT');
    if (variables.AUTH_MODE === 'test') return fail('TEST_AUTH');
    if (variables.NODE_TLS_REJECT_UNAUTHORIZED === '0') return fail('TLS');
    if (Object.keys(variables).some(key => key.startsWith('CAKE_PREVIEW'))) return fail('PREVIEW');
    const environment = { ...variables, VERCEL_ENV: 'production' } as Record<string, string>;
    try { previewDatabaseIdentity(environment); } catch { return fail('PREVIEW'); }
    if (!requireDatabase && !Object.hasOwn(variables, 'DATABASE_URL')) return;
    if (!Object.hasOwn(variables, 'DATABASE_URL')) return fail('DATABASE_MISSING');
    const databaseUrl = environment.DATABASE_URL.trim();
    if (!databaseUrl) return fail('DATABASE_EMPTY');
    if (databaseUrl === '[SENSITIVE]') return fail('DATABASE_REDACTED');
    let url: URL, user: string, password: string, database: string;
    try {
      url = new URL(databaseConnectionString(environment));
      user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); database = decodeURIComponent(url.pathname.slice(1));
    } catch { return fail('URI_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) return fail('URI_INVALID');
    if (url.port && url.port !== '5432') return fail('PORT');
    if (user !== expected.role) return fail('ROLE_MISMATCH');
    if (database !== expected.database) return fail('DATABASE_MISMATCH');
    if (!password || /[\u0000-\u001f\u007f]/.test(password)) return fail('PASSWORD');
    url.hostname = url.hostname.replace(/-pooler(?=\.)/, '');
    if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname)) return fail('HOST_MISMATCH');
    if (!url.hostname.startsWith(`${expected.endpointId}.`)) return fail('ENDPOINT_MISMATCH');
    if (hash(url.hostname) !== expected.hostDigest) return fail('HOST_MISMATCH');
    for (const key of url.searchParams.keys()) {
      if (url.searchParams.getAll(key).length !== 1 || !['sslmode', 'channel_binding'].includes(key)
        || key === 'channel_binding' && url.searchParams.get(key) !== 'require') return fail('URL_OPTIONS');
    }
    if (url.searchParams.get('sslmode') !== 'require') return fail('SSLMODE');
    // Keep the shared strict connection validator authoritative if its rules change.
    try { parseConnection(url.href, expected); } catch { return fail('CONNECTION'); }
  } catch (error) {
    if (error instanceof ProductionEnvironmentError) throw error;
    return fail('SHAPE');
  }
}

/** A masked value is acceptable only when the provider identifies this Production variable as a Secret. */
export async function assertProductionSecretDatabase(api: Api, scope: ProductionEnvironmentScope): Promise<void> {
  const response = await api('vercel', `/v10/projects/${config.vercelProjectId}/env?decrypt=false`);
  const fail = (): never => { throw new ProductionEnvironmentError(scope, 'SECRET_METADATA'); };
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return fail();
  const envs = (response as Record<string, unknown>).envs;
  if (!Array.isArray(envs)) return fail();
  const applicable: Record<string, unknown>[] = [];
  for (const value of envs) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>;
    if (row.key !== 'DATABASE_URL') continue;
    const targets = typeof row.target === 'string' ? [row.target] : row.target;
    if (!Array.isArray(targets) || targets.some(target => typeof target !== 'string')) return fail();
    if (!targets.includes('production')) continue;
    if (row.gitBranch != null) return fail();
    applicable.push(row);
  }
  if (applicable.length !== 1 || !(applicable[0].type === 'sensitive' || applicable[0].visibility === 'secret')) return fail();
}

/** Provider exports hide Secrets; readable values still use the complete strict connection check. */
export async function assertProviderProductionEnvironment(api: Api, value: unknown, expected: Binding,
  scope: ProductionEnvironmentScope, requireDatabase = true): Promise<void> {
  try { validateProductionEnvironment(value, expected, scope, requireDatabase); }
  catch (error) {
    if (!(error instanceof ProductionEnvironmentError)
      || ![`ENVIRONMENT_${scope}_DATABASE_EMPTY`, `ENVIRONMENT_${scope}_DATABASE_REDACTED`].includes(error.code)) throw error;
    await assertProductionSecretDatabase(api, scope);
    // Recheck all non-DB guards; Native connection metadata remains the binding source for hidden Secrets.
    const visible = { ...(value as Record<string, unknown>) }; delete visible.DATABASE_URL;
    validateProductionEnvironment(visible, expected, scope, false);
  }
}

/** Only these two fixed GET routes can retrieve the effective project environment. */
export async function assertProductionProjectEnvironment(api: Api, expected: Binding): Promise<void> {
  for (const [suffix, scope] of [['', 'DEFAULT'], ['/main', 'MAIN']] as const) {
    const response = await api('vercel', `/v3/env/pull/${config.vercelProjectId}/production${suffix}`);
    if (response === null || typeof response !== 'object' || Array.isArray(response)) throw new ProductionEnvironmentError(scope, 'SHAPE');
    await assertProviderProductionEnvironment(api, (response as Record<string, unknown>).env, expected, scope);
  }
}
