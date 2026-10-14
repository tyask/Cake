const stages = ["UNKNOWN", "READ_LEDGER", "SAVE_LEDGER", "READ_PR", "READ_GIT", "READ_VARIABLES", "READ_PROJECT",
  "READ_DATABASE", "READ_DEPLOYMENTS", "READ_DEPLOYMENT", "CREATE_DEPLOYMENT", "READ_ALIAS", "ASSIGN_ALIAS",
  "DELETE_ALIAS", "DELETE_DEPLOYMENT", "APPROVAL_VALIDATE", "ALIAS_APPROVAL", "PROBE_APPROVAL"] as const;
const providers = ["UNKNOWN", "GITHUB", "VERCEL", "NEON", "NONE"] as const;
const methods = ["UNKNOWN", "GET", "POST", "PATCH", "DELETE", "NONE"] as const;
const reasons = ["UNKNOWN", "AUTH_MISSING", "METHOD_NOT_ALLOWED", "TRANSPORT_ERROR", "HTTP_ERROR", "INVALID_RESPONSE",
  "CHECK_FAILED", "VALIDATION_ERROR"] as const;

export type QaDiagnosticFields = {
  stage: typeof stages[number]; provider: typeof providers[number]; method: typeof methods[number];
  status: number | null; reason: typeof reasons[number];
};
type Context = Partial<Pick<QaDiagnosticFields, "stage" | "provider" | "method">>;
const member = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
const sanitized = (value: Partial<QaDiagnosticFields>): QaDiagnosticFields => ({
  stage: member(value.stage, stages, "UNKNOWN"), provider: member(value.provider, providers, "UNKNOWN"),
  method: member(value.method, methods, "UNKNOWN"),
  status: typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : null,
  reason: member(value.reason, reasons, "UNKNOWN"),
});

/** Only allow-listed metadata is retained. Remote messages, URLs, bodies and causes are discarded. */
export class QaDiagnosticFailure extends Error {
  readonly diagnostic: QaDiagnosticFields;
  constructor(value: Partial<QaDiagnosticFields>) {
    const diagnostic = sanitized(value);
    super(diagnostic.reason === "METHOD_NOT_ALLOWED" ? "GET専用検査から変更APIは呼び出せません。" : "QA処理を確認できません。");
    this.diagnostic = Object.freeze(diagnostic);
  }
}

export function qaDiagnosticFields(error: unknown): QaDiagnosticFields {
  try { return error instanceof QaDiagnosticFailure ? sanitized(error.diagnostic) : sanitized({}); }
  catch { return sanitized({}); }
}

/** Add the fixed operation to shape/check failures without reading an arbitrary error message. */
export function contextualQaFailure(error: unknown, context: Context): QaDiagnosticFailure {
  const current = qaDiagnosticFields(error);
  return new QaDiagnosticFailure({ ...current,
    stage: current.stage === "UNKNOWN" ? context.stage : current.stage,
    provider: current.provider === "UNKNOWN" ? context.provider : current.provider,
    method: current.method === "UNKNOWN" ? context.method : current.method,
    reason: current.reason,
  });
}

/** All fields are enums or an integer, so workflow-command control characters cannot be injected. */
export function qaFailureAnnotation(error: unknown): string {
  const value = qaDiagnosticFields(error);
  return `::error title=QA writer failure::stage=${value.stage} provider=${value.provider} method=${value.method} status=${value.status ?? "NONE"} reason=${value.reason}`;
}
