-- Check the entire payload after taking the current workspace/member locks.
CREATE OR REPLACE FUNCTION cake_assert_private_import(
  target_workspace uuid, requester text, items jsonb, category_targets jsonb
)
RETURNS void AS $cake_private_import$
BEGIN
  PERFORM cake_assert_transaction_access(target_workspace, requester);
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) AS item
    WHERE item->>'expenseClass' = 'PERSONAL' AND item->>'actorUserId' IS DISTINCT FROM requester
  ) THEN
    RAISE EXCEPTION '個人費は本人の明細だけ登録・変更できます。';
  END IF;
  PERFORM cake_assert_transaction_categories(category_targets);
END;
$cake_private_import$ LANGUAGE plpgsql;

-- Keep the workspace/external-ID uniqueness contract. Hidden conflicts always
-- abort the whole import without comparing or exposing their stored values.
CREATE OR REPLACE FUNCTION cake_assert_visible_paypay_duplicate(
  saved_class text, saved_actor text, requester text, saved_source text,
  saved_merchant text, saved_amount integer, incoming_merchant text, incoming_amount integer
)
RETURNS boolean AS $cake_private_paypay_duplicate$
BEGIN
  IF saved_class = 'PERSONAL' AND saved_actor IS DISTINCT FROM requester THEN
    RAISE EXCEPTION '明細を取り込めませんでした。入力内容を確認してください。';
  END IF;
  RETURN cake_assert_paypay_duplicate(saved_source, saved_merchant, saved_amount, incoming_merchant, incoming_amount);
END;
$cake_private_paypay_duplicate$ LANGUAGE plpgsql;
