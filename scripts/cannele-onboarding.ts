import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HttpQaGateway, type QaTransport } from "./qa-pool-writer";

const REPOSITORY = "tyask/Cake";
const REPOSITORY_ID = 1318171856;
const OWNER_ID = 16447050;
const WORKFLOW = ".github/workflows/cannele-onboarding.yml";
const HELPER = ".github/workflows/cannele-onboarding-run.yml";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FLAGS = ["CAKE_CANNELE_ENABLED", "CAKE_QA_POOL_ENABLED", "CAKE_QA_REGISTRY_ENABLED"] as const;
const DRAIN_FIELDS = ["allCloudTasksStopped", "allPcSessionsStopped", "oldProviderCreationCredentialsRevoked",
  "legacyRegistryAndOwnerCredentialsRevoked", "noInFlightProviderWriters", "noUnknownCreationIntents"] as const;
type Env = Readonly<Record<string, string | undefined>>;
type Object_ = Record<string, unknown>;
export type OnboardingAction = "inspect" | "transition" | "provision-runtime";
export class OnboardingError extends Error {
  constructor(readonly code: string) { super("Cannele onboarding could not be verified; private details suppressed."); }
}
const fail = (code: string): never => { throw new OnboardingError(code); };
const object = (value: unknown): Object_ => value && typeof value === "object" && !Array.isArray(value) ? value as Object_ : fail("ONBOARDING_INPUT_INVALID");
const text = (value: unknown, pattern: RegExp): string => typeof value === "string" && pattern.test(value) ? value : fail("ONBOARDING_INPUT_INVALID");
const number = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail("ONBOARDING_RESULT_INVALID");
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const blob = (value: Uint8Array): string => createHash("sha1").update(`blob ${value.byteLength}\0`).update(value).digest("hex");
function json(value: string | undefined): Object_ {
  if (!value || Buffer.byteLength(value) > 65_536) return fail("ONBOARDING_INPUT_INVALID");
  try { return object(JSON.parse(value)); } catch { return fail("ONBOARDING_INPUT_INVALID"); }
}
function exact(value: Object_, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail("ONBOARDING_INPUT_INVALID");
}
function secret(environment: Env, name: string): string {
  const value = environment[name];
  if (!value) return fail("ONBOARDING_CREDENTIAL_REQUIRED");
  return value;
}
export type OnboardingSource = { cakeRevision: string; canneleRevision: string; workflowBlobSha: string; helperBlobSha: string; sourceDirectory: string };
export type OnboardingRun = { runId: string; runAttempt: 1 };
type Provider = "github" | "vercel" | "neon";
type ReadTransport = (provider: Provider, path: string, options: { signal: AbortSignal }) => Promise<{ status: number; data: unknown; redirected: boolean }>;
type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Object_[] }>; release(): void };
type Pool = { connect(): Promise<Client>; end(): Promise<void> };
type Connection = { host: string; port: number; database: string; user: string };
type Snapshot = { identity: { protocol: string; databaseName: string; writerMode: string; writerEpoch: number; fenceReceipt: Object_ }; stateDigest: string; footprintDigest: string };
export type OnboardingCore = {
  connection(environment: Env): Connection;
  pool(connection: Connection): Pool;
  migrations(): Promise<unknown[]>;
  inspect(client: Client): Promise<Snapshot>;
  transition(client: Client, migrations: unknown[], input: Object_, options: { connectedHostDigest: string; verify(input: unknown): Promise<unknown> }): Promise<Object_>;
  provision(client: Client, input: { roleName: string; context: Object_ }): Promise<void>;
  assertRuntime(client: Client, context: Object_): Promise<void>;
  transport(environment: { githubToken: string; vercelToken: string; neonApiKey: string }): ReadTransport;
  verify(transport: ReadTransport, input: unknown): Promise<unknown>;
  errorCode(error: unknown): string | null;
};

/** The three repository variable responses come only from this authorized,
 * environment-free workflow context. There is no Cloud/file fallback. */
