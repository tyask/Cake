import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OnboardingError, OnboardingGateway, onboardingFailure, onboardingSource, runOnboarding, type OnboardingCore, type OnboardingSource } from "../scripts/cannele-onboarding";
import type { QaTransport } from "../scripts/qa-pool-writer";
import { RuntimeHandoffError, type HandoffDiagnostic } from "../scripts/cannele-runtime-handoff";

const revision = "a".repeat(40), canneleRevision = "b".repeat(40), requestId = randomUUID(), instanceId = randomUUID();
const caller = Buffer.from("name: synthetic onboarding caller\n"), helper = Buffer.from("name: synthetic onboarding runner\n");
const blob = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const source: OnboardingSource = { cakeRevision: revision, canneleRevision, workflowBlobSha: blob(caller), helperBlobSha: blob(helper), sourceDirectory: "/private/source" };
const environment = { EVENT_NAME: "workflow_dispatch", GITHUB_TOKEN: "synthetic-github-token", GITHUB_REPOSITORY: "tyask/Cake", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ID: "123",
  GITHUB_WORKFLOW_REF: "tyask/Cake/.github/workflows/cannele-onboarding.yml@refs/heads/main", GITHUB_WORKFLOW_SHA: revision, QA_TRUSTED_MAIN_SHA: revision,
  CANNELE_ONBOARDING_EXPECTED_REVISION: revision, CANNELE_ONBOARDING_REQUEST_ID: requestId, CANNELE_ONBOARDING_ACTION: "inspect",
  CAKE_CANNELE_ENABLED: "true", CAKE_QA_POOL_ENABLED: "false", CAKE_QA_REGISTRY_ENABLED: "false",
  CANNELE_REGISTRY_ADMIN_DATABASE_URL: "postgresql://synthetic_owner:synthetic-admin-password@ep-management.mock.aws.neon.tech/neondb?sslmode=require",
  CANNELE_REGISTRY_ADMIN_DATABASE_HOST: "ep-management.mock.aws.neon.tech",
  CANNELE_REGISTRY_DATABASE_URL: "postgresql://cannele_runtime:synthetic-runtime-password@ep-management.mock.aws.neon.tech/neondb?sslmode=require",
  CANNELE_REGISTRY_DATABASE_HOST: "ep-management.mock.aws.neon.tech",
  CANNELE_TRANSITION_VERCEL_TOKEN: "synthetic-vercel-token", CANNELE_TRANSITION_NEON_API_KEY: "synthetic-neon-token" };
const run = { id: 123, repository: { full_name: "tyask/Cake" }, head_repository: { full_name: "tyask/Cake" }, actor: { id: 16447050, type: "User" }, triggering_actor: { id: 16447050, type: "User" },
  path: ".github/workflows/cannele-onboarding.yml", head_branch: "main", head_sha: revision, run_attempt: 1, event: "workflow_dispatch", status: "in_progress",
  referenced_workflows: [{ path: "tyask/Cake/.github/workflows/cannele-onboarding-run.yml@refs/heads/main", sha: revision }] };
function transport(changes: { run?: Record<string, unknown>; main?: string; wrongBlob?: boolean; calls?: string[] } = {}): QaTransport {
  return async (method, address, token) => {
    assert.equal(method, "GET"); assert.equal(token, environment.GITHUB_TOKEN);
    const url = new URL(address); assert.equal(url.hostname, "api.github.com"); changes.calls?.push(address);
    if (url.pathname === "/repos/tyask/Cake") return { status: 200, data: { id: 1318171856, full_name: "tyask/Cake", owner: { id: 16447050, type: "User" } } };
    if (url.pathname.endsWith("/actions/runs/123")) return { status: 200, data: { ...run, ...changes.run } };
    if (url.pathname.endsWith("/branches/main")) return { status: 200, data: { commit: { sha: changes.main ?? revision } } };
    if (url.pathname.includes("/contents/")) {
      assert.equal(url.searchParams.get("ref"), revision);
      const bytes = url.pathname.endsWith("cannele-onboarding-run.yml") ? helper : caller;
      return { status: 200, data: { type: "file", encoding: "base64", sha: changes.wrongBlob ? "f".repeat(40) : blob(bytes), content: bytes.toString("base64") } };
    }
    return assert.fail("Unexpected administrative authorization request");
  };
}
const context = { instanceId, repositoryId: 1318171856, bindingDigest: "c".repeat(64), writerEpoch: 1, schemaVersion: 4, schemaChecksum: "d".repeat(64) };
const request = { protocol: "cannele-legacy-transition/v1", transitionId: randomUUID(), database: { hostDigest: "e".repeat(64), name: "neondb" },
  source: { canneleRevision, cakeRevision: revision, legacyDdlSha256: "1".repeat(64), fenceDdlSha256: "2".repeat(64) }, legacy: { writerEpoch: 1, stateDigest: "3".repeat(64), footprintDigest: "4".repeat(64) },
  binding: { instanceId }, repository: { id: "1318171856", fullName: "tyask/Cake" }, scope: {},
  admission: { protocol: "cannele-legacy-admission/v1", reviewId: randomUUID(), reviewerGitHubId: "16447050", stoppedAt: "2026-10-15T00:00:00.000Z", reviewedAt: "2026-10-15T00:01:00.000Z",
    trustedMainRevision: revision, legacyWorkflowBlobShas: { "qa-pool": revision, "qa-private-run": revision, "qa-registry": revision, "qa-registry-run": revision },
    allCloudTasksStopped: true, allPcSessionsStopped: true, oldProviderCreationCredentialsRevoked: true,
    legacyRegistryAndOwnerCredentialsRevoked: true, noInFlightProviderWriters: true, noUnknownCreationIntents: true } };
