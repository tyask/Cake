import { createHash } from 'node:crypto';
import { databaseConnectionString, previewDatabaseIdentity } from './database-environment';
type Environment = Readonly<Record<string, string | undefined>>;
export function previewRuntimeProofHandler(dependencies: { environment: () => Environment; database: () => { query(statement: string, parameters: unknown[]): PromiseLike<readonly Record<string, unknown>[]> } }) {
  return async (request: Request): Promise<Response> => {
    const env = dependencies.environment();
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
    if (env.VERCEL_ENV !== 'preview' || env.AUTH_MODE !== 'test') return reply({ code: 'NOT_FOUND' }, 404);
    if (request.method !== 'GET') return reply({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const u = new URL(request.url), nonce = u.searchParams.get('nonce');
    if (u.pathname !== '/api/qa/preview' || u.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(nonce ?? '')) return reply({ code: 'INPUT_INVALID' }, 400);
    try {
      const connection = databaseConnectionString(env), identity = previewDatabaseIdentity(env);
      if (!identity || !/^dpl_[A-Za-z0-9]+$/.test(env.VERCEL_DEPLOYMENT_ID ?? '')) throw new Error();
      const rows = await dependencies.database().query(`SELECT 1 AS verified WHERE
        (SELECT count(*) FROM public.cake_preview_database_identity) = 1 AND EXISTS (
        SELECT 1 FROM public.cake_preview_database_identity WHERE singleton AND version = 2 AND repository = $1 AND pr = $2
        AND generation = $3::uuid AND source_branch = $4 AND branch_id = $5 AND database_host = $6 AND database_name = $7 AND database_name = current_database())`,
      [identity.repository, identity.pr, identity.generation, identity.sourceBranch, identity.branchId, identity.databaseHost, identity.databaseName]);
      if (rows.length !== 1 || rows[0].verified !== 1) throw new Error();
      const databaseHostDigest = createHash('sha256').update(new URL(connection).hostname.replace(/-pooler(?=\.)/, '')).digest('hex');
      return reply({ protocol: 'cake-preview/v1', nonce, deploymentId: env.VERCEL_DEPLOYMENT_ID,
        pr: identity.pr, generation: identity.generation, branch: identity.sourceBranch, sha: env.VERCEL_GIT_COMMIT_SHA,
        database: { branchId: identity.branchId, hostDigest: databaseHostDigest }, connectionVerified: true });
    } catch { return reply({ code: 'PREVIEW_RUNTIME_UNAVAILABLE' }, 503); }
  };
}
