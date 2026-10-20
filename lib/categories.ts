import type { Category } from "./types";

export const CATEGORY_NAME_MAX_LENGTH = 40;
export const CATEGORY_PALETTE = [
  { id: "orange", label: "オレンジ", shades: ["#fdba74", "#fb923c", "#f97316", "#ea580c", "#c2410c"] },
  { id: "blue", label: "青", shades: ["#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8"] },
  { id: "green", label: "緑", shades: ["#86efac", "#4ade80", "#22c55e", "#16a34a", "#15803d"] },
  { id: "purple", label: "紫", shades: ["#d8b4fe", "#c084fc", "#a855f7", "#9333ea", "#7e22ce"] },
  { id: "teal", label: "青緑", shades: ["#5eead4", "#2dd4bf", "#14b8a6", "#0d9488", "#0f766e"] },
  { id: "pink", label: "桃", shades: ["#f9a8d4", "#f472b6", "#ec4899", "#db2777", "#be185d"] },
  { id: "amber", label: "黄", shades: ["#fcd34d", "#fbbf24", "#f59e0b", "#d97706", "#b45309"] },
  { id: "red", label: "赤", shades: ["#fca5a5", "#f87171", "#ef4444", "#dc2626", "#b91c1c"] },
  { id: "indigo", label: "藍", shades: ["#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#4338ca"] },
] as const;

export function categoryPath(categories: readonly Category[], id: string | null): Category[] {
  const byId = new Map(categories.map(category => [category.id, category]));
  const path: Category[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const category = byId.get(id);
    if (!category) break;
    path.push(category);
    id = category.parentId;
  }
  return path.reverse();
}

export function flattenCategories(categories: readonly Category[]): { category: Category; depth: number; path: string }[] {
  const children = new Map<string | null, Category[]>();
  for (const category of categories) {
    const siblings = children.get(category.parentId) ?? [];
    siblings.push(category);
    children.set(category.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const stack = (children.get(null) ?? []).slice().reverse().map(category => ({ category, depth: 0, path: category.name }));
  const result: { category: Category; depth: number; path: string }[] = [];
  const seen = new Set<string>();
  while (stack.length) {
    const entry = stack.pop()!;
    if (seen.has(entry.category.id)) continue;
    seen.add(entry.category.id);
    result.push(entry);
    for (const child of (children.get(entry.category.id) ?? []).slice().reverse()) {
      stack.push({ category: child, depth: entry.depth + 1, path: `${entry.path} › ${child.name}` });
    }
  }
  return result;
}

export function suggestCategoryColor(categories: readonly Category[], parentId: string | null): string {
  const parent = categories.find(category => category.id === parentId);
  if (parent) {
    const family = CATEGORY_PALETTE.find(palette => (palette.shades as readonly string[]).includes(parent.colorHex.toLowerCase()));
    if (!family) return parent.colorHex;
    const used = new Set(categories.filter(category => category.parentId === parentId && !category.archivedAt).map(category => category.colorHex.toLowerCase()));
    return [2, 3, 1, 4, 0].map(index => family.shades[index]).find(color => !used.has(color)) ?? family.shades[2];
  }
  const roots = categories.filter(category => category.parentId === null && !category.archivedAt);
  const usage = CATEGORY_PALETTE.map(palette => roots.filter(category => (palette.shades as readonly string[]).includes(category.colorHex.toLowerCase())).length);
  return CATEGORY_PALETTE[usage.indexOf(Math.min(...usage))].shades[2];
}

/** Fixed 10% tint: category tone and readable transaction background are independent. */
export function categoryBackground(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "transparent";
  const channels = [1, 3, 5].map(start => Math.round(255 * 0.9 + parseInt(hex.slice(start, start + 2), 16) * 0.1));
  return `rgb(${channels.join(", ")})`;
}
