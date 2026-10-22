import type { ExpenseClass, TransactionType } from "../lib/domain-values";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// Parents precede children so the normal category structure guard stays active.
const categories = [
  [1, null, "食費", "#f97316", 0],
  [2, 1, "食料品", "#fb923c", 0],
  [3, 2, "スーパー", "#fdba74", 0],
  [4, 1, "外食", "#ea580c", 1],
  [5, null, "暮らし", "#3b82f6", 1],
  [6, 5, "日用品", "#60a5fa", 0],
  [7, 5, "光熱費", "#2563eb", 1],
  [8, null, "交通", "#22c55e", 2],
  [9, null, "趣味", "#a855f7", 3],
  [10, null, "収入", "#14b8a6", 4],
] as const;

const transactions: readonly {
  merchant: string; method: string; amount: number; actor: "owner" | "member";
  type: TransactionType; expenseClass: ExpenseClass; weights: readonly [number, number]; category: number | null;
}[] = [
  { merchant: "スーパーで食材", method: "PayPay", amount: 4800, actor: "owner", type: "PAYMENT", expenseClass: "SHARED", weights: [1, 1], category: 3 },
  { merchant: "二人でランチ", method: "クレジットカード", amount: 3200, actor: "member", type: "PAYMENT", expenseClass: "SHARED", weights: [1, 1], category: 4 },
  { merchant: "日用品の買い物", method: "PayPay", amount: 1980, actor: "member", type: "PAYMENT", expenseClass: "SHARED", weights: [3, 2], category: 6 },
  { merchant: "電気料金", method: "口座振替", amount: 6200, actor: "owner", type: "PAYMENT", expenseClass: "SHARED", weights: [1, 1], category: 7 },
  { merchant: "電車でお出かけ", method: "交通系IC", amount: 600, actor: "member", type: "PAYMENT", expenseClass: "PERSONAL", weights: [0, 1], category: 8 },
  { merchant: "読書用の本", method: "現金", amount: 1500, actor: "owner", type: "PAYMENT", expenseClass: "PERSONAL", weights: [1, 0], category: 9 },
  { merchant: "共通費の返金", method: "銀行振込", amount: 500, actor: "member", type: "RECEIPT", expenseClass: "SHARED", weights: [1, 1], category: 10 },
  { merchant: "カテゴリ未設定の買い物", method: "現金", amount: 1200, actor: "owner", type: "PAYMENT", expenseClass: "SHARED", weights: [1, 1], category: null },
];

const categoryId = (index: number) => `00000000-0000-4000-8100-${String(index).padStart(12, "0")}`;

export function previewSampleDataSql(workspaceId: string, ownerId: string, memberId: string): string {
  const workspace = `${literal(workspaceId)}::uuid`;
  return `
    ${categories.map(([index, parent, name, color, order]) => `
      INSERT INTO categories (id, workspace_id, parent_id, name, color_hex, sort_order, created_by, updated_by)
      VALUES (${literal(categoryId(index))}::uuid, ${workspace}, ${parent === null ? "NULL" : `${literal(categoryId(parent))}::uuid`},
        ${literal(name)}, ${literal(color)}, ${order}, ${literal(ownerId)}, ${literal(ownerId)});`).join("\n")}
    INSERT INTO transactions (workspace_id, occurred_at, merchant, method, type, amount_yen, actor_user_id,
      expense_class, split_weights, category_id, external_id, source, memo, created_by, updated_by)
    VALUES ${transactions.map((transaction, index) => {
      const actor = literal(transaction.actor === "owner" ? ownerId : memberId);
      const weights = literal(JSON.stringify({ [ownerId]: transaction.weights[0], [memberId]: transaction.weights[1] }));
      return `(${workspace},
        (date_trunc('month', now() AT TIME ZONE 'Asia/Tokyo') + interval '${index} days 12 hours') AT TIME ZONE 'Asia/Tokyo',
        ${literal(`[サンプル] ${transaction.merchant}`)}, ${literal(transaction.method)}, ${literal(transaction.type)},
        ${transaction.amount}, ${actor}, ${literal(transaction.expenseClass)}, ${weights}::jsonb,
        ${transaction.category === null ? "NULL" : `${literal(categoryId(transaction.category))}::uuid`},
        ${literal(`cake-preview-sample-v1-${index + 1}`)}, 'MANUAL',
        'Previewの検証用サンプルです。編集・削除できます。', ${actor}, ${actor})`;
    }).join(",\n")};
  `;
}
