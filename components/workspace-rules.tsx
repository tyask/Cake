"use client";

import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { defaultSplitWeights, validateSplitWeights } from "@/lib/expense-splits";
import type { DefaultRule, ExpenseClass, SplitWeights, WorkspaceData, WorkspaceMember } from "@/lib/types";
import styles from "./workspace-rules.module.css";

type RunAction = (payload: Record<string, unknown>, success: string) => Promise<unknown>;
type RuleValues = Pick<DefaultRule, "merchantContains" | "expenseClass" | "splitWeights" | "enabled">;
type SaveRule = (ruleId: string, getValues: () => RuleValues) => Promise<RuleValues>;
type StructuralAction = { payload: Record<string, unknown>; message: string };
type AcknowledgedSave = { sources: string[]; values: RuleValues };

function ruleValues(rule: DefaultRule): RuleValues {
  return { merchantContains: rule.merchantContains, expenseClass: rule.expenseClass, splitWeights: rule.splitWeights, enabled: rule.enabled };
}

function fieldEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as SplitWeights;
  const b = right as SplitWeights;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);
}

function signature(values: RuleValues): string {
  const weights = values.splitWeights === null ? null : Object.entries(values.splitWeights).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([values.merchantContains, values.expenseClass, weights, values.enabled]);
}

function validateRule(values: RuleValues, members: WorkspaceMember[]): RuleValues {
  const merchantContains = values.merchantContains.trim();
  if (!merchantContains || merchantContains.length > 120) throw new Error("取引先に含まれる文字を1〜120文字で入力してください。");
  return { ...values, merchantContains, splitWeights: values.expenseClass === "PERSONAL" || values.splitWeights === null ? null : validateSplitWeights(values.splitWeights, members) };
}

export function WorkspaceRules({ selected, run }: { selected: WorkspaceData; run: RunAction }) {
  return <RulesEditor key={selected.workspace.id} selected={selected} run={run} />;
}

function RulesEditor({ selected, run }: { selected: WorkspaceData; run: RunAction }) {
  const dragContextId = useId();
  const queue = useRef<Promise<void>>(Promise.resolve());
  const structuralLock = useRef(false);
  const [pending, setPending] = useState(0);
  const [structuralBusy, setStructuralBusy] = useState(false);
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<StructuralAction | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedRules = orderOverride
    ? [...orderOverride.map((id) => selected.rules.find((rule) => rule.id === id)).filter((rule): rule is DefaultRule => Boolean(rule)), ...selected.rules.filter((rule) => !orderOverride.includes(rule.id))]
    : selected.rules;
  const orderedIds = orderedRules.map((rule) => rule.id);
  const selectedIds = orderedIds.filter((id) => selection.includes(id));
  const allSelected = selectedIds.length > 0 && selectedIds.length === orderedIds.length;

  // Read drafts when their queued turn starts, after the previous refresh.
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    setPending((count) => count + 1);
    const result = queue.current.then(operation);
    queue.current = result.then(() => undefined, () => undefined);
    void result.then(() => setPending((count) => count - 1), () => setPending((count) => count - 1));
    return result;
  }

  async function perform(action: StructuralAction): Promise<boolean> {
    if (structuralLock.current) return false;
    structuralLock.current = true;
    setStructuralBusy(true);
    setError(null);
    setFailedAction(null);
    try {
      await enqueue(() => run({ ...action.payload, workspaceId: selected.workspace.id }, action.message));
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "ルールの保存に失敗しました。");
      setFailedAction(action);
      return false;
    } finally {
      structuralLock.current = false;
      setStructuralBusy(false);
    }
  }

  const saveRule: SaveRule = (ruleId, getValues) => enqueue(async () => {
    const values = getValues();
    await run({ action: "updateRule", workspaceId: selected.workspace.id, ruleId, ...values }, "");
    return values;
  });

  async function reorder(nextIds: string[]) {
    if (structuralLock.current || nextIds.every((id, index) => id === orderedIds[index])) return;
    const previousOrder = orderOverride;
    setOrderOverride(nextIds);
    const saved = await perform({ payload: { action: "reorderRules", ruleIds: nextIds }, message: "ルールの順番を変更しました。" });
    setOrderOverride(saved ? null : previousOrder);
  }

  function dragEnded({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || structuralLock.current) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex >= 0 && newIndex >= 0) void reorder(arrayMove(orderedIds, oldIndex, newIndex));
  }

  async function deleteSelected() {
    if (selectedIds.length === 0 || structuralLock.current) return;
    if (!confirm(`選択した${selectedIds.length}件のルールを削除しますか？`)) return;
    const ids = [...selectedIds];
    const saved = await perform({ payload: { action: "deleteRules", ruleIds: ids }, message: `${ids.length}件のルールを削除しました。` });
    if (saved) setSelection((current) => current.filter((id) => !ids.includes(id)));
  }

  return (
    <section className={`panel settings-section ${styles.section}`} aria-busy={pending > 0}>
      <div className="panel-head"><div><span>WORKSPACE RULES</span><h2>費用区分のデフォルトルール</h2></div></div>
      <p className={styles.description}>ワークスペースの共有設定です。上から最初に一致する有効なルールを適用します。文字と割合は欄を離れるかEnterで保存し、費用区分・デフォルト・有効の変更はすぐ保存します。</p>
      <p className={styles.description}>右端のハンドルをドラッグして並べ替えます。キーボードではスペースキーで開始し、上下キーで移動、スペースキーで確定します。</p>
      {error && <div className={`form-error ${styles.error}`} role="alert">{error}{failedAction && failedAction.payload.action !== "createRule" && <button type="button" className="text-button" disabled={structuralBusy} onClick={() => { void perform(failedAction); }}>再試行</button>}</div>}
      <div className={styles.create}>
        <h3>ルールを追加</h3>
        <CreateRule members={selected.members} busy={structuralBusy} onCreate={(values) => perform({ payload: { action: "createRule", ...values }, message: "ルールを追加しました。" })} />
      </div>
      <div className={styles.toolbar}>
        <label className={styles.checkbox}><input type="checkbox" aria-label="ルールをすべて選択" checked={allSelected} disabled={structuralBusy || orderedIds.length === 0}
          ref={(element) => { if (element) element.indeterminate = selectedIds.length > 0 && !allSelected; }}
          onChange={(event) => setSelection(event.target.checked ? orderedIds : [])} />全選択</label>
        <span aria-live="polite">{selectedIds.length}件選択</span>
        <button type="button" className={styles.bulkDelete} disabled={structuralBusy || selectedIds.length === 0} onClick={() => { void deleteSelected(); }}>選択したルールを削除</button>
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
            {orderedRules.map((rule) => <EditableRule key={rule.id} rule={rule} members={selected.members} structuralBusy={structuralBusy}
              selected={selectedIds.includes(rule.id)} onSelect={(checked) => setSelection((current) => checked ? [...new Set([...current, rule.id])] : current.filter((id) => id !== rule.id))} onSave={saveRule} />)}
          </ol>
        </SortableContext>
      </DndContext>
      {orderedRules.length === 0 && <p className={styles.empty}>デフォルトルールはまだありません。</p>}
      <p className={styles.footnote}>新しいルールは一番下に追加します。保存済みの明細の割合は変わりません。</p>
    </section>
  );
}

