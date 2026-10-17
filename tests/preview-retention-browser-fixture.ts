import { config, type Deployment, type Source } from '../scripts/preview-model';
import { retentionPayload, retentionWorkspaceId } from '../scripts/preview-retention-model';

export const retentionMarker = '10000000-0000-4000-8000-000000000001';
export const retentionSource: Source = { pr: 75, branch: 'codex/retention-test', sha: 'a'.repeat(40), createdAt: '2026-10-16T00:00:00Z', state: 'open' };
export const retentionDeployment: Deployment = { id: 'dpl_retentiontest', url: 'https://cake-retention-test.vercel.app', sha: retentionSource.sha,
  pr: retentionSource.pr, branch: retentionSource.branch, generation: '20000000-0000-4000-8000-000000000002',
  operation: '30000000-0000-4000-8000-000000000003', phase: 'application', state: 'READY', createdAt: Date.parse(retentionSource.createdAt),
  database: { branchId: 'br-retention-test', endpointId: 'ep-retention-test', hostDigest: 'd'.repeat(64) } };
export function retentionOidcFixture() {
  return 'header.' + Buffer.from(JSON.stringify({ project_id: config.vercelProjectId, owner_id: config.vercelTeamId,
    environment: 'development', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url') + '.signature';
}
export function retentionTransactionFixture(marker = retentionMarker) {
  const p = retentionPayload(marker), id = '50000000-0000-4000-8000-000000000005';
  return { id, occurredAt: p.occurredAt as string, merchant: p.merchant as string, method: p.method as string, memo: p.memo,
    type: p.type as string, amountYen: p.amountYen as number, actorUserId: p.actorUserId as string, actorName: 'Fixture A',
    expenseClass: p.expenseClass as string, splitWeights: { ...p.splitWeights }, settledAt: null as string | null, externalId: `manual_${id}`, source: 'MANUAL' };
}
export function retentionAppFixture(marker = retentionMarker, present = true) {
  const workspace = { id: retentionWorkspaceId, name: 'Test shared workspace', type: 'SHARED', ownerUserId: 'test-user-a', memberCount: 2 };
  const members = [
    { id: 'test-user-a', email: 'test-a@cake.local', name: 'Fixture A', imageUrl: null, weight: 1, role: 'OWNER' },
    { id: 'test-user-b', email: 'test-b@cake.local', name: 'Fixture B', imageUrl: null, weight: 1, role: 'MEMBER' },
  ];
  const existing = { ...retentionTransactionFixture(marker), id: '40000000-0000-4000-8000-000000000004',
    merchant: 'Existing test record', memo: 'Existing synthetic data', amountYen: 200, externalId: 'manual-existing' };
  return { user: { id: members[0].id, email: members[0].email, name: members[0].name, imageUrl: null, isEnabled: true, isAdmin: true },
    workspaces: [{ ...workspace }], selected: { workspace, members, transactions: [existing, ...(present ? [retentionTransactionFixture(marker)] : [])],
      rules: [], settlement: null, settlementHistory: [] }, pendingInvitations: [] };
}
