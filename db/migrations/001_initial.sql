CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  type text NOT NULL CHECK (type IN ('PERSONAL', 'SHARED')),
  owner_user_id text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MEMBER')),
  weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE OR REPLACE FUNCTION enforce_workspace_member_limit()
RETURNS trigger AS $$
DECLARE
  workspace_type text;
  current_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.workspace_id::text));
  SELECT type INTO workspace_type FROM workspaces WHERE id = NEW.workspace_id;
  SELECT COUNT(*) INTO current_count FROM workspace_members WHERE workspace_id = NEW.workspace_id;
  IF workspace_type = 'PERSONAL' AND current_count >= 1 THEN
    RAISE EXCEPTION '個人ワークスペースには一人だけ参加できます';
  END IF;
  IF workspace_type = 'SHARED' AND current_count >= 2 THEN
    RAISE EXCEPTION '共有ワークスペースは二人までです';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workspace_member_limit_trigger ON workspace_members;
CREATE TRIGGER workspace_member_limit_trigger
BEFORE INSERT ON workspace_members
FOR EACH ROW EXECUTE FUNCTION enforce_workspace_member_limit();

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED')),
  invited_by text NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  imported_by text NOT NULL REFERENCES app_users(id),
  file_name text NOT NULL,
  total_rows integer NOT NULL,
  imported_rows integer NOT NULL,
  skipped_rows integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  merchant text NOT NULL CHECK (char_length(merchant) BETWEEN 1 AND 240),
  method text NOT NULL CHECK (char_length(method) BETWEEN 1 AND 120),
  type text NOT NULL CHECK (type IN ('PAYMENT', 'RECEIPT')),
  amount_yen integer NOT NULL CHECK (amount_yen > 0),
  actor_user_id text NOT NULL REFERENCES app_users(id),
  expense_class text NOT NULL CHECK (expense_class IN ('PERSONAL', 'SHARED')),
  settled_at timestamptz,
  external_id text NOT NULL,
  source text NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'PAYPAY')),
  import_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  created_by text NOT NULL REFERENCES app_users(id),
  updated_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_id)
);

CREATE INDEX IF NOT EXISTS transactions_workspace_date_idx
  ON transactions (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS transactions_unsettled_idx
  ON transactions (workspace_id, expense_class, settled_at);

CREATE TABLE IF NOT EXISTS default_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  merchant_contains text NOT NULL CHECK (char_length(merchant_contains) BETWEEN 1 AND 120),
  expense_class text NOT NULL CHECK (expense_class IN ('PERSONAL', 'SHARED')),
  priority integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS default_rules_workspace_priority_idx
  ON default_rules (workspace_id, priority ASC, created_at ASC);

CREATE TABLE IF NOT EXISTS settlements (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payer_user_id text REFERENCES app_users(id),
  payee_user_id text REFERENCES app_users(id),
  amount_yen integer NOT NULL CHECK (amount_yen >= 0),
  weight_snapshot jsonb NOT NULL,
  calculation_snapshot jsonb NOT NULL,
  completed_by text NOT NULL REFERENCES app_users(id),
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlement_transactions (
  settlement_id uuid NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  PRIMARY KEY (settlement_id, transaction_id),
  UNIQUE (transaction_id)
);
