import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { fullSha, QA_REPOSITORY } from "../lib/qa-pool";
import { registryConnectionString } from "./qa-registry-store";
import { HttpQaGateway, type QaTransport } from "./qa-pool-writer";
import { registryDdlStatements, registryLegacyWorkflows, registrySafeSearchPath, registryWriterLocks } from "./qa-registry-ddl";

export const LEGACY_DDL_SHA256 = "ea1b1aa6459b478a73308709d60a8dd4e120017a472603921fd3f39a48bc7b73";
export const LEGACY_WORKFLOWS = registryLegacyWorkflows;
const WORKFLOW = ".github/workflows/qa-registry-fence.yml";
const ERROR = "QA registry fence installation could not be verified; database and credential details suppressed.";
const AUTH_ERROR = "QA registry fence requires its owner-only reviewed main workflow, disabled legacy jobs and confirmed external writer drain.";
type Env = Readonly<Record<string, string | undefined>>;
type BatchClient = Pick<NeonQueryFunction<false, false>, "transaction">;
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(AUTH_ERROR);
  return value as Record<string, unknown>;
};
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export type RegistryFenceReceipt = {
  protocol: "cake-qa-registry-fence/v1"; version: 2; revision: string;
  legacyDdlSha256: string; fenceDdlSha256: string; writerEpoch: 1;
};

/** Read-only GitHub checks. No provider credential, deployment or comment calls. */
export class RegistryFenceGateway extends HttpQaGateway {
  constructor(private readonly environment: Env, request?: QaTransport) { super(environment, request, "read"); }

  async assertReviewedMain(): Promise<string> {
    const e = this.environment;
    if (e.GITHUB_REPOSITORY !== QA_REPOSITORY || e.GITHUB_REF !== "refs/heads/main"
      || e.EVENT_NAME !== "workflow_dispatch" || !/^[1-9][0-9]*$/.test(e.GITHUB_RUN_ID ?? "")
      || !fullSha(e.QA_TRUSTED_MAIN_SHA) || e.QA_FENCE_EXPECTED_REVISION !== e.QA_TRUSTED_MAIN_SHA
      || e.CAKE_CANNELE_ENABLED !== "true" || e.CAKE_QA_REGISTRY_ENABLED !== "false"
      || e.CAKE_QA_POOL_ENABLED !== "false" || e.QA_FENCE_DRAIN_CONFIRMED !== "true") throw new Error(AUTH_ERROR);
    const repository = obj(await this.api("github", `/repos/${QA_REPOSITORY}`));
    const owner = obj(repository.owner);
    const run = obj(await this.api("github", `/repos/${QA_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`));
    const main = obj(await this.api("github", `/repos/${QA_REPOSITORY}/branches/main`));
    if (owner.type !== "User" || !Number.isSafeInteger(owner.id) || Number(owner.id) < 1
      || obj(run.actor).type !== "User" || obj(run.triggering_actor).type !== "User"
      || obj(run.actor).id !== owner.id || obj(run.triggering_actor).id !== owner.id
      || obj(run.repository).full_name !== QA_REPOSITORY || obj(run.head_repository).full_name !== QA_REPOSITORY
      || run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.head_sha !== e.QA_TRUSTED_MAIN_SHA
      || run.path !== WORKFLOW || run.run_attempt !== 1 || run.status !== "in_progress"
      || obj(main.commit).sha !== e.QA_TRUSTED_MAIN_SHA) throw new Error(AUTH_ERROR);
    return e.QA_TRUSTED_MAIN_SHA;
  }

  async assertAllLegacyRunsIdle(): Promise<void> {
    for (const workflow of LEGACY_WORKFLOWS) {
      for (let page = 1; page <= 100; page++) {
        const response = obj(await this.api("github", `/repos/${QA_REPOSITORY}/actions/workflows/${workflow}/runs?per_page=100&page=${page}`));
        if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count)
          || Number(response.total_count) < 0) throw new Error(AUTH_ERROR);
        if (response.workflow_runs.some(raw => obj(raw).status !== "completed")) throw new Error(AUTH_ERROR);
        if (response.workflow_runs.length < 100) {
          if ((page - 1) * 100 + response.workflow_runs.length < Number(response.total_count)) throw new Error(AUTH_ERROR);
          break;
        }
        if (page === 100) throw new Error(AUTH_ERROR);
      }
    }
  }
}

