ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT false;

UPDATE app_users SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));
ALTER TABLE app_users ADD CONSTRAINT app_users_normalized_email_check
  CHECK (email = lower(btrim(email)));

-- Updating this row serializes capacity changes even for transactions using a
-- fixed snapshot, which must retry instead of observing an outdated user count.
CREATE TABLE app_user_access_guard (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO app_user_access_guard (singleton) VALUES (true);

CREATE OR REPLACE FUNCTION enforce_enabled_user_limit()
RETURNS trigger AS $$
DECLARE
  current_count integer;
  excluded_user_id text;
BEGIN
  IF NOT NEW.is_enabled OR (
    (NEW.id = 'test-user-a' AND NEW.email = 'test-a@cake.local') OR
    (NEW.id = 'test-user-b' AND NEW.email = 'test-b@cake.local')
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('cake:enabled-users'));
  UPDATE app_user_access_guard SET revision = revision + 1 WHERE singleton;
  excluded_user_id := CASE WHEN TG_OP = 'UPDATE' THEN OLD.id ELSE NEW.id END;
  SELECT COUNT(*) INTO current_count
  FROM app_users
  WHERE is_enabled
    AND id <> excluded_user_id
    AND NOT (
      (id = 'test-user-a' AND email = 'test-a@cake.local') OR
      (id = 'test-user-b' AND email = 'test-b@cake.local')
    );

  IF current_count >= 2 THEN
    RAISE EXCEPTION 'Cakeを利用できるアカウントは二人までです'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enabled_user_limit_trigger ON app_users;
CREATE TRIGGER enabled_user_limit_trigger
BEFORE INSERT OR UPDATE OF is_enabled, email, id ON app_users
FOR EACH ROW EXECUTE FUNCTION enforce_enabled_user_limit();

-- The migration runs once. Existing users keep their IDs and associated data,
-- but only the initial administrator is permitted to sign in until registered.
INSERT INTO app_users (id, email, name, is_admin, is_enabled)
VALUES (gen_random_uuid()::text, 't.yasu417@gmail.com', '管理者', true, true)
ON CONFLICT (email) DO UPDATE SET
  is_admin = true,
  is_enabled = true,
  updated_at = now();