function coreFixture(changes: Partial<OnboardingCore> = {}) {
  const events: string[] = [], received: unknown[] = [];
  const core: OnboardingCore = {
    connection: e => { events.push("connection"); const parsed = new URL(e.CANNELE_REGISTRY_DATABASE_URL!); assert.equal(parsed.hostname, e.CANNELE_REGISTRY_DATABASE_HOST); return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 5432, database: parsed.pathname.slice(1), user: parsed.username }; },
    pool: config => ({ connect: async () => { events.push(`connect:${config.user}`); return { query: async sql => { events.push(sql); return { rows: sql.includes("server_version_num") ? [{ major: 18 }] : [] }; }, release: () => { events.push(`release:${config.user}`); } }; }, end: async () => { events.push(`end:${config.user}`); } }),
    migrations: async () => { events.push("migrations"); return [1, 2, 3, 4]; },
    inspect: async () => { events.push("inspect"); return { identity: { protocol: "cake-qa-registry/v1", databaseName: "neondb", writerMode: "legacy", writerEpoch: 1, fenceReceipt: { revision } }, stateDigest: "5".repeat(64), footprintDigest: "6".repeat(64) }; },
    transition: async (_client, _migrations, input, options) => {
      events.push("transition:begin"); received.push(structuredClone(input)); await options.verify({ boundedCoreProof: true }); events.push("transition:commit");
      return { replayed: false, schemaVersion: 4, schemaChecksum: context.schemaChecksum, transition: { transitionId: request.transitionId, evidenceDigest: "7".repeat(64),
        ...((input.admission as Record<string, unknown>).oldProviderCreationCredentialsRevoked === false ? { providerCredentialRetentionAccepted: true } : {}) } };
    },
    provision: async (_client, input) => { events.push("provision"); received.push(structuredClone(input)); },
    assertRuntime: async (_client, input) => { events.push("assertRuntime"); received.push(structuredClone(input)); },
    transport: credentials => { assert.deepEqual(credentials, { githubToken: environment.GITHUB_TOKEN, vercelToken: environment.CANNELE_TRANSITION_VERCEL_TOKEN, neonApiKey: environment.CANNELE_TRANSITION_NEON_API_KEY }); events.push("providerTransport"); return async (_provider, path) => { received.push(path); return { status: 200, data: { realRead: true }, redirected: false }; }; },
    verify: async (read, input) => { events.push("verify"); assert.deepEqual(input, { boundedCoreProof: true }); const response = await read("github", "/repos/tyask/Cake/actions/variables/CAKE_CANNELE_ENABLED", { signal: new AbortController().signal }); assert.deepEqual(response.data, { name: "CAKE_CANNELE_ENABLED", value: "true" }); return { proof: true }; },
    errorCode: () => null,
    ...changes,
  };
  return { core, events, received };
}
const transitionEnvironment = { ...environment, CANNELE_ONBOARDING_ACTION: "transition", CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN: "true", CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify(request) };
const runtimeEnvironment = { ...environment, CANNELE_ONBOARDING_ACTION: "provision-runtime", CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON: JSON.stringify(context), CANNELE_ONBOARDING_RUNTIME_ROLE_NAME: "cannele_runtime" };
const bootstrapEnvironment = { ...runtimeEnvironment, CANNELE_ONBOARDING_ACTION: "bootstrap-runtime",
  CANNELE_REGISTRY_DATABASE_URL: undefined, CANNELE_REGISTRY_DATABASE_HOST: undefined };

