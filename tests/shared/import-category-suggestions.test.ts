import assert from "node:assert/strict";
import test from "node:test";
import { importCategorySuggestionsSchema, MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS } from "../../lib/shared/import-category-suggestions";
import { MAX_MERCHANT_LENGTH } from "../../lib/shared/domain-values";

const workspaceId = "00000000-0000-4000-8000-000000000001";

test("カテゴリ補完の入力は共通取引先制約を適用し、応答照合用の表記を保持する", () => {
  const merchants = ["  ＳＨＯＰ　Ａ  ", "店".repeat(MAX_MERCHANT_LENGTH)];
  assert.deepEqual(importCategorySuggestionsSchema.parse({ workspaceId, merchants }), { workspaceId, merchants });
  for (const merchant of ["", " \t　", "店".repeat(MAX_MERCHANT_LENGTH + 1), null, 123]) {
    assert.equal(importCategorySuggestionsSchema.safeParse({ workspaceId, merchants: [merchant] }).success, false);
  }
});

test("カテゴリ補完は最大2000取引先を受け入れ、空配列・上限超過・不正workspaceを拒否する", () => {
  assert.equal(MAX_IMPORT_CATEGORY_SUGGESTION_MERCHANTS, 2000);
  assert.equal(importCategorySuggestionsSchema.safeParse({ workspaceId, merchants: Array(2000).fill("店") }).success, true);
  for (const input of [{ workspaceId, merchants: [] }, { workspaceId, merchants: Array(2001).fill("店") },
    { workspaceId: "invalid", merchants: ["店"] }, { merchants: ["店"] }, { workspaceId, merchants: "店" }]) {
    assert.equal(importCategorySuggestionsSchema.safeParse(input).success, false);
  }
});
