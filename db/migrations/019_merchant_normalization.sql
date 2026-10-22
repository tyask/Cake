-- PostgreSQL 18 / UTF8 is the normalization authority. Pin full Unicode case
-- mapping instead of inheriting a database/libc/ICU locale or a JS runtime.
DO $merchant_normalization_requirements$
BEGIN
  IF current_setting('server_version_num')::integer < 180000
    OR current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Merchant normalization requires PostgreSQL 18 or later with UTF8';
  END IF;
END;
$merchant_normalization_requirements$;

CREATE FUNCTION cake_normalize_merchant(value text)
RETURNS text AS $cake_normalize_merchant$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.lower(pg_catalog.normalize(value, 'NFKC') COLLATE pg_catalog.pg_unicode_fast),
    -- ECMAScript WhiteSpace + LineTerminator: a fixed set, not locale-sensitive
    -- POSIX space. U+0085 and U+200B stay significant; U+FEFF is whitespace.
    U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',
    ' ', 'g'
  ), ' ');
$cake_normalize_merchant$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

-- STORED computes existing rows during this atomic table rewrite, without
-- issuing business UPDATEs or changing display/audit/category fields. It also
-- covers old applications, recurring SQL, seed and direct SQL on every write.
-- NFKC can expand beyond merchant's 240-character input limit; do not truncate.
ALTER TABLE transactions ADD COLUMN merchant_normalized text COLLATE "C"
  GENERATED ALWAYS AS (cake_normalize_merchant(merchant)) STORED NOT NULL;

CREATE INDEX transactions_workspace_merchant_normalized_idx
  ON transactions (workspace_id, merchant_normalized);
