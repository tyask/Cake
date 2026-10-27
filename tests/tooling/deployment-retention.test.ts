import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentRetentionService } from '../../scripts/preview/deployment-retention';
import { StagingProvider } from '../../scripts/preview/staging-service';
import { config, deployment, type Source } from '../../scripts/preview/preview-model';
import { type Transport } from '../../scripts/preview/preview-provider';
import staging from '../../staging.config.json';

const day = 86_400_000, now = Date.parse('2026-11-30T12:00:00Z');
const sha = 'a'.repeat(40), generation = '10000000-0000-4000-8000-000000000001';
const source: Source = { pr: 0, branch: staging.branch, sha, state: 'open', createdAt: '2026-01-01T00:00:00Z' };
const database = { branchId: 'br-staging', endpointId: 'ep-staging', hostDigest: 'b'.repeat(64) };
type Raw = Record<string, unknown>;

function raw(id: string, kind: 'staging' | 'production', age: number, state = 'READY'): Raw {
  const branch = kind === 'staging' ? staging.branch : 'main';
  const [owner, repo] = config.repository.split('/');
  const meta = {
    githubCommitRef: branch, githubCommitSha: sha, githubCommitOrg: owner, githubCommitRepo: repo, githubRepoId: String(config.repositoryId),
    ...(kind === 'staging' ? {
      cakePreviewProtocol: 'cake-preview/v1', cakePreviewRepository: config.repository, cakePreviewPr: '0',
      cakePreviewGeneration: generation, cakePreviewOperation: '20000000-0000-4000-8000-000000000002',
      cakePreviewPhase: 'application', cakePreviewDatabaseBranch: database.branchId,
      cakePreviewDatabaseEndpoint: database.endpointId, cakePreviewDatabaseDigest: database.hostDigest,
    } : {}),
  };
  return {
    id, uid: id, name: 'cake', projectId: config.vercelProjectId, ownerId: config.vercelTeamId,
    target: kind === 'production' ? 'production' : null, createdAt: now - age, created: now - age,
    url: `cake-${id.slice(4).toLowerCase()}.vercel.app`, readyState: state, state,
    gitSource: { type: 'github', repoId: config.repositoryId, ref: branch, sha }, meta, alias: [],
  };
}

