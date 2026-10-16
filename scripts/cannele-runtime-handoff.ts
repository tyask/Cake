import { createHash } from "node:crypto";

// Reviewed Vercel REST: GET/POST v10 project env, PATCH v9 env ID, and
// GET v1 env ID for the four known public Config values only.
const PROJECT = "prj_EgVvFUE4gXVZnMTuw69lQ3mIGYVN";
const TEAM = "team_D1Mcx2TdFWPKcypfu8KzNMub";
const ORIGIN = "https://api.vercel.com";
const API_ORIGIN = "https://cannele-cake.vercel.app";
const SECRET_KEYS = ["CANNELE_REGISTRY_DATABASE_URL", "CANNELE_REGISTRY_DATABASE_HOST", "CANNELE_VERCEL_TOKEN", "CANNELE_NEON_API_KEY"] as const;
const PUBLIC_KEYS = ["CANNELE_BINDING_JSON", "CANNELE_API_ORIGIN", "CANNELE_API_MUTATIONS_ENABLED", "CANNELE_PROVIDER_OPERATIONS_ENABLED"] as const;
const MAX_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9_-]{1,255}$/;
type Object_ = Record<string, unknown>;
type Context = { instanceId: string; repositoryId: number; bindingDigest: string; writerEpoch: number; schemaVersion: number; schemaChecksum: string };
type Code = "INPUT_INVALID" | "PREFLIGHT_REQUIRED" | "PROJECT_MISMATCH" | "NOT_DISABLED" | "CONTEXT_MISMATCH" | "ENV_CONFLICT" | "RESPONSE_INVALID" | "REQUEST_FAILED" | "WRITE_UNKNOWN";

export class RuntimeHandoffError extends Error {
  readonly code: string;
  constructor(code: Code) { super("Runtime credential handoff could not be verified."); this.code = `RUNTIME_HANDOFF_${code}`; }
}
const fail = (code: Code): never => { throw new RuntimeHandoffError(code); };
const object = (value: unknown): Object_ => value && typeof value === "object" && !Array.isArray(value) ? value as Object_ : fail("RESPONSE_INVALID");

function checkedContext(value: Record<string, unknown>): Context {
  const keys = ["instanceId", "repositoryId", "bindingDigest", "writerEpoch", "schemaVersion", "schemaChecksum"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || typeof value.instanceId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.instanceId)
    || !Number.isSafeInteger(value.repositoryId) || Number(value.repositoryId) < 1 || !Number.isSafeInteger(value.writerEpoch) || Number(value.writerEpoch) < 1
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1
    || typeof value.bindingDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.bindingDigest)
    || typeof value.schemaChecksum !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaChecksum)) return fail("INPUT_INVALID");
  return { instanceId: value.instanceId, repositoryId: Number(value.repositoryId), bindingDigest: value.bindingDigest,
    writerEpoch: Number(value.writerEpoch), schemaVersion: Number(value.schemaVersion), schemaChecksum: value.schemaChecksum };
}
function role(value: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) return fail("INPUT_INVALID");
  return value;
}
function token(value: string): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return fail("INPUT_INVALID");
  return value;
}

/** Fixed key order and typed scalar values bind retries to one immutable role/context. */
export function runtimeHandoffMarker(context: Record<string, unknown>, roleName: string): string {
  const checked = checkedContext(context);
  return `cannele-runtime-handoff/v1:${createHash("sha256").update(JSON.stringify({ ...checked, roleName: role(roleName) })).digest("hex")}`;
}

type EnvRow = { id: string; key: string; type: unknown; target: unknown; comment: unknown; gitBranch: unknown; customEnvironmentIds: unknown;
  customEnvironmentId: unknown; customEnvironmentSlug: unknown; configurationId: unknown; integrationConfigurationId: unknown; integrationId: unknown;
  system: unknown; visibility: unknown; contentHint: unknown; edgeConfigId: unknown; edgeConfigTokenId: unknown };
