import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL を設定してください。");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migration = await readFile(resolve(here, "../db/migrations/001_initial.sql"), "utf8");
const sql = neon(connectionString);
await sql.query(migration);
console.log("Cakeのデータベースを初期化しました。");

