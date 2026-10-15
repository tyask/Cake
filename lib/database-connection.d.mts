type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export type PreviewDatabaseIdentity = { slot: string; pr: number; leaseToken: string; sourceBranch: string; databaseHost: string; databaseName: string };
export type DatabaseQueryExecutor = { query(statement: string): PromiseLike<unknown> };
export function databaseVariable(environment: DatabaseEnvironment): "CAKE_TEST_DATABASE_URL" | "DATABASE_URL";
export function databaseConnectionString(environment: DatabaseEnvironment): string;
/** Cannele-tagged Preview URLs also reject connection overrides before any client is created. */
export function previewDatabaseIdentity(environment: DatabaseEnvironment): PreviewDatabaseIdentity | null;
export function previewDatabaseGuardSql(identity: PreviewDatabaseIdentity, initialize?: boolean, statements?: string): string;
export function guardPreviewDatabase(sql: DatabaseQueryExecutor, environment: DatabaseEnvironment, initialize?: boolean): Promise<PreviewDatabaseIdentity | null>;
