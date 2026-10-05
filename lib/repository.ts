import { db } from "./db";
import { calculateSettlement } from "./settlement";
import { updateRegisteredProfile } from "./user-access";
import type {
  AppUser,
  BootstrapData,
  DefaultRule,
  PendingInvitation,
  SettlementHistory,
  SplitWeights,
  TransactionRecord,
  WorkspaceData,
  WorkspaceMember,
  WorkspaceSummary,
} from "./types";

type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "");
const nullableText = (value: unknown) => (value == null ? null : String(value));
const number = (value: unknown) => Number(value ?? 0);

export async function ensureUser(user: AppUser) {
  if (!await updateRegisteredProfile(user)) throw new Error("このアカウントはCakeを利用できません。");
}

export async function requireWorkspaceMember(workspaceId: string, userId: string) {
  const sql = db();
  const rows = await sql`
    SELECT w.id, w.name, w.type, w.owner_user_id
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE w.id = ${workspaceId}::uuid AND wm.user_id = ${userId}
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("このワークスペースを操作する権限がありません。");
  return rows[0] as Row;
}

async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
  const sql = db();
  const rows = await sql`
    SELECT w.id, w.name, w.type, w.owner_user_id, COUNT(all_members.user_id)::int AS member_count
    FROM workspaces w
    JOIN workspace_members mine ON mine.workspace_id = w.id AND mine.user_id = ${userId}
    LEFT JOIN workspace_members all_members ON all_members.workspace_id = w.id
    GROUP BY w.id
    ORDER BY w.updated_at DESC, w.created_at DESC
  `;
  return (rows as Row[]).map((row) => ({
    id: text(row.id),
    name: text(row.name),
    type: text(row.type) as WorkspaceSummary["type"],
    ownerUserId: text(row.owner_user_id),
    memberCount: number(row.member_count),
  }));
}

async function createInitialWorkspace(userId: string) {
  const sql = db();
  await sql`
    WITH created AS (
      INSERT INTO workspaces (name, type, owner_user_id)
      VALUES ('個人の家計', 'PERSONAL', ${userId})
      RETURNING id
    )
    INSERT INTO workspace_members (workspace_id, user_id, role, weight)
    SELECT id, ${userId}, 'OWNER', 1 FROM created
  `;
}

async function getWorkspaceData(
  workspace: WorkspaceSummary,
  userId: string,
): Promise<WorkspaceData> {
  await requireWorkspaceMember(workspace.id, userId);
  const sql = db();
  const [memberRows, transactionRows, ruleRows, historyRows] = await Promise.all([
    sql`
      SELECT u.id, u.email, u.name, u.image_url, wm.weight, wm.role
      FROM workspace_members wm
      JOIN app_users u ON u.id = wm.user_id
      WHERE wm.workspace_id = ${workspace.id}::uuid
      ORDER BY wm.joined_at ASC, wm.user_id ASC
    `,
    sql`
      SELECT t.id, t.occurred_at, t.merchant, t.method, t.type, t.amount_yen,
             t.actor_user_id, u.name AS actor_name, t.expense_class, t.settled_at,
             t.external_id, t.source, t.split_weights
      FROM transactions t
      JOIN app_users u ON u.id = t.actor_user_id
      WHERE t.workspace_id = ${workspace.id}::uuid
      ORDER BY t.occurred_at DESC, t.created_at DESC
    `,
    sql`
      SELECT id, merchant_contains, expense_class, sort_order, split_weights, enabled
      FROM default_rules
      WHERE workspace_id = ${workspace.id}::uuid
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `,
    sql`
      SELECT s.id, payer.name AS payer_name, payee.name AS payee_name,
             s.amount_yen, s.completed_at
      FROM settlements s
      LEFT JOIN app_users payer ON payer.id = s.payer_user_id
      LEFT JOIN app_users payee ON payee.id = s.payee_user_id
      WHERE s.workspace_id = ${workspace.id}::uuid
      ORDER BY s.completed_at DESC
      LIMIT 20
    `,
  ]);

  const members: WorkspaceMember[] = (memberRows as Row[]).map((row) => ({
    id: text(row.id),
    email: text(row.email),
    name: text(row.name),
    imageUrl: nullableText(row.image_url),
    weight: number(row.weight),
    role: text(row.role) as WorkspaceMember["role"],
  }));
  const transactions: TransactionRecord[] = (transactionRows as Row[]).map((row) => ({
    id: text(row.id),
    occurredAt: new Date(text(row.occurred_at)).toISOString(),
    merchant: text(row.merchant),
    method: text(row.method),
    type: text(row.type) as TransactionRecord["type"],
    amountYen: number(row.amount_yen),
    actorUserId: text(row.actor_user_id),
    actorName: text(row.actor_name),
    expenseClass: text(row.expense_class) as TransactionRecord["expenseClass"],
    splitWeights: row.split_weights as SplitWeights,
    settledAt: row.settled_at ? new Date(text(row.settled_at)).toISOString() : null,
    externalId: text(row.external_id),
    source: text(row.source) as TransactionRecord["source"],
  }));
  const rules: DefaultRule[] = (ruleRows as Row[]).map((row) => ({
    id: text(row.id),
    merchantContains: text(row.merchant_contains),
    expenseClass: text(row.expense_class) as DefaultRule["expenseClass"],
    sortOrder: number(row.sort_order),
    splitWeights: row.split_weights as SplitWeights | null,
    enabled: Boolean(row.enabled),
  }));
  const settlementHistory: SettlementHistory[] = (historyRows as Row[]).map((row) => ({
    id: text(row.id),
    payerName: nullableText(row.payer_name),
    payeeName: nullableText(row.payee_name),
    amountYen: number(row.amount_yen),
    completedAt: new Date(text(row.completed_at)).toISOString(),
  }));

  return {
    workspace,
    members,
    transactions,
    rules,
    settlement: workspace.type === "SHARED" ? calculateSettlement(members, transactions) : null,
    settlementHistory,
  };
}

async function listPendingInvitations(email: string): Promise<PendingInvitation[]> {
  const sql = db();
  const rows = await sql`
    SELECT i.id, w.name AS workspace_name, u.name AS inviter_name, i.expires_at
    FROM invitations i
    JOIN workspaces w ON w.id = i.workspace_id
    JOIN app_users u ON u.id = i.invited_by
    WHERE lower(i.email) = ${email.toLowerCase()}
      AND i.status = 'PENDING'
      AND i.expires_at > now()
    ORDER BY i.created_at DESC
  `;
  return (rows as Row[]).map((row) => ({
    id: text(row.id),
    workspaceName: text(row.workspace_name),
    inviterName: text(row.inviter_name),
    expiresAt: new Date(text(row.expires_at)).toISOString(),
  }));
}

export async function getBootstrap(
  user: AppUser,
  requestedWorkspaceId?: string | null,
): Promise<BootstrapData> {
  await ensureUser(user);
  let workspaces = await listWorkspaces(user.id);
  if (workspaces.length === 0) {
    await createInitialWorkspace(user.id);
    workspaces = await listWorkspaces(user.id);
  }
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ?? workspaces[0] ?? null;
  const [selected, pendingInvitations] = await Promise.all([
    selectedWorkspace ? getWorkspaceData(selectedWorkspace, user.id) : Promise.resolve(null),
    listPendingInvitations(user.email),
  ]);
  return { user, workspaces, selected, pendingInvitations };
}
