import type { DatabaseQueryExecutor } from "../../lib/server/database/database-connection.mjs";
type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export function prepareMigration(name: string, migration: string, environment: DatabaseEnvironment): string;
export function setupDatabase(environment: DatabaseEnvironment, options?: {
  migrationDirectory?: string;
  readMigration?: (name: string) => Promise<string>;
  connect?: (connectionString: string) => DatabaseQueryExecutor;
}): Promise<void>;
