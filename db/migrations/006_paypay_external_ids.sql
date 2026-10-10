-- Keep the UUID primary key and all references unchanged. The original PayPay
-- transaction number is namespaced by its transaction time in Japan.
-- Leave canonical IDs untouched so rerunning this SQL never adds a second prefix.
-- A collision with an existing key fails the entire migration through the
-- existing UNIQUE (workspace_id, external_id) constraint; no rows are discarded.
-- Hold off writes through the backfill and trigger creation, so an old server
-- cannot insert another raw key between those operations during a rollout.
LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE;

UPDATE transactions
SET external_id = 'PayPay_'
  || to_char(occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYYMMDDHH24MISS')
  || '_' || external_id
WHERE source = 'PAYPAY'
  AND external_id !~ '^PayPay_[0-9]{14}_.+$';

-- Preview rollout can leave an older server sending raw transaction numbers.
-- Normalize inserts at the DB boundary; later date edits must preserve the key.
CREATE OR REPLACE FUNCTION cake_normalize_paypay_external_id()
RETURNS trigger AS $cake_normalize_paypay_external_id$
BEGIN
  IF NEW.source = 'PAYPAY' AND NEW.external_id !~ '^PayPay_[0-9]{14}_.+$' THEN
    NEW.external_id := 'PayPay_'
      || to_char(NEW.occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYYMMDDHH24MISS')
      || '_' || NEW.external_id;
  END IF;
  RETURN NEW;
END;
$cake_normalize_paypay_external_id$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS normalize_paypay_external_id_trigger ON transactions;
CREATE TRIGGER normalize_paypay_external_id_trigger
BEFORE INSERT ON transactions
FOR EACH ROW EXECUTE FUNCTION cake_normalize_paypay_external_id();

-- ON CONFLICT holds the existing row lock while calling this function. Matching
-- duplicates return false, so the conflicting row is neither updated nor
-- returned. A reused key with different details aborts the entire import.
CREATE OR REPLACE FUNCTION cake_assert_paypay_duplicate(
  existing_source text,
  existing_merchant text,
  existing_amount_yen integer,
  incoming_merchant text,
  incoming_amount_yen integer
)
RETURNS boolean AS $cake_assert_paypay_duplicate$
BEGIN
  IF existing_source IS DISTINCT FROM 'PAYPAY'
    OR existing_merchant IS DISTINCT FROM incoming_merchant
    OR existing_amount_yen IS DISTINCT FROM incoming_amount_yen THEN
    RAISE EXCEPTION '同じ取引日・取引番号に異なる金額または取引先の明細が登録されています。CSVと登録済み明細を確認してください。';
  END IF;
  RETURN false;
END;
$cake_assert_paypay_duplicate$ LANGUAGE plpgsql;
