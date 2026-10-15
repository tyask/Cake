import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { fullSha, leaseToken, qaAlias, QA_REPOSITORY, QA_PROJECT_ID, QA_NEON_PROJECT_ID, SLOTS } from "../lib/qa-pool";
import { parseRegistryLease, type QaRegistryLease } from "../lib/qa-registry";
import { qaDiagnosticFields } from "../lib/qa-diagnostics";
import { registryConnectionString } from "./qa-registry-store";
import { HttpQaGateway, type QaTransport } from "./qa-pool-writer";
import { expectedLegacyCatalog, expectedFencedCatalog, legacyCatalogSql, LEGACY_DDL_SHA256, LEGACY_WORKFLOWS } from "./qa-registry-fence";

const WORKFLOW = ".github/workflows/cannele-readiness.yml";
const HELPER = ".github/workflows/cannele-readiness-run.yml";
const TEAM = "team_D1Mcx2TdFWPKcypfu8KzNMub";
const REPOSITORY_ID = 1318171856;
const OWNER_ID = 16447050;
const MAX_ROWS = 10_000;
const TABLES = ["identity", "slots", "leases", "history", "requests", "resource_owners"] as const;
type Env = Readonly<Record<string, string | undefined>>;
type Batch = Pick<NeonQueryFunction<false, false>, "transaction">;
type Object_ = Record<string, unknown>;
export class ReadinessError extends Error {
  constructor(readonly code: string) { super("Cannele readiness could not be verified; private details suppressed."); }
}
const fail = (code: string): never => { throw new ReadinessError(code); };
const object = (value: unknown): Object_ => value && typeof value === "object" && !Array.isArray(value) ? value as Object_ : fail("READINESS_RESPONSE_INVALID");
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail("READINESS_RESPONSE_INVALID");
const text = (value: unknown, pattern: RegExp): string => typeof value === "string" && value.length <= 1024 && pattern.test(value) ? value : fail("READINESS_RESPONSE_INVALID");
const integer = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail("READINESS_RESPONSE_INVALID");
type InventoryScope = "GITHUB_RUNS" | "VERCEL_DEPLOYMENTS" | "NEON_BRANCHES" | "NEON_ENDPOINTS";
type InventoryReason = "RESPONSE_INVALID" | "ROWS_INVALID" | "ITEM_INVALID" | "ID_INVALID" | "DETAIL_INVALID" | "META_INVALID"
  | "DUPLICATE_ID" | "TOTAL_INVALID" | "TOTAL_MISMATCH" | "STATUS_MISMATCH" | "PAGE_LIMIT"
  | "PAGINATION_INVALID" | "PAGINATION_UNKNOWN_KEY" | "PAGINATION_NEXT_MISSING" | "PAGINATION_NEXT_INVALID"
  | "PAGINATION_CURSOR_LOOP" | "PAGINATION_TOP_MARKER" | "PAGINATION_PRESENT" | "PAGINATION_FULL_UNMARKED"
  | "PAGINATION_SORT_BY_MISMATCH" | "PAGINATION_SORT_ORDER_MISMATCH";
const inventoryFail = (scope: InventoryScope, reason: InventoryReason): never => fail(`READINESS_INVENTORY_${scope}_${reason}`);
const inventoryObject = (value: unknown, scope: InventoryScope, reason: InventoryReason): Object_ =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Object_ : inventoryFail(scope,reason);
const inventoryRows = (value: unknown, scope: InventoryScope): unknown[] => Array.isArray(value) ? value : inventoryFail(scope,"ROWS_INVALID");
const inventoryId = (value: unknown, pattern: RegExp, scope: InventoryScope): string =>
  typeof value === "string" && value.length <= 1024 && pattern.test(value) ? value : inventoryFail(scope,"ID_INVALID");
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b,"en")).map(([key,item]) => [key,stable(item)]));
  return value;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const bytesDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
const blobDigest = (value: Uint8Array): string => createHash("sha1").update(`blob ${value.byteLength}\0`).update(value).digest("hex");
function hostDigest(value: string): string {
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(value)) return fail("READINESS_CONTEXT_INVALID");
  return bytesDigest(value.replace(/-pooler(?=\.)/,""));
}
export type ReadinessSource = { revision: string; workflowBlobSha: string; helperBlobSha: string; canneleRevision: string | null };
export type ReadinessContext = { flags: Record<"CAKE_CANNELE_ENABLED" | "CAKE_QA_REGISTRY_ENABLED" | "CAKE_QA_POOL_ENABLED", "true" | "false" | "unset">; parentId: string; productionHostDigest: string };
export function readinessContext(environment: Env): ReadinessContext {
  const flags = {} as ReadinessContext["flags"];
  for (const name of ["CAKE_CANNELE_ENABLED","CAKE_QA_REGISTRY_ENABLED","CAKE_QA_POOL_ENABLED"] as const) {
    const value = environment[name] ?? "";
    if (!["","true","false"].includes(value)) return fail("READINESS_CONTEXT_INVALID");
    flags[name] = value === "" ? "unset" : value as "true" | "false";
  }
  return { flags, parentId: text(environment.CAKE_QA_PARENT_BRANCH_ID,/^br-[a-z0-9-]+$/), productionHostDigest: hostDigest(environment.CAKE_QA_PRODUCTION_DATABASE_HOST ?? "") };
}

