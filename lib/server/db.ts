import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { instrumentDatabase } from "./db-query-logging";
import { databaseConnectionString } from "./database-environment";

let client: NeonQueryFunction<false, false> | undefined;

export function db(): NeonQueryFunction<false, false> {
  const connectionString = databaseConnectionString(process.env);
  client ??= instrumentDatabase(neon(connectionString));
  return client;
}