function fixture() {
  const records = new Map<string, Raw>([
    ['dpl_stageCurrent', raw('dpl_stageCurrent', 'staging', day / 24)],
    ['dpl_prodCurrent', raw('dpl_prodCurrent', 'production', day / 24)],
  ]);
  const writes: { provider: string; path: string; method: string }[] = [];
  const calls: { provider: string; path: string; method: string }[] = [];
  const aliases: Raw[] = [];
  const project: Raw = {
    id: config.vercelProjectId, accountId: config.vercelTeamId, link: { repoId: config.repositoryId },
    ssoProtection: { deploymentType: 'all_except_custom_domains' }, lastRollbackTarget: null,
    targets: { production: { id: 'dpl_prodCurrent' }, preview: { id: 'dpl_stageCurrent' } },
    crons: { deploymentId: 'dpl_prodCurrent', definitions: [] },
  };
  let mainSha = sha, fixedAlias = 'dpl_stageCurrent';
  let retainDeleted = false, unknownDelete = false;
  let listOverride: ((until: string | null) => unknown) | undefined;
  let aliasesOverride: ((until: string | null) => unknown) | undefined;
  let onCall: ((path: string, method: string) => void) | undefined;
  const api: Transport = async (provider, path, method = 'GET') => {
    calls.push({ provider, path, method });
    onCall?.(path, method);
    if (method !== 'GET') writes.push({ provider, path, method });
    assert.equal(provider, 'vercel', 'retentionはDB・branchを変更しない');
    if (path.startsWith('/v9/projects/')) return structuredClone(project);
    if (path.startsWith('/v6/deployments?')) {
      const until = new URL(path, 'https://api.vercel.com').searchParams.get('until');
      if (listOverride) return structuredClone(listOverride(until));
      return { deployments: structuredClone([...records.values()]), pagination: { next: null } };
    }
    if (path.startsWith('/v4/aliases?')) {
      const until = new URL(path, 'https://api.vercel.com').searchParams.get('until');
      if (aliasesOverride) return structuredClone(aliasesOverride(until));
      return { aliases: structuredClone(aliases), pagination: { next: null } };
    }
    if (path === `/v4/aliases/${staging.alias}`) {
      return { alias: staging.alias, projectId: config.vercelProjectId, deploymentId: fixedAlias, deployment: { id: fixedAlias } };
    }
    if (path.startsWith('/v13/deployments/')) {
      const id = path.split('/').at(-1)!;
      if (method === 'DELETE') {
        if (unknownDelete) throw new Error('PREVIEW_VERCEL_DELETE_RESPONSE_UNKNOWN');
        if (!retainDeleted) records.delete(id);
        return { state: 'DELETED', uid: id };
      }
      return structuredClone(records.get(id) ?? null);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  class Provider extends StagingProvider {
    override async main() { return { ...source, sha: mainSha }; }
    override async assertBindings() {}
    override async assertProtection() {}
    override async assertSource(expected: Source) {
      if (expected.sha !== mainSha) throw new Error('PREVIEW_STAGING_SOURCE_CHANGED');
    }
    override async deployments(expected: Source) {
      return [...records.values()].filter(d => (d.meta as Raw).cakePreviewPr === '0')
        .map(d => deployment(d, expected)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    override async database() { return { ...database }; }
  }
  const provider = new Provider(api);
  return {
    records, writes, calls, aliases, project, service: new DeploymentRetentionService(provider, () => now),
    add: (d: Raw) => { records.set(d.id as string, d); },
    setMain: (value: string) => { mainSha = value; },
    setFixedAlias: (value: string) => { fixedAlias = value; },
    retainDeleted: () => { retainDeleted = true; },
    unknownDelete: () => { unknownDelete = true; },
    list: (value: (until: string | null) => unknown) => { listOverride = value; },
    aliasList: (value: (until: string | null) => unknown) => { aliasesOverride = value; },
    onCall: (value: (path: string, method: string) => void) => { onCall = value; },
  };
}

function oldHistory(f: ReturnType<typeof fixture>) {
  f.add(raw('dpl_stage5', 'staging', 7 * day));
  f.add(raw('dpl_prod5', 'production', 40 * day));
}

test('planは本番とstagingの直近成功1件だけを保持し、経過時間にかかわらず旧版・失敗分を削除候補にする', async () => {
  const f = fixture(); oldHistory(f);
  f.add(raw('dpl_stageRecentError', 'staging', 1, 'ERROR'));
  f.add(raw('dpl_stageRecentCanceled', 'staging', 2, 'CANCELED'));
  f.add(raw('dpl_prodRecentError', 'production', 1, 'ERROR'));
  f.add(raw('dpl_prodRecentCanceled', 'production', 2, 'CANCELED'));
  f.add(raw('dpl_stageBuilding', 'staging', 10 * day, 'BUILDING'));
  f.add(raw('dpl_prodUnknown', 'production', 40 * day, 'UNKNOWN'));
  const other = raw('dpl_otherPr', 'staging', 20 * day);
  other.gitSource = { type: 'github', repoId: config.repositoryId, ref: 'codex/other', sha };
  other.meta = { ...(other.meta as Raw), githubCommitRef: 'codex/other', cakePreviewPr: '123' };
  f.add(other);
  const result = await f.service.run('plan');
  assert.deepEqual(result.planned.sort(), ['dpl_prod5', 'dpl_prodRecentError', 'dpl_prodRecentCanceled',
    'dpl_stage5', 'dpl_stageRecentError', 'dpl_stageRecentCanceled'].sort());
  assert.equal(result.mode, 'plan'); assert.equal(result.sourceSha, sha);
  assert.deepEqual(result.deleted, []); assert.deepEqual(f.writes, []);
  assert.equal(result.success, true);
  assert.deepEqual(Object.keys(result).sort(), ['protocol', 'mode', 'sourceSha', 'checkedAt', 'planned', 'deleted', 'skipped', 'retained', 'success'].sort());
  assert.ok(!JSON.stringify(result).includes('cakePreviewDatabaseDigest'));
});

test('applyは確認済みの過去Deploymentだけを削除し、現用とDB・alias・branchを保持する', async () => {
  const f = fixture(); oldHistory(f);
  const result = await f.service.run('apply');
  assert.deepEqual([...result.deleted].sort(), ['dpl_prod5', 'dpl_stage5']);
  assert.ok(f.records.has('dpl_stageCurrent')); assert.ok(f.records.has('dpl_prodCurrent'));
  assert.ok(!f.records.has('dpl_stage5')); assert.ok(!f.records.has('dpl_prod5'));
  assert.equal(f.records.size, 2); assert.equal(result.retained, 2);
  assert.ok(f.writes.every(call => call.provider === 'vercel' && call.method === 'DELETE' && call.path.startsWith('/v13/deployments/')));
});

test('開始時に未完了stagingを検出した場合は計画・削除を開始しない', async () => {
  const f = fixture(); oldHistory(f);
  const audit: { action: string; ids: readonly string[] }[] = [];
  const service = new DeploymentRetentionService(f.service.provider, () => now, event => { audit.push(event); },
    async () => { throw new Error('PREVIEW_RETENTION_STAGING_BUSY'); });
  await assert.rejects(service.run('apply'), /STAGING_BUSY/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.calls, []); assert.deepEqual(audit, []);
});

test('開始後に未完了stagingを検出した場合も削除前の再照合より先に停止する', async () => {
  const f = fixture(); oldHistory(f);
  let guards = 0;
  const audit: { action: string; ids: readonly string[] }[] = [];
  const service = new DeploymentRetentionService(f.service.provider, () => now, event => { audit.push(event); }, async () => {
    if (++guards === 2) throw new Error('PREVIEW_RETENTION_STAGING_BUSY');
  });
  await assert.rejects(service.run('apply'), /STAGING_BUSY/);
  assert.equal(guards, 2); assert.deepEqual(f.writes, []);
  assert.deepEqual(audit.map(event => event.action), ['plan']);
  assert.equal(f.calls.filter(call => call.path === '/v13/deployments/dpl_prod5').length, 1);
});

test('alias・cronの参照先を保持し、参照のないrollback履歴は削除候補にする', async () => {
  const f = fixture();
  for (let i = 1; i <= 8; i++) f.add(raw(`dpl_protected${i}`, 'production', (35 + i) * day));
  f.aliases.push({ uid: 'alias-extra', alias: 'saved.example.com', projectId: config.vercelProjectId,
    deploymentId: 'dpl_protected5', deployment: { id: 'dpl_protected5' } });
  f.project.lastRollbackTarget = { id: 'dpl_protected6' };
  f.project.crons = { deploymentId: 'dpl_protected7', definitions: [] };
  const result = await f.service.run('plan');
  assert.deepEqual(result.planned.sort(), ['dpl_protected1', 'dpl_protected2', 'dpl_protected3',
    'dpl_protected4', 'dpl_protected6', 'dpl_protected8'].sort());
});

test('本番を旧版へrollback済みの場合も現用参照先と最新成功1件を保持する', async () => {
  const f = fixture(); oldHistory(f);
  const newest = raw('dpl_prodNewest', 'production', 1);
  (newest.gitSource as Raw).sha = 'b'.repeat(40);
  (newest.meta as Raw).githubCommitSha = 'b'.repeat(40);
  f.add(newest);
  const result = await f.service.run('apply');
  assert.deepEqual(result.planned.sort(), ['dpl_prod5', 'dpl_stage5']);
  assert.ok(f.records.has('dpl_prodNewest')); assert.ok(f.records.has('dpl_prodCurrent'));
});

test('全ページを取得し、後続ページのaliasも保持する', async () => {
  const f = fixture(); oldHistory(f);
  const all = [...f.records.values()];
  f.list(until => until === null ? { deployments: all.slice(0, 3), pagination: { next: now - day } }
    : { deployments: all.slice(3), pagination: { next: null } });
  f.aliasList(until => until === null ? { aliases: [], pagination: { next: now - day } }
    : { aliases: [{ uid: 'alias-page2', alias: 'saved.example.com', projectId: config.vercelProjectId,
      deploymentId: 'dpl_stage5', deployment: { id: 'dpl_stage5' } }], pagination: { next: null } });
  const result = await f.service.run('plan');
  assert.deepEqual(result.planned, ['dpl_prod5']);
  assert.ok(f.calls.some(call => call.path.includes('/v6/deployments?') && call.path.includes('&until=')));
  assert.ok(f.calls.some(call => call.path.includes('/v4/aliases?') && call.path.includes('&until=')));
});

test('不完全な一覧・重複・循環paginationを拒否し削除しない', async () => {
  for (const invalid of ['missing', 'duplicate', 'cycle'] as const) {
    const f = fixture(); oldHistory(f);
    const all = [...f.records.values()];
    f.list(() => invalid === 'missing' ? { deployments: all, pagination: {} }
      : invalid === 'duplicate' ? { deployments: [...all, all[0]], pagination: { next: null } }
        : { deployments: [], pagination: { next: now - day } });
    await assert.rejects(f.service.run('apply'), /PREVIEW_/);
    assert.deepEqual(f.writes, []);
  }
});

test('現在の本番Deploymentが全件一覧から欠落していれば削除しない', async () => {
  const f = fixture(); oldHistory(f);
  f.list(() => ({ deployments: [...f.records.values()].filter(row => row.id !== 'dpl_prodCurrent'), pagination: { next: null } }));
  await assert.rejects(f.service.run('apply'), /INCOMPLETE_INVENTORY/);
  assert.deepEqual(f.writes, []);
});

test('不完全なalias一覧・異なるprojectの応答では削除しない', async () => {
  for (const invalid of ['aliases', 'project'] as const) {
    const f = fixture(); oldHistory(f);
    if (invalid === 'aliases') f.aliasList(() => ({ aliases: [], pagination: {} }));
    else f.project.accountId = 'team_other';
    await assert.rejects(f.service.run('apply'), /PREVIEW_/);
    assert.deepEqual(f.writes, []);
  }
});

test('所有権・repo・SHAの不一致を拒否して削除しない', async () => {
  for (const invalid of ['project', 'owner', 'repo', 'sha'] as const) {
    const f = fixture(); oldHistory(f);
    const target = f.records.get('dpl_prod5')!;
    if (invalid === 'project') target.projectId = 'prj_other';
    if (invalid === 'owner') target.ownerId = 'team_other';
    if (invalid === 'repo') (target.gitSource as Raw).repoId = 1;
    if (invalid === 'sha') (target.meta as Raw).githubCommitSha = 'b'.repeat(40);
    await assert.rejects(f.service.run('apply'), /PREVIEW_/);
    assert.deepEqual(f.writes, []);
  }
});

test('呼出元の完全SHAがmainと一致しなければ計画も削除も行わない', async () => {
  const f = fixture(); oldHistory(f);
  await assert.rejects(f.service.run('apply', 'b'.repeat(40)), /SOURCE_CHANGED/);
  assert.deepEqual(f.writes, []);
});

test('固定staging aliasが現在mainの検証済みDeploymentと異なる場合は停止する', async () => {
  const f = fixture(); oldHistory(f); f.setFixedAlias('dpl_stage5');
  await assert.rejects(f.service.run('apply'), /PREVIEW_/);
  assert.deepEqual(f.writes, []);
});

test('mainが計画後に進んだ場合は削除前に停止する', async () => {
  const f = fixture(); oldHistory(f);
  let projectReads = 0;
  f.onCall(path => {
    if (path.startsWith('/v9/projects/') && ++projectReads === 2) f.setMain('b'.repeat(40));
  });
  await assert.rejects(f.service.run('apply'), /SOURCE_CHANGED/);
  assert.deepEqual(f.writes, []);
});

test('削除直前にaliasを取得した候補は削除しない', async () => {
  const f = fixture(); oldHistory(f);
  let aliasReads = 0;
  f.onCall(path => {
    if (path.startsWith('/v4/aliases?') && ++aliasReads === 2) f.aliases.push({
      uid: 'alias-promoted', alias: 'saved.example.com', projectId: config.vercelProjectId,
      deploymentId: 'dpl_stage5', deployment: { id: 'dpl_stage5' },
    });
  });
  const result = await f.service.run('apply');
  assert.ok(f.records.has('dpl_stage5'));
  assert.ok(result.skipped.includes('dpl_stage5'));
  assert.ok(!f.writes.some(call => call.path.endsWith('/dpl_stage5')));
});

test('削除直前に本番のcurrentへ昇格した候補は保持する', async () => {
  const f = fixture(); oldHistory(f);
  let projectReads = 0;
  f.onCall(path => {
    if (path.startsWith('/v9/projects/') && ++projectReads === 2) {
      f.project.targets = { production: { id: 'dpl_prod5' }, preview: { id: 'dpl_stageCurrent' } };
    }
  });
  const result = await f.service.run('apply');
  assert.ok(result.skipped.includes('dpl_prod5')); assert.ok(f.records.has('dpl_prod5'));
  assert.ok(!f.writes.some(call => call.path.endsWith('/dpl_prod5')));
});

test('旧Deploymentの履歴aliasではなく現在のalias一覧を参照する', async () => {
  const f = fixture(); oldHistory(f);
  f.records.get('dpl_stage5')!.alias = [staging.alias];
  const result = await f.service.run('plan');
  assert.ok(result.planned.includes('dpl_stage5'));
});

test('計画後に他の処理で消えた候補はDELETEせずskipする', async () => {
  const f = fixture(); oldHistory(f);
  let candidateReads = 0;
  f.onCall((path, method) => {
    if (method === 'GET' && path.endsWith('/dpl_prod5') && ++candidateReads === 2) f.records.delete('dpl_prod5');
  });
  const result = await f.service.run('apply');
  assert.ok(result.skipped.includes('dpl_prod5')); assert.ok(!result.deleted.includes('dpl_prod5'));
  assert.ok(!f.writes.some(call => call.path.endsWith('/dpl_prod5')));
});

test('最新の準備用Deploymentも削除候補にし、現用applicationと継続DBの所有権を保持する', async () => {
  const f = fixture(); oldHistory(f);
  const provision = raw('dpl_provision', 'staging', 1);
  const meta = provision.meta as Raw;
  meta.cakePreviewPhase = 'provisioning';
  for (const key of ['cakePreviewDatabaseBranch', 'cakePreviewDatabaseEndpoint', 'cakePreviewDatabaseDigest']) delete meta[key];
  f.add(provision);
  const result = await f.service.run('apply');
  assert.ok(result.deleted.includes('dpl_provision')); assert.ok(f.records.has('dpl_stageCurrent'));
  const current = deployment(f.records.get('dpl_stageCurrent'), source);
  assert.deepEqual(current.database, database);
});

test('削除前の詳細GETで候補のSHAが変わっていれば削除しない', async () => {
  const f = fixture(); oldHistory(f);
  // Production is older than staging and is processed first by creation time.
  let candidateReads = 0;
  f.onCall((path, method) => {
    if (method === 'GET' && path.endsWith('/dpl_prod5') && ++candidateReads === 2) {
      const candidate = f.records.get('dpl_prod5')!;
      (candidate.gitSource as Raw).sha = 'b'.repeat(40);
      (candidate.meta as Raw).githubCommitSha = 'b'.repeat(40);
    }
  });
  await assert.rejects(f.service.run('apply'), /PREVIEW_/);
  assert.ok(!f.writes.some(call => call.path.endsWith('/dpl_prod5')));
});

test('DELETEの応答不明では再送せず停止する', async () => {
  const f = fixture(); oldHistory(f); f.unknownDelete();
  const audit: { action: string; ids: readonly string[] }[] = [];
  const service = new DeploymentRetentionService(f.service.provider, () => now, event => { audit.push(event); });
  await assert.rejects(service.run('apply'), /DELETE_RESPONSE_UNKNOWN/);
  assert.equal(f.writes.length, 1);
  assert.equal(audit[0].action, 'plan');
  assert.deepEqual(audit[1], { action: 'deleting', ids: ['dpl_prod5'] });
  assert.ok(!audit.some(event => event.action === 'deleted'));
});

test('DELETE後の直接GETで不在を確認できなければ停止する', async () => {
  const f = fixture(); oldHistory(f); f.retainDeleted();
  await assert.rejects(f.service.run('apply'), /PREVIEW_/);
  assert.equal(f.writes.length, 1);
});

test('直接GETで不在でも全件一覧に残る場合は削除完了としない', async () => {
  const f = fixture(); oldHistory(f);
  const original = structuredClone([...f.records.values()]);
  f.list(() => ({ deployments: original, pagination: { next: null } }));
  await assert.rejects(f.service.run('apply'), /PREVIEW_/);
  assert.ok(f.writes.length > 0);
});