function EditableRule({ rule, members, selected, onSelect, structuralBusy, onSave }: {
  rule: DefaultRule;
  members: WorkspaceMember[];
  selected: boolean;
  onSelect: (checked: boolean) => void;
  structuralBusy: boolean;
  onSave: SaveRule;
}) {
  const [changes, setChanges] = useState<Partial<RuleValues>>({});
  const changesRef = useRef<Partial<RuleValues>>({});
  const [acknowledged, setAcknowledged] = useState<AcknowledgedSave | null>(null);
  const acknowledgedRef = useRef<AcknowledgedSave | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const incoming = ruleValues(rule);
  const incomingSignature = signature(incoming);
  // The override only bridges a delayed React commit. Once the server catches
  // up, later shared edits (including a change back to an old value) take over.
  if (acknowledged && incomingSignature === signature(acknowledged.values)) setAcknowledged(null);
  const base = acknowledged && acknowledged.sources.includes(incomingSignature) ? acknowledged.values : incoming;
  const baseRef = useRef(base);
  const sourceSignatureRef = useRef(incomingSignature);
  const draft = { ...base, ...changes };
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id, disabled: structuralBusy });

  useLayoutEffect(() => {
    baseRef.current = base;
    sourceSignatureRef.current = incomingSignature;
    acknowledgedRef.current = acknowledged;
  }, [acknowledged, base, incomingSignature]);

  function commit() {
    if (Object.keys(changesRef.current).length === 0) return;
    setPending((count) => count + 1);
    setError(null);
    let captured: Partial<RuleValues> = {};
    void onSave(rule.id, () => {
      captured = { ...changesRef.current };
      return validateRule({ ...baseRef.current, ...captured }, members);
    }).then((saved) => {
      baseRef.current = saved;
      const previous = acknowledgedRef.current;
      const sources = [...new Set([sourceSignatureRef.current, ...(previous?.sources ?? []), ...(previous ? [signature(previous.values)] : [])])];
      const next = sourceSignatureRef.current === signature(saved) ? null : { sources, values: saved };
      acknowledgedRef.current = next;
      setAcknowledged(next);
      const remaining = { ...changesRef.current };
      for (const key of Object.keys(captured) as (keyof RuleValues)[]) {
        if (fieldEqual(remaining[key], captured[key])) delete remaining[key];
      }
      changesRef.current = remaining;
      setChanges(remaining);
      setError(null);
    }).catch((failure) => {
      setError(failure instanceof Error ? failure.message : "保存できませんでした。入力内容は保持しています。");
    }).finally(() => setPending((count) => count - 1));
  }

  function change(patch: Partial<RuleValues>, saveImmediately = false) {
    changesRef.current = { ...changesRef.current, ...patch };
    setChanges(changesRef.current);
    setError(null);
    if (saveImmediately) commit();
  }

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`${styles.rule}${isDragging ? ` ${styles.dragging}` : ""}`}>
      <div className={styles.ruleLine}>
        <label className={styles.selection}><input type="checkbox" checked={selected} disabled={structuralBusy} onChange={(event) => onSelect(event.target.checked)} aria-label={`「${draft.merchantContains}」を削除対象に選択`} /></label>
        <InlineFields values={draft} members={members} disabled={structuralBusy} onChange={change} onCommit={commit}
          status={<span className={error ? styles.failed : styles.saveStatus} aria-live="polite">{pending > 0 ? "保存中…" : error ? "未保存" : Object.keys(changes).length > 0 ? "未保存" : "保存済み"}</span>} />
        <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners} disabled={structuralBusy} className={styles.dragHandle}
          aria-label={`「${draft.merchantContains}」の順番を変更`} title="ドラッグして順番を変更">⠿</button>
      </div>
      {error && <div className={`form-error ${styles.rowError}`} role="alert">{error}<button type="button" className="text-button" disabled={structuralBusy || pending > 0} onClick={commit}>再試行</button></div>}
    </li>
  );
}