function bootstrapFixture() {
  const fixture = coreFixture(), events = fixture.events;
  fixture.core.pool = configured => ({ connect: async () => {
    events.push(`connect:${configured.user}`);
    return { query: async () => ({ rows: [{ role_name: configured.user, session_role: configured.user, database_name: configured.database }] }),
      release: () => { events.push(`release:${configured.user}`); } };
  }, end: async () => { events.push(`end:${configured.user}`); } });
  const runtimeBootstrap: NonNullable<Parameters<typeof runOnboarding>[1]["runtimeBootstrap"]> = async (_client, input) => {
    events.push("create"); assert.equal(input.roleName, "cannele_runtime"); assert.deepEqual(input.context, context);
    return { connection: { ...input.connection, user: input.roleName, password: "synthetic-bootstrap-password" },
      databaseUrl: "postgresql://cannele_runtime:synthetic-bootstrap-password@ep-management.mock.aws.neon.tech/neondb?sslmode=require",
      marker: "synthetic-public-provenance", roleCreated: true, transitionId: request.transitionId,
      releaseControl: async () => { events.push("unlock"); } };
  };
  const runtimeHandoff: NonNullable<Parameters<typeof runOnboarding>[1]["runtimeHandoff"]> = input => {
    assert.equal(input.vercelToken, environment.CANNELE_TRANSITION_VERCEL_TOKEN);
    assert.equal(input.neonApiKey, environment.CANNELE_TRANSITION_NEON_API_KEY);
    assert.deepEqual(input.context, context); assert.equal(input.roleName, "cannele_runtime");
    return { preflight: async () => { events.push("preflight"); }, publish: async input => {
      assert.equal(input.databaseHost, environment.CANNELE_REGISTRY_ADMIN_DATABASE_HOST);
      assert.match(input.databaseUrl, /synthetic-bootstrap-password/); events.push("publish");
    } };
  };
  return { ...fixture, runtimeBootstrap, runtimeHandoff };
}

test("bootstrap preflights before SQL and proves actual LOGIN before grants, then unlocks before final LOGIN and handoff", async () => {
  const fixture = bootstrapFixture();
  const receipt = await runOnboarding(bootstrapEnvironment, { source, transport: transport(), core: async () => fixture.core,
    runtimeBootstrap: fixture.runtimeBootstrap, runtimeHandoff: fixture.runtimeHandoff });
  assert.deepEqual(fixture.events.filter(event => ["preflight", "create", "provision", "unlock", "assertRuntime", "publish", "connect:cannele_runtime"].includes(event)),
    ["preflight", "create", "connect:cannele_runtime", "provision", "unlock", "connect:cannele_runtime", "assertRuntime", "publish"]);
  assert.equal(receipt.action, "bootstrap-runtime"); assert.equal(receipt.result.runtimeLoginVerified, true);
  assert.equal(receipt.result.environmentWriteAcknowledged, true); assert.equal(receipt.result.roleCreated, true);
  for (const value of ["postgresql:", "synthetic-bootstrap-password", "synthetic-vercel-token", "synthetic-neon-token", "synthetic-public-provenance", environment.CANNELE_REGISTRY_ADMIN_DATABASE_HOST]) assert.equal(JSON.stringify(receipt).includes(value), false);
});

test("bootstrap rejected preflight never reaches SQL creation; missing transition credentials fail before bootstrap", async () => {
  for (const changes of [{}, { CANNELE_TRANSITION_VERCEL_TOKEN: "" }, { CANNELE_TRANSITION_NEON_API_KEY: "" }]) {
    const fixture = bootstrapFixture();
    await assert.rejects(runOnboarding({ ...bootstrapEnvironment, ...changes }, { source, transport: transport(), core: async () => fixture.core,
      runtimeBootstrap: fixture.runtimeBootstrap, runtimeHandoff: input => ({ ...fixture.runtimeHandoff(input), preflight: async () => { throw new Error(privateDiagnostic); } }) }));
    assert.equal(fixture.events.includes("create"), false); assert.equal(fixture.events.includes("provision"), false); assert.equal(fixture.events.includes("publish"), false);
  }
});

test("bootstrap handoff diagnostics project only closed HTTP facts and never reach role creation", async () => {
  const handoff: HandoffDiagnostic = { method: "GET", endpoint: "PUBLIC_BINDING", status: 403, reason: "HTTP" };
  const fixture = bootstrapFixture();
  await assert.rejects(runOnboarding(bootstrapEnvironment, { source, transport: transport(), core: async () => fixture.core,
    runtimeBootstrap: fixture.runtimeBootstrap, runtimeHandoff: input => ({ ...fixture.runtimeHandoff(input), preflight: async () => {
      throw Object.assign(new RuntimeHandoffError("REQUEST_FAILED", handoff), { query: "private-value", response: "private-value", cause: { token: "private-value" } });
    } }) }), error => {
      assert.deepEqual(onboardingFailure(error), { ok: false, code: "RUNTIME_HANDOFF_REQUEST_FAILED", stage: "RUNTIME_PREFLIGHT", reason: "CORE_REJECTED", handoff });
      assert.equal(JSON.stringify(onboardingFailure(error)).includes("private-value"), false); return true;
    });
  assert.equal(fixture.events.includes("create"), false);
  for (const malformed of [{ ...handoff, status: 999 }, { ...handoff, endpoint: "private-url" }, { ...handoff, response: "private-value" }]) {
    assert.deepEqual(onboardingFailure(new OnboardingError("RUNTIME_HANDOFF_REQUEST_FAILED", "RUNTIME_PREFLIGHT", "CORE_REJECTED", malformed as HandoffDiagnostic)),
      { ok: false, code: "RUNTIME_HANDOFF_REQUEST_FAILED", stage: "RUNTIME_PREFLIGHT", reason: "CORE_REJECTED" });
  }
});

