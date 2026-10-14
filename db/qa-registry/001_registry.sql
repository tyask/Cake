-- Management-only database. Do NOT put this file in db/migrations or run it
-- through db:setup. Initialize only after the legacy pool is completely free
-- and its Vercel/Neon resources have been independently confirmed absent.
BEGIN;
DO $registry_empty$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg_%'
  ) THEN
    RAISE EXCEPTION 'Cake QA registry requires a separate empty management database';
  END IF;
END;
$registry_empty$;

CREATE SCHEMA cake_qa_registry;
CREATE TABLE cake_qa_registry.identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  protocol text NOT NULL CHECK (protocol = 'cake-qa-registry/v1'),
  database_name text NOT NULL CHECK (database_name = current_database())
);
INSERT INTO cake_qa_registry.identity VALUES (true, 'cake-qa-registry/v1', current_database());

CREATE TABLE cake_qa_registry.slots (
  slot text PRIMARY KEY CHECK (slot IN ('qa1','qa2','qa3')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  state text NOT NULL DEFAULT 'free' CHECK (state IN ('free','reserved','published','deleting')),
  lease_id uuid, pr bigint, branch text, record jsonb,
  CHECK ((version = 0 AND record IS NULL AND lease_id IS NULL AND pr IS NULL AND branch IS NULL AND state = 'free')
    OR (version > 0 AND record IS NOT NULL AND record->>'protocol' = 'cake-qa-registry/v1'
      AND record ?& ARRAY['protocol','slot','state','version','leaseId','pr','branch','headSha','requestId','createdAt','updatedAt','deployments','retiredDatabases']
      AND record->>'slot' = slot AND record->>'state' = state
      AND (record->>'version')::bigint = version AND (record->>'leaseId')::uuid = lease_id
      AND (record->>'pr')::bigint = pr AND record->>'branch' = branch))
);
CREATE UNIQUE INDEX qa_registry_active_pr ON cake_qa_registry.slots (pr) WHERE state <> 'free';
CREATE UNIQUE INDEX qa_registry_active_branch ON cake_qa_registry.slots (branch) WHERE state <> 'free';
INSERT INTO cake_qa_registry.slots (slot) VALUES ('qa1'),('qa2'),('qa3');

-- Retain leases and private snapshots after slots are reused. A retired lease,
-- feature branch, Deployment, or database identity must never be recycled.
CREATE TABLE cake_qa_registry.leases (
  lease_id uuid PRIMARY KEY, slot text NOT NULL REFERENCES cake_qa_registry.slots(slot),
  pr bigint NOT NULL CHECK (pr > 0), branch text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE TABLE cake_qa_registry.history (
  lease_id uuid NOT NULL REFERENCES cake_qa_registry.leases(lease_id),
  version bigint NOT NULL, record jsonb NOT NULL,
  PRIMARY KEY (lease_id, version)
);
CREATE TABLE cake_qa_registry.resource_owners (
  kind text NOT NULL CHECK (kind IN ('deployment','database-branch','database-endpoint','database-host')),
  resource_id text NOT NULL, lease_id uuid NOT NULL REFERENCES cake_qa_registry.leases(lease_id),
  PRIMARY KEY (kind, resource_id)
);
CREATE TABLE cake_qa_registry.requests (
  request_id uuid PRIMARY KEY, fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb, completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION cake_qa_registry.assert_identity() RETURNS void LANGUAGE plpgsql AS $guard$
BEGIN
  IF (SELECT count(*) FROM cake_qa_registry.identity) <> 1 OR NOT EXISTS (
    SELECT 1 FROM cake_qa_registry.identity
    WHERE singleton AND protocol = 'cake-qa-registry/v1' AND database_name = current_database()
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  ) THEN
    RAISE EXCEPTION 'Cake QA registry identity mismatch';
  END IF;
END;
$guard$;

CREATE FUNCTION cake_qa_registry.reserve(input jsonb, digest text) RETURNS jsonb LANGUAGE plpgsql AS $reserve$
DECLARE
  receipt cake_qa_registry.requests%ROWTYPE;
  selected cake_qa_registry.slots%ROWTYPE;
  result jsonb;
BEGIN
  PERFORM cake_qa_registry.assert_identity();
  PERFORM pg_advisory_xact_lock(hashtext('cake:qa-registry:v1'));
  SELECT * INTO receipt FROM cake_qa_registry.requests WHERE request_id = (input->>'requestId')::uuid;
  IF FOUND THEN
    IF receipt.fingerprint <> digest THEN RAISE EXCEPTION 'Cake QA request identity mismatch'; END IF;
    RETURN receipt.result;
  END IF;
  IF input->>'repository' <> 'tyask/Cake' OR input->>'base' <> 'main' THEN
    RAISE EXCEPTION 'Cake QA repository mismatch';
  END IF;
  SELECT * INTO selected FROM cake_qa_registry.slots WHERE state <> 'free' AND pr = (input->>'pr')::bigint;
  IF FOUND THEN
    IF selected.branch <> input->>'branch' THEN RAISE EXCEPTION 'Cake QA PR branch mismatch'; END IF;
    result := selected.record;
  ELSE
    IF EXISTS (SELECT 1 FROM cake_qa_registry.leases WHERE lease_id = (input->>'leaseId')::uuid) THEN
      RAISE EXCEPTION 'Cake QA retired lease cannot be reused';
    END IF;
    SELECT * INTO selected FROM cake_qa_registry.slots
    WHERE state = 'free' AND (input->>'slot' IS NULL OR slot = input->>'slot') ORDER BY slot LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      result := jsonb_build_object('protocol','cake-qa-registry/v1','slot',selected.slot,
        'leaseId',input->>'leaseId','pr',(input->>'pr')::bigint,'branch',input->>'branch',
        'headSha',input->>'headSha','state','reserved','version',selected.version + 1,
        'requestId',input->>'requestId','createdAt',input->>'now','updatedAt',input->>'now',
        'deployments','[]'::jsonb,'retiredDatabases',COALESCE((
          SELECT jsonb_agg(identity ORDER BY identity::text) FROM (
            SELECT DISTINCT record->'database' AS identity FROM cake_qa_registry.history
            WHERE record->>'state' = 'free' AND record ? 'database'
          ) retired
        ),'[]'::jsonb));
      INSERT INTO cake_qa_registry.leases (lease_id,slot,pr,branch,created_at)
        VALUES ((input->>'leaseId')::uuid,selected.slot,(input->>'pr')::bigint,input->>'branch',(input->>'now')::timestamptz);
      UPDATE cake_qa_registry.slots SET state = 'reserved', version = selected.version + 1,
        lease_id = (input->>'leaseId')::uuid, pr = (input->>'pr')::bigint, branch = input->>'branch', record = result
        WHERE slot = selected.slot AND version = selected.version AND state = 'free';
      IF NOT FOUND THEN RAISE EXCEPTION 'Cake QA reservation conflict'; END IF;
      INSERT INTO cake_qa_registry.history VALUES ((input->>'leaseId')::uuid,selected.version + 1,result);
    END IF;
  END IF;
  INSERT INTO cake_qa_registry.requests (request_id,fingerprint,result) VALUES ((input->>'requestId')::uuid,digest,result);
  RETURN result;
END;
$reserve$;

CREATE FUNCTION cake_qa_registry.write_snapshot(requested_slot text, expected_lease uuid, expected_version bigint,
  next_record jsonb, digest text) RETURNS jsonb LANGUAGE plpgsql AS $write$
DECLARE
  receipt cake_qa_registry.requests%ROWTYPE;
  previous cake_qa_registry.slots%ROWTYPE;
  resource record;
  existing_owner uuid;
BEGIN
  PERFORM cake_qa_registry.assert_identity();
  PERFORM pg_advisory_xact_lock(hashtext('cake:qa-registry:v1'));
  SELECT * INTO receipt FROM cake_qa_registry.requests WHERE request_id = (next_record->>'requestId')::uuid;
  IF FOUND THEN
    IF receipt.fingerprint <> digest THEN RAISE EXCEPTION 'Cake QA request identity mismatch'; END IF;
    RETURN receipt.result;
  END IF;
  SELECT * INTO previous FROM cake_qa_registry.slots WHERE slot = requested_slot FOR UPDATE;
  IF NOT FOUND OR previous.lease_id <> expected_lease OR previous.version <> expected_version
    OR previous.state = 'free' THEN RAISE EXCEPTION 'Cake QA stale lease or version'; END IF;
  IF next_record->>'slot' <> requested_slot OR (next_record->>'leaseId')::uuid <> expected_lease
    OR (next_record->>'version')::bigint <> expected_version + 1
    OR next_record->>'pr' <> previous.record->>'pr' OR next_record->>'branch' <> previous.branch
    OR next_record->>'createdAt' <> previous.record->>'createdAt'
    OR (previous.state = 'deleting' AND next_record->>'state' NOT IN ('deleting','free'))
    OR (previous.state <> 'deleting' AND next_record->>'state' = 'free') THEN
    RAISE EXCEPTION 'Cake QA invalid snapshot transition';
  END IF;
  IF (previous.record ? 'database' AND (previous.record->'database') IS DISTINCT FROM (next_record->'database'))
    OR NOT ((next_record->'deployments') @> (previous.record->'deployments'))
    OR NOT ((next_record->'retiredDatabases') @> (previous.record->'retiredDatabases')) THEN
    RAISE EXCEPTION 'Cake QA resource history cannot be removed';
  END IF;
  IF next_record->>'state' = 'free' AND next_record ? 'database'
    AND NOT ((next_record->'retiredDatabases') @> jsonb_build_array(next_record->'database')) THEN
    RAISE EXCEPTION 'Cake QA retired database identity is missing';
  END IF;
  FOR resource IN
    SELECT 'deployment' AS kind, d->>'id' AS id FROM jsonb_array_elements(next_record->'deployments') d
    UNION ALL SELECT 'database-branch', next_record->'database'->>'branchId' WHERE next_record ? 'database'
    UNION ALL SELECT 'database-endpoint', next_record->'database'->>'endpointId' WHERE next_record ? 'database'
    UNION ALL SELECT 'database-host', next_record->'database'->>'host' WHERE next_record ? 'database'
  LOOP
    SELECT lease_id INTO existing_owner FROM cake_qa_registry.resource_owners WHERE kind = resource.kind AND resource_id = resource.id;
    IF FOUND AND existing_owner <> expected_lease THEN RAISE EXCEPTION 'Cake QA resource belongs to another lease'; END IF;
    INSERT INTO cake_qa_registry.resource_owners VALUES (resource.kind,resource.id,expected_lease) ON CONFLICT DO NOTHING;
  END LOOP;
  UPDATE cake_qa_registry.slots SET version = expected_version + 1, state = next_record->>'state', record = next_record
    WHERE slot = requested_slot AND lease_id = expected_lease AND version = expected_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cake QA snapshot conflict'; END IF;
  INSERT INTO cake_qa_registry.history VALUES (expected_lease,expected_version + 1,next_record);
  INSERT INTO cake_qa_registry.requests (request_id,fingerprint,result) VALUES ((next_record->>'requestId')::uuid,digest,next_record);
  RETURN next_record;
END;
$write$;

-- Prevent accidentally inheriting public access if database roles are added.
REVOKE ALL ON SCHEMA cake_qa_registry FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA cake_qa_registry FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cake_qa_registry FROM PUBLIC;
COMMIT;