/** Closed catalog projection; table data and credentials never leave this query. */
export const legacyCatalogSql = `SELECT jsonb_build_object(
  'relations', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity) ORDER BY c.relname COLLATE "C")
    FROM pg_class c WHERE c.relnamespace=to_regnamespace('cake_qa_registry')), '[]'::jsonb),
  'columns', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated) ORDER BY c.relname COLLATE "C",a.attnum)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped), '[]'::jsonb),
  'constraints', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true),k.convalidated,k.condeferrable,k.condeferred) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C")
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND k.contype<>'n'), '[]'::jsonb),
  'indexes', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) ORDER BY c.relname COLLATE "C")
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=to_regnamespace('cake_qa_registry')), '[]'::jsonb),
  'functions', COALESCE((SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_function_result(p.oid),l.lanname,p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,p.proconfig,p.prosrc) ORDER BY p.proname COLLATE "C")
    FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.pronamespace=to_regnamespace('cake_qa_registry')), '[]'::jsonb),
  'triggers', COALESCE((SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid)) ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C")
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND NOT t.tgisinternal), '[]'::jsonb),
  'rules', COALESCE((SELECT jsonb_agg(r.rulename ORDER BY r.rulename COLLATE "C") FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class WHERE c.relnamespace=to_regnamespace('cake_qa_registry')), '[]'::jsonb),
  'policies', COALESCE((SELECT jsonb_agg(p.polname ORDER BY p.polname COLLATE "C") FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=to_regnamespace('cake_qa_registry')), '[]'::jsonb),
  'customTypes', COALESCE((SELECT jsonb_agg(t.typname ORDER BY t.typname COLLATE "C") FROM pg_type t WHERE t.typnamespace=to_regnamespace('cake_qa_registry') AND t.typtype NOT IN ('c') AND t.typelem=0), '[]'::jsonb),
  'otherObjects', COALESCE((SELECT jsonb_agg(jsonb_build_array(kind,name) ORDER BY kind COLLATE "C",name COLLATE "C") FROM (
    SELECT 'collation' AS kind,collname AS name FROM pg_collation WHERE collnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'conversion',conname FROM pg_conversion WHERE connamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'operator',oprname FROM pg_operator WHERE oprnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'operator-class',opcname FROM pg_opclass WHERE opcnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'operator-family',opfname FROM pg_opfamily WHERE opfnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'text-config',cfgname FROM pg_ts_config WHERE cfgnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'text-dictionary',dictname FROM pg_ts_dict WHERE dictnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'text-parser',prsname FROM pg_ts_parser WHERE prsnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'text-template',tmplname FROM pg_ts_template WHERE tmplnamespace=to_regnamespace('cake_qa_registry')
    UNION ALL SELECT 'statistics',stxname FROM pg_statistic_ext WHERE stxnamespace=to_regnamespace('cake_qa_registry')
  ) extras), '[]'::jsonb),
  'ordinaryColumns', NOT EXISTS(SELECT FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND c.relkind='r' AND a.attnum>0
      AND (a.attisdropped OR a.attcollation NOT IN (0,'pg_catalog."default"'::regcollation) OR a.attoptions IS NOT NULL OR a.attfdwoptions IS NOT NULL)),
  'owned', (SELECT n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_namespace n WHERE n.oid=to_regnamespace('cake_qa_registry'))
    AND NOT EXISTS(SELECT FROM pg_class c WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
    AND NOT EXISTS(SELECT FROM pg_proc p WHERE p.pronamespace=to_regnamespace('cake_qa_registry') AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)),
  'private', NOT EXISTS(SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.oid=to_regnamespace('cake_qa_registry') AND a.grantee<>n.nspowner)
    AND NOT EXISTS(SELECT FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.relnamespace=to_regnamespace('cake_qa_registry') AND a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace=to_regnamespace('cake_qa_registry') AND a.grantee<>p.proowner)
) AS catalog`;