test("bootstrap failed candidate LOGIN never grants or publishes and still releases the control lock", async () => {
  const fixture = bootstrapFixture(), original = fixture.core.pool;
  fixture.core.pool = configured => configured.user === "cannele_runtime" ? { connect: async () => { throw Object.assign(new Error(privateDiagnostic), { code: "28P01" }); }, end: async () => {} } : original(configured);
  await expectDiagnostic(runOnboarding(bootstrapEnvironment, { source, transport: transport(), core: async () => fixture.core,
    runtimeBootstrap: fixture.runtimeBootstrap, runtimeHandoff: fixture.runtimeHandoff }), { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "RUNTIME_CONNECT", reason: "AUTHENTICATION" });
  assert.ok(fixture.events.includes("unlock")); assert.equal(fixture.events.includes("provision"), false); assert.equal(fixture.events.includes("publish"), false);
});

test("bootstrap preserves a grant failure across unlock failure and never transfers unverified credentials", async () => {
  const fixture = bootstrapFixture(); fixture.core.provision = async () => { throw Object.assign(new Error(privateDiagnostic), { code: "42501" }); };
  await expectDiagnostic(runOnboarding(bootstrapEnvironment, { source, transport: transport(), core: async () => fixture.core,
    runtimeBootstrap: async (client, input) => ({ ...await fixture.runtimeBootstrap(client, input), releaseControl: async () => { fixture.events.push("unlock"); throw new Error(privateDiagnostic); } }),
    runtimeHandoff: fixture.runtimeHandoff }), { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "RUNTIME_PROVISION", reason: "PERMISSION" });
  assert.ok(fixture.events.includes("unlock")); assert.equal(fixture.events.includes("assertRuntime"), false); assert.equal(fixture.events.includes("publish"), false);
});

test("bootstrap final runtime proof failure prevents handoff and every credential remains behind owner/main authorization", async () => {
  const fixture = bootstrapFixture(); fixture.core.assertRuntime = async () => { throw new Error(privateDiagnostic); };
  await expectDiagnostic(runOnboarding(bootstrapEnvironment, { source, transport: transport(), core: async () => fixture.core,
    runtimeBootstrap: fixture.runtimeBootstrap, runtimeHandoff: fixture.runtimeHandoff }), { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "RUNTIME_VERIFY", reason: "UNKNOWN" });
  assert.ok(fixture.events.includes("unlock")); assert.equal(fixture.events.includes("publish"), false);
  let coreReads = 0, secretReads = 0, factoryCalls = 0;
  const guarded = { ...bootstrapEnvironment };
  for (const key of ["CANNELE_REGISTRY_ADMIN_DATABASE_URL", "CANNELE_REGISTRY_ADMIN_DATABASE_HOST", "CANNELE_TRANSITION_VERCEL_TOKEN", "CANNELE_TRANSITION_NEON_API_KEY"]) {
    Object.defineProperty(guarded, key, { get: () => { secretReads++; throw new Error(privateDiagnostic); } });
  }
  await assert.rejects(runOnboarding(guarded, { source, transport: transport({ run: { run_attempt: 2 } }),
    core: async () => { coreReads++; return fixture.core; }, runtimeBootstrap: fixture.runtimeBootstrap,
    runtimeHandoff: input => { factoryCalls++; return fixture.runtimeHandoff(input); } }), { code: "ONBOARDING_RUN_UNTRUSTED" });
  assert.equal(coreReads, 0); assert.equal(secretReads, 0); assert.equal(factoryCalls, 0);
});

test("foreign owner/main workflows, changed source and reruns never receive administrative credentials", async () => {
  for (const changes of [{ GITHUB_WORKFLOW_REF: "tyask/Cake/.github/workflows/foreign.yml@refs/heads/main" }, { GITHUB_REF: "refs/heads/codex/foreign" }, { GITHUB_WORKFLOW_SHA: "f".repeat(40) }]) {
    let loaded = 0; const calls: string[] = [];
    await assert.rejects(runOnboarding({ ...environment, ...changes }, { source, transport: transport({ calls }), core: async () => { loaded++; return coreFixture().core; } }));
    assert.equal(loaded, 0); assert.deepEqual(calls, []);
  }
  for (const change of [{ actor: { id: 42, type: "User" } }, { triggering_actor: { id: 42, type: "User" } }, { path: ".github/workflows/foreign.yml" }, { run_attempt: 2 }, { referenced_workflows: [] }, { referenced_workflows: [{ path: "tyask/Cake/.github/workflows/foreign.yml@main", sha: revision }] }]) {
    let loaded = 0;
    await assert.rejects(runOnboarding(environment, { source, transport: transport({ run: change }), core: async () => { loaded++; return coreFixture().core; } }));
    assert.equal(loaded, 0);
  }
  for (const options of [{ main: "f".repeat(40) }, { wrongBlob: true }]) {
    let loaded = 0;
    await assert.rejects(runOnboarding(environment, { source, transport: transport(options), core: async () => { loaded++; return coreFixture().core; } })); assert.equal(loaded, 0);
  }
});

