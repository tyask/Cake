import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CategorySettings } from "../../components/category-settings";
import { postAction } from "../../lib/app-client";
import type { RunAppAction } from "../../lib/app-input";
import { applyCategoryUpdate } from "../../lib/category-updates";
import type { BootstrapData, Category } from "../../lib/types";
import "../../app/globals.css";

const category = (id: string, name: string, parentId: string | null, sortOrder = 0, archivedAt: string | null = null): Category => ({
  id, name, parentId, sortOrder, archivedAt, revision: 1, colorHex: "#f97316",
});
const categories = [
  category("food", "食費", null), category("grocery", "食料品", "food"), category("fresh", "生鮮食品", "grocery"),
  category("leaf", "野菜", "fresh"), category("snacks", "お菓子", "grocery", 1), category("old-conflict", "保存前の名前", "food", 1),
  category("daily", "日用品", null, 2), category("duplicate", "食料品", "daily"), category("fun", "娯楽", null, 3),
  category("movie", "映画", "fun"), category("books", "書籍", "fun", 1), category("archived", "以前のカテゴリ", null, 1, "2026-10-20T00:00:00Z"),
];
const workspace = { id: "workspace", name: "テスト", type: "PERSONAL" as const, ownerUserId: "user", memberCount: 1 };
const initial: BootstrapData = {
  user: { id: "user", name: "テスト利用者", email: "test@example.com", imageUrl: null },
  workspaces: [workspace], pendingInvitations: [],
  selected: { workspace, members: [], rules: [], categories, transactions: [], settlement: null, settlementHistory: [] },
};

function Harness() {
  const [data, setData] = useState(initial);
  const run: RunAppAction = async payload => {
    const result = await postAction(payload);
    if ("movedCategories" in result || "category" in result || "archivedCategories" in result || "deletedCategoryIds" in result) setData(current => applyCategoryUpdate(current, "workspace", result));
    return result;
  };
  return <main style={{ padding: 12, maxWidth: 1600 }}>
    <CategorySettings categories={data.selected!.categories} workspaceId="workspace" run={run} />
    <output id="saved-categories" hidden>{JSON.stringify(data.selected!.categories)}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
