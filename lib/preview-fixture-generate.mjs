import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { prepareMigration } from "../scripts/setup-db.mjs";
import { previewFixtureCatalogSql, previewFixtureCatalogFingerprintSql } from "./preview-fixture-base.mjs";

// Reproducible, explicit offline baseline generation. PGlite is installed outside
// the repo; no env files, Neon clients or configured connections are accessed.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--pglite-module") {
  throw new Error("Usage: node lib/preview-fixture-generate.mjs --pglite-module /absolute/path/to/pglite/dist/index.js");
}
const moduleUrl = pathToFileURL(resolve(args[1]));
const { PGlite } = await import(moduleUrl.href);
const { pgcrypto } = await import(new URL("contrib/pgcrypto.js", moduleUrl).href);
const db = new PGlite({ extensions: { pgcrypto } });
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  await db.exec("SET search_path=pg_catalog,public");
  const empty = [(await db.query(previewFixtureCatalogFingerprintSql())).rows[0].fingerprint];
  await db.exec("CREATE EXTENSION pgcrypto WITH SCHEMA public");
  empty.push((await db.query(previewFixtureCatalogFingerprintSql())).rows[0].fingerprint);
  await db.exec(`SET search_path=public;
    CREATE TABLE public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const migrations = [];
  const names = (await readdir(resolve(root, "db/migrations"))).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (names.length !== 11 || names.some((name, index) => !name.startsWith(`${String(index + 1).padStart(3, "0")}_`))) {
    throw new Error("The approved fixture requires exactly the reviewed 001..011 migrations.");
  }
  for (const name of names) {
    const source = await readFile(resolve(root, "db/migrations", name), "utf8");
    await db.exec(prepareMigration(name, source, { VERCEL_ENV: "preview" }));
    await db.query("INSERT INTO public.schema_migrations(name) VALUES ($1)", [name]);
    migrations.push({ name, sha256: createHash("sha256").update(source).digest("hex") });
  }
  await db.exec("SET search_path=pg_catalog,public");
  const fingerprint = (await db.query(previewFixtureCatalogFingerprintSql())).rows[0].fingerprint;
  const categories = (await db.query(`SELECT key,jsonb_array_length(value) AS count,
    encode(pg_catalog.sha256(pg_catalog.convert_to(value::text,'UTF8')),'hex') AS sha256
    FROM (${previewFixtureCatalogSql()}) catalog CROSS JOIN LATERAL jsonb_each(descriptor) ORDER BY key`)).rows;
  const versions = (await db.query(`SELECT current_setting('server_version_num') AS postgres,
    (SELECT extversion FROM pg_extension WHERE extname='pgcrypto') AS pgcrypto`)).rows[0];
  await writeFile(resolve(root, "lib/preview-fixture-reference.mjs"),
    `// Generated offline with PGlite PostgreSQL ${versions.postgres} + pgcrypto ${versions.pgcrypto} using trusted Preview prepareMigration.
// Hashes pin the exact semantic catalog, excluding OIDs, owners and C library paths.
// Review and regenerate explicitly when the approved baseline changes.
export const PREVIEW_FIXTURE_SCHEMA_SHA256 = ${JSON.stringify(fingerprint)};
export const PREVIEW_FIXTURE_EMPTY_SCHEMA_SHA256 = ${JSON.stringify(empty, null, 2)};
export const PREVIEW_FIXTURE_SCHEMA_CATEGORIES = ${JSON.stringify(categories, null, 2)};
export const PREVIEW_FIXTURE_MIGRATIONS = ${JSON.stringify(migrations, null, 2)};
`);
  console.log(JSON.stringify({ postgres: versions.postgres, pgcrypto: versions.pgcrypto, migrations: names.length, fingerprint }));
} finally {
  await db.close();
}
