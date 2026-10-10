export type WorkspaceType = "PERSONAL" | "SHARED";
export type TransactionType = "PAYMENT" | "RECEIPT";
export type ExpenseClass = "PERSONAL" | "SHARED";
export type SplitWeights = Record<string, number>;

export interface AppUser {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  isAdmin?: boolean;
}

export interface RegisteredUser extends AppUser {
  isAdmin: boolean;
  isEnabled: boolean;
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
  memo: string;
  type: TransactionType;
  amountYen: number;
  actorUserId: string;
  actorName: string;
  expenseClass: ExpenseClass;
  splitWeights: SplitWeights;
  settledAt: string | null;
  externalId: string;
  source: "MANUAL" | "PAYPAY" | "RECURRING";
}

export interface DefaultRule {
  id: string;
  merchantContains: string;
  expenseClass: ExpenseClass;
  sortOrder: number;
  splitWeights: SplitWeights | null;
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

export interface WorkspaceMetadata {
  workspace: WorkspaceSummary;
  members: WorkspaceMember[];
  rules: DefaultRule[];
}

export interface WorkspaceData extends WorkspaceMetadata {
  transactions: TransactionRecord[];
  settlement: SettlementResult | null;
  settlementHistory: SettlementHistory[];
}

export type BootstrapScope = "full" | "metadata";

export interface BootstrapMetadata {
  user: AppUser;
  workspaces: WorkspaceSummary[];
  selected: WorkspaceMetadata | null;
  pendingInvitations: PendingInvitation[];
}

export interface BootstrapData extends BootstrapMetadata {
  selected: WorkspaceData | null;
}