// Generated from immutable 001 on PostgreSQL 17; function bodies are extracted from its pinned bytes.
const LEGACY_STRUCTURE: Record<string, unknown> = {
  "otherObjects": [],
  "ordinaryColumns": true,
  "owned": true,
  "rules": [],
  "columns": [
    ["history", "lease_id", "uuid", true, null, "", ""],
    ["history", "version", "bigint", true, null, "", ""],
    ["history", "record", "jsonb", true, null, "", ""],
    ["identity", "singleton", "boolean", true, "true", "", ""],
    ["identity", "protocol", "text", true, null, "", ""],
    ["identity", "database_name", "text", true, null, "", ""],
    ["leases", "lease_id", "uuid", true, null, "", ""],
    ["leases", "slot", "text", true, null, "", ""],
    ["leases", "pr", "bigint", true, null, "", ""],
    ["leases", "branch", "text", true, null, "", ""],
    ["leases", "created_at", "timestamp with time zone", true, null, "", ""],
    ["requests", "request_id", "uuid", true, null, "", ""],
    ["requests", "fingerprint", "text", true, null, "", ""],
    ["requests", "result", "jsonb", false, null, "", ""],
    ["requests", "completed_at", "timestamp with time zone", true, "now()", "", ""],
    ["resource_owners", "kind", "text", true, null, "", ""],
    ["resource_owners", "resource_id", "text", true, null, "", ""],
    ["resource_owners", "lease_id", "uuid", true, null, "", ""],
    ["slots", "slot", "text", true, null, "", ""],
    ["slots", "version", "bigint", true, "0", "", ""],
    ["slots", "state", "text", true, "'free'::text", "", ""],
    ["slots", "lease_id", "uuid", false, null, "", ""],
    ["slots", "pr", "bigint", false, null, "", ""],
    ["slots", "branch", "text", false, null, "", ""],
    ["slots", "record", "jsonb", false, null, "", ""],
  ],
  "indexes": [
    ["history_pkey", "CREATE UNIQUE INDEX history_pkey ON cake_qa_registry.history USING btree (lease_id, version)", true, true],
    ["identity_pkey", "CREATE UNIQUE INDEX identity_pkey ON cake_qa_registry.identity USING btree (singleton)", true, true],
    ["leases_branch_key", "CREATE UNIQUE INDEX leases_branch_key ON cake_qa_registry.leases USING btree (branch)", true, true],
    ["leases_pkey", "CREATE UNIQUE INDEX leases_pkey ON cake_qa_registry.leases USING btree (lease_id)", true, true],
    ["qa_registry_active_branch", "CREATE UNIQUE INDEX qa_registry_active_branch ON cake_qa_registry.slots USING btree (branch) WHERE (state <> 'free'::text)", true, true],
    ["qa_registry_active_pr", "CREATE UNIQUE INDEX qa_registry_active_pr ON cake_qa_registry.slots USING btree (pr) WHERE (state <> 'free'::text)", true, true],
    ["requests_pkey", "CREATE UNIQUE INDEX requests_pkey ON cake_qa_registry.requests USING btree (request_id)", true, true],
    ["resource_owners_pkey", "CREATE UNIQUE INDEX resource_owners_pkey ON cake_qa_registry.resource_owners USING btree (kind, resource_id)", true, true],
    ["slots_pkey", "CREATE UNIQUE INDEX slots_pkey ON cake_qa_registry.slots USING btree (slot)", true, true],
  ],
  "private": true,
  "policies": [],
  "triggers": [],
  "relations": [
    ["history", "r", "p", false, false],
    ["history_pkey", "i", "p", false, false],
    ["identity", "r", "p", false, false],
    ["identity_pkey", "i", "p", false, false],
    ["leases", "r", "p", false, false],
    ["leases_branch_key", "i", "p", false, false],
    ["leases_pkey", "i", "p", false, false],
    ["qa_registry_active_branch", "i", "p", false, false],
    ["qa_registry_active_pr", "i", "p", false, false],
    ["requests", "r", "p", false, false],
    ["requests_pkey", "i", "p", false, false],
    ["resource_owners", "r", "p", false, false],
    ["resource_owners_pkey", "i", "p", false, false],
    ["slots", "r", "p", false, false],
    ["slots_pkey", "i", "p", false, false],
  ],
  "constraints": [
    ["history", "history_lease_id_fkey", "f", "FOREIGN KEY (lease_id) REFERENCES cake_qa_registry.leases(lease_id)", true, false, false],
    ["history", "history_pkey", "p", "PRIMARY KEY (lease_id, version)", true, false, false],
    ["identity", "identity_database_name_check", "c", "CHECK (database_name = current_database())", true, false, false],
    ["identity", "identity_pkey", "p", "PRIMARY KEY (singleton)", true, false, false],
    ["identity", "identity_protocol_check", "c", "CHECK (protocol = 'cake-qa-registry/v1'::text)", true, false, false],
    ["identity", "identity_singleton_check", "c", "CHECK (singleton)", true, false, false],
    ["leases", "leases_branch_key", "u", "UNIQUE (branch)", true, false, false],
    ["leases", "leases_pkey", "p", "PRIMARY KEY (lease_id)", true, false, false],
    ["leases", "leases_pr_check", "c", "CHECK (pr > 0)", true, false, false],
    ["leases", "leases_slot_fkey", "f", "FOREIGN KEY (slot) REFERENCES cake_qa_registry.slots(slot)", true, false, false],
    ["requests", "requests_fingerprint_check", "c", "CHECK (fingerprint ~ '^[a-f0-9]{64}$'::text)", true, false, false],
    ["requests", "requests_pkey", "p", "PRIMARY KEY (request_id)", true, false, false],
    ["resource_owners", "resource_owners_kind_check", "c", "CHECK (kind = ANY (ARRAY['deployment'::text, 'database-branch'::text, 'database-endpoint'::text, 'database-host'::text]))", true, false, false],
    ["resource_owners", "resource_owners_lease_id_fkey", "f", "FOREIGN KEY (lease_id) REFERENCES cake_qa_registry.leases(lease_id)", true, false, false],
    ["resource_owners", "resource_owners_pkey", "p", "PRIMARY KEY (kind, resource_id)", true, false, false],
    ["slots", "slots_check", "c", "CHECK (version = 0 AND record IS NULL AND lease_id IS NULL AND pr IS NULL AND branch IS NULL AND state = 'free'::text OR version > 0 AND record IS NOT NULL AND (record ->> 'protocol'::text) = 'cake-qa-registry/v1'::text AND record ?& ARRAY['protocol'::text, 'slot'::text, 'state'::text, 'version'::text, 'leaseId'::text, 'pr'::text, 'branch'::text, 'headSha'::text, 'requestId'::text, 'createdAt'::text, 'updatedAt'::text, 'deployments'::text, 'retiredDatabases'::text] AND (record ->> 'slot'::text) = slot AND (record ->> 'state'::text) = state AND ((record ->> 'version'::text)::bigint) = version AND ((record ->> 'leaseId'::text)::uuid) = lease_id AND ((record ->> 'pr'::text)::bigint) = pr AND (record ->> 'branch'::text) = branch)", true, false, false],
    ["slots", "slots_pkey", "p", "PRIMARY KEY (slot)", true, false, false],
    ["slots", "slots_slot_check", "c", "CHECK (slot = ANY (ARRAY['qa1'::text, 'qa2'::text, 'qa3'::text]))", true, false, false],
    ["slots", "slots_state_check", "c", "CHECK (state = ANY (ARRAY['free'::text, 'reserved'::text, 'published'::text, 'deleting'::text]))", true, false, false],
    ["slots", "slots_version_check", "c", "CHECK (version >= 0)", true, false, false],
  ],
  "customTypes": [],
};

