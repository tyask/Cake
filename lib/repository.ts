import { db } from "./db";
import { calculateSettlement } from "./settlement";
import { transactionRecord } from "./transaction-record";
import type {
  AppUser,
  BootstrapData,
  BootstrapMetadata,
  BootstrapScope,
  DefaultRule,
  PendingInvitation,
  SettlementHistory,
  SplitWeights,
  TransactionRecord,
  WorkspaceData,
  WorkspaceMember,
  WorkspaceMetadata,
  WorkspaceSummary,
} from "./types";

type Row = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "");
const nullableText = (value: unknown) => (value == null ? null : String(value));
const number = (value: unknown) => Number(value ?? 0);

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

async function readBootstrapRow(
  user: AppUser,
  requestedWorkspaceId: string | null | undefined,
  scope: BootstrapScope,
): Promise<Row> {
  const sql = db();
  // These lazy SQL fragments are executed only as part of the aggregate query.
  // Every workspace-specific aggregate is restricted to this authorized selection.
  // JSON keeps fractional seconds; preserve the old Neon Date -> String DTO precision.
  const workspaceSelection = sql`
    my_workspaces AS (
      SELECT w.id, w.name, w.type, w.owner_user_id, w.updated_at, w.created_at,
             COUNT(all_members.user_id)::int AS member_count
      FROM workspaces w
      JOIN workspace_members mine ON mine.workspace_id = w.id AND mine.user_id = ${user.id}
      LEFT JOIN workspace_members all_members ON all_members.workspace_id = w.id
      GROUP BY w.id
    ),
    selected_workspace AS (
      SELECT * FROM my_workspaces
      ORDER BY CASE WHEN id::text = ${requestedWorkspaceId ?? null} THEN 0 ELSE 1 END,
               updated_at DESC, created_at DESC, id ASC
      LIMIT 1
    )
  `;
  const commonColumns = sql`
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'type', type,
        'owner_user_id', owner_user_id, 'member_count', member_count
      ) ORDER BY updated_at DESC, created_at DESC, id ASC)
      FROM my_workspaces
    ), '[]'::jsonb) AS workspaces,
    (SELECT id::text FROM selected_workspace) AS selected_workspace_id,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id, 'email', u.email, 'name', u.name, 'image_url', u.image_url,
        'weight', wm.weight, 'role', wm.role
      ) ORDER BY wm.joined_at ASC, wm.user_id ASC)
      FROM workspace_members wm
      JOIN selected_workspace sw ON sw.id = wm.workspace_id
      JOIN app_users u ON u.id = wm.user_id
    ), '[]'::jsonb) AS members,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'merchant_contains', r.merchant_contains, 'expense_class', r.expense_class,
        'sort_order', r.sort_order, 'split_weights', r.split_weights, 'enabled', r.enabled
      ) ORDER BY r.sort_order ASC, r.created_at ASC, r.id ASC)
      FROM default_rules r
      JOIN selected_workspace sw ON sw.id = r.workspace_id
    ), '[]'::jsonb) AS rules,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'workspace_name', w.name, 'inviter_name', u.name,
        'expires_at', date_trunc('second', i.expires_at)
      ) ORDER BY i.created_at DESC)
      FROM invitations i
      JOIN workspaces w ON w.id = i.workspace_id
      JOIN app_users u ON u.id = i.invited_by
      WHERE lower(i.email) = ${user.email.toLowerCase()}
        AND i.status = 'PENDING'
        AND i.expires_at > now()
    ), '[]'::jsonb) AS pending_invitations
  `;
  const rows = scope === "metadata"
    ? await sql`WITH ${workspaceSelection} SELECT ${commonColumns}`
    : await sql`
      WITH ${workspaceSelection}
      SELECT ${commonColumns},
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'occurred_at', date_trunc('second', t.occurred_at), 'merchant', t.merchant,
            'method', t.method, 'type', t.type, 'amount_yen', t.amount_yen,
            'actor_user_id', t.actor_user_id, 'actor_name', u.name,
            'expense_class', t.expense_class, 'settled_at', date_trunc('second', t.settled_at),
            'external_id', t.external_id, 'source', t.source,
            'split_weights', t.split_weights, 'memo', t.memo
          ) ORDER BY t.occurred_at DESC, t.created_at DESC)
          FROM transactions t
          JOIN selected_workspace sw ON sw.id = t.workspace_id
          JOIN app_users u ON u.id = t.actor_user_id
        ), '[]'::jsonb) AS transactions,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', history.id, 'payer_name', history.payer_name,
            'payee_name', history.payee_name, 'amount_yen', history.amount_yen,
            'completed_at', date_trunc('second', history.completed_at)
          ) ORDER BY history.completed_at DESC)
          FROM (
            SELECT s.id, payer.name AS payer_name, payee.name AS payee_name,
                   s.amount_yen, s.completed_at
            FROM settlements s
            JOIN selected_workspace sw ON sw.id = s.workspace_id
            LEFT JOIN app_users payer ON payer.id = s.payer_user_id
            LEFT JOIN app_users payee ON payee.id = s.payee_user_id
            ORDER BY s.completed_at DESC
            LIMIT 20
          ) history
        ), '[]'::jsonb) AS settlement_history
      `;
  if (!rows[0]) throw new Error("ワークスペース情報を取得できませんでした。");
  return rows[0] as Row;
}

