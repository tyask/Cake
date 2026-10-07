const DATABASE_REASONS: Record<string, string> = {
  "23505": "既存データとの重複があります。",
  "23503": "参照先の利用者またはワークスペースがありません。",
  "23502": "必須の列に値がありません。",
  "23514": "DBの制約に違反しています。",
  "42501": "DBへの登録権限がありません。",
  "42P01": "必要なテーブルがありません。",
  "42703": "必要な列がありません。",
  "40001": "同時更新のためトランザクションが失敗しました。",
  "40P01": "DBの更新が競合しました。",
};

const SCHEMA_NAMES = new Set([
  "app_users", "workspaces", "workspace_members", "id", "email", "name", "image_url",
  "is_admin", "is_enabled", "workspace_id", "user_id", "role", "weight", "type", "owner_user_id",
  "app_users_pkey", "app_users_email_key", "app_users_normalized_email_check",
  "workspaces_pkey", "workspaces_name_check", "workspaces_type_check", "workspaces_owner_user_id_fkey",
  "workspace_members_pkey", "workspace_members_workspace_id_fkey", "workspace_members_user_id_fkey",
  "workspace_members_role_check", "workspace_members_weight_check",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

// Error messages, details and stacks can contain connection strings or row data.
// Emit only codes, known schema names, and descriptions written here.
export function formatSeedError(stage: string, error: unknown): string {
  const failure = record(error);
  const diagnostics = [`段階: ${stage}`];
  if (typeof failure.code === "string" && /^[0-9A-Z]{5}$/.test(failure.code)) {
    diagnostics.push(`SQLSTATE: ${failure.code}`);
    if (DATABASE_REASONS[failure.code]) diagnostics.push(DATABASE_REASONS[failure.code]);
  }
  for (const [property, label] of [["constraint", "制約"], ["table", "テーブル"], ["column", "列"]]) {
    const value = failure[property];
    if (typeof value === "string" && SCHEMA_NAMES.has(value)) diagnostics.push(`${label}: ${value}`);
  }
  if (failure.code === "P0001") {
    if (failure.message === "共有ワークスペースは二人までです") {
      diagnostics.push("テスト共有ワークスペースの既存メンバーが二人の上限に達しています。");
    } else if (failure.message === "個人ワークスペースには一人だけ参加できます") {
      diagnostics.push("個人ワークスペースのメンバー数制限に達しています。");
    }
  }
  const source = record(failure.sourceError ?? failure.cause);
  const networkCode = source.code ?? record(source.cause).code;
  if (typeof networkCode === "string" && /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(networkCode)) {
    diagnostics.push(`接続エラー: ${networkCode}`);
  }
  if (typeof failure.message === "string") {
    const httpStatus = /^Server error \(HTTP status (\d{3})\):/.exec(failure.message)?.[1];
    if (httpStatus) diagnostics.push(`DB HTTPステータス: ${httpStatus}`);
    if (failure.message.startsWith("Database connection string")) {
      diagnostics.push("DATABASE_URLの形式が不正です。");
    }
  }
  if (["Error", "TypeError", "NeonDbError", "DatabaseError", "AbortError", "TimeoutError"].includes(String(failure.name))) {
    diagnostics.push(`種別: ${failure.name}`);
  }
  return `テストユーザーの登録に失敗しました。${diagnostics.join(" / ")}`;
}
