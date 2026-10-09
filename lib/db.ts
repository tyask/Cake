import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { instrumentDatabase } from "./db-query-logging";

let client: NeonQueryFunction<false, false> | undefined;

export function db(): NeonQueryFunction<false, false> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が設定されていません。");
  }
  client ??= instrumentDatabase(neon(connectionString));
  return client;
}
