import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { SLOTS, leaseToken, type Slot, type DatabaseIdentity } from "../lib/qa-pool";
import {
  parseRegistryLease, validateRegistryReservation, validateRegistryTransition,
  type QaRegistryLease, type QaRegistryStore, type RegistryExpected, type RegistryPool, type RegistryReservation,
} from "../lib/qa-registry";

export type RegistryQuery = (statement: string, parameters?: unknown[]) => Promise<Record<string, unknown>[]>;
const DATABASE_ERROR = "QA管理DBの読取・更新を確認できません。接続情報やDBエラー本文は表示しません。";
const CONNECTION_ERROR = "独立したQA管理DBの明示接続先とhost照合が必要です。DB操作は開始しません。";

function normalizedHost(value: string): string {
  const parsed = new URL(value.includes("://") ? value : `postgresql://guard@${value}/guard`);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(parsed.hostname)) throw new Error(CONNECTION_ERROR);
  return parsed.hostname.replace(/-pooler(?=\.)/, "");
}

/** No DATABASE_URL fallback, no env files, and no application DB client. */
export function registryConnectionString(environment: Record<string, string | undefined>): string {
  try {
    const connection = environment.CAKE_QA_REGISTRY_DATABASE_URL?.trim();
    const pinned = environment.CAKE_QA_REGISTRY_DATABASE_HOST?.trim();
    if (!connection || !pinned || connection === "[SENSITIVE]") throw new Error();
    const host = normalizedHost(connection);
    if (host !== normalizedHost(pinned)) throw new Error();
    for (const key of ["CAKE_QA_PRODUCTION_DATABASE_HOST", "CAKE_QA_PARENT_DATABASE_HOST", "CAKE_QA_DATABASE_HOST", "DATABASE_URL", "CAKE_TEST_DATABASE_URL"]) {
      const other = environment[key]?.trim();
      if (other && host === normalizedHost(other)) throw new Error();
    }
    const url = new URL(connection);
    if (!url.username || !url.password || !/^\/[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(url.pathname)) throw new Error();
    return connection;
  } catch { throw new Error(CONNECTION_ERROR); }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
  return value;
}
export function registryRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

/** The trusted main Actions runner alone receives this store's credentials. */
export class NeonQaRegistryStore implements QaRegistryStore {
  constructor(private readonly query: RegistryQuery) {}

  private async execute(statement: string, parameters: unknown[] = []): Promise<Record<string, unknown>[]> {
    try { return await this.query(statement, parameters); }
    catch { throw new Error(DATABASE_ERROR); }
  }

  async read(): Promise<RegistryPool> {
    const rows = await this.execute(`SELECT cake_qa_registry.assert_identity(), slot, version, record,
      COALESCE((SELECT jsonb_agg(identity ORDER BY identity::text) FROM (
        SELECT DISTINCT record->'database' AS identity FROM cake_qa_registry.history
        WHERE record->>'state' = 'free' AND record ? 'database'
      ) retired), '[]'::jsonb) AS retired_databases
      FROM cake_qa_registry.slots ORDER BY slot`);
    const slots: RegistryPool["slots"] = { qa1: null, qa2: null, qa3: null };
    const found = new Set<Slot>();
    let retiredDatabases: DatabaseIdentity[] = [];
    for (const row of rows) {
      if (!SLOTS.includes(row.slot as Slot) || found.has(row.slot as Slot)) throw new Error(DATABASE_ERROR);
      const slot = row.slot as Slot; found.add(slot);
      if (row.record === null && Number(row.version) !== 0) throw new Error(DATABASE_ERROR);
      const record = row.record === null ? null : parseRegistryLease(row.record);
      if (record && (record.slot !== slot || record.version !== Number(row.version))) throw new Error(DATABASE_ERROR);
      slots[slot] = record;
      if (!Array.isArray(row.retired_databases)) throw new Error(DATABASE_ERROR);
      retiredDatabases = row.retired_databases as DatabaseIdentity[];
    }
    if (found.size !== SLOTS.length) throw new Error(DATABASE_ERROR);
    // Reuse the strict record validator for private retired identities.
    const sample = Object.values(slots).find((record) => record !== null);
    if (sample) parseRegistryLease({ ...sample, retiredDatabases });
    else if (retiredDatabases.length) throw new Error(DATABASE_ERROR);
    return { slots, retiredDatabases };
  }

  async reserve(input: RegistryReservation): Promise<QaRegistryLease | null> {
    validateRegistryReservation(input);
    const fingerprint = registryRequestFingerprint({ operation: "reserve", ...input, now: undefined });
    const rows = await this.execute("SELECT cake_qa_registry.reserve($1::jsonb, $2) AS record", [JSON.stringify(input), fingerprint]);
    if (rows.length !== 1 || !Object.hasOwn(rows[0], "record")) throw new Error(DATABASE_ERROR);
    return rows[0].record === null ? null : parseRegistryLease(rows[0].record);
  }

  /** Caller must directly verify all provider resources absent before writing free. */
  async writeSnapshot(slot: Slot, expected: RegistryExpected, next: QaRegistryLease): Promise<QaRegistryLease> {
    const canonical = parseRegistryLease(next);
    if (!SLOTS.includes(slot) || canonical.slot !== slot || !leaseToken(expected.leaseId)
      || !Number.isSafeInteger(expected.version) || expected.version < 1 || canonical.leaseId !== expected.leaseId
      || canonical.version !== expected.version + 1) throw new Error("QA管理DBの更新条件が不正です。");
    const pool = await this.read();
    const current = pool.slots[slot];
    if (current?.leaseId === expected.leaseId && current.version === expected.version) validateRegistryTransition(current, canonical);
    // If a prior attempt already committed, SQL returns its exact receipt before
    // checking CAS. An unknown stale request still fails without any changes.
    const fingerprint = registryRequestFingerprint({ operation: "write", slot, expected, next: canonical });
    const rows = await this.execute("SELECT cake_qa_registry.write_snapshot($1, $2::uuid, $3::bigint, $4::jsonb, $5) AS record",
      [slot, expected.leaseId, expected.version, JSON.stringify(canonical), fingerprint]);
    if (rows.length !== 1) throw new Error(DATABASE_ERROR);
    return parseRegistryLease(rows[0].record);
  }
}

export function createQaRegistryStore(environment: Record<string, string | undefined> = process.env): NeonQaRegistryStore {
  const client = neon(registryConnectionString(environment));
  return new NeonQaRegistryStore(async (statement, parameters = []) => await client.query(statement, parameters) as Record<string, unknown>[]);
}
