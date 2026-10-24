import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { instrumentDatabase } from "./db-query-logging";
import { databaseConnectionString } from "./database-environment";
import { cloudMemoryDatabase, cloudMemoryDatabaseUrl } from "./cloud-memory";

let client: NeonQueryFunction<false, false> | undefined;

export function db(): NeonQueryFunction<false, false> {
  const memoryUrl = cloudMemoryDatabaseUrl(process.env);
  if (memoryUrl) {
    client ??= instrumentDatabase(cloudMemoryDatabase(process.env)!);
    return client;
  }
  const connectionString = databaseConnectionString(process.env);
  client ??= instrumentDatabase(neon(connectionString));
  return client;
}
