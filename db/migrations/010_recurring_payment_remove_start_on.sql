-- Revised 007-009 omit the start date on new installations. This migration
-- upgrades existing Preview databases where those files are already applied.
DROP TRIGGER IF EXISTS recurring_payments_immutable_start ON recurring_payments;
DROP TRIGGER IF EXISTS recurring_payments_immutable_workspace ON recurring_payments;
CREATE OR REPLACE FUNCTION cake_recurring_workspace_immutable()
RETURNS trigger AS $cake_recurring_workspace$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0400', MESSAGE = 'INPUT_INVALID';
  END IF;
  RETURN NEW;
END;
$cake_recurring_workspace$ LANGUAGE plpgsql;
CREATE TRIGGER recurring_payments_immutable_workspace BEFORE UPDATE OF workspace_id ON recurring_payments
  FOR EACH ROW EXECUTE FUNCTION cake_recurring_workspace_immutable();
DROP FUNCTION IF EXISTS cake_recurring_start_immutable();

-- PostgreSQL removes the three local checks that also reference start_on.
-- Preserve their month-boundary validation for the remaining date columns.
-- No CASCADE is needed, and existing transaction snapshots are untouched.
ALTER TABLE recurring_payments DROP COLUMN IF EXISTS start_on;
DO $cake_recurring_month_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'recurring_payments'::regclass
    AND conname = 'recurring_payments_active_from_month_month_start_check') THEN
    ALTER TABLE recurring_payments ADD CONSTRAINT recurring_payments_active_from_month_month_start_check
      CHECK (active_from_month = date_trunc('month',active_from_month)::date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'recurring_payments'::regclass
    AND conname = 'recurring_payments_pending_effective_month_month_start_check') THEN
    ALTER TABLE recurring_payments ADD CONSTRAINT recurring_payments_pending_effective_month_month_start_check
      CHECK (pending_effective_month IS NULL OR pending_effective_month = date_trunc('month',pending_effective_month)::date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'recurring_payments'::regclass
    AND conname = 'recurring_payments_last_generated_month_month_start_check') THEN
    ALTER TABLE recurring_payments ADD CONSTRAINT recurring_payments_last_generated_month_month_start_check
      CHECK (last_generated_month IS NULL OR last_generated_month = date_trunc('month',last_generated_month)::date);
  END IF;
END;
$cake_recurring_month_checks$;
