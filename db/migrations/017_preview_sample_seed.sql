-- Preview ownership metadata is created by the guarded setup before migrations.
-- Production and ordinary local databases do not have this table.
DO $cake_preview_sample_seed$
BEGIN
  IF to_regclass('public.cake_preview_database_identity') IS NOT NULL THEN
    ALTER TABLE public.cake_preview_database_identity ADD COLUMN samples_seeded_at timestamptz;
  END IF;
END;
$cake_preview_sample_seed$;
