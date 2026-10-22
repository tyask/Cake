type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export type PreviewDatabaseIdentity = { repository: string; pr: number; generation: string; branchId: string; sourceBranch: string; databaseHost: string; databaseName: string };
export type DatabaseQueryExecutor = { query(statement: string): PromiseLike<unknown> };
export function databaseVariable(environment: DatabaseEnvironment): "CAKE_TEST_DATABASE_URL" | "DATABASE_URL";
export function databaseConnectionString(environment: DatabaseEnvironment): string;
/** Preview URLs reject connection overrides before any client is created. */
export function previewDatabaseIdentity(environment: DatabaseEnvironment): PreviewDatabaseIdentity | null;
export function previewDatabaseGuardSql(identity: PreviewDatabaseIdentity, initialize?: boolean, statements?: string): string;
export function guardPreviewDatabase(sql: DatabaseQueryExecutor, environment: DatabaseEnvironment, initialize?: boolean): Promise<PreviewDatabaseIdentity | null>;