const FENCE_STRUCTURE_CHANGES: Record<string, unknown[][]> = {
  "columns": [
    ["identity","writer_mode","text",true,"'legacy'::text","",""],
    ["identity","writer_epoch","bigint",true,"1","",""],
    ["identity","fence_receipt","jsonb",false,null,"",""],
  ],
  "constraints": [
    ["identity","qa_registry_fence_receipt","c","CHECK (fence_receipt IS NULL OR (jsonb_typeof(fence_receipt) = 'object'::text AND fence_receipt ?& ARRAY['protocol'::text, 'version'::text, 'revision'::text, 'legacyDdlSha256'::text, 'fenceDdlSha256'::text, 'writerEpoch'::text] AND (fence_receipt - ARRAY['protocol'::text, 'version'::text, 'revision'::text, 'legacyDdlSha256'::text, 'fenceDdlSha256'::text, 'writerEpoch'::text]) = '{}'::jsonb AND (fence_receipt ->> 'protocol'::text) = 'cake-qa-registry-fence/v1'::text AND (fence_receipt -> 'version'::text) = '2'::jsonb AND (fence_receipt -> 'writerEpoch'::text) = '1'::jsonb AND jsonb_typeof(fence_receipt -> 'revision'::text) = 'string'::text AND (fence_receipt ->> 'revision'::text) ~ '^[a-f0-9]{40}$'::text AND jsonb_typeof(fence_receipt -> 'legacyDdlSha256'::text) = 'string'::text AND (fence_receipt ->> 'legacyDdlSha256'::text) ~ '^[a-f0-9]{64}$'::text AND jsonb_typeof(fence_receipt -> 'fenceDdlSha256'::text) = 'string'::text AND (fence_receipt ->> 'fenceDdlSha256'::text) ~ '^[a-f0-9]{64}$'::text) IS TRUE)",true,false,false],
    ["identity","qa_registry_writer_control","c","CHECK (writer_mode = 'legacy'::text AND writer_epoch = 1 OR writer_mode = 'maintenance'::text AND writer_epoch >= 2 AND writer_epoch <= '9007199254740991'::bigint)",true,false,false],
  ],
  "triggers": [
    ["history","qa_registry_writer_fence","CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.history FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write()"],
    ["identity","qa_registry_control_identity","CREATE TRIGGER qa_registry_control_identity BEFORE INSERT OR DELETE OR UPDATE ON cake_qa_registry.identity FOR EACH ROW EXECUTE FUNCTION cake_qa_registry.protect_fence_identity()"],
    ["identity","qa_registry_control_lock","CREATE TRIGGER qa_registry_control_lock BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.identity FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.protect_fence_identity()"],
    ["leases","qa_registry_writer_fence","CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.leases FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write()"],
    ["requests","qa_registry_writer_fence","CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.requests FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write()"],
    ["resource_owners","qa_registry_writer_fence","CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.resource_owners FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write()"],
    ["slots","qa_registry_writer_fence","CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON cake_qa_registry.slots FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write()"],
  ],
 };