test("only the exact three trusted repository variable GETs are synthesized after authorization", async () => {
  const gateway = new OnboardingGateway(environment, transport()), delegated: string[] = [];
  const delegate: ReturnType<OnboardingGateway["variableTransport"]> = async (provider, path) => { delegated.push(`${provider}:${path}`); return { status: 403, data: null, redirected: false }; };
  assert.throws(() => gateway.variableTransport(delegate)); await gateway.authorize(source);
  const read = gateway.variableTransport(delegate), options = { signal: new AbortController().signal };
  for (const name of ["CAKE_CANNELE_ENABLED", "CAKE_QA_POOL_ENABLED", "CAKE_QA_REGISTRY_ENABLED"]) {
    const response = await read("github", `/repos/tyask/Cake/actions/variables/${name}`, options);
    assert.deepEqual(response, { status: 200, data: { name, value: name === "CAKE_CANNELE_ENABLED" ? "true" : "false" }, redirected: false });
  }
  for (const [provider, path] of [["github", "/repos/tyask/Cake/actions/variables/OTHER"], ["github", "/repos/tyask/Cake/actions/variables/CAKE_CANNELE_ENABLED?scope=untrusted"], ["github", "/repos/foreign/Cake/actions/variables/CAKE_CANNELE_ENABLED"], ["neon", "/projects/fixed"]] as const) await read(provider, path, options);
  assert.equal(delegated.length, 4);
  const aborted = AbortSignal.abort(); await assert.rejects(read("github", "/repos/tyask/Cake/actions/variables/CAKE_CANNELE_ENABLED", { signal: aborted }));
});

test("inspect takes ordered transaction locks and emits only closed core facts; failure rolls back", async () => {
  const fixture = coreFixture(), receipt = await runOnboarding(environment, { source, transport: transport(), core: async () => fixture.core });
  assert.deepEqual(fixture.events.slice(2, 9), ["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT pg_advisory_xact_lock(hashtext('cake:qa-registry:v1'))", "SELECT pg_advisory_xact_lock(hashtextextended('cannele_registry:control',0))", "SET LOCAL search_path=pg_catalog", "SELECT current_setting('server_version_num')::integer / 10000 AS major", "inspect", "COMMIT"]);
  assert.equal(receipt.result.stateDigest, "5".repeat(64)); assert.equal(receipt.database.name, "neondb"); assert.equal(receipt.result.postgresMajor, 18);
  const output = JSON.stringify(receipt);
  for (const value of ["synthetic_owner", "cannele_runtime", "synthetic-admin-password", "synthetic-runtime-password", "synthetic-github-token", environment.CANNELE_REGISTRY_ADMIN_DATABASE_HOST, "/private/source", "postgresql://"]) assert.equal(output.includes(value), false);
  const failed = coreFixture({ inspect: async () => { throw new Error("raw PostgreSQL password and query detail"); } });
  await assert.rejects(runOnboarding(environment, { source, transport: transport(), core: async () => failed.core }), { code: "ONBOARDING_DEPENDENCY_FAILED" });
  assert.ok(failed.events.includes("ROLLBACK")); assert.equal(failed.events.includes("COMMIT"), false); assert.ok(failed.events.at(-1)?.startsWith("end:"));
});

const privateDiagnostic = "postgresql://private-role:private-password@ep-private.mock.aws.neon.tech/db SELECT private_column private-token";
async function expectDiagnostic(work: Promise<unknown>, expected: { code: string; stage: string; reason: string }): Promise<void> {
  await assert.rejects(work, error => {
    assert.ok(error instanceof OnboardingError);
    const projected = onboardingFailure(error);
    assert.deepEqual(projected, { ok: false, ...expected });
    assert.doesNotMatch(JSON.stringify(projected), /private-|postgresql|SELECT|sqlstate|cause|query|password/i);
    assert.equal(error.message, "Cannele onboarding could not be verified; private details suppressed.");
    assert.deepEqual(Object.keys(projected), ["ok", "code", "stage", "reason"]);
    return true;
  });
}