/** All HTTP methods are fixed GETs; administrative credentials are not read before provenance passes. */
export class ReadinessGateway extends HttpQaGateway {
  private authorized = false;
  private calls = 0;
  private readonly started = Date.now();
  constructor(private readonly environment: Env, request?: QaTransport) { super(environment,request,"read"); }
  private async get(provider: "github" | "vercel" | "neon", path: string, missing = false): Promise<unknown> {
    if (provider !== "github" && !this.authorized) return fail("READINESS_RUN_UNTRUSTED");
    if (++this.calls > 250 || Date.now()-this.started > 180_000) return fail("READINESS_READ_LIMIT");
    try { return await this.api(provider,path,"GET",undefined,missing); }
    catch (error) {
      const diagnostic = qaDiagnosticFields(error);
      return fail(`READINESS_PROVIDER_${diagnostic.provider}_${diagnostic.stage}_HTTP_${diagnostic.status ?? "NONE"}_${diagnostic.reason}`);
    }
  }
  async authorize(source: ReadinessSource): Promise<{ runId: string; runAttempt: 1 }> {
    const e = this.environment;
    if (e.GITHUB_REPOSITORY !== QA_REPOSITORY || e.GITHUB_REF !== "refs/heads/main" || e.EVENT_NAME !== "workflow_dispatch"
      || e.GITHUB_WORKFLOW_REF !== `${QA_REPOSITORY}/${WORKFLOW}@refs/heads/main`
      || e.GITHUB_WORKFLOW_SHA !== source.revision || e.QA_TRUSTED_MAIN_SHA !== source.revision
      || e.CANNELE_READINESS_EXPECTED_REVISION !== source.revision || !fullSha(source.revision)
      || !leaseToken(e.CANNELE_READINESS_REQUEST_ID) || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? "")) return fail("READINESS_RUN_UNTRUSTED");
    const repository = object(await this.get("github",`/repos/${QA_REPOSITORY}`));
    const owner = object(repository.owner);
    const run = object(await this.get("github",`/repos/${QA_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`));
    const main = object(await this.get("github",`/repos/${QA_REPOSITORY}/branches/main`));
    if (repository.id !== REPOSITORY_ID || repository.full_name !== QA_REPOSITORY || owner.id !== OWNER_ID || owner.type !== "User"
      || object(run.actor).id !== OWNER_ID || object(run.actor).type !== "User" || object(run.triggering_actor).id !== OWNER_ID || object(run.triggering_actor).type !== "User"
      || String(run.id) !== e.GITHUB_RUN_ID || object(run.repository).full_name !== QA_REPOSITORY || object(run.head_repository).full_name !== QA_REPOSITORY
      || run.path !== WORKFLOW || run.head_branch !== "main" || run.head_sha !== source.revision || run.run_attempt !== 1
      || run.event !== "workflow_dispatch" || run.status !== "in_progress" || object(main.commit).sha !== source.revision) return fail("READINESS_RUN_UNTRUSTED");
    const references = array(run.referenced_workflows).map(object);
    if (references.length !== 1 || references[0].sha !== source.revision
      || ![`${QA_REPOSITORY}/${HELPER}@refs/heads/main`,`${QA_REPOSITORY}/${HELPER}@main`,`${QA_REPOSITORY}/${HELPER}@${source.revision}`].includes(String(references[0].path))) return fail("READINESS_RUN_UNTRUSTED");
    for (const [path,expected] of [[WORKFLOW,source.workflowBlobSha],[HELPER,source.helperBlobSha]]) {
      const file = object(await this.get("github",`/repos/${QA_REPOSITORY}/contents/${path}?ref=${source.revision}`));
      if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string" || file.sha !== expected) return fail("READINESS_SOURCE_UNTRUSTED");
      const bytes = Buffer.from(file.content.replace(/\s/g,""),"base64");
      if (bytes.length > 262_144 || blobDigest(bytes) !== expected) return fail("READINESS_SOURCE_UNTRUSTED");
    }
    this.authorized = true;
    return { runId: e.GITHUB_RUN_ID!, runAttempt: 1 };
  }
  async legacyRuns(): Promise<{ complete: true; active: number }> {
    if (!this.authorized) return fail("READINESS_RUN_UNTRUSTED");
    let active = 0;
    for (const workflow of LEGACY_WORKFLOWS) for (const status of ["queued","in_progress","waiting","requested","pending"]) {
      for (let page = 1; page <= 20; page++) {
        const response = inventoryObject(await this.get("github",`/repos/${QA_REPOSITORY}/actions/workflows/${workflow}/runs?status=${status}&per_page=100&page=${page}`),"GITHUB_RUNS","RESPONSE_INVALID");
        const runs = inventoryRows(response.workflow_runs,"GITHUB_RUNS"); const total = response.total_count;
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return inventoryFail("GITHUB_RUNS","TOTAL_INVALID");
        if (runs.some(run => inventoryObject(run,"GITHUB_RUNS","ITEM_INVALID").status !== status)) return inventoryFail("GITHUB_RUNS","STATUS_MISMATCH");
        active += runs.length;
        if (runs.length < 100) { if ((page-1)*100+runs.length !== total) return inventoryFail("GITHUB_RUNS","TOTAL_MISMATCH"); break; }
        if (page === 20) return inventoryFail("GITHUB_RUNS","PAGE_LIMIT");
      }
    }
    return { complete: true, active };
  }
  async providers(snapshot: PrivateSnapshot, context: ReadinessContext): Promise<ProviderSummary> {
    if (!this.authorized) return fail("READINESS_RUN_UNTRUSTED");
    const project = object(await this.get("vercel",`/v9/projects/${QA_PROJECT_ID}`)); const link = object(project.link);
    if (project.id !== QA_PROJECT_ID || project.accountId !== TEAM || link.type !== "github" || Number(link.repoId) !== REPOSITORY_ID
      || link.org !== "tyask" || link.repo !== "Cake") return fail("READINESS_PROVIDER_SCOPE_INVALID");
    const aliases = [];
    for (const slot of SLOTS) {
      const value = await this.get("vercel",`/v4/aliases/${qaAlias(slot)}`,true);
      if (value !== null) { const alias = object(value); if (alias.projectId !== QA_PROJECT_ID || alias.alias !== qaAlias(slot)) return fail("READINESS_PROVIDER_SCOPE_INVALID"); }
      aliases.push({slot,absent:value === null});
    }
    const deployments: { id: string; production: boolean }[] = []; const seen = new Set<string>(); const cursors = new Set<number>();
    let until: number | undefined;
    for (let page = 0; page < 20; page++) {
      const list = inventoryObject(await this.get("vercel",`/v6/deployments?projectId=${QA_PROJECT_ID}&limit=100${until === undefined ? "" : `&until=${until}`}`),"VERCEL_DEPLOYMENTS","RESPONSE_INVALID");
      for (const raw of inventoryRows(list.deployments,"VERCEL_DEPLOYMENTS")) {
        const item = inventoryObject(raw,"VERCEL_DEPLOYMENTS","ITEM_INVALID");
        const id = inventoryId(item.uid ?? item.id,/^dpl_[A-Za-z0-9_-]+$/,"VERCEL_DEPLOYMENTS");
        if (seen.has(id)) return inventoryFail("VERCEL_DEPLOYMENTS","DUPLICATE_ID"); seen.add(id);
        const deployment = inventoryObject(await this.get("vercel",`/v13/deployments/${id}?withGitRepoInfo=true`),"VERCEL_DEPLOYMENTS","DETAIL_INVALID");
        if ((deployment.id ?? deployment.uid) !== id || deployment.projectId !== QA_PROJECT_ID
          || [deployment.teamId,deployment.accountId,deployment.ownerId].some(value => value !== undefined && value !== TEAM)) return fail("READINESS_PROVIDER_SCOPE_INVALID");
        deployments.push({id,production:deployment.target === "production" && deployment.qaTagged !== true && !Object.keys(inventoryObject(deployment.meta ?? {},"VERCEL_DEPLOYMENTS","META_INVALID")).some(key => /^cakeQa|^cannele/.test(key))});
      }
      const pagination = inventoryObject(list.pagination,"VERCEL_DEPLOYMENTS","PAGINATION_INVALID");
      if(Object.keys(pagination).some(key=>!["next","prev","count"].includes(key))) return inventoryFail("VERCEL_DEPLOYMENTS","PAGINATION_UNKNOWN_KEY");
      if(!Object.hasOwn(pagination,"next")) return inventoryFail("VERCEL_DEPLOYMENTS","PAGINATION_NEXT_MISSING");
      const next = pagination.next;
      if (next === null) break;
      if (!Number.isSafeInteger(next) || Number(next)<0) return inventoryFail("VERCEL_DEPLOYMENTS","PAGINATION_NEXT_INVALID");
      if (cursors.has(Number(next))) return inventoryFail("VERCEL_DEPLOYMENTS","PAGINATION_CURSOR_LOOP");
      if (page === 19) return inventoryFail("VERCEL_DEPLOYMENTS","PAGE_LIMIT");
      until = Number(next); cursors.add(until);
    }
    let knownDeploymentsAbsent = 0;
    for (const id of [...snapshot.deployments].sort()) if (await this.get("vercel",`/v13/deployments/${id}?withGitRepoInfo=true`,true) === null) knownDeploymentsAbsent++;
    const neon = object(object(await this.get("neon",`/projects/${QA_NEON_PROJECT_ID}`)).project);
    if (neon.id !== QA_NEON_PROJECT_ID || neon.name !== "cake-preview") return fail("READINESS_PROVIDER_SCOPE_INVALID");
    const parent = object(object(await this.get("neon",`/projects/${QA_NEON_PROJECT_ID}/branches/${context.parentId}`)).branch);
    if (parent.id !== context.parentId || parent.project_id !== QA_NEON_PROJECT_ID) return fail("READINESS_PROVIDER_SCOPE_INVALID");
    const branches = await this.neonInventory("branches"), endpoints = await this.neonInventory("endpoints");
    const listedParent = branches.find(branch => branch.id === context.parentId);
    if (!listedParent) return fail("READINESS_NEON_PARENT_MISSING");
    for (const key of ["id","project_id","parent_id","name","default","protected"] as const) {
      if (!isDeepStrictEqual(listedParent[key],parent[key])) return fail(`READINESS_NEON_PARENT_${key.toUpperCase()}_MISMATCH`);
    }
    if (branches.some(branch => branch.project_id !== QA_NEON_PROJECT_ID) || endpoints.some(endpoint => endpoint.project_id !== QA_NEON_PROJECT_ID
      || !branches.some(branch => branch.id === endpoint.branch_id) || String(endpoint.host).split(".")[0] !== endpoint.id)) return fail("READINESS_PROVIDER_SCOPE_INVALID");
    const endpointDigests = endpoints.map(endpoint => hostDigest(text(endpoint.host,/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/)));
    if (endpointDigests.includes(snapshot.hostDigest) || endpointDigests.includes(context.productionHostDigest)) return fail("READINESS_DATABASE_SCOPE_INVALID");
    let knownBranchesAbsent = 0, knownEndpointsAbsent = 0;
    for (const id of [...snapshot.branches].sort()) if (await this.get("neon",`/projects/${QA_NEON_PROJECT_ID}/branches/${id}`,true) === null) knownBranchesAbsent++;
    for (const id of [...snapshot.endpoints].sort()) if (await this.get("neon",`/projects/${QA_NEON_PROJECT_ID}/endpoints/${id}`,true) === null) knownEndpointsAbsent++;
    const unknown = deployments.filter(deployment => !deployment.production).map(deployment => deployment.id).sort();
    return { complete:true,aliases,deployments:{total:deployments.length,production:deployments.length-unknown.length,nonProductionOrQaTagged:unknown.length,
      blockerIds:unknown.slice(0,32),blockerIdsTruncated:unknown.length>32,inventoryDigest:digest(deployments)},
      neon:{projectId:QA_NEON_PROJECT_ID,parentId:context.parentId,branchCount:branches.length,endpointCount:endpoints.length,
        childBranchCount:branches.filter(branch => branch.id!==context.parentId).length,nonParentEndpointCount:endpoints.filter(endpoint=>endpoint.branch_id!==context.parentId).length,
        inventoryDigest:digest({branches:branches.map(branch=>({id:branch.id,parentId:branch.parent_id})),endpoints:endpoints.map(endpoint=>({id:endpoint.id,branchId:endpoint.branch_id}))})},
      historicalResources:{complete:true,deploymentCount:snapshot.deployments.size,deploymentAbsent:knownDeploymentsAbsent,branchCount:snapshot.branches.size,branchAbsent:knownBranchesAbsent,
        endpointCount:snapshot.endpoints.size,endpointAbsent:knownEndpointsAbsent,hostCount:snapshot.hosts.size,hostsAbsent: [...snapshot.hosts].filter(host=>!endpointDigests.includes(host)).length} };
  }
  private async neonInventory(kind: "branches" | "endpoints"): Promise<Object_[]> {
    const scope = kind === "branches" ? "NEON_BRANCHES" : "NEON_ENDPOINTS";
    const items:Object_[]=[]; const ids=new Set<string>(); const cursors=new Set<string>(); let cursor:string|undefined;
    let sortOrder:"asc"|"desc"="asc";
    for(let page=0;page<20;page++) {
      const body=inventoryObject(await this.get("neon",`/projects/${QA_NEON_PROJECT_ID}/${kind}${kind === "branches" ? `?limit=100&sort_by=created_at&sort_order=${sortOrder}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : ""}`),scope,"RESPONSE_INVALID");
      const rows=inventoryRows(body[kind],scope);
      for(const raw of rows){const item=inventoryObject(raw,scope,"ITEM_INVALID");const id=inventoryId(item.id,kind === "branches" ? /^br-[a-z0-9-]+$/ : /^ep-[a-z0-9-]+$/,scope);if(ids.has(id))return inventoryFail(scope,"DUPLICATE_ID");ids.add(id);items.push(item);}
      if(body.next!==undefined||body.next_cursor!==undefined||body.cursor!==undefined)return inventoryFail(scope,"PAGINATION_TOP_MARKER");
      if(body.pagination === undefined){if(kind === "endpoints" || rows.length<100)return items;return inventoryFail(scope,"PAGINATION_FULL_UNMARKED");}
      if(kind === "endpoints")return inventoryFail(scope,"PAGINATION_PRESENT");
      const pagination=inventoryObject(body.pagination,scope,"PAGINATION_INVALID");
      if(Object.keys(pagination).some(key=>!["next","sort_by","sort_order"].includes(key)))return inventoryFail(scope,"PAGINATION_UNKNOWN_KEY");
      if(pagination.sort_by!==undefined && pagination.sort_by!=="created_at")return inventoryFail(scope,"PAGINATION_SORT_BY_MISMATCH");
      if(pagination.sort_order!==undefined){
        const returnedOrder=pagination.sort_order==="asc"||pagination.sort_order==="ASC"?"asc"
          :pagination.sort_order==="desc"||pagination.sort_order==="DESC"?"desc":inventoryFail(scope,"PAGINATION_SORT_ORDER_MISMATCH");
        if(page>0 && returnedOrder!==sortOrder)return inventoryFail(scope,"PAGINATION_SORT_ORDER_MISMATCH");
        sortOrder=returnedOrder;
      }
      const next=pagination.next;
      // Neon documents next/sort_by/sort_order as optional. An absent next on
      // a short final branch page is complete even when optional echoes are absent.
      if(next===null || next==="" || (next===undefined && rows.length<100))return items;
      if(next===undefined)return inventoryFail(scope,"PAGINATION_NEXT_MISSING");
      if(typeof next!=="string" || next.length>2048)return inventoryFail(scope,"PAGINATION_NEXT_INVALID");
      if(cursors.has(next))return inventoryFail(scope,"PAGINATION_CURSOR_LOOP");
      if(page===19)return inventoryFail(scope,"PAGE_LIMIT");
      cursors.add(next);cursor=next;
    }
    return inventoryFail(scope,"PAGE_LIMIT");
  }
}

const ROLE_CAPABILITIES = ["login","superuser","createRole","createDatabase","replication","bypassRls","ownsDatabase","ownsLegacySchema","schemaOwnerMember","publicSchemaCreateForPublic","hasMembership"] as const;
type RoleCapabilities = Record<typeof ROLE_CAPABILITIES[number],boolean>;
export type DatabaseSummary = { dedicatedIdentity:true; name:string; hostDigest:string; postgresVersion:string; catalog:"001"|"002"; catalogDigest:string; stateDigest:string;
  fence:{mode:"legacy"|"maintenance";epoch:number;receiptRevision:string}|null; roleCapabilities:RoleCapabilities; otherSessions:number;
  slots:{slot:string;state:string;version:number}[]; allSlotsFree:boolean; requestsSettled:boolean; leasesSettled:boolean; historicalRows:number };
export type ProviderSummary = {complete:true;aliases:{slot:string;absent:boolean}[];deployments:{total:number;production:number;nonProductionOrQaTagged:number;blockerIds:string[];blockerIdsTruncated:boolean;inventoryDigest:string};
  neon:{projectId:string;parentId:string;branchCount:number;endpointCount:number;childBranchCount:number;nonParentEndpointCount:number;inventoryDigest:string};
  historicalResources:{complete:true;deploymentCount:number;deploymentAbsent:number;branchCount:number;branchAbsent:number;endpointCount:number;endpointAbsent:number;hostCount:number;hostsAbsent:number}};
export type PrivateSnapshot = {summary:DatabaseSummary;hostDigest:string;deployments:Set<string>;branches:Set<string>;endpoints:Set<string>;hosts:Set<string>};

const metadataSql = `SELECT current_database() AS database_name,
  (current_setting('server_version_num')::integer / 10000)::text || '.' || (current_setting('server_version_num')::integer % 10000)::text AS postgres_version,
  to_regnamespace('cannele_registry') IS NULL AND NOT EXISTS(SELECT FROM pg_namespace WHERE nspname NOT IN ('public','cake_qa_registry','information_schema') AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\')
    AND NOT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')) AS dedicated,
  (SELECT jsonb_agg(to_jsonb(i)) FROM cake_qa_registry.identity i) AS identities,
  (SELECT catalog FROM (${legacyCatalogSql}) c) AS catalog,
  (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_sessions,
  NOT EXISTS(SELECT FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND NOT t.tgisinternal AND t.tgenabled<>'O') AS guards_enabled,
  NOT EXISTS(SELECT FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) p WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND p.grantee<>c.relowner) AS columns_private,
  (SELECT jsonb_build_object('login',r.rolcanlogin,'superuser',r.rolsuper,'createRole',r.rolcreaterole,'createDatabase',r.rolcreatedb,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,
    'ownsDatabase',EXISTS(SELECT FROM pg_database WHERE datname=current_database() AND datdba=r.oid),
    'ownsLegacySchema',EXISTS(SELECT FROM pg_namespace WHERE nspname='cake_qa_registry' AND nspowner=r.oid),
    'schemaOwnerMember',EXISTS(SELECT FROM pg_namespace WHERE nspname='cake_qa_registry' AND pg_has_role(r.oid,nspowner,'USAGE')),
    'publicSchemaCreateForPublic',EXISTS(SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'),
    'hasMembership',EXISTS(SELECT FROM pg_auth_members WHERE member=r.oid)) FROM pg_roles r WHERE rolname=current_user) AS role_capabilities`;

/** Separate bounded read-only batches; catalog admission precedes any retained-record read. */
export async function inspectReadinessDatabase(client:Batch,connection:string,legacyDdl:string,fenceDdl:string):Promise<PrivateSnapshot>{
  try{
    const expected001=expectedLegacyCatalog(legacyDdl),expected002=expectedFencedCatalog(legacyDdl,fenceDdl);
    const opts={isolationLevel:"RepeatableRead" as const,readOnly:true};
    const metadata=(await client.transaction(tx=>[tx.query("SET LOCAL search_path=pg_catalog",[]),tx.query("SET LOCAL statement_timeout='20s'",[]),tx.query(metadataSql,[])],opts)).at(-1) as Object_[];
    if(metadata.length!==1)return fail("READINESS_DATABASE_UNKNOWN");const row=metadata[0];const identities=array(row.identities);
    if(row.dedicated!==true||identities.length!==1)return fail("READINESS_DATABASE_IDENTITY_INVALID");
    const identity=object(identities[0]);const name=text(row.database_name,/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/);
    if(identity.singleton!==true||identity.protocol!=="cake-qa-registry/v1"||identity.database_name!==name)return fail("READINESS_DATABASE_IDENTITY_INVALID");
    if(row.guards_enabled!==true||row.columns_private!==true)return fail("READINESS_CATALOG_UNCONFIRMED");
    const catalog = isDeepStrictEqual(row.catalog,expected001) ? "001" : isDeepStrictEqual(row.catalog,expected002) ? "002" : fail("READINESS_CATALOG_UNCONFIRMED");
    let fence:DatabaseSummary["fence"]=null;
    if(catalog==="002"){
      const receipt=object(identity.fence_receipt);
      if(!["legacy","maintenance"].includes(String(identity.writer_mode))||!Number.isSafeInteger(identity.writer_epoch)||Number(identity.writer_epoch)<1
        ||receipt.protocol!=="cake-qa-registry-fence/v1"||receipt.version!==2||receipt.writerEpoch!==1||receipt.legacyDdlSha256!==LEGACY_DDL_SHA256
        ||receipt.fenceDdlSha256!==bytesDigest(fenceDdl)||!fullSha(receipt.revision))return fail("READINESS_FENCE_UNCONFIRMED");
      fence={mode:identity.writer_mode as "legacy"|"maintenance",epoch:Number(identity.writer_epoch),receiptRevision:String(receipt.revision)};
    }
    const data=(await client.transaction(tx=>[
      tx.query("SET LOCAL search_path=pg_catalog",[]),tx.query("SET LOCAL statement_timeout='20s'",[]),
      tx.query(`LOCK TABLE ${TABLES.map(table=>`cake_qa_registry.${table}`).join(',')} IN ACCESS SHARE MODE`,[]),
      tx.query(`SELECT 1 / CASE WHEN catalog IS NOT DISTINCT FROM $1::jsonb THEN 1 ELSE 0 END AS verified FROM (${legacyCatalogSql}) c`,[JSON.stringify(row.catalog)]),
      ...TABLES.map(table=>tx.query(`SELECT to_jsonb(t) AS value FROM cake_qa_registry.${table} t ORDER BY to_jsonb(t)::text LIMIT ${MAX_ROWS+1}`,[])),
    ],opts)).slice(-TABLES.length) as Object_[][];
    const tables=Object.fromEntries(TABLES.map((table,index)=>[table,data[index].map(item=>object(item.value))]));
    if(Object.values(tables).some(rows=>rows.length>MAX_ROWS)||JSON.stringify(tables).length>8_388_608)return fail("READINESS_DATABASE_LIMIT");
    if(!isDeepStrictEqual(tables.identity,identities))return fail("READINESS_DATABASE_CHANGED");
    const slotRows=tables.slots;
    if(slotRows.length!==3||slotRows.map(slot=>slot.slot).sort().join(',')!==SLOTS.join(','))return fail("READINESS_DATABASE_IDENTITY_INVALID");
    const records:QaRegistryLease[]=[];
    const leases = new Map(tables.leases.map(lease=>[String(lease.lease_id),lease]));
    if(leases.size!==tables.leases.length)return fail("READINESS_HISTORY_UNCONFIRMED");
    for(const slot of slotRows){
      const version=integer(slot.version);
      if(version===0){if(slot.state!=="free"||slot.record!==null||slot.lease_id!==null||slot.pr!==null||slot.branch!==null)return fail("READINESS_SLOT_UNCONFIRMED");}
      else{const record=parseRegistryLease(slot.record);if(record.slot!==slot.slot||record.state!==slot.state||record.version!==version||record.leaseId!==slot.lease_id
        ||record.pr!==Number(slot.pr)||record.branch!==slot.branch)return fail("READINESS_SLOT_UNCONFIRMED");}
    }
    for(const history of tables.history){
      const lease=leases.get(String(history.lease_id)),record=parseRegistryLease(history.record);
      if(!lease||record.leaseId!==history.lease_id||record.version!==integer(history.version)||record.slot!==lease.slot
        ||record.pr!==Number(lease.pr)||record.branch!==lease.branch||Date.parse(record.createdAt)!==Date.parse(String(lease.created_at)))return fail("READINESS_HISTORY_UNCONFIRMED");
    }
    for(const lease of tables.leases){
      const history=tables.history.filter(item=>item.lease_id===lease.lease_id).sort((a,b)=>Number(a.version)-Number(b.version));
      if(!history.length||history.some((item,index)=>index>0&&Number(item.version)!==Number(history[index-1].version)+1))return fail("READINESS_HISTORY_UNCONFIRMED");
      const current=slotRows.find(slot=>slot.lease_id===lease.lease_id),latest=history.at(-1)!;
      if(current&&(Number(current.version)!==Number(latest.version)||!isDeepStrictEqual(current.record,latest.record)))return fail("READINESS_HISTORY_UNCONFIRMED");
    }
    for(const request of tables.requests){if(!leaseToken(request.request_id)||! /^[a-f0-9]{64}$/.test(String(request.fingerprint)))return fail("READINESS_HISTORY_UNCONFIRMED");
      if(request.result!==null){const result=parseRegistryLease(request.result);
        if(!tables.history.some(history=>history.lease_id===result.leaseId&&Number(history.version)===result.version&&isDeepStrictEqual(history.record,request.result)))return fail("READINESS_HISTORY_UNCONFIRMED");}}
    const add=(value:unknown)=>{if(value!==null)records.push(parseRegistryLease(value));};
    for(const slot of slotRows){if(!["free","reserved","published","deleting"].includes(String(slot.state)))return fail("READINESS_DATABASE_UNKNOWN");add(slot.record);}
    for(const history of tables.history)add(history.record);
    for(const request of tables.requests)add(request.result);
    const deployments=new Set<string>(),branches=new Set<string>(),endpoints=new Set<string>(),hosts=new Set<string>();
    for(const record of records){for(const deployment of record.deployments)deployments.add(deployment.id);for(const db of [...record.retiredDatabases,...(record.database?[record.database]:[])]){branches.add(db.branchId);endpoints.add(db.endpointId);hosts.add(hostDigest(db.host));}}
    for(const owner of tables.resource_owners){const id=String(owner.resource_id);switch(owner.kind){case "deployment":deployments.add(text(id,/^dpl_[A-Za-z0-9_-]+$/));break;case "database-branch":branches.add(text(id,/^br-[a-z0-9-]+$/));break;case "database-endpoint":endpoints.add(text(id,/^ep-[a-z0-9-]+$/));break;case "database-host":hosts.add(hostDigest(id));break;default:return fail("READINESS_DATABASE_UNKNOWN");}}
    const allSlotsFree=slotRows.every(slot=>slot.state==="free"&&(slot.record===null||object(slot.record).state==="free"&&!object(slot.record).intent&&object(object(slot.record).aliasAssignment??{}).state!=="pending"));
    const leasesSettled=tables.leases.every(lease=>{const latest=tables.history.filter(history=>history.lease_id===lease.lease_id).sort((a,b)=>Number(b.version)-Number(a.version))[0];const record=latest?.record===undefined?null:object(latest.record);return record?.state==="free"&&!record.intent&&object(record.aliasAssignment??{}).state!=="pending";});
    const requestsSettled=tables.requests.every(request=>request.completed_at!==null&&Number.isFinite(Date.parse(String(request.completed_at))));
    const role=object(row.role_capabilities);if(Object.keys(role).length!==ROLE_CAPABILITIES.length||ROLE_CAPABILITIES.some(key=>typeof role[key]!=="boolean"))return fail("READINESS_DATABASE_UNKNOWN");
    const roleCapabilities=Object.fromEntries(ROLE_CAPABILITIES.map(key=>[key,role[key]])) as RoleCapabilities;
    const host=hostDigest(new URL(connection).hostname);
    const exactHostDigest=bytesDigest(new URL(connection).hostname.toLowerCase().replace(/\.$/,""));
    const summary:DatabaseSummary={dedicatedIdentity:true,name,hostDigest:exactHostDigest,postgresVersion:text(row.postgres_version,/^\d+\.\d+(?:\.\d+)?$/),catalog,catalogDigest:digest(row.catalog),stateDigest:digest(tables),fence,
      roleCapabilities,otherSessions:integer(row.other_sessions),slots:slotRows.map(slot=>({slot:String(slot.slot),state:String(slot.state),version:integer(slot.version)})),
      allSlotsFree,requestsSettled,leasesSettled,historicalRows:tables.history.length};
    return{summary,hostDigest:host,deployments,branches,endpoints,hosts};
  }catch(error){if(error instanceof ReadinessError)throw error;return fail("READINESS_DATABASE_UNKNOWN");}
}

export type ReadinessReceipt = {protocol:"cake-cannele-readiness/v1";requestId:string;source:ReadinessSource;run:{runId:string;runAttempt:1};checkedAt:string;
  context:ReadinessContext;database:DatabaseSummary|null;providers:ProviderSummary|null;legacyRuns:{complete:true;active:number}|null;
  observedConditionsSatisfied:boolean;externalActorAndCredentialDrain:"unconfirmed";blockers:string[]};
export async function collectReadiness(environment:Env,dependencies:{source:ReadinessSource;transport?:QaTransport;database:()=>Promise<PrivateSnapshot>}):Promise<ReadinessReceipt>{
  const gateway=new ReadinessGateway(environment,dependencies.transport);
  const run=await gateway.authorize(dependencies.source);
  const context=readinessContext(environment);
  const blockers:string[]=[];let snapshot:PrivateSnapshot|undefined;
  const observations:{providers:ProviderSummary|null;legacyRuns:ReadinessReceipt["legacyRuns"]}={providers:null,legacyRuns:null};
  const observe=async(fn:()=>Promise<void>)=>{try{await fn();}catch(error){blockers.push(error instanceof ReadinessError?error.code:"READINESS_DEPENDENCY_UNCONFIRMED");}};
  await observe(async()=>{snapshot=await dependencies.database();});
  await observe(async()=>{observations.legacyRuns=await gateway.legacyRuns();});
  if(snapshot)await observe(async()=>{observations.providers=await gateway.providers(snapshot!,context);});
  const {providers,legacyRuns}=observations;
  if(snapshot){const db=snapshot.summary;if(!db.allSlotsFree)blockers.push("REGISTRY_POOL_OCCUPIED");if(!db.requestsSettled||!db.leasesSettled)blockers.push("REGISTRY_HISTORY_UNSETTLED");if(db.catalog!=="002")blockers.push("LEGACY_FENCE_REQUIRED");if(db.otherSessions>0)blockers.push("MANAGEMENT_SESSIONS_PRESENT");}
  if(legacyRuns?.active)blockers.push("LEGACY_RUNS_ACTIVE");
  if(providers){const proof=providers.historicalResources;if(providers.aliases.some(alias=>!alias.absent)||providers.deployments.nonProductionOrQaTagged>0||providers.neon.childBranchCount>0||providers.neon.nonParentEndpointCount>0
    ||proof.deploymentCount!==proof.deploymentAbsent||proof.branchCount!==proof.branchAbsent||proof.endpointCount!==proof.endpointAbsent||proof.hostCount!==proof.hostsAbsent)blockers.push("PROVIDER_RESOURCES_PRESENT");}
  if(context.flags.CAKE_CANNELE_ENABLED!=="true"||context.flags.CAKE_QA_REGISTRY_ENABLED!=="false"||context.flags.CAKE_QA_POOL_ENABLED!=="false")blockers.push("LEGACY_FLAGS_NOT_STOPPED");
  return{protocol:"cake-cannele-readiness/v1",requestId:environment.CANNELE_READINESS_REQUEST_ID!,source:dependencies.source,run,checkedAt:new Date().toISOString(),context,database:snapshot?.summary??null,providers,legacyRuns,
    observedConditionsSatisfied:blockers.length===0,externalActorAndCredentialDrain:"unconfirmed",blockers:[...new Set(blockers)].sort()};
}

async function reviewedSource(environment:Env):Promise<{source:ReadinessSource;legacyDdl:string;fenceDdl:string}>{
  const root=fileURLToPath(new URL("../",import.meta.url));
  try{
    const revision=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
    if(revision!==environment.QA_TRUSTED_MAIN_SHA||execFileSync("git",["status","--porcelain","--","scripts","lib","db/qa-registry","cannele.config.json",WORKFLOW,HELPER],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim())return fail("READINESS_SOURCE_UNTRUSTED");
    const blobs:string[]=[];
    for(const path of [WORKFLOW,HELPER]){const tree=execFileSync("git",["ls-tree",revision,"--",path],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();if(!/^100644 blob [a-f0-9]{40}\t/.test(tree)||tree.split('\t')[1]!==path)return fail("READINESS_SOURCE_UNTRUSTED");blobs.push(tree.split(' ')[2].split('\t')[0]);}
    const configuration=object(JSON.parse(await readFile(join(root,"cannele.config.json"),"utf8")));
    if(configuration.protocol!=="cake-cannele/v1"||!(configuration.sourceRevision===null||fullSha(configuration.sourceRevision)))return fail("READINESS_SOURCE_UNTRUSTED");
    const [legacyDdl,fenceDdl]=await Promise.all([readFile(join(root,"db/qa-registry/001_registry.sql"),"utf8"),readFile(join(root,"db/qa-registry/002_cannele_fence.sql"),"utf8")]);
    return{source:{revision,workflowBlobSha:blobs[0],helperBlobSha:blobs[1],canneleRevision:configuration.sourceRevision as string|null},legacyDdl,fenceDdl};
  }catch(error){if(error instanceof ReadinessError)throw error;return fail("READINESS_SOURCE_UNTRUSTED");}
}
export async function runCanneleReadiness(environment:Env=process.env):Promise<void>{
  const source=await reviewedSource(environment);
  const receipt=await collectReadiness(environment,{source:source.source,database:async()=>{
    const connection=registryConnectionString({...environment});
    return inspectReadinessDatabase(neon(connection,{fetchOptions:{signal:AbortSignal.timeout(30_000)}}),connection,source.legacyDdl,source.fenceDdl);
  }});
  const temporary=realpathSync(environment.RUNNER_TEMP??"");
  const directory=join(temporary,"cannele-readiness",receipt.requestId);const target=join(directory,"result.json");
  if(environment.CANNELE_READINESS_RESULT_PATH!==target)return fail("READINESS_OUTPUT_INVALID");
  await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(target,JSON.stringify(receipt)+"\n",{encoding:"utf8",mode:0o600,flag:"wx"});
  console.log(`Cake: Cannele readiness inspected; database=${receipt.database?.catalog??"unconfirmed"}, blockers=${receipt.blockers.join(',')||"none"}; external actor/credential drain remains unconfirmed.`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runCanneleReadiness().catch(error=>{
  const code=error instanceof ReadinessError?error.code:"READINESS_UNCONFIRMED";console.error(`Cake: Cannele readiness failed (${code}); private details suppressed.`);process.exitCode=1;
});
