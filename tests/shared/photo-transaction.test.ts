import assert from "node:assert/strict";
import test from "node:test";
import {
  photoTransactionExtractionSchema,
  photoTransactionResponseSchema,
  type PhotoTransactionExtraction,
} from "../../lib/shared/photo-transaction";
import { MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH } from "../../lib/shared/domain-values";
import { MAX_TRANSACTION_MEMO_LENGTH } from "../../lib/shared/schemas/transaction-memo";

const unread: PhotoTransactionExtraction = { date: null, time: null, merchant: null, amountYen: null, memo: null };
const complete: PhotoTransactionExtraction = {
  date: "2026-11-17", time: "19:24", merchant: "スーパー", amountYen: 1234, memo: "牛乳・パン",
};
const categoryId = "00000000-0000-4000-8000-000000000001";

test("写真の未読取項目はnullで保持し、日付だけ・時刻だけの読取結果も受け入れる", () => {
  assert.deepEqual(photoTransactionExtractionSchema.parse(unread), unread);
  assert.deepEqual(photoTransactionExtractionSchema.parse(complete), complete);
  assert.deepEqual(photoTransactionExtractionSchema.parse({ ...unread, date: "2026-11-17" }), { ...unread, date: "2026-11-17" });
  assert.deepEqual(photoTransactionExtractionSchema.parse({ ...unread, time: "19:24" }), { ...unread, time: "19:24" });
  for (const field of Object.keys(unread)) {
    const missing: Record<string, unknown> = { ...unread };
    delete missing[field];
    assert.equal(photoTransactionExtractionSchema.safeParse(missing).success, false, `${field}の欠落は未読取のnullと区別する`);
  }
});

test("写真の日付は実在する年月日だけを受け入れ、閏年と月末を検証する", () => {
  for (const date of ["2000-02-29", "2024-02-29", "2026-02-28", "2026-04-30", "2026-12-31"]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, date }).success, true, date);
  }
  for (const date of ["1900-02-29", "2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-11-00", "0000-01-01",
    "2026-1-7", "2026/11/17", "2026-11-17T19:24", " 2026-11-17", ""]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, date }).success, false, date);
  }
});

test("写真の時刻は24時間制のHH:mmで検証し、不正時刻と秒付き形式を拒否する", () => {
  for (const time of ["00:00", "09:05", "12:34", "23:59"]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, time }).success, true, time);
  }
  for (const time of ["24:00", "23:60", "-1:30", "9:05", "09:5", "09:05:00", "09:05Z", " 09:05", ""]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, time }).success, false, time);
  }
});

test("写真の取引先は共通の240文字制約とtrimを適用し、メモの改行と空白は保持する", () => {
  const merchant = "店".repeat(MAX_MERCHANT_LENGTH);
  const memo = "  牛乳\nパン  ";
  assert.deepEqual(photoTransactionExtractionSchema.parse({ ...unread, merchant: `  ${merchant}  `, memo }), {
    ...unread, merchant, memo,
  });
  assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, memo: "記".repeat(MAX_TRANSACTION_MEMO_LENGTH) }).success, true);
  assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, memo: "" }).success, true);
  for (const merchant of ["", " \t　", "店".repeat(MAX_MERCHANT_LENGTH + 1), 123]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, merchant }).success, false);
  }
  assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, memo: "記".repeat(MAX_TRANSACTION_MEMO_LENGTH + 1) }).success, false);
});

test("写真の金額は共通上限内の正の整数円だけを受け入れ、文字列や非有限値を拒否する", () => {
  for (const amountYen of [1, MAX_AMOUNT_YEN]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, amountYen }).success, true);
  }
  for (const amountYen of [0, -1, 1.5, MAX_AMOUNT_YEN + 1, NaN, Infinity, "1234"]) {
    assert.equal(photoTransactionExtractionSchema.safeParse({ ...unread, amountYen }).success, false);
  }
});

test("写真補完応答はカテゴリUUIDまたはnullと失敗状態を要求し、未知項目を受け入れない", () => {
  for (const category of [categoryId, null]) {
    for (const categorySuggestionFailed of [false, true]) {
      const response = { ...complete, categoryId: category, categorySuggestionFailed };
      assert.deepEqual(photoTransactionResponseSchema.parse(response), response);
    }
  }
  const response = { ...complete, categoryId, categorySuggestionFailed: false };
  for (const invalid of [
    { ...response, categoryId: "food" },
    { ...response, categorySuggestionFailed: "false" },
    { ...complete, categoryId },
    { ...complete, categorySuggestionFailed: false },
    { ...response, image: "data:image/jpeg;base64,unrequested" },
  ]) {
    assert.equal(photoTransactionResponseSchema.safeParse(invalid).success, false);
  }
  assert.equal(photoTransactionExtractionSchema.safeParse({ ...complete, categoryId }).success, false);
});