test("administrative connection diagnostics classify only known PostgreSQL and Node codes and still close the pool", async () => {
  for (const [code, reason] of [["28P01", "AUTHENTICATION"], ["42501", "PERMISSION"], ["08P01", "PROTOCOL"], ["0A000", "UNSUPPORTED"],
    ["08006", "CONNECT"], ["ENOTFOUND", "DNS"], ["ECONNREFUSED", "CONNECT"], ["ECONNRESET", "RESET"], ["ETIMEDOUT", "TIMEOUT"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS"], [privateDiagnostic, "UNKNOWN"], ["PRIVATE_CREDENTIAL_ERROR", "UNKNOWN"]]) {
    let connects = 0, ends = 0;
    const error = Object.assign(new Error(privateDiagnostic, { cause: { code: "08P01", message: privateDiagnostic } }), { code, query: privateDiagnostic });
    const fixture = coreFixture({ pool: () => ({ connect: async () => { connects++; throw error; }, end: async () => { ends++; } }) });
    await expectDiagnostic(runOnboarding(environment, { source, transport: transport(), core: async () => fixture.core }),
      { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "ADMIN_CONNECT", reason });
    assert.equal(connects, 1); assert.equal(ends, 1); assert.equal(fixture.events.includes("inspect"), false);
  }
});

test("inspect diagnostics retain the original read failure even when rollback, release and pool cleanup also fail", async () => {
  for (const [code, reason] of [["42703", "UNDEFINED_COLUMN"], ["42883", "UNDEFINED_FUNCTION"], ["42P01", "UNDEFINED_TABLE"],
    ["42601", "SYNTAX"], ["42804", "DATATYPE"], ["57014", "TIMEOUT"], ["private-unknown-sqlstate", "UNKNOWN"]]) {
    const events: string[] = [];
    const primary = Object.assign(new Error(privateDiagnostic), { code });
    const secondary = Object.assign(new Error(privateDiagnostic), { code: "ECONNRESET" });
    const fixture = coreFixture({
      inspect: async () => { events.push("inspect"); throw primary; },
      pool: () => ({ connect: async () => ({ query: async sql => {
        events.push(sql); if (sql === "ROLLBACK") throw secondary;
        return { rows: sql.includes("server_version_num") ? [{ major: 18 }] : [] };
      }, release: () => { events.push("release"); throw secondary; } }), end: async () => { events.push("end"); throw secondary; } }),
    });
    await expectDiagnostic(runOnboarding(environment, { source, transport: transport(), core: async () => fixture.core }),
      { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "INSPECT_CORE", reason });
    assert.deepEqual(events.slice(-3), ["ROLLBACK", "release", "end"]); assert.equal(events.includes("COMMIT"), false);
  }
});

test("version and standalone cleanup failures identify their stage while known core rejections keep their code", async () => {
  const version = coreFixture({ pool: () => ({ connect: async () => ({ query: async sql => {
    if (sql.includes("server_version_num")) throw Object.assign(new Error(privateDiagnostic), { code: "42501" });
    return { rows: [] };
  }, release: () => {} }), end: async () => {} }) });
  await expectDiagnostic(runOnboarding(environment, { source, transport: transport(), core: async () => version.core }),
    { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "INSPECT_VERSION", reason: "PERMISSION" });
  const known = coreFixture({ inspect: async () => { throw new Error(privateDiagnostic); }, errorCode: () => "LEGACY_REGISTRY_SHAPE_UNSUPPORTED" });
  await expectDiagnostic(runOnboarding(environment, { source, transport: transport(), core: async () => known.core }),
    { code: "LEGACY_REGISTRY_SHAPE_UNSUPPORTED", stage: "INSPECT_CORE", reason: "CORE_REJECTED" });
  const cleanup = coreFixture(); const original = cleanup.core.pool;
  cleanup.core.pool = connection => ({ ...original(connection), end: async () => { throw Object.assign(new Error(privateDiagnostic), { code: "ECONNRESET" }); } });
  await expectDiagnostic(runOnboarding(environment, { source, transport: transport(), core: async () => cleanup.core }),
    { code: "ONBOARDING_DEPENDENCY_FAILED", stage: "ADMIN_POOL_END", reason: "RESET" });
});

test("CLI failure output never serializes arbitrary error properties, nested causes or invalid diagnostic fields", () => {
  const raw = Object.assign(new Error(privateDiagnostic, { cause: { code: "28P01", message: privateDiagnostic } }), { code: privateDiagnostic, query: privateDiagnostic });
  assert.deepEqual(onboardingFailure(raw), { ok: false, code: "ONBOARDING_FAILED", stage: "CONFIG", reason: "UNKNOWN" });
  const invalid = new OnboardingError(privateDiagnostic, privateDiagnostic as never, privateDiagnostic as never);
  assert.deepEqual(onboardingFailure(invalid), { ok: false, code: "ONBOARDING_FAILED", stage: "CONFIG", reason: "UNKNOWN" });
});

test("transition requires a real explicit drain admission, preserves request bytes and obtains proof inside core transaction", async () => {
  for (const changes of [{ CANNELE_ONBOARDING_CONFIRM_LEGACY_DRAIN: "false" }, { CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify({ ...request, admission: { ...request.admission, oldProviderCreationCredentialsRevoked: false } }) }, { CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify({ ...request, admission: { ...request.admission, legacyRegistryAndOwnerCredentialsRevoked: undefined } }) }]) {
    let loaded = 0;
    await assert.rejects(runOnboarding({ ...transitionEnvironment, ...changes }, { source, transport: transport(), core: async () => { loaded++; return coreFixture().core; } }), { code: "ONBOARDING_CREDENTIAL_DRAIN_UNCONFIRMED" }); assert.equal(loaded, 0);
  }
  const fixture = coreFixture(); await runOnboarding(transitionEnvironment, { source, transport: transport(), core: async () => fixture.core });
  assert.deepEqual(fixture.received[0], request);
  assert.ok(fixture.events.indexOf("providerTransport") > fixture.events.indexOf("transition:begin")); assert.ok(fixture.events.indexOf("verify") < fixture.events.indexOf("transition:commit"));
  const replay = coreFixture({ transition: async (_client, _migrations, input) => { assert.deepEqual(input, request); return { replayed: true, schemaVersion: 4, schemaChecksum: context.schemaChecksum, transition: { transitionId: request.transitionId, evidenceDigest: "7".repeat(64) } }; } });
  const result = await runOnboarding({ ...transitionEnvironment, CANNELE_TRANSITION_VERCEL_TOKEN: "", CANNELE_TRANSITION_NEON_API_KEY: "" }, { source, transport: transport(), core: async () => replay.core });
  assert.equal(result.result.replayed, true); assert.equal(replay.events.includes("providerTransport"), false);
  assert.equal(Object.hasOwn(result.result, "providerCredentialRetentionAccepted"), false);
});

test("explicit provider credential retention preserves the reviewed input without claiming revocation", async () => {
  const retained = { ...request, admission: { ...request.admission, oldProviderCreationCredentialsRevoked: false, providerCredentialRetentionAccepted: true } };
  const fixture = coreFixture();
  const receipt = await runOnboarding({ ...transitionEnvironment, CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify(retained) }, { source, transport: transport(), core: async () => fixture.core });
  assert.deepEqual(fixture.received[0], retained);
  assert.equal((fixture.received[0] as typeof retained).admission.oldProviderCreationCredentialsRevoked, false);
  assert.equal(receipt.result.providerCredentialRetentionAccepted, true);
  const replay = coreFixture({ transition: async (_client, _migrations, input) => {
    assert.deepEqual(input, retained);
    return { replayed: true, schemaVersion: 4, schemaChecksum: context.schemaChecksum, transition: { transitionId: request.transitionId, evidenceDigest: "7".repeat(64), providerCredentialRetentionAccepted: true } };
  } });
  const result = await runOnboarding({ ...transitionEnvironment, CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify(retained), CANNELE_TRANSITION_VERCEL_TOKEN: "", CANNELE_TRANSITION_NEON_API_KEY: "" },
    { source, transport: transport(), core: async () => replay.core });
  assert.equal(result.result.replayed, true); assert.equal(replay.events.includes("providerTransport"), false);
  assert.equal(result.result.providerCredentialRetentionAccepted, true);
  assert.equal(Object.hasOwn(request.admission, "providerCredentialRetentionAccepted"), false, "old revoked input stays unchanged");
});

test("public retention evidence must match the actual immutable core receipt, on first execution and replay", async () => {
  const retained = { ...request, admission: { ...request.admission, oldProviderCreationCredentialsRevoked: false, providerCredentialRetentionAccepted: true } };
  for (const replayed of [false, true]) for (const input of [request, retained]) {
    const retainedPolicy = input === retained;
    const invalidMarkers = retainedPolicy ? [{}, ...[undefined, false, null, "true"].map(providerCredentialRetentionAccepted => ({ providerCredentialRetentionAccepted }))]
      : [undefined, true, false, null, "true"].map(providerCredentialRetentionAccepted => ({ providerCredentialRetentionAccepted }));
    for (const marker of invalidMarkers) {
      const fixture = coreFixture({ transition: async () => ({ replayed, schemaVersion: 4, schemaChecksum: context.schemaChecksum,
        transition: { transitionId: request.transitionId, evidenceDigest: "7".repeat(64), ...marker } }) });
      await assert.rejects(runOnboarding({ ...transitionEnvironment, CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify(input) },
        { source, transport: transport(), core: async () => fixture.core }), { code: "ONBOARDING_RESULT_INVALID" });
    }
  }
});

test("ambiguous provider policy and unconfirmed actor or DB drain fail before core or credential access", async () => {
  const retained = { ...request.admission, oldProviderCreationCredentialsRevoked: false, providerCredentialRetentionAccepted: true };
  const commaKey = Object.fromEntries(Object.entries(retained).filter(([key]) => !["reviewId", "reviewedAt"].includes(key)));
  commaKey["reviewId,reviewedAt"] = "untrusted combined key";
  const invalid = [
    { ...request.admission, oldProviderCreationCredentialsRevoked: false },
    ...[false, null, "true"].map(providerCredentialRetentionAccepted => ({ ...retained, providerCredentialRetentionAccepted })),
    ...[true, false, null, "true"].map(providerCredentialRetentionAccepted => ({ ...request.admission, providerCredentialRetentionAccepted })),
    ...["allCloudTasksStopped", "allPcSessionsStopped", "legacyRegistryAndOwnerCredentialsRevoked", "noInFlightProviderWriters", "noUnknownCreationIntents"]
      .map(name => ({ ...retained, [name]: false })),
    { ...retained, unknownRetentionPolicy: true },
    commaKey,
  ];
  for (const admission of invalid) {
    let loaded = 0;
    await assert.rejects(runOnboarding({ ...transitionEnvironment, CANNELE_ONBOARDING_TRANSITION_JSON: JSON.stringify({ ...request, admission }) },
      { source, transport: transport(), core: async () => { loaded++; return coreFixture().core; } }),
    error => ["ONBOARDING_CREDENTIAL_DRAIN_UNCONFIRMED", "ONBOARDING_INPUT_INVALID"].includes((error as { code: string }).code));
    assert.equal(loaded, 0);
  }
});

test("runtime grants bind explicit context and same DB then authenticate a separate non-owner LOGIN", async () => {
  const fixture = coreFixture(); const receipt = await runOnboarding(runtimeEnvironment, { source, transport: transport(), core: async () => fixture.core });
  assert.deepEqual(fixture.received, [{ roleName: "cannele_runtime", context }, context]);
  assert.ok(fixture.events.indexOf("connect:cannele_runtime") > fixture.events.indexOf("provision")); assert.equal(receipt.result.runtimeLoginVerified, true);
  for (const [url, host] of [[environment.CANNELE_REGISTRY_ADMIN_DATABASE_URL, environment.CANNELE_REGISTRY_ADMIN_DATABASE_HOST], [environment.CANNELE_REGISTRY_DATABASE_URL.replace("/neondb", "/business"), environment.CANNELE_REGISTRY_DATABASE_HOST], [environment.CANNELE_REGISTRY_DATABASE_URL.replace("ep-management.", "ep-other."), "ep-other.mock.aws.neon.tech"], [environment.CANNELE_REGISTRY_DATABASE_URL.replace("/neondb", ":6543/neondb"), environment.CANNELE_REGISTRY_DATABASE_HOST]]) {
    const rejected = coreFixture(); await assert.rejects(runOnboarding({ ...runtimeEnvironment, CANNELE_REGISTRY_DATABASE_URL: url, CANNELE_REGISTRY_DATABASE_HOST: host }, { source, transport: transport(), core: async () => rejected.core }), { code: "ONBOARDING_RUNTIME_TARGET_INVALID" }); assert.equal(rejected.events.includes("provision"), false);
  }
  const rejected = coreFixture(); await assert.rejects(runOnboarding({ ...runtimeEnvironment, CANNELE_ONBOARDING_RUNTIME_CONTEXT_JSON: JSON.stringify({ ...context, repositoryId: 1 }) }, { source, transport: transport(), core: async () => rejected.core })); assert.deepEqual(rejected.events, []);
  const invalidLogin = coreFixture({ assertRuntime: async () => { throw new Error("owner or SET ROLE detected with credential detail"); } });
  await assert.rejects(runOnboarding(runtimeEnvironment, { source, transport: transport(), core: async () => invalidLogin.core }), { code: "ONBOARDING_DEPENDENCY_FAILED" });
  assert.ok(invalidLogin.events.includes("end:cannele_runtime"));
});

test("source selection uses committed config, exact clean Cannele HEAD and main ancestry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-onboarding-source-")), cake = join(directory, "cake"), cannele = join(directory, "cannele");
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    for (const path of [cake, cannele]) { await mkdir(path); git(path, ["init", "-b", "main"]); git(path, ["config", "user.name", "Synthetic Test"]); git(path, ["config", "user.email", "synthetic@example.invalid"]); }
    await writeFile(join(cannele, "source.txt"), "reviewed source\n"); git(cannele, ["add", "."]); git(cannele, ["commit", "-m", "reviewed source"]);
    const selected = git(cannele, ["rev-parse", "HEAD"]); git(cannele, ["update-ref", "refs/remotes/origin/main", selected]); git(cannele, ["remote", "add", "origin", "https://github.com/tyask/cannele.git"]);
    await mkdir(join(cake, ".github/workflows"), { recursive: true }); await writeFile(join(cake, ".github/workflows/cannele-onboarding.yml"), caller); await writeFile(join(cake, ".github/workflows/cannele-onboarding-run.yml"), helper);
    await writeFile(join(cake, "cannele-onboarding.config.json"), JSON.stringify({ protocol: "cake-cannele-onboarding/v1", canneleSourceRevision: selected })); git(cake, ["add", "."]); git(cake, ["commit", "-m", "reviewed onboarding"]);
    const loaded = await onboardingSource({ CANNELE_ONBOARDING_SOURCE_DIR: "../cannele" }, cake); assert.equal(loaded.canneleRevision, selected); assert.equal(loaded.sourceDirectory, cannele);
    await writeFile(join(cannele, "source.txt"), "changed source\n"); await assert.rejects(onboardingSource({ CANNELE_ONBOARDING_SOURCE_DIR: cannele }, cake), { code: "ONBOARDING_SOURCE_UNTRUSTED" }); git(cannele, ["checkout", "--", "source.txt"]);
    git(cannele, ["remote", "set-url", "origin", "https://github.com/foreign/cannele.git"]); await assert.rejects(onboardingSource({ CANNELE_ONBOARDING_SOURCE_DIR: cannele }, cake), { code: "ONBOARDING_SOURCE_UNTRUSTED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
