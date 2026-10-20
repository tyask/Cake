"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type { RunAppAction } from "@/lib/app-input";
import { categoryColorSchema, categoryNameSchema } from "@/lib/category-input";
import { CATEGORY_NAME_MAX_LENGTH, CATEGORY_PALETTE, categoryBackground, categoryPath, flattenCategories, suggestCategoryColor } from "@/lib/categories";
import type { Category } from "@/lib/types";
import styles from "./category-settings.module.css";

type Editor = {
  categoryId: string | null;
  parentId: string | null;
  name: string;
  colorHex: string;
  initialName: string;
  initialColor: string;
};

type Props = { categories: Category[]; workspaceId: string; run: RunAppAction };

export function CategorySettings(props: Props) {
  return <CategorySettingsEditor key={props.workspaceId} {...props} />;
}

function CategorySettingsEditor({ categories, workspaceId, run }: Props) {
  const formId = useId();
  const pending = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepared = useMemo(() => {
    const flat = flattenCategories(categories);
    const byId = new Map(categories.map(category => [category.id, category]));
    const parents = new Set(categories.filter(category => showArchived || !category.archivedAt).map(category => category.parentId));
    let hiddenDepth: number | null = null;
    const visible: typeof flat = [];
    for (const entry of flat) {
      const { category, depth } = entry;
      if (hiddenDepth !== null && depth > hiddenDepth) continue;
      hiddenDepth = null;
      if (!showArchived && category.archivedAt) continue;
      if (collapsed.has(category.id)) hiddenDepth = depth;
      visible.push(entry);
    }
    return { visible, byId, parents };
  }, [categories, collapsed, showArchived]);
  const selected = editor?.categoryId ? prepared.byId.get(editor.categoryId) : undefined;
  const parent = editor?.parentId ? prepared.byId.get(editor.parentId) : undefined;
  const unavailable = !!editor && (editor.categoryId ? !selected || !!selected.archivedAt : !!editor.parentId && (!parent || !!parent.archivedAt));
  const dirty = !!editor && (editor.name.trim() !== editor.initialName || editor.colorHex.toLowerCase() !== editor.initialColor.toLowerCase());
  const validColor = categoryColorSchema.safeParse(editor?.colorHex);
  const previewColor = validColor.success ? validColor.data : editor?.initialColor ?? "#64748b";
  const palette = CATEGORY_PALETTE.find(group => group.shades.some(color => color.toLowerCase() === editor?.colorHex.toLowerCase()));
  const shadeIndex = palette?.shades.findIndex(color => color.toLowerCase() === editor?.colorHex.toLowerCase()) ?? 2;
  const parentPath = editor?.parentId ? categoryPath(categories, editor.parentId).map(category => category.name).join(" › ") : "";
  const editorKey = editor ? `${editor.categoryId ?? "new"}:${editor.parentId ?? "root"}` : null;
  useEffect(() => { if (editorKey) nameInput.current?.focus(); }, [editorKey]);

  function changeEditor(next: Editor | null) {
    if (pending.current) return false;
    if (dirty && !confirm("保存していない変更を破棄しますか？")) return false;
    setError(null);
    setEditor(next);
    return true;
  }

  function beginCreate(parentId: string | null) {
    if (parentId && prepared.byId.get(parentId)?.archivedAt) return;
    const colorHex = suggestCategoryColor(categories, parentId);
    const changed = changeEditor({ categoryId: null, parentId, name: "", colorHex, initialName: "", initialColor: colorHex });
    if (changed && parentId) setCollapsed(current => { const next = new Set(current); next.delete(parentId); return next; });
  }

  function beginEdit(category: Category) {
    if (editor?.categoryId === category.id) return;
    changeEditor({ categoryId: category.id, parentId: category.parentId, name: category.name, colorHex: category.colorHex, initialName: category.name, initialColor: category.colorHex });
  }

  function setColor(colorHex: string) {
    setEditor(current => current ? { ...current, colorHex } : current);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || pending.current || unavailable) return;
    setError(null);
    const name = categoryNameSchema.safeParse(editor.name);
    const color = categoryColorSchema.safeParse(editor.colorHex);
    if (!name.success) { setError(`カテゴリ名を1〜${CATEGORY_NAME_MAX_LENGTH}文字で入力してください。`); return; }
    if (!color.success) { setError("色は #RRGGBB 形式で入力してください。"); return; }
    if (categories.some(category => !category.archivedAt && category.id !== editor.categoryId && category.parentId === editor.parentId && category.name === name.data)) {
      setError("同じ階層に同じ名前のカテゴリがあります。");
      return;
    }
    if (selected && name.data === selected.name && color.data.toLowerCase() === selected.colorHex.toLowerCase()) {
      setEditor(null);
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      if (editor.categoryId) {
        await run({ action: "updateCategory", workspaceId, categoryId: editor.categoryId, name: name.data, colorHex: color.data }, "カテゴリを保存しました。");
      } else {
        await run({ action: "createCategory", workspaceId, parentId: editor.parentId, name: name.data, colorHex: color.data }, "カテゴリを追加しました。");
      }
      setEditor(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "カテゴリを保存できませんでした。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function archive() {
    if (!selected || selected.archivedAt || pending.current) return;
    const descendants = new Map<string | null, Category[]>();
    for (const category of categories) {
      const siblings = descendants.get(category.parentId) ?? [];
      siblings.push(category);
      descendants.set(category.parentId, siblings);
    }
    const stack = [selected];
    const visited = new Set<string>();
    let count = 0;
    while (stack.length) {
      const category = stack.pop()!;
      if (visited.has(category.id)) continue;
      visited.add(category.id);
      if (!category.archivedAt) count += 1;
      stack.push(...descendants.get(category.id) ?? []);
    }
    if (!confirm(`「${selected.name}」${count > 1 ? `と子カテゴリを合わせた${count}件` : ""}を使用停止にしますか？過去の明細の分類は残ります。${dirty ? "未保存の変更は破棄されます。" : ""}`)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await run({ action: "archiveCategory", workspaceId, categoryId: selected.id }, "カテゴリを使用停止にしました。");
      setEditor(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "カテゴリを使用停止にできませんでした。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <section className={`panel settings-section ${styles.section}`} aria-busy={busy}>
    <div className="panel-head"><div><span>CATEGORIES</span><h2>集計用カテゴリ</h2></div></div>
    <p className={styles.description}>明細に設定するカテゴリを管理します。「＋」で子カテゴリを追加できます。</p>
    <div className={styles.layout}>
      <div className={styles.treePanel}>
        <div className={styles.treeToolbar}>
          <button type="button" className="secondary" disabled={busy} onClick={() => beginCreate(null)}>＋ 大分類を追加</button>
          <label className={styles.archiveToggle}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />使用停止も表示</label>
        </div>
        <div className={styles.treeScroll}>
          <ul className={styles.tree} aria-label="カテゴリ一覧">
            {prepared.visible.map(({ category, depth, path }) => <li key={category.id}>
              <div className={`${styles.treeRow} ${editor?.categoryId === category.id ? styles.selected : ""} ${category.archivedAt ? styles.archived : ""}`} style={{ "--category-depth": depth } as CSSProperties}>
                {prepared.parents.has(category.id) ? <button type="button" className={styles.collapse} aria-label={`${path}を${collapsed.has(category.id) ? "展開" : "折りたたむ"}`} aria-expanded={!collapsed.has(category.id)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}>{collapsed.has(category.id) ? "▸" : "▾"}</button> : <span />}
                <button type="button" className={styles.categoryButton} disabled={busy} aria-label={`${path}を選択${category.archivedAt ? "（使用停止）" : ""}`} aria-pressed={editor?.categoryId === category.id} title={path} onClick={() => beginEdit(category)}>
                  <span className={styles.colorDot} style={{ backgroundColor: category.colorHex }} />
                  <span className={styles.categoryName}>{category.name}</span>
                  {category.archivedAt && <small>使用停止</small>}
                </button>
                {!category.archivedAt ? <button type="button" className={styles.addChild} aria-label={`${path}に子カテゴリを追加`} disabled={busy} onClick={() => beginCreate(category.id)}>＋</button> : <span />}
              </div>
            </li>)}
          </ul>
        </div>
        {prepared.visible.length === 0 && <p className={styles.empty}>カテゴリはまだありません。大分類を追加してください。</p>}
      </div>
      <div className={styles.editorPanel}>
        {editor ? <form onSubmit={event => { void save(event); }}>
          <div className={styles.editorHeading}><h3>{editor.categoryId ? "カテゴリを編集" : parentPath ? "子カテゴリを追加" : "大分類を追加"}</h3><button type="button" className="text-button" disabled={busy} onClick={() => changeEditor(null)}>閉じる</button></div>
          <p className={styles.path}>{parentPath || "最上位のカテゴリ"}</p>
          {unavailable && <p className={styles.notice}>このカテゴリ、または親カテゴリは使用停止・削除されています。編集や追加はできません。</p>}
          <fieldset className={styles.fields} disabled={busy || unavailable}>
            <label className={styles.field} htmlFor={`${formId}-name`}>カテゴリ名<input ref={nameInput} id={`${formId}-name`} value={editor.name} maxLength={CATEGORY_NAME_MAX_LENGTH} onChange={event => setEditor(current => current ? { ...current, name: event.target.value } : current)} autoComplete="off" placeholder="例：食費" required /></label>
            <fieldset className={styles.colorGroup}><legend>基本色</legend><div className={styles.palette}>
              {CATEGORY_PALETTE.map(group => <button type="button" key={group.id} className={`${styles.paletteButton} ${palette?.id === group.id ? styles.colorSelected : ""}`} aria-pressed={palette?.id === group.id} onClick={() => setColor(group.shades[Math.max(0, shadeIndex)])}>
                <span style={{ backgroundColor: group.shades[2] }} /><small>{group.label}</small>
              </button>)}
            </div></fieldset>
            {palette ? <fieldset className={styles.colorGroup}><legend>濃淡</legend><div className={styles.shades}>
              {palette.shades.map((color, index) => <button type="button" key={color} className={`${styles.shadeButton} ${editor.colorHex.toLowerCase() === color.toLowerCase() ? styles.colorSelected : ""}`} aria-label={`${palette.label}の濃淡 ${index + 1}（${index === 0 ? "最も薄い" : index === 4 ? "最も濃い" : index === 2 ? "標準" : index === 1 ? "薄い" : "濃い"}）`} aria-pressed={editor.colorHex.toLowerCase() === color.toLowerCase()} onClick={() => setColor(color)}><span style={{ backgroundColor: color }} /><small>{index + 1}</small></button>)}
            </div><p className={styles.shadeCaption}><span>薄い</span><span>濃い</span></p></fieldset> : <p className={styles.customNote}>自由指定の色です。基本色を選ぶと5段階の濃淡から選べます。</p>}
            <div className={styles.customColor}>
              <label className={styles.field} htmlFor={`${formId}-color-picker`}>自由に指定<input id={`${formId}-color-picker`} type="color" value={previewColor} onChange={event => setColor(event.target.value)} /></label>
              <label className={styles.field} htmlFor={`${formId}-hex`}>カラーコード<input id={`${formId}-hex`} value={editor.colorHex} onChange={event => setColor(event.target.value)} maxLength={7} spellCheck={false} autoComplete="off" placeholder="#f59e0b" /></label>
            </div>
          </fieldset>
          <div className={styles.preview} style={{ backgroundColor: categoryBackground(previewColor), borderInlineStartColor: previewColor }}>
            <span>明細の背景プレビュー</span><b>{[parentPath, editor.name.trim() || "カテゴリ名"].filter(Boolean).join(" › ")}</b><small>サンプルのお買い物<span>¥1,280</span></small>
          </div>
          <p className={styles.note}>保存すると明細に反映されます。色を変えても子カテゴリの色は変わりません。</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className={styles.actions}>
            {selected && !selected.archivedAt && <button type="button" className={`danger-text ${styles.archiveButton}`} disabled={busy} onClick={() => { void archive(); }}>使用停止にする</button>}
            <button type="submit" className="primary" disabled={busy || unavailable || !editor.name.trim() || (!!editor.categoryId && !dirty)}>{busy ? "保存中…" : editor.categoryId ? "変更を保存" : "カテゴリを追加"}</button>
          </div>
        </form> : <div className={styles.placeholder}><span aria-hidden="true">◈</span><h3>カテゴリと色を設定</h3><p>一覧のカテゴリを選択するか、<br />「＋」から新しいカテゴリを追加してください。</p><div className={styles.example}><span style={{ backgroundColor: CATEGORY_PALETTE[0].shades[2] }} />食費<span className={styles.exampleArrow}>›</span>外食費</div></div>}
      </div>
    </div>
    <p className={styles.footnote}>使用停止にしたカテゴリは新しく割り当てられません。過去の明細のカテゴリ名と色は残ります。</p>
  </section>;
}