function workspaceSummaries(rows: Row[]): WorkspaceSummary[] {
  return rows.map((row) => ({
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

function getWorkspaceData(
  workspace: WorkspaceSummary,
  row: Row,
  scope: BootstrapScope,
): WorkspaceData | WorkspaceMetadata {
  const members: WorkspaceMember[] = (row.members as Row[]).map((row) => ({
    id: text(row.id),
    email: text(row.email),
    name: text(row.name),
    imageUrl: nullableText(row.image_url),
    weight: number(row.weight),
    role: text(row.role) as WorkspaceMember["role"],
  }));
  const rules: DefaultRule[] = (row.rules as Row[]).map((row) => ({
    id: text(row.id),
    merchantContains: text(row.merchant_contains),
    expenseClass: text(row.expense_class) as DefaultRule["expenseClass"],
    sortOrder: number(row.sort_order),
    splitWeights: row.split_weights as SplitWeights | null,
    enabled: Boolean(row.enabled),
  }));
  if (scope === "metadata") return { workspace, members, rules };

  const transactions: TransactionRecord[] = (row.transactions as Row[]).map(row => transactionRecord(row));
  const settlementHistory: SettlementHistory[] = (row.settlement_history as Row[]).map((row) => ({
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

function pendingInvitations(rows: Row[]): PendingInvitation[] {
  return rows.map((row) => ({
    id: text(row.id),
    workspaceName: text(row.workspace_name),
    inviterName: text(row.inviter_name),
    expiresAt: new Date(text(row.expires_at)).toISOString(),
  }));
}

export async function getBootstrap(
  user: AppUser,
  requestedWorkspaceId: string | null | undefined,
  scope: "metadata",
): Promise<BootstrapMetadata>;
export async function getBootstrap(
  user: AppUser,
  requestedWorkspaceId?: string | null,
  scope?: "full",
): Promise<BootstrapData>;
export async function getBootstrap(
  user: AppUser,
  requestedWorkspaceId: string | null | undefined,
  scope: BootstrapScope,
): Promise<BootstrapData | BootstrapMetadata>;
export async function getBootstrap(
  user: AppUser,
  requestedWorkspaceId?: string | null,
  scope: BootstrapScope = "full",
): Promise<BootstrapData | BootstrapMetadata> {
  let row = await readBootstrapRow(user, requestedWorkspaceId, scope);
  let workspaces = workspaceSummaries(row.workspaces as Row[]);
  if (workspaces.length === 0) {
    await createInitialWorkspace(user.id);
    row = await readBootstrapRow(user, requestedWorkspaceId, scope);
    workspaces = workspaceSummaries(row.workspaces as Row[]);
  }
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === row.selected_workspace_id) ?? null;
  return {
    user,
    workspaces,
    selected: selectedWorkspace ? getWorkspaceData(selectedWorkspace, row, scope) : null,
    pendingInvitations: pendingInvitations(row.pending_invitations as Row[]),
  };
}
