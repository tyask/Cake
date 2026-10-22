import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StagingProvider } from '../scripts/staging-service';
import { config, type Source, type Deployment } from '../scripts/preview-model';
import { PreviewService } from '../scripts/preview-service';
import { type Transport } from '../scripts/preview-provider';
import { databaseConnectionString, previewDatabaseIdentity } from '../lib/database-environment';
import { activeTestUsers } from '../lib/test-fixture-context';
import { QA_TEST_USERS } from '../lib/test-users';
import { provisioningBuild } from '../scripts/preview-provisioning';
import staging from '../staging.config.json';
const sha = 'a'.repeat(40), generation = '10000000-0000-4000-8000-000000000001';
const source: Source = { pr: 0, branch: staging.branch, sha, createdAt: '2026-01-01T00:00:00Z', state: 'open' };
const environment = {
  VERCEL_ENV: 'preview', AUTH_MODE: 'test', AUTH_SECRET: 'test-only', CAKE_PREVIEW_KIND: 'main',
  CAKE_PREVIEW_PHASE: 'application', CAKE_PREVIEW_REPOSITORY: config.repository, CAKE_PREVIEW_PR: '0',
  CAKE_PREVIEW_GENERATION: generation, CAKE_PREVIEW_SOURCE_BRANCH: staging.branch, VERCEL_GIT_COMMIT_REF: staging.branch,
  CAKE_PREVIEW_SOURCE_SHA: sha, VERCEL_GIT_COMMIT_SHA: sha,
  CAKE_PREVIEW_DATABASE_BRANCH_ID: 'br-staging', CAKE_TEST_DATABASE_URL: 'postgresql://user:private@ep-staging.ap-southeast-1.aws.neon.tech/cake',
  CAKE_PREVIEW_DATABASE_HOST_SHA256: createHash('sha256').update('ep-staging.ap-southeast-1.aws.neon.tech').digest('hex'),
  CAKE_PREVIEW_PRODUCTION_HOST_SHA256: config.productionHostDigest,
};
test('常設Previewは専用branch・kind・予約ID・DBを照合し、PR用と同じA/Bを使う', () => {
  assert.equal(databaseConnectionString(environment), environment.CAKE_TEST_DATABASE_URL);
  assert.equal(activeTestUsers(environment), QA_TEST_USERS);
  for (const change of [ { CAKE_PREVIEW_KIND: undefined }, { CAKE_PREVIEW_KIND: 'other' }, { CAKE_PREVIEW_PR: '1' },
    { CAKE_PREVIEW_SOURCE_BRANCH: 'main', VERCEL_GIT_COMMIT_REF: 'main' },
    { CAKE_PREVIEW_SOURCE_BRANCH: 'codex/feature', VERCEL_GIT_COMMIT_REF: 'codex/feature' },
    { VERCEL_ENV: 'production' }, { DATABASE_URL: environment.CAKE_TEST_DATABASE_URL },
    { CAKE_PREVIEW_DATABASE_HOST_SHA256: config.productionHostDigest }, { CAKE_PREVIEW_SOURCE_SHA: 'b'.repeat(40) } ])
    assert.throws(() => databaseConnectionString({ ...environment, ...change }));
  assert.deepEqual(previewDatabaseIdentity({ ...environment, CAKE_PREVIEW_SOURCE_SHA: 'b'.repeat(40), VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) }), previewDatabaseIdentity(environment));
  assert.equal(provisioningBuild({ ...environment, CAKE_PREVIEW_PHASE: 'provisioning', CAKE_PREVIEW_DATABASE_BRANCH_ID: '', CAKE_PREVIEW_DATABASE_HOST_SHA256: '' }), true);
});
function fixture() {
  let comparison = 'ahead';
  let deploymentCreatedAt = Date.parse('2026-10-18T13:40:00Z');
  let deploymentCounter = 0;
  let mirror: string | undefined, main = sha, protection = 'all_except_custom_domains', alias: unknown = null;
  const writes: {provider: string; path: string; method: string; body: unknown}[] = [];
  const deployments: Record<string, unknown>[] = [], branches: unknown[] = [], endpoints: unknown[] = [];
  const branch = { id: 'br-staging', project_id: config.neonProjectId, parent_id: config.neonParentBranchId, name: `preview/${staging.branch}`, default: false, protected: false, created_at: '2026-10-18T13:40:01Z' };
  const endpoint = { id: 'ep-staging', project_id: config.neonProjectId, branch_id: branch.id, type: 'read_write', host: 'ep-staging.ap-southeast-1.aws.neon.tech' };
  const api: Transport = async (provider, path, method = 'GET', body) => {
    if (method !== 'GET') writes.push({provider, path, method, body});
    if (provider === 'github') {
      if (path.endsWith('/tyask/Cake')) return { id: config.repositoryId, full_name: config.repository, created_at: source.createdAt };
      if (path.endsWith('/git/ref/heads/main')) return {object: {sha: main}};
      if (path.endsWith(`/git/ref/heads/${staging.branch}`)) return mirror ? {object: {sha: mirror}} : null;
      if (method === 'POST' || method === 'PATCH') { mirror = (body as {sha:string}).sha; return {}; }
      if (path.includes('/compare/')) return {status: comparison};
      if (path.endsWith('/branches/main')) return {commit: {sha: main}};
      if (path.includes('/contents/vercel.json?')) return {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({git: {deploymentEnabled: {'**': false, main: true}}})).toString('base64')};
    }
    if (provider === 'vercel') {
      if (path.startsWith('/v9/projects/')) return { id: config.vercelProjectId, accountId: config.vercelTeamId, link: {repoId: config.repositoryId}, ssoProtection: {deploymentType: protection} };
      if (path.startsWith('/v6/deployments')) return {deployments, pagination: {next: null}};
      if (path.startsWith('/v4/aliases/')) return alias;
      if (path.includes('/aliases') && method === 'POST') { alias = {projectId: config.vercelProjectId, deploymentId: path.split('/')[3]}; return {}; }
      if (method === 'POST') {
        const b = body as {meta: Record<string, string>; env:Record<string,string>};
        assert.equal(b.env.CAKE_PREVIEW_KIND, 'main'); assert.equal(b.env.CAKE_PREVIEW_PR, '0');
        assert.ok(!('CAKE_TEST_DATABASE_URL' in b.env));
        if (b.meta.cakePreviewPhase === 'provisioning') {branches.push(branch); endpoints.push(endpoint);}
        const deploymentIndex = deploymentCounter++;
        const d = {id: `dpl_stage${deploymentIndex}`, projectId: config.vercelProjectId, target: null, url: `cake-stage${deploymentIndex}.vercel.app`,
          gitSource: {type:'github', repoId:config.repositoryId, ref:staging.branch, sha:main}, meta:b.meta, readyState:'READY', createdAt:deploymentCreatedAt};
        deployments.push(d); return d;
      }
      return deployments.find(d => d.id === path.split('/').at(-1));
    }
    if (provider === 'neon') {
      if (path === `/projects/${config.neonProjectId}`) return {project:{id:config.neonProjectId}};
      if (path.endsWith(`/branches/${config.neonParentBranchId}`)) return {branch:{id:config.neonParentBranchId,project_id:config.neonProjectId}};
      if (path.includes('/branches?')) return {branches, pagination:{}};
      if (path.endsWith('/endpoints')) return {endpoints};
      if (path.endsWith('/branches/br-staging')) return {branch};
      if (path.endsWith('/endpoints/ep-staging')) return {endpoint};
    }
    throw new Error(`Unexpected ${provider} ${method} ${path}`);
  };
  const provider = new StagingProvider(api), service = new PreviewService(provider, async()=>{});
  return {provider, service, writes, deployments, branch, setMain:(value:string)=>{main=value;}, setMirror:(value:string)=>{mirror=value;},
    setDeploymentCreatedAt:(value:number)=>{deploymentCreatedAt=value;},
    diverge:()=>{comparison='diverged';}, unprotect:()=>{protection='none';}, setAlias:(value:unknown)=>{alias=value;}};
}
test('mainをfast-forward同期し、Native準備→application→固定alias、次のmainでも同じDB・世代を保持する', async () => {
  const f = fixture(); await f.provider.sync(source);
  const first = await f.service.deploy(source, generation);
  await f.provider.alias(source, first.deployment!);
  assert.equal(f.writes.filter(w=>w.provider==='github').length,1);
  const next = {...source, sha:'b'.repeat(40)}; f.setMain(next.sha); await f.provider.sync(next);
  const second = await f.service.deploy(next, '20000000-0000-4000-8000-000000000002');
  assert.deepEqual(second.database, first.database); assert.equal(second.deployment?.generation, first.deployment?.generation);
  assert.equal(f.writes.filter(w=>w.path.includes('forceNew')).length,3);
  assert.deepEqual(f.writes.find(w=>w.method==='PATCH')?.body,{sha:next.sha,force:false});
  assert.ok(!f.writes.some(w=>w.method==='DELETE'));
  await assert.rejects(f.service.cleanup({...next,state:'closed'}), /SOURCE_CHANGED/);
});
test('準備用Deployment消失後も古い常設DBを保持して新しいmainを配置し、aliasを更新する', async () => {
  const f = fixture(); await f.provider.sync(source);
  const first = await f.service.deploy(source, generation);
  await f.provider.alias(source, first.deployment!);
  // Native DB precedes the first application by several minutes. Retention has
  // removed the original provisioning record, leaving only its application.
  f.deployments.splice(0, 1);
  f.deployments[0].createdAt = Date.parse('2026-10-18T13:49:00Z');
  assert.ok(Date.parse(f.branch.created_at) < Number(f.deployments[0].createdAt) - 60_000);
  const writesBefore = f.writes.length;
  const next = {...source, sha:'b'.repeat(40)};
  f.setMain(next.sha); f.setDeploymentCreatedAt(Date.parse('2026-10-22T12:00:00Z'));
  await f.provider.sync(next);
  const second = await f.service.deploy(next, '20000000-0000-4000-8000-000000000002');
  await f.provider.alias(next, second.deployment!);
  assert.deepEqual(second.database, first.database);
  assert.equal(second.deployment?.generation, first.deployment?.generation);
  assert.equal(second.deployment?.sha, next.sha);
  assert.notEqual(second.deployment?.id, first.deployment?.id);
  assert.equal((await f.service.status(next)).deployment?.id, second.deployment?.id);
  const updates = f.writes.slice(writesBefore);
  const creates = updates.filter(w=>w.path.includes('forceNew'));
  assert.equal(creates.length, 1);
  assert.equal((creates[0].body as {meta:{cakePreviewPhase:string}}).meta.cakePreviewPhase, 'application');
  assert.equal(updates.filter(w=>w.path.includes('/aliases') && w.method==='POST').length, 1);
  assert.ok(!updates.some(w=>w.provider==='neon' || w.method==='DELETE'));
});
test('保護なし・mainの変化・管理外branch/aliasでは書込や上書きを停止する', async () => {
  const unprotected=fixture(); unprotected.unprotect(); await assert.rejects(unprotected.provider.sync(source),/PROTECTION/); assert.equal(unprotected.writes.length,0);
  const stale=fixture(); stale.setMain('b'.repeat(40)); await assert.rejects(stale.provider.sync(source),/SOURCE_CHANGED/); assert.equal(stale.writes.length,0);
  const branch=fixture(); branch.setMirror('c'.repeat(40)); branch.diverge(); await assert.rejects(branch.provider.sync(source),/NON_FAST_FORWARD/); assert.equal(branch.writes.length,0);
  const alias=fixture(); await alias.provider.sync(source); const deployed=await alias.service.deploy(source,generation);
  alias.setAlias({projectId:'other',deploymentId:'dpl_other'});
  await assert.rejects(alias.provider.alias(source,deployed.deployment as Deployment),/ALIAS_CONFLICT/);
  assert.ok(!alias.writes.some(w=>w.path.endsWith('/aliases')));
});