function row(value: unknown): EnvRow {
  const raw = object(value);
  if (typeof raw.id !== "string" || !ID.test(raw.id) || typeof raw.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(raw.key)) return fail("RESPONSE_INVALID");
  // Do not project or inspect any sensitive value from a metadata response.
  return { id: raw.id, key: raw.key, type: raw.type, target: raw.target, comment: raw.comment, gitBranch: raw.gitBranch,
    customEnvironmentIds: raw.customEnvironmentIds, customEnvironmentId: raw.customEnvironmentId, customEnvironmentSlug: raw.customEnvironmentSlug,
    configurationId: raw.configurationId, integrationConfigurationId: raw.integrationConfigurationId, integrationId: raw.integrationId,
    system: raw.system, visibility: raw.visibility, contentHint: raw.contentHint, edgeConfigId: raw.edgeConfigId, edgeConfigTokenId: raw.edgeConfigTokenId };
}
function manualProduction(env: EnvRow): boolean {
  return (env.target === "production" || Array.isArray(env.target) && env.target.length === 1 && env.target[0] === "production")
    && env.gitBranch == null && env.customEnvironmentId == null && env.customEnvironmentSlug == null
    && (env.customEnvironmentIds === undefined || Array.isArray(env.customEnvironmentIds) && env.customEnvironmentIds.length === 0)
    && env.configurationId == null && env.integrationConfigurationId == null && env.integrationId == null
    && (env.system === undefined || env.system === false) && env.contentHint == null && env.edgeConfigId == null && env.edgeConfigTokenId == null;
}

