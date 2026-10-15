-- Compatibility fence for the already initialized, dedicated Cake QA registry.
-- Apply only from the reviewed admin installer in ONE transaction, then fill
-- identity.fence_receipt before committing. A NULL receipt blocks old callers.
-- This does not stop outside-DB producers or revoke a database owner's rights.
-- Old Cloud/PC actors, queued workflows and credential sessions must be drained.
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cake:qa-registry:v1'));
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cannele_registry:control', 0));

DO $fence_identity$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'cannele_registry') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA writer already retired';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'cake_qa_registry' AND r.rolname = current_user
  ) OR (SELECT count(*) FROM cake_qa_registry.identity) <> 1 OR NOT EXISTS (
    SELECT 1 FROM cake_qa_registry.identity
    WHERE singleton AND protocol = 'cake-qa-registry/v1' AND database_name = current_database()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA fence identity mismatch';
  END IF;
END;
$fence_identity$;

ALTER TABLE cake_qa_registry.identity
  ADD COLUMN writer_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN writer_epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN fence_receipt jsonb,
  ADD CONSTRAINT qa_registry_writer_control CHECK (
    (writer_mode = 'legacy' AND writer_epoch = 1) OR
    (writer_mode = 'maintenance' AND writer_epoch BETWEEN 2 AND 9007199254740991)
  ),
  ADD CONSTRAINT qa_registry_fence_receipt CHECK (fence_receipt IS NULL OR (
    jsonb_typeof(fence_receipt) = 'object' AND
    fence_receipt ?& ARRAY['protocol','version','revision','legacyDdlSha256','fenceDdlSha256','writerEpoch'] AND
    fence_receipt - ARRAY['protocol','version','revision','legacyDdlSha256','fenceDdlSha256','writerEpoch'] = '{}'::jsonb AND
    fence_receipt->>'protocol' = 'cake-qa-registry-fence/v1' AND
    fence_receipt->'version' = '2'::jsonb AND fence_receipt->'writerEpoch' = '1'::jsonb AND
    jsonb_typeof(fence_receipt->'revision') = 'string' AND fence_receipt->>'revision' ~ '^[a-f0-9]{40}$' AND
    jsonb_typeof(fence_receipt->'legacyDdlSha256') = 'string' AND fence_receipt->>'legacyDdlSha256' ~ '^[a-f0-9]{64}$' AND
    jsonb_typeof(fence_receipt->'fenceDdlSha256') = 'string' AND fence_receipt->>'fenceDdlSha256' ~ '^[a-f0-9]{64}$'
  ) IS TRUE);

-- Keep the exact signature used by old checkouts and stored SQL call plans.
-- Take the existing exclusive lock first, then the shared Cannele control lock.
-- FOR SHARE is essential: an old REPEATABLE READ snapshot must serialize-fail
-- after a committed maintenance UPDATE, rather than authorize a stale writer.
CREATE OR REPLACE FUNCTION cake_qa_registry.assert_identity() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, cake_qa_registry AS $guard$
DECLARE c cake_qa_registry.identity%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cake:qa-registry:v1'));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('cannele_registry:control', 0));
  SELECT * INTO c FROM cake_qa_registry.identity WHERE singleton FOR SHARE;
  IF NOT FOUND OR (SELECT count(*) FROM cake_qa_registry.identity) <> 1 OR
    c.protocol IS DISTINCT FROM 'cake-qa-registry/v1' OR c.database_name IS DISTINCT FROM current_database() OR
    EXISTS (
      SELECT 1 FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' AND r.relkind IN ('r','p','v','m','f')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA registry identity mismatch';
  END IF;
  IF c.writer_mode IS DISTINCT FROM 'legacy' OR c.writer_epoch IS DISTINCT FROM 1::bigint OR
    c.fence_receipt IS NULL OR
    EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'cannele_registry') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA writer fenced';
  END IF;
END;
$guard$;

-- A statement guard runs before row locks, including on an old function frame
-- that passed the previous identity guard. It cannot block receipt-only SELECT
-- replay in such a frame; stopping/draining those actors remains a prerequisite.
CREATE FUNCTION cake_qa_registry.guard_legacy_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, cake_qa_registry AS $guard_write$
BEGIN
  PERFORM cake_qa_registry.assert_identity();
  RETURN NULL;
END;
$guard_write$;

CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.slots FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write();
CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.leases FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write();
CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.history FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write();
CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.resource_owners FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write();
CREATE TRIGGER qa_registry_writer_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.requests FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.guard_legacy_write();

-- Control updates also take the ordered locks at STATEMENT level before their
-- row locks. The ROW guard preserves the identity/receipt and closes legacy
-- mode irreversibly. This is an admin path, never a runtime bypass switch.
CREATE FUNCTION cake_qa_registry.protect_fence_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, cake_qa_registry AS $protect_control$
BEGIN
  IF TG_LEVEL = 'STATEMENT' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cake:qa-registry:v1'));
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('cannele_registry:control', 0));
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA fence identity is immutable';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'cannele_registry') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA writer already retired';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP <> 'UPDATE' OR
    ROW(NEW.singleton, NEW.protocol, NEW.database_name) IS DISTINCT FROM ROW(OLD.singleton, OLD.protocol, OLD.database_name) OR
    (OLD.fence_receipt IS NOT NULL AND NEW.fence_receipt IS DISTINCT FROM OLD.fence_receipt) OR
    NEW.writer_epoch < OLD.writer_epoch OR
    (OLD.writer_mode = 'maintenance' AND NEW.writer_mode IS DISTINCT FROM 'maintenance') OR
    (NEW.writer_mode = 'maintenance' AND NEW.fence_receipt IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Cake QA fence identity is immutable';
  END IF;
  RETURN NEW;
END;
$protect_control$;

CREATE TRIGGER qa_registry_control_lock BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
ON cake_qa_registry.identity FOR EACH STATEMENT EXECUTE FUNCTION cake_qa_registry.protect_fence_identity();
CREATE TRIGGER qa_registry_control_identity BEFORE INSERT OR UPDATE OR DELETE
ON cake_qa_registry.identity FOR EACH ROW EXECUTE FUNCTION cake_qa_registry.protect_fence_identity();

REVOKE ALL ON FUNCTION cake_qa_registry.assert_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION cake_qa_registry.guard_legacy_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION cake_qa_registry.protect_fence_identity() FROM PUBLIC;
COMMIT;
