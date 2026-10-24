export const MAX_AMOUNT_YEN = 2_147_483_647;
export const MAX_SPLIT_WEIGHT = 2_147_483_647;
export const MAX_MERCHANT_LENGTH = 240;
export const MAX_METHOD_LENGTH = 120;
export const MAX_RULE_MERCHANT_LENGTH = 120;
export const MAX_WORKSPACE_NAME_LENGTH = 80;

export const workspaceTypes = ["PERSONAL", "SHARED"] as const;
export type WorkspaceType = typeof workspaceTypes[number];
export const workspaceTypeLabels = { PERSONAL: "個人用", SHARED: "共有用" } satisfies Record<WorkspaceType, string>;

export const expenseClasses = ["PERSONAL", "SHARED"] as const;
export type ExpenseClass = typeof expenseClasses[number];
export const expenseClassLabels = { PERSONAL: "個人", SHARED: "共有" } satisfies Record<ExpenseClass, string>;
export const commonExpenseClassLabels = expenseClassLabels;

export const transactionTypes = ["PAYMENT", "RECEIPT"] as const;
export type TransactionType = typeof transactionTypes[number];
export const transactionTypeLabels = { PAYMENT: "支払い", RECEIPT: "収入" } satisfies Record<TransactionType, string>;
export const transactionActorLabels = { PAYMENT: "支払者", RECEIPT: "受取者" } satisfies Record<TransactionType, string>;

export const transactionSources = ["MANUAL", "PAYPAY", "RECURRING"] as const;
export type TransactionSource = typeof transactionSources[number];
export const workspaceRoles = ["OWNER", "MEMBER"] as const;
export type WorkspaceRole = typeof workspaceRoles[number];
export const bootstrapScopes = ["full", "metadata"] as const;
export type BootstrapScope = typeof bootstrapScopes[number];
