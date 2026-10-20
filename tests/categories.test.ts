import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_PALETTE, categoryBackground, categoryPath, flattenCategories, suggestCategoryColor } from "../lib/categories";
import { appActionInputSchema } from "../lib/app-input";
import type { Category } from "../lib/types";

const root: Category = { id: "root", revision: 1, name: "食費", parentId: null, colorHex: "#f97316", sortOrder: 0, archivedAt: null };
const child: Category = { ...root, id: "child", name: "食品", parentId: root.id };

test("親にも末端にも分類でき、使用停止済みを含む任意階層のパスと兄弟順を表示する", () => {
  const categories = [root, child];
  for (let i = 0; i < 8; i++) categories.push({ ...child, id: `deep-${i}`, name: `${i}`, parentId: categories.at(-1)!.id });
  categories[2] = { ...categories[2], archivedAt: "2026-10-20T00:00:00Z" };
  const rows = flattenCategories(categories.slice().reverse());
  assert.equal(rows.length, 10);
  assert.equal(rows.at(-1)!.depth, 9);
  assert.equal(rows[1].path, "食費 › 食品");
  assert.equal(categoryPath(categories, "deep-7")[0].id, root.id);
  assert.equal(categoryPath(categories, root.id).length, 1);
  assert.deepEqual(categoryPath(categories, null), []);
});

test("新規カテゴリは色の重複を抑え、子では親の系統、自由色では親の色を初期候補にする", () => {
  const nextRoot = suggestCategoryColor([root], null);
  assert.notEqual(nextRoot, root.colorHex);
  const nextChild = suggestCategoryColor([root, child], root.id);
  assert.ok((CATEGORY_PALETTE[0].shades as readonly string[]).includes(nextChild));
  assert.notEqual(nextChild, child.colorHex);
  assert.equal(suggestCategoryColor([{ ...root, colorHex: "#123456" }], root.id), "#123456");
  assert.equal(root.colorHex, "#f97316");
  assert.match(categoryBackground("#000000"), /^rgb\(23[0-9], 23[0-9], 23[0-9]\)$/);
});

test("カテゴリ入力を共通schemaで検証し、名前を整形し、専用操作以外で既存カテゴリを更新しない", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const input = { action: "createCategory", workspaceId, parentId: null, name: " 食費 ", colorHex: "#ABCDEF" };
  assert.deepEqual(appActionInputSchema.parse(input), { ...input, name: "食費", colorHex: "#abcdef" });
  for (const change of [{ name: " " }, { name: "名".repeat(41) }, { colorHex: "red" }, { colorHex: "#123" }]) {
    assert.equal(appActionInputSchema.safeParse({ ...input, ...change }).success, false);
  }
  const save = { action: "saveTransaction", workspaceId, occurredAt: "2026-10-20T00:00:00Z", merchant: "店",
    method: "現金", type: "PAYMENT", amountYen: 100, actorUserId: "a", categoryId: null };
  assert.equal(appActionInputSchema.safeParse(save).success, true);
  assert.equal(appActionInputSchema.safeParse({ ...save, transactionId: workspaceId }).success, false);
});
