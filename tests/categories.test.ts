import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORY_PALETTE, categoryPath, flattenCategories, suggestCategoryColor } from "../lib/categories";
import { appActionInputSchema } from "../lib/app-input";
import { applyCategoryUpdate } from "../lib/category-updates";
import type { BootstrapData, Category } from "../lib/types";

const root: Category = { id: "root", revision: 1, name: "食費", parentId: null, colorHex: "#f97316", sortOrder: 0, archivedAt: null };
const child: Category = { ...root, id: "child", name: "食品", parentId: root.id };

test("使用停止の全DTOは未取得の子も保持し、遅い作成・編集応答で名前・色・停止状態を戻さない", () => {
  const data = { selected: { workspace: { id: "workspace" }, categories: [root], transactions: [] } } as unknown as BootstrapData;
  const archived = { ...root, revision: 3, name: "確定名", colorHex: "#2563eb", archivedAt: "2026-10-20T00:00:00.123Z" };
  const archivedChild = { ...child, revision: 2, archivedAt: archived.archivedAt };
  let next = applyCategoryUpdate(data, "workspace", { archivedCategories: [archived, archivedChild] });
  next = applyCategoryUpdate(next, "workspace", { category: child });
  next = applyCategoryUpdate(next, "workspace", { category: { ...root, revision: 2, name: "遅い応答" } });
  assert.deepEqual(next.selected!.categories, [archived, archivedChild]);
  assert.deepEqual(data.selected!.categories, [root]);
  assert.strictEqual(applyCategoryUpdate(next, "other", { category: root }), next);
});

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

test("移動応答の全兄弟をrevisionで併合し、遅い移動・編集・使用停止応答で新しい階層や順序を戻さない", () => {
  const sibling = { ...root, id: "sibling", name: "日用品", sortOrder: 1 };
  const data = { selected: { workspace: { id: "workspace" }, categories: [root, child, sibling], transactions: [] } } as unknown as BootstrapData;
  const moved = { ...child, parentId: sibling.id, sortOrder: 1, revision: 3 };
  const reordered = { ...root, sortOrder: 1, revision: 2 };
  const unseen = { ...root, id: "unseen", sortOrder: 0, revision: 2 };
  let next = applyCategoryUpdate(data, "workspace", { movedCategories: [moved, reordered, unseen] });
  next = applyCategoryUpdate(next, "workspace", { movedCategories: [{ ...child, revision: 2 }, root] });
  next = applyCategoryUpdate(next, "workspace", { category: { ...child, revision: 3, name: "同じ版の旧値" } });
  next = applyCategoryUpdate(next, "workspace", { archivedCategories: [{ ...child, revision: 2, archivedAt: "2026-10-20T00:00:00Z" }] });
  assert.deepEqual(next.selected!.categories, [reordered, moved, sibling, unseen]);
  assert.deepEqual(data.selected!.categories, [root, child, sibling]);
  assert.strictEqual(applyCategoryUpdate(next, "other", { movedCategories: [child] }), next);
});

test("新規カテゴリは色の重複を抑え、子では親の系統、自由色では親の色を初期候補にする", () => {
  const nextRoot = suggestCategoryColor([root], null);
  assert.notEqual(nextRoot, root.colorHex);
  const nextChild = suggestCategoryColor([root, child], root.id);
  assert.ok((CATEGORY_PALETTE[0].shades as readonly string[]).includes(nextChild));
  assert.notEqual(nextChild, child.colorHex);
  assert.equal(suggestCategoryColor([{ ...root, colorHex: "#123456" }], root.id), "#123456");
  assert.equal(root.colorHex, "#f97316");
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
  const move = { action: "moveCategory", workspaceId, categoryId: workspaceId, parentId: null, beforeCategoryId: null };
  assert.deepEqual(appActionInputSchema.parse(move), move);
  for (const change of [{ parentId: "invalid" }, { beforeCategoryId: "invalid" }, { categoryId: null }, { beforeCategoryId: undefined }, { parentId: undefined }]) {
    assert.equal(appActionInputSchema.safeParse({ ...move, ...change }).success, false);
  }
});