export function createRuntimeHandoff(options: { vercelToken: string; neonApiKey: string; context: Record<string, unknown>; roleName: string; request?: typeof fetch }): {
  preflight(): Promise<void>; publish(input: { databaseUrl: string; databaseHost: string }): Promise<void>;
} {
  const context = checkedContext(options.context), roleName = role(options.roleName);
  const vercelToken = token(options.vercelToken), neonApiKey = token(options.neonApiKey);
  const marker = runtimeHandoffMarker(context, roleName), request = options.request ?? fetch;
  let prepared = false;
  const path = (version: number, suffix = "", extra = "") => `/v${version}/projects/${PROJECT}${suffix}?teamId=${TEAM}${extra}`;

  async function send(endpoint: string, method: "GET" | "POST" | "PATCH", signal: AbortSignal, body?: Object_): Promise<Response> {
    try {
      const response = await request(new URL(endpoint, ORIGIN), { method, redirect: "manual", cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { authorization: `Bearer ${vercelToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.redirected || response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined); return fail("REQUEST_FAILED");
      }
      return response;
    } catch { return fail("REQUEST_FAILED"); }
  }
  async function json(endpoint: string, signal: AbortSignal): Promise<unknown> {
    const response = await send(endpoint, "GET", signal);
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return fail("REQUEST_FAILED"); }
    const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength; if (bytes > MAX_BYTES) { await reader.cancel().catch(() => undefined); return fail("RESPONSE_INVALID"); }
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) { if (error instanceof RuntimeHandoffError) throw error; return fail("RESPONSE_INVALID"); }
    finally { reader.releaseLock(); }
  }
  async function metadata(signal: AbortSignal): Promise<Map<string, EnvRow>> {
    const body = object(await json(path(10, "/env", "&decrypt=false"), signal));
    if (!Array.isArray(body.envs) || body.envs.length > 10_000 || body.hiddenProductionEnvCount !== undefined && body.hiddenProductionEnvCount !== 0
      || ["next", "next_cursor", "cursor"].some(key => body[key] !== undefined)) return fail("RESPONSE_INVALID");
    if (body.pagination !== undefined) {
      const pagination = object(body.pagination);
      if (Object.keys(pagination).some(key => !["count", "next", "prev"].includes(key)) || pagination.next !== null
        || pagination.count !== body.envs.length || pagination.prev !== null && (typeof pagination.prev !== "number" || !Number.isSafeInteger(pagination.prev))) return fail("RESPONSE_INVALID");
    }
    const found = new Map<string, EnvRow>(), ids = new Set<string>();
    for (const raw of body.envs) {
      const env = row(raw); if (ids.has(env.id)) return fail("RESPONSE_INVALID"); ids.add(env.id);
      if (!(PUBLIC_KEYS as readonly string[]).includes(env.key) && !(SECRET_KEYS as readonly string[]).includes(env.key)) continue;
      if (found.has(env.key)) return fail("ENV_CONFLICT"); found.set(env.key, env);
    }
    for (const key of SECRET_KEYS) {
      const env = found.get(key);
      if (env && (!manualProduction(env) || env.type !== "sensitive" || env.visibility !== undefined && env.visibility !== "secret" || env.comment !== marker)) return fail("ENV_CONFLICT");
    }
    return found;
  }
  async function inspect(signal: AbortSignal): Promise<Map<string, EnvRow>> {
    const project = object(await json(path(9), signal));
    if (project.id !== PROJECT || project.name !== "cannele-cake" || project.accountId !== TEAM) return fail("PROJECT_MISMATCH");
    const found = await metadata(signal), values = new Map<string, string>();
    // All four metadata rows are verified before the first public-value GET.
    for (const key of PUBLIC_KEYS) {
      const env = found.get(key);
      if (!env || !manualProduction(env) || !["plain", "encrypted"].includes(String(env.type)) || env.visibility !== undefined && env.visibility !== "config") return fail("ENV_CONFLICT");
    }
    for (const key of PUBLIC_KEYS) {
      const env = found.get(key)!;
      const body = object(await json(path(1, `/env/${env.id}`), signal)), current = row(body);
      if (current.id !== env.id || current.key !== key || !manualProduction(current) || !["plain", "encrypted"].includes(String(current.type))
        || current.visibility !== undefined && current.visibility !== "config") return fail("ENV_CONFLICT");
      if (typeof body.value !== "string") return fail(key.endsWith("_ENABLED") ? "NOT_DISABLED" : "CONTEXT_MISMATCH");
      values.set(key, body.value);
    }
    if (values.get("CANNELE_API_ORIGIN") !== API_ORIGIN) return fail("CONTEXT_MISMATCH");
    if (values.get("CANNELE_API_MUTATIONS_ENABLED") !== "false" || values.get("CANNELE_PROVIDER_OPERATIONS_ENABLED") !== "false") return fail("NOT_DISABLED");
    let binding: Object_; try { binding = object(JSON.parse(values.get("CANNELE_BINDING_JSON")!)); } catch { return fail("CONTEXT_MISMATCH"); }
    if (binding.instanceId !== context.instanceId || binding.bindingDigest !== context.bindingDigest || binding.writerEpoch !== context.writerEpoch
      || !binding.repository || typeof binding.repository !== "object" || Array.isArray(binding.repository) || (binding.repository as Object_).id !== context.repositoryId) return fail("CONTEXT_MISMATCH");
    return found;
  }
  async function write(method: "POST" | "PATCH", endpoint: string, body: Object_, signal: AbortSignal): Promise<boolean> {
    try {
      const response = await send(endpoint, method, signal, body);
      // Provider write bodies may contain values; neither parse nor expose them.
      await response.body?.cancel().catch(() => undefined);
      return response.status === 200 || method === "POST" && response.status === 201;
    } catch { return false; }
  }
  function credentials(input: { databaseUrl: string; databaseHost: string }): string[] {
    try {
      if (!input || typeof input.databaseUrl !== "string" || input.databaseUrl.length > 32768 || typeof input.databaseHost !== "string") return fail("INPUT_INVALID");
      const url = new URL(input.databaseUrl), password = decodeURIComponent(url.password);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash || decodeURIComponent(url.username) !== roleName || !password || /[\u0000-\u001f\u007f]/.test(password)
        || url.hostname !== input.databaseHost || !/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(input.databaseHost)
        || url.port && url.port !== "5432" || decodeURIComponent(url.pathname) !== "/neondb"
        || [...url.searchParams.keys()].some(key => key !== "sslmode") || url.searchParams.getAll("sslmode").length > 1
        || !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "verify-full")) return fail("INPUT_INVALID");
      return [input.databaseUrl, input.databaseHost, vercelToken, neonApiKey];
    } catch { return fail("INPUT_INVALID"); }
  }
  return {
    async preflight() {
      prepared = false; await inspect(AbortSignal.timeout(30_000)); prepared = true;
    },
    async publish(input) {
      if (!prepared) return fail("PREFLIGHT_REQUIRED");
      const values = credentials(input), signal = AbortSignal.timeout(90_000);
      await inspect(signal);
      for (const [index, key] of SECRET_KEYS.entries()) {
        const body = { key, value: values[index], type: "sensitive", target: ["production"], comment: marker, gitBranch: null, customEnvironmentIds: [] };
        let done = false;
        for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
          let found = await metadata(signal), env = found.get(key);
          if (!env) {
            await write("POST", path(10, "/env"), body, signal);
            found = await metadata(signal); env = found.get(key); if (!env) continue;
          }
          // A POST response can be lost or contain a partial failure. Once an
          // exact owned row exists, require acknowledgement of the same PATCH.
          if (!await write("PATCH", path(9, `/env/${env.id}`), body, signal)) { await metadata(signal); continue; }
          const confirmed = (await metadata(signal)).get(key);
          if (confirmed?.id === env.id) { done = true; break; }
        }
        if (!done) return fail("WRITE_UNKNOWN");
      }
      const confirmed = await inspect(signal);
      if (SECRET_KEYS.some(key => !confirmed.has(key))) return fail("WRITE_UNKNOWN");
    },
  };
}