export class OnboardingGateway extends HttpQaGateway {
  private authorized = false;
  private readonly variables = new Map<string, { name: string; value: string }>();
  constructor(private readonly environment: Env, request?: QaTransport) { super(environment, request, "read"); }
  async authorize(source: OnboardingSource): Promise<OnboardingRun> {
    const e = this.environment;
    if (e.GITHUB_REPOSITORY !== REPOSITORY || e.GITHUB_REF !== "refs/heads/main" || e.EVENT_NAME !== "workflow_dispatch"
      || e.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main`
      || e.GITHUB_WORKFLOW_SHA !== source.cakeRevision || e.QA_TRUSTED_MAIN_SHA !== source.cakeRevision
      || e.CANNELE_ONBOARDING_EXPECTED_REVISION !== source.cakeRevision || !SHA.test(source.cakeRevision)
      || !SHA.test(source.canneleRevision) || !UUID.test(e.CANNELE_ONBOARDING_REQUEST_ID ?? "")
      || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? "")) return fail("ONBOARDING_RUN_UNTRUSTED");
    const get = async (path: string): Promise<Object_> => {
      try { return object(await this.api("github", path)); } catch { return fail("ONBOARDING_RUN_UNTRUSTED"); }
    };
    const repository = await get(`/repos/${REPOSITORY}`), owner = object(repository.owner);
    const run = await get(`/repos/${REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`);
    const main = await get(`/repos/${REPOSITORY}/branches/main`);
    if (repository.id !== REPOSITORY_ID || repository.full_name !== REPOSITORY || owner.id !== OWNER_ID || owner.type !== "User"
      || object(run.actor).id !== OWNER_ID || object(run.actor).type !== "User" || object(run.triggering_actor).id !== OWNER_ID || object(run.triggering_actor).type !== "User"
      || String(run.id) !== e.GITHUB_RUN_ID || object(run.repository).full_name !== REPOSITORY || object(run.head_repository).full_name !== REPOSITORY
      || run.path !== WORKFLOW || run.head_branch !== "main" || run.head_sha !== source.cakeRevision || run.run_attempt !== 1
      || run.event !== "workflow_dispatch" || run.status !== "in_progress" || object(main.commit).sha !== source.cakeRevision) return fail("ONBOARDING_RUN_UNTRUSTED");
    const references = run.referenced_workflows;
    if (!Array.isArray(references) || references.length !== 1) return fail("ONBOARDING_RUN_UNTRUSTED");
    const helper = object(references[0]);
    if (helper.sha !== source.cakeRevision || ![`${REPOSITORY}/${HELPER}@refs/heads/main`, `${REPOSITORY}/${HELPER}@main`, `${REPOSITORY}/${HELPER}@${source.cakeRevision}`].includes(String(helper.path))) return fail("ONBOARDING_RUN_UNTRUSTED");
    for (const [path, expected] of [[WORKFLOW, source.workflowBlobSha], [HELPER, source.helperBlobSha]]) {
      const file = await get(`/repos/${REPOSITORY}/contents/${path}?ref=${source.cakeRevision}`);
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.sha !== expected || !SHA.test(expected)) return fail("ONBOARDING_SOURCE_UNTRUSTED");
      const bytes = Buffer.from(file.content.replace(/\s/g, ""), "base64");
      if (bytes.length > 262_144 || blob(bytes) !== expected) return fail("ONBOARDING_SOURCE_UNTRUSTED");
    }
    for (const name of FLAGS) {
      if (e[name] !== (name === "CAKE_CANNELE_ENABLED" ? "true" : "false")) return fail("ONBOARDING_LEGACY_FLAGS_NOT_STOPPED");
      this.variables.set(`/repos/${REPOSITORY}/actions/variables/${name}`, { name, value: e[name]! });
    }
    this.authorized = true;
    return { runId: e.GITHUB_RUN_ID!, runAttempt: 1 };
  }
  variableTransport(delegate: ReadTransport): ReadTransport {
    if (!this.authorized) return fail("ONBOARDING_RUN_UNTRUSTED");
    return async (provider, path, options) => {
      const value = provider === "github" ? this.variables.get(path) : undefined;
      if (value) {
        options.signal.throwIfAborted();
        return { status: 200, data: { ...value }, redirected: false };
      }
      return delegate(provider, path, options);
    };
  }
}

function runtimeContext(value: Object_): Object_ {
  exact(value, ["instanceId", "repositoryId", "bindingDigest", "writerEpoch", "schemaVersion", "schemaChecksum"]);
  text(value.instanceId, UUID); text(value.bindingDigest, DIGEST); text(value.schemaChecksum, DIGEST);
  if (value.repositoryId !== REPOSITORY_ID || value.writerEpoch !== 1 || value.schemaVersion !== 4) return fail("ONBOARDING_CONTEXT_INVALID");
  return value;
}
function transitionInput(environment: Env, source: OnboardingSource): Object_ {
  const input = json(environment.CANNELE_ONBOARDING_TRANSITION_JSON);
  if (environment.CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN !== "true") return fail("ONBOARDING_CREDENTIAL_DRAIN_UNCONFIRMED");
  const admission = object(input.admission), sources = object(input.source), repository = object(input.repository);
  if (DRAIN_FIELDS.some(name => admission[name] !== true)) return fail("ONBOARDING_CREDENTIAL_DRAIN_UNCONFIRMED");
  if (sources.canneleRevision !== source.canneleRevision || !SHA.test(String(sources.cakeRevision))
    || repository.id !== String(REPOSITORY_ID) || repository.fullName !== REPOSITORY || admission.reviewerGitHubId !== String(OWNER_ID)) return fail("ONBOARDING_CONTEXT_INVALID");
  // Full closed shape, binding, checksums, timestamps and exact prior fence are
  // validated again by transitionLegacyRegistry before BEGIN.
  return input;
}
export type OnboardingReceipt = { protocol: "cake-cannele-onboarding-result/v1"; requestId: string; action: OnboardingAction;
  source: Omit<OnboardingSource, "sourceDirectory">; run: OnboardingRun; database: { name: string; hostDigest: string }; result: Object_ };

/** Administrative helpers receive credentials only after the actual trusted
 * owner/main workflow and both source blobs have been independently checked. */
export async function runOnboarding(environment: Env, dependencies: { source: OnboardingSource; transport?: QaTransport; core: () => Promise<OnboardingCore> }): Promise<OnboardingReceipt> {
  const { source } = dependencies, gateway = new OnboardingGateway(environment, dependencies.transport);
  const run = await gateway.authorize(source);
  const action = environment.CANNELE_ONBOARDING_ACTION;
  if (action !== "inspect" && action !== "transition" && action !== "provision-runtime") return fail("ONBOARDING_ACTION_INVALID");
  const input = action === "transition" ? transitionInput(environment, source) : null;
  const context = action === "provision-runtime" ? runtimeContext(json(environment.CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON)) : null;
  const roleName = action === "provision-runtime" ? text(environment.CANNELE_ONBOARDING_RUNTIME_ROLE_NAME, /^[a-z][a-z0-9_]{0,62}$/) : null;
  if ((action !== "transition" && environment.CANNELE_ONBOARDING_TRANSITION_JSON)
    || (action !== "provision-runtime" && (environment.CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON || environment.CANNELE_ONBOARDING_RUNTIME_ROLE_NAME))) return fail("ONBOARDING_INPUT_INVALID");
  const core = await dependencies.core();
  try {
    const connection = core.connection({ CANNELE_REGISTRY_DATABASE_URL: secret(environment, "CANNELE_REGISTRY_ADMIN_DATABASE_URL"),
      CANNELE_REGISTRY_DATABASE_HOST: secret(environment, "CANNELE_REGISTRY_ADMIN_DATABASE_HOST") });
    const database = { name: connection.database, hostDigest: hash(connection.host) };
    const pool = core.pool(connection);
    let result: Object_;
    try {
      const client = await pool.connect();
      try {
        if (action === "inspect") {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          try {
            await client.query("SELECT pg_advisory_xact_lock(hashtext('cake:qa-registry:v1'))");
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('cannele_registry:control',0))");
            await client.query("SET LOCAL search_path=pg_catalog");
            const version = await client.query("SELECT current_setting('server_version_num')::integer / 10000 AS major");
            const postgresMajor = number(version.rows[0]?.major);
            const snapshot = await core.inspect(client), identity = snapshot.identity;
            if (identity.protocol !== "cake-qa-registry/v1" || identity.databaseName !== connection.database || identity.writerMode !== "legacy" || identity.writerEpoch !== 1) return fail("ONBOARDING_LEGACY_IDENTITY_INVALID");
            result = { stateDigest: text(snapshot.stateDigest, DIGEST), footprintDigest: text(snapshot.footprintDigest, DIGEST), writerMode: "legacy", writerEpoch: 1, postgresMajor,
              fenceRevision: text(identity.fenceReceipt.revision, SHA) };
            await client.query("COMMIT");
          } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
        } else if (action === "transition") {
          const migrations = await core.migrations();
          const transitioned = await core.transition(client, migrations, input!, { connectedHostDigest: database.hostDigest,
            verify: request => core.verify(gateway.variableTransport(core.transport({ githubToken: secret(environment, "GITHUB_TOKEN"),
              vercelToken: secret(environment, "CANNELE_TRANSITION_VERCEL_TOKEN"), neonApiKey: secret(environment, "CANNELE_TRANSITION_NEON_API_KEY") })), request) });
          const receipt = object(transitioned.transition);
          if (typeof transitioned.replayed !== "boolean") return fail("ONBOARDING_RESULT_INVALID");
          result = { transitionId: text(receipt.transitionId, UUID), replayed: transitioned.replayed, schemaVersion: number(transitioned.schemaVersion),
            schemaChecksum: text(transitioned.schemaChecksum, DIGEST), evidenceDigest: text(receipt.evidenceDigest, DIGEST) };
        } else {
          const runtime = core.connection({ CANNELE_REGISTRY_DATABASE_URL: secret(environment, "CANNELE_REGISTRY_DATABASE_URL"),
            CANNELE_REGISTRY_DATABASE_HOST: secret(environment, "CANNELE_REGISTRY_DATABASE_HOST") });
          if (runtime.host !== connection.host || runtime.port !== connection.port || runtime.database !== connection.database
            || runtime.user !== roleName || runtime.user === connection.user) return fail("ONBOARDING_RUNTIME_TARGET_INVALID");
          await core.provision(client, { roleName: roleName!, context: context! });
          const runtimePool = core.pool(runtime);
          try {
            const runtimeClient = await runtimePool.connect();
            try { await core.assertRuntime(runtimeClient, context!); } finally { runtimeClient.release(); }
          } finally { await runtimePool.end(); }
          result = { schemaVersion: context!.schemaVersion, instanceId: context!.instanceId, bindingDigest: context!.bindingDigest, writerEpoch: context!.writerEpoch, runtimeLoginVerified: true };
        }
      } finally { client.release(); }
    } finally { await pool.end(); }
    return { protocol: "cake-cannele-onboarding-result/v1", requestId: environment.CANNELE_ONBOARDING_REQUEST_ID!, action,
      source: { cakeRevision: source.cakeRevision, canneleRevision: source.canneleRevision, workflowBlobSha: source.workflowBlobSha, helperBlobSha: source.helperBlobSha }, run, database, result };
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    const code = core.errorCode(error);
    return fail(code && /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "ONBOARDING_DEPENDENCY_FAILED");
  }
}

/** Local Git reads only; the workflow performs fixed-repository checkout and
 * credential-free dependency/metadata generation before this program starts. */
export async function onboardingSource(environment: Env, cwd = fileURLToPath(new URL("../", import.meta.url))): Promise<OnboardingSource> {
  try {
    const git = (directory: string, args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const cake = await realpath(cwd), cakeRevision = git(cake, ["rev-parse", "HEAD"]);
    if (!SHA.test(cakeRevision) || git(cake, ["status", "--porcelain=v1", "--untracked-files=all"])) return fail("ONBOARDING_SOURCE_UNTRUSTED");
    const configPath = "cannele-onboarding.config.json";
    if (git(cake, ["ls-tree", cakeRevision, "--", configPath]).split(/\s+/)[0] !== "100644") return fail("ONBOARDING_SOURCE_UNTRUSTED");
    const config = json(git(cake, ["show", `${cakeRevision}:${configPath}`]));
    exact(config, ["protocol", "canneleSourceRevision"]);
    if (config.protocol !== "cake-cannele-onboarding/v1") return fail("ONBOARDING_SOURCE_UNTRUSTED");
    const canneleRevision = text(config.canneleSourceRevision, SHA);
    if (!environment.CANNELE_ONBOARDING_SOURCE_DIR) return fail("ONBOARDING_SOURCE_UNTRUSTED");
    const sourceDirectory = await realpath(resolve(cake, environment.CANNELE_ONBOARDING_SOURCE_DIR));
    const remote = git(sourceDirectory, ["remote", "get-url", "origin"]);
    if (!["https://github.com/tyask/cannele", "https://github.com/tyask/cannele.git"].includes(remote)
      || await realpath(git(sourceDirectory, ["rev-parse", "--show-toplevel"])) !== sourceDirectory
      || git(sourceDirectory, ["rev-parse", "HEAD"]) !== canneleRevision
      || git(sourceDirectory, ["status", "--porcelain=v1", "--untracked-files=all"])) return fail("ONBOARDING_SOURCE_UNTRUSTED");
    git(sourceDirectory, ["merge-base", "--is-ancestor", canneleRevision, "origin/main"]);
    return { cakeRevision, canneleRevision, sourceDirectory,
      workflowBlobSha: text(git(cake, ["rev-parse", `${cakeRevision}:${WORKFLOW}`]), SHA), helperBlobSha: text(git(cake, ["rev-parse", `${cakeRevision}:${HELPER}`]), SHA) };
  } catch { return fail("ONBOARDING_SOURCE_UNTRUSTED"); }
}

async function loadCore(source: OnboardingSource): Promise<OnboardingCore> {
  const loadModule = async (path: string): Promise<Object_> => {
    const absolute = join(source.sourceDirectory, path), info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return fail("ONBOARDING_SOURCE_UNTRUSTED");
    return import(pathToFileURL(absolute).href) as Promise<Object_>;
  };
  const [connection, legacy, roles, migrations, preflight, metadata] = await Promise.all([
    loadModule("src/db/connection.ts"), loadModule("src/db/legacy-transition.ts"), loadModule("src/db/runtime-role.ts"),
    loadModule("src/db/migrations.ts"), loadModule("src/db/legacy-provider-preflight.ts"), loadModule("src/generated/registry-metadata.ts"),
  ]);
  type Callable = (...args: unknown[]) => unknown;
  const call = (target: Object_, name: string): Callable => typeof target[name] === "function" ? target[name] as Callable : fail("ONBOARDING_SOURCE_UNTRUSTED");
  const loaded = await call(migrations, "loadMigrations")(join(source.sourceDirectory, "db/migrations")) as Object_[];
  const generated = metadata.registryMigrations as Object_[];
  if (!Array.isArray(loaded) || !Array.isArray(generated) || loaded.length !== 4 || generated.length !== loaded.length
    || loaded.some((row, index) => row.version !== generated[index].version || row.filename !== generated[index].filename || row.checksum !== generated[index].checksum)) return fail("ONBOARDING_SOURCE_UNTRUSTED");
  const errors = [[connection, "RegistryConnectionError"], [legacy, "LegacyTransitionError"], [roles, "RuntimeRoleError"], [migrations, "MigrationError"], [preflight, "LegacyPreflightError"]] as const;
  return {
    connection: environment => call(connection, "registryConnectionConfig")(environment) as Connection,
    pool: config => call(connection, "createRegistryPool")(config) as Pool,
    migrations: async () => loaded,
    inspect: async client => await call(legacy, "inspectLegacyRegistry")(client) as Snapshot,
    transition: async (client, inputMigrations, input, options) => await call(legacy, "transitionLegacyRegistry")(client, inputMigrations, input, options) as Object_,
    provision: async (client, input) => { await call(roles, "provisionRuntimeRole")(client, input); },
    assertRuntime: async (client, context) => { await call(roles, "assertRuntimeRole")(client, context); },
    transport: environment => call(preflight, "createLegacyAuthenticatedReadTransport")(environment) as ReadTransport,
    verify: async (transport, input) => {
      const Reader = preflight.LegacyProviderPreflightReader as new (transport: ReadTransport) => { verify(input: unknown): Promise<unknown> };
      return new Reader(transport).verify(input);
    },
    errorCode: error => {
      for (const [target, name] of errors) {
        const Constructor = target[name] as new (...args: unknown[]) => Error;
        if (typeof Constructor === "function" && error instanceof Constructor) return String((error as unknown as Object_).code);
      }
      return null;
    },
  };
}

async function output(environment: Env, receipt: OnboardingReceipt): Promise<void> {
  if (!environment.RUNNER_TEMP || environment.CANNELE_ONBOARDING_RESULT_PATH !== join(environment.RUNNER_TEMP, "cannele-onboarding", receipt.requestId, "result.json")) return fail("ONBOARDING_RESULT_PATH_INVALID");
  const directory = join(environment.RUNNER_TEMP, "cannele-onboarding", receipt.requestId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return fail("ONBOARDING_RESULT_PATH_INVALID");
  await writeFile(join(directory, "result.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    const source = await onboardingSource(process.env);
    const receipt = await runOnboarding(process.env, { source, core: () => loadCore(source) });
    await output(process.env, receipt);
    console.log(JSON.stringify({ ok: true, action: receipt.action, requestId: receipt.requestId }));
  })().catch(error => {
    console.error(JSON.stringify({ ok: false, code: error instanceof OnboardingError ? error.code : "ONBOARDING_FAILED" }));
    process.exitCode = 1;
  });
}
