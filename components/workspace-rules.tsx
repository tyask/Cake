"use client";

import { useId, useState, type FormEvent } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { defaultSplitWeights, validateSplitWeights } from "@/lib/expense-splits";
import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceData, WorkspaceMember } from "@/lib/types";
import { SplitEditor } from "./split-editor";
import styles from "./workspace-rules.module.css";

type RunAction = (payload: Record<string, unknown>, success: string) => Promise<unknown>;
type RuleValues = Pick<DefaultRule, "merchantContains" | "expenseClass" | "splitWeights" | "enabled">;

export function WorkspaceRules({ selected, run }: { selected: WorkspaceData; run: RunAction }) {
  return <RulesEditor key={selected.workspace.id} selected={selected} run={run} />;
}

function RulesEditor({ selected, run }: { selected: WorkspaceData; run: RunAction }) {
  const dragContextId = useId();
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedRules = orderOverride
    ? [
        ...orderOverride.map((id) => selected.rules.find((rule) => rule.id === id)).filter((rule): rule is DefaultRule => Boolean(rule)),
        ...selected.rules.filter((rule) => !orderOverride.includes(rule.id)),
      ]
    : selected.rules;
  const orderedIds = orderedRules.map((rule) => rule.id);

  async function mutate(payload: Record<string, unknown>, message: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await run({ ...payload, workspaceId: selected.workspace.id }, message);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ルールの保存に失敗しました。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function reorder(nextIds: string[]) {
    if (busy || nextIds.every((id, index) => id === orderedIds[index])) return;
    const previousOrder = orderOverride;
    setOrderOverride(nextIds);
    const saved = await mutate({ action: "reorderRules", ruleIds: nextIds }, "ルールの順番を変更しました。");
    setOrderOverride(saved ? null : previousOrder);
  }

  function dragEnded({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || busy) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    void reorder(arrayMove(orderedIds, oldIndex, newIndex));
  }

  async function saveRule(ruleId: string, values: RuleValues) {
    const saved = await mutate({ action: "updateRule", ruleId, ...values }, "ルールを更新しました。");
    if (saved) setEditingId(null);
    return saved;
  }

  return (
    <section className={`panel settings-section ${styles.section}`} aria-busy={busy}>
      <div className="panel-head"><div><span>WORKSPACE RULES</span><h2>費用区分のデフォルトルール</h2></div></div>
      <p className={styles.description}>このワークスペースの参加者で共有する設定です。上から順に確認し、取引先の文字が一致する最初の有効なルールを明細に適用します。</p>
      <p className={styles.description}>左のハンドルをドラッグして順番を変更できます。キーボードではハンドルでスペースキーを押し、上下キーで移動して、再びスペースキーで確定します。</p>
      {error && <p role="alert" className={`form-error ${styles.error}`}>{error}</p>}

      <div className={styles.create}>
        <h3>ルールを追加</h3>
        <RuleForm members={selected.members} busy={busy}
          onSave={(values) => mutate({ action: "createRule", ...values }, "ルールを追加しました。")} />
      </div>

      <DndContext id={dragContextId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnded}
        accessibility={{
          screenReaderInstructions: { draggable: "スペースキーでルールを持ち上げます。上下キーで移動し、スペースキーで確定します。エスケープキーでキャンセルします。" },
          announcements: {
            onDragStart: ({ active }) => `${orderedRules.find((rule) => rule.id === active.id)?.merchantContains ?? "ルール"}の順番を変更します。`,
            onDragOver: ({ over }) => over ? `${orderedIds.indexOf(String(over.id)) + 1}番目へ移動します。` : "ルールの範囲外です。",
            onDragEnd: ({ over }) => over ? `${orderedIds.indexOf(String(over.id)) + 1}番目で確定しました。` : "順番の変更をキャンセルしました。",
            onDragCancel: () => "順番の変更をキャンセルしました。",
          },
        }}>
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          <ol className={styles.list} aria-label="適用順のルール">
            {orderedRules.map((rule, index) => (
              <SortableRule key={rule.id} rule={rule} position={index + 1} count={orderedRules.length}
                members={selected.members} busy={busy} editing={editingId === rule.id}
                onEdit={() => { setEditingId(rule.id); setError(null); }} onCancel={() => setEditingId(null)}
                onSave={(values) => saveRule(rule.id, values)}
                onToggle={(enabled) => { void saveRule(rule.id, { merchantContains: rule.merchantContains, expenseClass: rule.expenseClass, splitWeights: rule.expenseClass === "PERSONAL" ? null : rule.splitWeights, enabled }); }}
                onDelete={() => {
                  if (!confirm(`「${rule.merchantContains}」のルールを削除しますか？`)) return;
                  void mutate({ action: "deleteRule", ruleId: rule.id }, "ルールを削除しました。").then((saved) => { if (saved && editingId === rule.id) setEditingId(null); });
                }}
                onMove={(offset) => { void reorder(arrayMove(orderedIds, index, index + offset)); }} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {orderedRules.length === 0 && <p className={styles.empty}>デフォルトルールはまだありません。</p>}
      <p className={styles.footnote}>新しいルールは一番下に追加します。ルールの変更は、保存済みの明細の割合には影響しません。</p>
    </section>
  );
}

function SortableRule({ rule, position, count, members, busy, editing, onEdit, onCancel, onSave, onToggle, onDelete, onMove }: {
  rule: DefaultRule;
  position: number;
  count: number;
  members: WorkspaceMember[];
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (values: RuleValues) => Promise<boolean>;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onMove: (offset: number) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id, disabled: busy });
  const weights = rule.splitWeights ?? defaultSplitWeights(members);
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${styles.rule}${isDragging ? ` ${styles.dragging}` : ""}`}>
      <div className={styles.ruleHead}>
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} disabled={busy}
          className={styles.dragHandle} aria-label={`「${rule.merchantContains}」の順番を変更`} title="ドラッグして順番を変更">⠿</button>
        <span className={styles.position} aria-label={`${position}番目`}>{position}</span>
        <div className={styles.summary}>
          <b>「{rule.merchantContains}」を含む</b>
          <span className={`class-tag ${rule.expenseClass.toLowerCase()}`}>{rule.expenseClass === "SHARED" ? "共有費" : "個人費"}</span>
          <small>{rule.expenseClass === "PERSONAL" ? "支払者・受取者 1 : 相手 0" : `${rule.splitWeights === null ? "デフォルト · " : "指定割合 · "}${members.map((member) => `${member.name} ${weights[member.id] ?? 0}`).join(" : ")}`}</small>
        </div>
        <label className={styles.enabled}><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(event) => onToggle(event.target.checked)} aria-label={`「${rule.merchantContains}」のルールを有効にする`} />有効</label>
      </div>
      <div className={styles.rowActions}>
        <div className={styles.moveButtons}>
          <button type="button" disabled={busy || position === 1} onClick={() => onMove(-1)} aria-label={`「${rule.merchantContains}」を上へ移動`}>↑ 上へ</button>
          <button type="button" disabled={busy || position === count} onClick={() => onMove(1)} aria-label={`「${rule.merchantContains}」を下へ移動`}>↓ 下へ</button>
        </div>
        <button type="button" className="text-button" disabled={busy || editing} onClick={onEdit}>編集</button>
        <button type="button" className="danger-text" disabled={busy} onClick={onDelete}>削除</button>
      </div>
      {editing && <div className={styles.editForm}><h3>「{rule.merchantContains}」のルールを編集</h3><RuleForm key={rule.id} rule={rule} members={members} busy={busy} onSave={onSave} onCancel={onCancel} /></div>}
    </li>
  );
}

function RuleForm({ rule, members, busy, onSave, onCancel }: {
  rule?: DefaultRule;
  members: WorkspaceMember[];
  busy: boolean;
  onSave: (values: RuleValues) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const formId = useId();
  const [merchantContains, setMerchantContains] = useState(rule?.merchantContains ?? "");
  const [expenseClass, setExpenseClass] = useState<ExpenseClass>(rule?.expenseClass ?? "SHARED");
  const [useDefaults, setUseDefaults] = useState(rule?.splitWeights == null);
  const [weights, setWeights] = useState<SplitWeights>(rule?.splitWeights ?? defaultSplitWeights(members));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const defaultWeights = defaultSplitWeights(members);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const merchant = merchantContains.trim();
      if (!merchant) throw new Error("取引先に含まれる文字を入力してください。");
      const splitWeights = expenseClass === "SHARED" && !useDefaults ? validateSplitWeights(weights, members) : null;
      const saved = await onSave({ merchantContains: merchant, expenseClass, splitWeights, enabled });
      if (saved && !rule) {
        setMerchantContains("");
        setExpenseClass("SHARED");
        setUseDefaults(true);
        setWeights(defaultWeights);
        setEnabled(true);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ルールの入力を確認してください。");
    }
  }

  return (
    <form onSubmit={submit} className={styles.form}>
      <div className={styles.formFields}>
        <label htmlFor={`${formId}-merchant`}>取引先に含まれる文字<input id={`${formId}-merchant`} required maxLength={120} value={merchantContains} disabled={busy} onChange={(event) => setMerchantContains(event.target.value)} placeholder="例: ヨークフーズ" /></label>
        <label htmlFor={`${formId}-class`}>費用区分<select id={`${formId}-class`} value={expenseClass} disabled={busy} onChange={(event) => setExpenseClass(event.target.value as ExpenseClass)}><option value="PERSONAL">個人費</option><option value="SHARED">共有費</option></select></label>
      </div>
      {expenseClass === "SHARED" ? (
        <div className={styles.splitOptions}>
          <label className={styles.checkbox}><input type="checkbox" checked={useDefaults} disabled={busy} onChange={(event) => { setUseDefaults(event.target.checked); if (!event.target.checked) setWeights(defaultWeights); }} />共有費のデフォルト割合を使う</label>
          <SplitEditor members={members} value={useDefaults ? defaultWeights : weights} onChange={useDefaults ? undefined : setWeights} disabled={busy || useDefaults} label={useDefaults ? "共有費のデフォルト割合" : "このルールの割合"} compact />
        </div>
      ) : <p className={styles.personalNote}>個人費は、明細の支払者・受取者が1、相手が0になります。</p>}
      <label className={styles.checkbox}><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />このルールを有効にする</label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className={styles.formActions}>
        {onCancel && <button type="button" className="secondary" disabled={busy} onClick={onCancel}>キャンセル</button>}
        <button type="submit" className={rule ? "secondary" : "primary"} disabled={busy}>{rule ? "変更を保存" : "ルールを追加"}</button>
      </div>
    </form>
  );
}
