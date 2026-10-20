"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import type { RunAppAction } from "@/lib/app-input";
import { categoryColorSchema, categoryNameSchema } from "@/lib/category-input";
import { CATEGORY_NAME_MAX_LENGTH, CATEGORY_PALETTE, categoryPath, flattenCategories, suggestCategoryColor } from "@/lib/categories";
import { prepareCategoryMove, type CategoryMoveDestination, type CategoryMovePosition, type CategoryMoveTarget } from "@/lib/category-move";
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
type Move = { sourceId: string; target: CategoryMoveTarget };
const movePositions: { value: CategoryMovePosition; label: string }[] = [
  { value: "before", label: "前に並べる" }, { value: "inside", label: "子カテゴリにする（末尾）" }, { value: "after", label: "後に並べる" },
];

export function CategorySettings(props: Props) {
  return <CategorySettingsEditor key={props.workspaceId} {...props} />;
}

function CategorySettingsEditor({ categories, workspaceId, run }: Props) {
  const formId = useId();
  const pending = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const moveInput = useRef<HTMLSelectElement>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedMove, setFailedMove] = useState<Move | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<CategoryMoveTarget>({ categoryId: null, position: "inside" });
  const [dragId, setDragId] = useState<string | null>(null);
  const [hoverTarget, setHoverTarget] = useState<CategoryMoveTarget | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
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
    return { flat, visible, byId, parents };
  }, [categories, collapsed, showArchived]);
  const selected = editor?.categoryId ? prepared.byId.get(editor.categoryId) : undefined;
  // An existing draft follows its category's confirmed parent after a move.
  const editorParentId = editor?.categoryId ? selected?.parentId ?? null : editor?.parentId ?? null;
  const parent = editorParentId ? prepared.byId.get(editorParentId) : undefined;
  const unavailable = !!editor && (editor.categoryId ? !selected || !!selected.archivedAt : !!editorParentId && (!parent || !!parent.archivedAt));
  const dirty = !!editor && (editor.name.trim() !== editor.initialName || editor.colorHex.toLowerCase() !== editor.initialColor.toLowerCase());
  const validColor = categoryColorSchema.safeParse(editor?.colorHex);
  const previewColor = validColor.success ? validColor.data : editor?.initialColor ?? "#64748b";
  const palette = CATEGORY_PALETTE.find(group => group.shades.some(color => color.toLowerCase() === editor?.colorHex.toLowerCase()));
  const shadeIndex = palette?.shades.findIndex(color => color.toLowerCase() === editor?.colorHex.toLowerCase()) ?? 2;
  const parentPath = editorParentId ? categoryPath(categories, editorParentId).map(category => category.name).join(" › ") : "";
  const editorKey = editor ? `${editor.categoryId ?? "new"}:${editor.parentId ?? "root"}` : null;
  useEffect(() => { if (editorKey) nameInput.current?.focus(); }, [editorKey]);
  useEffect(() => { if (moveId) moveInput.current?.focus(); }, [moveId]);
  const moving = useMemo(() => prepareCategoryMove(categories, dragId ?? moveId), [categories, dragId, moveId]);
  const moveDestination = moving.destination(moveTarget);
  const hoveredDestination = hoverTarget ? moving.destination(hoverTarget) : null;

  function beginMove(category: Category) {
    if (pending.current || category.archivedAt) return;
    setError(null);
    setFailedMove(null);
    setMoveId(category.id);
    setMoveTarget({ categoryId: null, position: "inside" });
  }

  async function moveCategory(move: Move) {
    if (pending.current) return;
    const destination = prepareCategoryMove(categories, move.sourceId).destination(move.target);
    setError(null);
    setFailedMove(null);
    if (destination.error) { setError(destination.error); return; }
    if (destination.unchanged) return;
    pending.current = true;
    setBusy(true);
    try {
      await run({ action: "moveCategory", workspaceId, categoryId: move.sourceId, parentId: destination.parentId, beforeCategoryId: destination.beforeCategoryId }, "カテゴリを移動しました。");
      setMoveId(null);
      const ancestors = categoryPath(categories, destination.parentId).map(category => category.id);
      setCollapsed(current => { const next = new Set(current); for (const id of ancestors) next.delete(id); return next; });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "カテゴリを移動できませんでした。");
      setFailedMove(move);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function changeEditor(next: Editor | null) {
    if (pending.current) return false;
    if (dirty && !confirm("保存していない変更を破棄しますか？")) return false;
    setError(null);
    setFailedMove(null);
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
    setFailedMove(null);
    const name = categoryNameSchema.safeParse(editor.name);
    const color = categoryColorSchema.safeParse(editor.colorHex);
    if (!name.success) { setError(`カテゴリ名を1〜${CATEGORY_NAME_MAX_LENGTH}文字で入力してください。`); return; }
    if (!color.success) { setError("色は #RRGGBB 形式で入力してください。"); return; }
    if (categories.some(category => !category.archivedAt && category.id !== editor.categoryId && category.parentId === editorParentId && category.name === name.data)) {
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
        await run({ action: "createCategory", workspaceId, parentId: editorParentId, name: name.data, colorHex: color.data }, "カテゴリを追加しました。");
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
    setFailedMove(null);
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
    <p className={styles.description}>右端のハンドルをドラッグすると、前・子・後へ移動できます。ハンドルを押して移動先を選ぶ操作も使えます。入力中の名前と色は移動後も保持します。</p>
    {error && <div className={`form-error ${styles.error}`} role="alert">{error}{failedMove && <button type="button" className="text-button" disabled={busy} onClick={() => { void moveCategory(failedMove); }}>移動を再試行</button>}</div>}
    <div className={styles.layout}>
      <div className={styles.treePanel}>
        <div className={styles.treeToolbar}>
          <button type="button" className="secondary" disabled={busy} onClick={() => beginCreate(null)}>＋ 大分類を追加</button>
          <label className={styles.archiveToggle}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />使用停止も表示</label>
        </div>
        {moveId && <form className={styles.movePanel} aria-label="カテゴリを移動" onSubmit={event => { event.preventDefault(); void moveCategory({ sourceId: moveId, target: moveTarget }); }}>
          <div className={styles.moveHeading}><b>「{prepared.byId.get(moveId)?.name ?? "カテゴリ"}」を移動</b><button type="button" className="text-button" disabled={busy} onClick={() => setMoveId(null)}>キャンセル</button></div>
          <div className={styles.field}><label htmlFor={`${formId}-move-target`}>移動先のカテゴリ</label><select id={`${formId}-move-target`} ref={moveInput} value={moveTarget.categoryId ?? ""} disabled={busy} onChange={event => setMoveTarget(current => ({ ...current, categoryId: event.target.value || null }))}>
            <option value="">最上位の末尾</option>
            {prepared.flat.filter(({ category }) => !category.archivedAt && !moving.descendants.has(category.id)).map(({ category, path }) => <option key={category.id} value={category.id}>{path}</option>)}
          </select></div>
          <fieldset className={styles.movePositions} disabled={busy || !moveTarget.categoryId}><legend>移動する位置</legend>{movePositions.map(position => <label key={position.value}><input type="radio" name={`${formId}-position`} value={position.value} checked={moveTarget.position === position.value} onChange={() => setMoveTarget(current => ({ ...current, position: position.value }))} />{position.label}</label>)}</fieldset>
          <p className={styles.moveNotice} role="status">{moveDestination.error ?? (moveDestination.unchanged ? "現在と同じ位置です。" : moveDestination.label)}</p>
          <button type="submit" className="secondary" disabled={busy || !!moveDestination.error || moveDestination.unchanged}>{busy ? "保存中…" : "この位置へ移動"}</button>
        </form>}
        <DndContext id={`${formId}-category-drag`} sensors={sensors} collisionDetection={pointerWithin}
          onDragStart={({ active }) => { setDragId(String(active.id)); setHoverTarget(null); }}
          onDragOver={({ over }) => setHoverTarget(over?.data.current?.target ?? null)}
          onDragCancel={() => { setDragId(null); setHoverTarget(null); }}
          onDragEnd={({ active, over }) => {
            setDragId(null); setHoverTarget(null);
            const target = over?.data.current?.target as CategoryMoveTarget | undefined;
            if (target) void moveCategory({ sourceId: String(active.id), target });
          }}
          accessibility={{
            screenReaderInstructions: { draggable: "ドラッグで移動します。このボタンを押すと、移動先と前・子・後をキーボードで選べます。" },
            announcements: {
              onDragStart: ({ active }) => `「${prepared.byId.get(String(active.id))?.name ?? "カテゴリ"}」の移動を開始します。`,
              onDragOver: ({ over }) => {
                const target = over?.data.current?.target as CategoryMoveTarget | undefined;
                if (!target) return "移動先のカテゴリに重ねてください。";
                const destination = moving.destination(target);
                return destination.error ?? destination.label;
              },
              onDragEnd: ({ over }) => over ? "移動先を確認します。" : "カテゴリの移動をキャンセルしました。",
              onDragCancel: () => "カテゴリの移動をキャンセルしました。",
            },
          }}>
          <div className={styles.treeScroll}>
            <ul className={styles.tree} aria-label="カテゴリ一覧">
              {prepared.visible.map(({ category, depth, path }) => <CategoryTreeRow key={category.id} category={category} depth={depth} path={path} selected={editor?.categoryId === category.id}
                busy={busy} dragging={!!dragId} collapsed={collapsed.has(category.id)} hasChildren={prepared.parents.has(category.id)} destination={moving.destination}
                onCollapse={() => setCollapsed(current => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}
                onEdit={() => beginEdit(category)} onCreate={() => beginCreate(category.id)} onMove={() => beginMove(category)} />)}
            </ul>
            <CategoryDropTarget target={{ categoryId: null, position: "inside" }} destination={moving.destination({ categoryId: null, position: "inside" })} active={!!dragId && !busy} root />
          </div>
          <DragOverlay dropAnimation={null}>{dragId && <div className={styles.dragOverlay}>{prepared.byId.get(dragId)?.name}</div>}</DragOverlay>
        </DndContext>
        {dragId && <p className={styles.dragStatus} role="status">{hoveredDestination?.error ?? (hoveredDestination?.unchanged ? "現在と同じ位置です。" : hoveredDestination?.label) ?? "移動先の行の上側・中央・下側に重ねてください。"}</p>}
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
          <div className={styles.preview} style={{ borderInlineStartColor: previewColor }}>
            <span>明細の表示プレビュー</span><b>{[parentPath, editor.name.trim() || "カテゴリ名"].filter(Boolean).join(" › ")}</b><small>サンプルのお買い物<span>¥1,280</span></small>
          </div>
          <p className={styles.note}>保存すると明細に反映されます。色を変えても子カテゴリの色は変わりません。</p>
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

function CategoryTreeRow({ category, depth, path, selected, busy, dragging, collapsed, hasChildren, destination, onCollapse, onEdit, onCreate, onMove }: {
  category: Category; depth: number; path: string; selected: boolean; busy: boolean; dragging: boolean;
  collapsed: boolean; hasChildren: boolean; destination: (target: CategoryMoveTarget) => CategoryMoveDestination;
  onCollapse: () => void; onEdit: () => void; onCreate: () => void; onMove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: category.id, disabled: busy || !!category.archivedAt });
  return <li ref={setNodeRef}>
    <div data-category-id={category.id} data-category-dragging={isDragging || undefined} className={`${styles.treeRow} ${selected ? styles.selected : ""} ${category.archivedAt ? styles.archived : ""} ${isDragging ? styles.dragging : ""}`} style={{ "--category-depth": depth } as CSSProperties}>
      {hasChildren ? <button type="button" className={styles.collapse} aria-label={`${path}を${collapsed ? "展開" : "折りたたむ"}`} aria-expanded={!collapsed} onClick={onCollapse}>{collapsed ? "▸" : "▾"}</button> : <span />}
      <button type="button" className={styles.categoryButton} disabled={busy || dragging} aria-label={`${path}を選択${category.archivedAt ? "（使用停止）" : ""}`} aria-pressed={selected} title={path} onClick={onEdit}>
        <span className={styles.colorDot} style={{ backgroundColor: category.colorHex }} />
        <span className={styles.categoryName}>{category.name}</span>
        {category.archivedAt && <small>使用停止</small>}
      </button>
      {!category.archivedAt ? <button type="button" className={styles.addChild} aria-label={`${path}に子カテゴリを追加`} disabled={busy || dragging} onClick={onCreate}>＋</button> : <span />}
      <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} data-category-move-handle={category.id} className={styles.dragHandle} aria-label={`${path}を移動`} title="ドラッグで移動。押すと移動先を選べます" disabled={busy || !!category.archivedAt} onClick={onMove}>⠿</button>
      {movePositions.map(({ value }) => {
        const target = { categoryId: category.id, position: value };
        return <CategoryDropTarget key={value} target={target} destination={destination(target)} active={dragging && !busy} />;
      })}
    </div>
  </li>;
}

function CategoryDropTarget({ target, destination, active, root = false }: {
  target: CategoryMoveTarget; destination: CategoryMoveDestination; active: boolean; root?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `category-drop:${target.categoryId ?? "root"}:${target.position}`, data: { target }, disabled: !active });
  return <div ref={setNodeRef} data-category-drop-id={target.categoryId ?? "root"} data-category-drop-position={target.position} data-category-drop-over={active && isOver ? destination.error ? "invalid" : "valid" : undefined} aria-hidden="true"
    className={`${root ? styles.rootDrop : `${styles.dropTarget} ${styles[target.position]}`} ${active && isOver ? destination.error ? styles.dropInvalid : styles.dropOver : ""}`}>
    {root ? <span>最上位の末尾へ移動</span> : active && isOver && <span>{destination.error ?? destination.label}</span>}
  </div>;
}
