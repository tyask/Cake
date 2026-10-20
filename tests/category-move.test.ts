import assert from "node:assert/strict";
import test from "node:test";
import { prepareCategoryMove } from "../lib/category-move";
import type { Category } from "../lib/types";

const category = (id: string, parentId: string | null = null, sortOrder = 0, extra: Partial<Category> = {}): Category => ({
  id, parentId, sortOrder, name: id, revision: 1, colorHex: "#f97316", archivedAt: null, ...extra,
});

test("移動先を前・子・後と最上位で解決し、使用停止済みを基準IDにしない", () => {
  const rows = [category("a"), category("archived", null, 1, { archivedAt: "2026-10-20T00:00:00Z" }), category("c", null, 2), category("source", "a")];
  const move = prepareCategoryMove(rows, "source");
  const before = move.destination({ categoryId: "a", position: "before" });
  assert.deepEqual([before.parentId, before.beforeCategoryId, before.error], [null, "a", null]);
  const after = move.destination({ categoryId: "a", position: "after" });
  assert.deepEqual([after.parentId, after.beforeCategoryId, after.error], [null, "c", null]);
  const inside = move.destination({ categoryId: "c", position: "inside" });
  assert.deepEqual([inside.parentId, inside.beforeCategoryId, inside.error], ["c", null, null]);
  const root = move.destination({ categoryId: null, position: "inside" });
  assert.deepEqual([root.parentId, root.beforeCategoryId, root.error], [null, null, null]);
  assert.equal(prepareCategoryMove(rows, "a").destination({ categoryId: "c", position: "before" }).unchanged, true);
});

test("自分・子孫・停止済み・同階層同名を拒否し、深い階層を反復走査する", () => {
  const rows = [category("root"), category("source", "root"), category("other"), category("duplicate", "other", 0, { name: "source" }), category("archived", null, 2, { archivedAt: "2026-10-20T00:00:00Z" })];
  for (let index = 0; index < 3000; index++) rows.push(category(`deep-${index}`, index ? `deep-${index - 1}` : "source"));
  const move = prepareCategoryMove(rows, "source");
  assert.match(move.destination({ categoryId: "source", position: "before" }).error!, /自分自身/);
  assert.match(move.destination({ categoryId: "deep-2999", position: "inside" }).error!, /子孫/);
  assert.match(move.destination({ categoryId: "deep-2999", position: "after" }).error!, /子孫/);
  assert.match(move.destination({ categoryId: "archived", position: "inside" }).error!, /使用停止/);
  assert.match(move.destination({ categoryId: "missing", position: "inside" }).error!, /削除/);
  assert.match(move.destination({ categoryId: "other", position: "inside" }).error!, /同じ名前/);
  assert.equal(move.destination({ categoryId: "root", position: "after" }).error, null);
  assert.match(prepareCategoryMove(rows, "archived").destination({ categoryId: null, position: "inside" }).error!, /使用停止/);
});

test("同じ親で隣接する移動は通信不要と判定し、移動元自身を基準にしない", () => {
  const rows = [category("a"), category("b", null, 1), category("c", null, 2)];
  const move = prepareCategoryMove(rows, "b");
  const afterPrevious = move.destination({ categoryId: "a", position: "after" });
  assert.equal(afterPrevious.beforeCategoryId, "c");
  assert.equal(afterPrevious.unchanged, true);
  assert.equal(move.destination({ categoryId: "c", position: "before" }).unchanged, true);
  assert.equal(move.destination({ categoryId: "c", position: "after" }).unchanged, false);
  assert.equal(prepareCategoryMove(rows, "c").destination({ categoryId: null, position: "inside" }).unchanged, true);
});