function CreateRule({ members, busy, onCreate }: { members: WorkspaceMember[]; busy: boolean; onCreate: (values: RuleValues) => Promise<boolean> }) {
  const [values, setValues] = useState<RuleValues>({ merchantContains: "", expenseClass: "SHARED", splitWeights: null, enabled: true });
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    try {
      const saved = await onCreate(validateRule(values, members));
      if (saved) setValues({ merchantContains: "", expenseClass: "SHARED", splitWeights: null, enabled: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "ルールの入力を確認してください。"); }
  }
  return <form onSubmit={submit}>
    <div className={styles.createLine}>
      <InlineFields values={values} members={members} disabled={busy} onChange={(patch) => { setValues((current) => ({ ...current, ...patch })); setError(null); }} />
      <button type="submit" className={`primary ${styles.addButton}`} disabled={busy} aria-label="ルールを追加">追加</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </form>;
}

function InlineFields({ values, members, disabled, onChange, onCommit, status }: {
  values: RuleValues;
  members: WorkspaceMember[];
  disabled: boolean;
  onChange: (patch: Partial<RuleValues>, saveImmediately?: boolean) => void;
  onCommit?: () => void;
  status?: React.ReactNode;
}) {
  const id = useId();
  const defaultWeights = defaultSplitWeights(members);
  const weights = values.splitWeights ?? defaultWeights;
  function commitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (onCommit && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onCommit(); }
  }
  return <>
    <label className={styles.merchant} htmlFor={`${id}-merchant`}><span>取引先に含まれる文字</span><input id={`${id}-merchant`} required maxLength={120} value={values.merchantContains} disabled={disabled}
      onChange={(event) => onChange({ merchantContains: event.target.value })} onBlur={onCommit} onKeyDown={commitOnEnter} placeholder="例: スーパー" /></label>
    <label className={styles.expenseClass} htmlFor={`${id}-class`}><span>費用区分</span><select id={`${id}-class`} disabled={disabled} value={values.expenseClass}
      onChange={(event) => onChange({ expenseClass: event.target.value as ExpenseClass, splitWeights: null }, true)}><option value="PERSONAL">個人費</option><option value="SHARED">共有費</option></select></label>
    <div className={styles.ratios} role="group" aria-label="ルールの負担割合">
      {values.expenseClass === "PERSONAL" ? <span className={styles.personalRatio}>支払者・受取者 <b>1</b> : 相手 <b>0</b></span> : members.map((member) => <label key={member.id} htmlFor={`${id}-${member.id}`}>
        <span title={member.name}>{member.name}</span><input id={`${id}-${member.id}`} type="number" required min="0" max="2147483647" step="1" disabled={disabled || values.splitWeights === null}
          aria-label={`${member.name}の割合`} value={weights[member.id] ?? 0} onChange={(event) => onChange({ splitWeights: { ...weights, [member.id]: Number(event.target.value) } })} onBlur={onCommit} onKeyDown={commitOnEnter} />
      </label>)}
    </div>
    <div className={styles.options}>
      {values.expenseClass === "SHARED" && <label className={styles.checkbox}><input type="checkbox" checked={values.splitWeights === null} disabled={disabled} aria-label="共有費のデフォルト割合を使う"
        onChange={(event) => onChange({ splitWeights: event.target.checked ? null : defaultWeights }, true)} />デフォルト</label>}
      <label className={styles.checkbox}><input type="checkbox" checked={values.enabled} disabled={disabled} aria-label="このルールを有効にする" onChange={(event) => onChange({ enabled: event.target.checked }, true)} />有効</label>
      {status}
    </div>
  </>;
}