export function expectedLegacyCatalog(legacyDdl: string): Record<string, unknown> {
  if (digest(legacyDdl) !== LEGACY_DDL_SHA256) throw new Error(ERROR);
  const functions = registryDdlStatements(legacyDdl).filter(sql => sql.startsWith("CREATE FUNCTION")).map(sql => {
    const match = sql.match(/^CREATE FUNCTION cake_qa_registry\.(\w+)\(([\s\S]*?)\) RETURNS (void|jsonb) LANGUAGE plpgsql AS (\$\w*\$)([\s\S]*)\4;$/);
    if (!match) throw new Error(ERROR);
    const argumentsText = match[2].replace(/\s+/g," ").replace(/, /g,", ").trim();
    return [match[1], argumentsText, match[3], "plpgsql", "v", false, false, "u", null, match[5]];
  }).sort((a,b) => String(a[0]).localeCompare(String(b[0]), "en"));
  if (functions.length !== 3) throw new Error(ERROR);
  return { ...LEGACY_STRUCTURE, functions };
}

export function expectedFencedCatalog(legacyDdl: string, fenceDdl: string): Record<string, unknown> {
  const before = expectedLegacyCatalog(legacyDdl);
  const functions = new Map((before.functions as unknown[][]).map(row => [String(row[0]), row]));
  for (const statement of registryDdlStatements(fenceDdl)) {
    const match = statement.match(/CREATE (?:OR REPLACE )?FUNCTION cake_qa_registry\.(\w+)\(([\s\S]*?)\) RETURNS (void|trigger)\s+LANGUAGE plpgsql SET search_path = pg_catalog, cake_qa_registry AS (\$\w*\$)([\s\S]*)\4;$/);
    if (match) functions.set(match[1], [match[1], match[2].replace(/\s+/g, " ").trim(), match[3], "plpgsql", "v", false, false, "u", ["search_path=pg_catalog, cake_qa_registry"], match[5]]);
  }
  if (functions.size !== 5) throw new Error(ERROR);
  const columns = before.columns as unknown[][];
  const constraints = [...before.constraints as unknown[][], ...FENCE_STRUCTURE_CHANGES.constraints];
  return { ...before,
    columns: columns.flatMap((row,index) => row[0] === "identity" && columns[index+1]?.[0] !== "identity"
      ? [row, ...FENCE_STRUCTURE_CHANGES.columns] : [row]),
    constraints: constraints.sort((a,b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`, "en")),
    triggers: FENCE_STRUCTURE_CHANGES.triggers,
    functions: [...functions.values()].sort((a,b) => String(a[0]).localeCompare(String(b[0]), "en")),
  };
}

export function registryFenceReceipt(revision: string, legacyDdl: string, fenceDdl: string): RegistryFenceReceipt {
  if (!fullSha(revision) || digest(legacyDdl) !== LEGACY_DDL_SHA256) throw new Error(ERROR);
  registryDdlStatements(fenceDdl);
  return { protocol: "cake-qa-registry-fence/v1", version: 2, revision,
    legacyDdlSha256: LEGACY_DDL_SHA256, fenceDdlSha256: digest(fenceDdl), writerEpoch: 1 };
}

const dedicatedGuard = `DO $fence_database_guard$
BEGIN
  IF to_regnamespace('cannele_registry') IS NOT NULL OR to_regclass('cake_qa_registry.identity') IS NULL
    OR EXISTS(SELECT FROM pg_namespace WHERE nspname NOT IN ('public','cake_qa_registry','information_schema') AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\')
    OR EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')) THEN
    RAISE EXCEPTION 'Cake QA fence database is not the exact legacy registry';
  END IF;
  IF (SELECT count(*) FROM cake_qa_registry.identity)<>1
    OR NOT EXISTS(SELECT FROM cake_qa_registry.identity WHERE singleton AND protocol='cake-qa-registry/v1' AND database_name=current_database()) THEN
    RAISE EXCEPTION 'Cake QA fence legacy identity mismatch';
  END IF;
END;
$fence_database_guard$;`;

/** Exact installed replay is read-only; a partial/different/retired installation never falls through to DDL. */
export async function inspectRegistryFence(client: BatchClient, revision: string, legacyDdl: string, fenceDdl: string): Promise<RegistryFenceReceipt | null> {
  const receipt = registryFenceReceipt(revision, legacyDdl, fenceDdl);
  const expectedLegacy = expectedLegacyCatalog(legacyDdl);
  const expectedFenced = expectedFencedCatalog(legacyDdl, fenceDdl);
  try {
    const results = await client.transaction(tx => [
      ...[registrySafeSearchPath, "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '60s';", ...registryWriterLocks, dedicatedGuard].map(sql => tx.query(sql, [])),
      tx.query(`SELECT to_jsonb(i) AS identity, (SELECT catalog FROM (${legacyCatalogSql}) exact_schema) AS catalog FROM cake_qa_registry.identity i`, []),
    ]);
    const rows = results.at(-1) as Record<string, unknown>[] | undefined;
    if (!rows || rows.length !== 1) throw new Error();
    const identity = obj(rows[0].identity);
    if (!("writer_mode" in identity) && !("writer_epoch" in identity) && !("fence_receipt" in identity)) {
      if (!isDeepStrictEqual(rows[0].catalog, expectedLegacy)) throw new Error();
      return null;
    }
    if (identity.writer_mode !== "legacy" || identity.writer_epoch !== 1
      || !isDeepStrictEqual(identity.fence_receipt, receipt) || !isDeepStrictEqual(rows[0].catalog, expectedFenced)) throw new Error();
    return receipt;
  } catch { throw new Error(ERROR); }
}

/** No providers run while these locks are held. The receipt and DDL commit together. */
export async function applyRegistryFence(client: BatchClient, revision: string, legacyDdl: string, fenceDdl: string): Promise<RegistryFenceReceipt> {
  const receipt = registryFenceReceipt(revision, legacyDdl, fenceDdl);
  const expected = expectedLegacyCatalog(legacyDdl);
  const batch = [registrySafeSearchPath, "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '60s';", ...registryWriterLocks, dedicatedGuard,
    "LOCK TABLE cake_qa_registry.identity, cake_qa_registry.slots, cake_qa_registry.leases, cake_qa_registry.history, cake_qa_registry.resource_owners, cake_qa_registry.requests IN SHARE ROW EXCLUSIVE MODE;",
  ];
  try {
    await client.transaction(tx => [
      ...batch.map(sql => tx.query(sql, [])),
      tx.query(`SELECT 1 / CASE WHEN (catalog IS NOT DISTINCT FROM $1::jsonb) THEN 1 ELSE 0 END AS verified FROM (${legacyCatalogSql}) legacy`, [JSON.stringify(expected)]),
      ...registryDdlStatements(fenceDdl).map(sql => tx.query(sql, [])),
      tx.query("UPDATE cake_qa_registry.identity SET fence_receipt=$1::jsonb WHERE singleton AND writer_mode='legacy' AND writer_epoch=1 AND fence_receipt IS NULL", [JSON.stringify(receipt)]),
      tx.query(`SELECT 1 / CASE WHEN count(*)=1 AND bool_and(protocol='cake-qa-registry/v1' AND database_name=current_database()
        AND writer_mode='legacy' AND writer_epoch=1 AND fence_receipt=$1::jsonb) THEN 1 ELSE 0 END AS verified FROM cake_qa_registry.identity`, [JSON.stringify(receipt)]),
    ]);
    return receipt;
  } catch { throw new Error(ERROR); }
}

function assertCleanSource(directory: string, revision: string): void {
  try {
    if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).trim() !== revision) throw new Error();
    execFileSync("git", ["diff", "--quiet", "HEAD", "--", "scripts", "lib", "db/qa-registry", "package.json", "package-lock.json", ".github/workflows"], { cwd: directory, stdio: "ignore" });
    for (const path of ["scripts/qa-registry-fence.ts", "scripts/qa-registry-ddl.ts", "db/qa-registry/001_registry.sql", "db/qa-registry/002_cannele_fence.sql", WORKFLOW, ...LEGACY_WORKFLOWS.map(name => `.github/workflows/${name}`)]) {
      const entry = execFileSync("git", ["ls-tree", revision, "--", path], { cwd: directory, encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).trim();
      if (!entry.startsWith("100644 blob ") || entry.split("\t")[1] !== path || entry.includes("\n")) throw new Error();
    }
  } catch { throw new Error(AUTH_ERROR); }
}

export async function runRegistryFence(environment: Env = process.env): Promise<void> {
  if (!["install", "inspect"].includes(environment.QA_FENCE_ACTION ?? "")) throw new Error(AUTH_ERROR);
  console.log("Cake: QA fence stage=owner");
  const gateway = new RegistryFenceGateway(environment);
  const revision = await gateway.assertReviewedMain();
  const directory = fileURLToPath(new URL("../", import.meta.url));
  console.log("Cake: QA fence stage=reviewed-source");
  assertCleanSource(directory, revision);
  console.log("Cake: QA fence stage=legacy-runs");
  await gateway.assertAllLegacyRunsIdle();
  const [legacyDdl, fenceDdl] = await Promise.all([
    readFile(new URL("../db/qa-registry/001_registry.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/qa-registry/002_cannele_fence.sql", import.meta.url), "utf8"),
  ]);
  // Recheck main, flags supplied by this reviewed workflow, and queues immediately before the DB batch.
  console.log("Cake: QA fence stage=final-main-and-runs");
  await gateway.assertReviewedMain();
  await gateway.assertAllLegacyRunsIdle();
  const client = neon(registryConnectionString({ ...environment }));
  console.log("Cake: QA fence stage=inspection");
  const installed = await inspectRegistryFence(client, revision, legacyDdl, fenceDdl);
  if (environment.QA_FENCE_ACTION === "inspect" && !installed) throw new Error(ERROR);
  if (!installed) console.log("Cake: QA fence stage=atomic-install");
  const receipt = installed ?? await applyRegistryFence(client, revision, legacyDdl, fenceDdl);
  console.log(`Cake: QA legacy compatibility fence installed; version=${receipt.version} writerEpoch=${receipt.writerEpoch} source=${receipt.revision}. Legacy data retained; Cannele cutover not performed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRegistryFence().catch(() => { console.error(ERROR); process.exitCode=1; });
}