test('常設DBのmigration/seedを再実行してもA/B・編集済みの名前・追加データを保持し、別PRは接続できない', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { setupDatabase } = await import('../scripts/setup-db.mjs');
  const { seedTestUsers } = await import('../scripts/seed-test-users');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    const name = (await db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
    const env = {...environment, CAKE_TEST_DATABASE_URL: environment.CAKE_TEST_DATABASE_URL.replace('/cake', `/${name}`)};
    const connect = () => ({ query: async (statement:string) => {
      if (statement.startsWith('SELECT name FROM schema_migrations')) return (await db.query(statement)).rows;
      await db.exec(statement); return [];
    }});
    await setupDatabase(env,{connect}); await seedTestUsers(env,connect);
    assert.equal((await db.query('SELECT * FROM app_users')).rows.length,2);
    assert.equal((await db.query<{pr:number}>('SELECT pr FROM cake_preview_database_identity')).rows[0].pr,0);
    await db.query('UPDATE app_users SET name = $1 WHERE id = $2',['常設で編集',QA_TEST_USERS[0].id]);
    const next={...env, CAKE_PREVIEW_SOURCE_SHA:'b'.repeat(40),VERCEL_GIT_COMMIT_SHA:'b'.repeat(40)};
    await setupDatabase(next,{connect}); await seedTestUsers(next,connect);
    assert.equal((await db.query<{name:string}>('SELECT name FROM app_users WHERE id = $1',[QA_TEST_USERS[0].id])).rows[0].name,'常設で編集');
    assert.equal((await db.query('SELECT * FROM workspace_members')).rows.length,2);
    await assert.rejects(setupDatabase({...env,CAKE_PREVIEW_KIND:undefined,CAKE_PREVIEW_PR:'123',CAKE_PREVIEW_SOURCE_BRANCH:'codex/other',VERCEL_GIT_COMMIT_REF:'codex/other'},{connect}),/照合/);
  } finally { await db.close(); }
});


test('固定URLは匿名アクセスがVercel認証で拒否されることを確認する', async () => {
  const { assertAnonymousProtection } = await import('../scripts/staging-workflow');
  for (const response of [new Response(null,{status:401}), new Response(null,{status:307,headers:{location:'https://vercel.com/sso-api?url=example'}})])
    await assertAnonymousProtection(async()=>response);
  for (const response of [new Response('public',{status:200}), new Response(null,{status:307,headers:{location:'/login'}}),new Response(null,{status:307,headers:{location:'https://other.example/login'}})])
    await assert.rejects(assertAnonymousProtection(async()=>response),/PUBLIC_ACCESS/);
});


test('初回mirror作成後にmainが進んでもDeployment未作成の状態からfast-forward復旧できる', async () => {
  const f=fixture(); await f.provider.sync(source);
  const next={...source,sha:'b'.repeat(40)}; f.setMain(next.sha);
  await f.provider.sync(next);
  assert.deepEqual(f.writes.at(-1)?.body,{sha:next.sha,force:false});
  assert.equal(f.deployments.length,0);
});
