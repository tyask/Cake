export type WorkspaceType = "PERSONAL" | "SHARED";
export type TransactionType = "PAYMENT" | "RECEIPT";
export type ExpenseClass = "PERSONAL" | "SHARED";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  type: WorkspaceType;
  ownerUserId: string;
  memberCount: number;
}

export interface WorkspaceMember extends AppUser {
  weight: number;
  role: "OWNER" | "MEMBER";
}

export interface TransactionRecord {
  id: string;
  occurredAt: string;
  merchant: string;
  method: string;
  type: TransactionType;
  amountYen: number;
  actorUserId: string;
  actorName: string;
  expenseClass: ExpenseClass;
  settledAt: string | null;
  externalId: string;
  source: "MANUAL" | "PAYPAY";
}

export interface DefaultRule {
  id: string;
  merchantContains: string;
  expenseClass: ExpenseClass;
  priority: number;
  enabled: boolean;
}

export interface SettlementPerson {
  userId: string;
  name: string;
  weight: number;
  payments: number;
  receipts: number;
  actual: number;
  target: number;
  balance: number;
}

export interface SettlementResult {
  transactionIds: string[];
  paymentTotal: number;
  receiptTotal: number;
  netTotal: number;
  people: SettlementPerson[];
  payerUserId: string | null;
  payerName: string | null;
  payeeUserId: string | null;
  payeeName: string | null;
  amountYen: number;
}

export interface SettlementHistory {
  id: string;
  payerName: string | null;
  payeeName: string | null;
  amountYen: number;
  completedAt: string;
}

export interface PendingInvitation {
  id: string;
  workspaceName: string;
  inviterName: string;
  expiresAt: string;
}

export interface WorkspaceData {
  workspace: WorkspaceSummary;
  members: WorkspaceMember[];
  transactions: TransactionRecord[];
  rules: DefaultRule[];
  settlement: SettlementResult | null;
  settlementHistory: SettlementHistory[];
}

export interface BootstrapData {
  user: AppUser;
  workspaces: WorkspaceSummary[];
  selected: WorkspaceData | null;
  pendingInvitations: PendingInvitation[];
}

