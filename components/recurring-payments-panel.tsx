"use client";

import { cashflowClass, formatTransactionAmount } from "@/lib/shared/display-formatters";

import { commonExpenseClassLabels, expenseClasses, MAX_AMOUNT_YEN, MAX_MERCHANT_LENGTH, MAX_METHOD_LENGTH } from "@/lib/shared/domain-values";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { validateSplitWeights, defaultSplitWeights, personalSplitWeights, prepareDefaultRuleMatcher } from "@/lib/shared/expense-splits";
import { splitAmounts } from "@/lib/shared/split-allocations";
import { recurringFormConfig, recurringFormDefaults, recurringFormPreview } from "@/lib/client/recurring-payment-form";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/shared/schemas/transaction-memo";
import { blockedReasonLabel, recurringPaymentStateLabel, type RecurringServiceErrorCode } from "@/lib/shared/recurring-payment-types";
import type { RecurringPaymentMutation, RecurringPaymentMutationDraft, RecurringPayment, RecurringPaymentConfig, RecurringPaymentMutationResult, RecurringPaymentsResponse } from "@/lib/shared/recurring-payment-types";
import type { ExpenseClass, WorkspaceData, WorkspaceMember } from "@/lib/shared/types";
import { SwipeDelete } from "./swipe-delete";
import { RefreshButton } from "./refresh-button";
import { SplitEditor } from "./split-editor";
import { SettingsSection } from "./settings-section";
import tableStyles from "./transactions-panel.module.css";
import styles from "./recurring-payments-panel.module.css";

const dateLabel = (date: string) => date.replaceAll("-", "/");
type StateAction = Extract<RecurringPaymentMutation, { action: "pause" | "resume" | "archive" }>["action"];
type FormState = { payment?: RecurringPayment };

class RecurringRequestError extends Error {
  constructor(message: string, public readonly code?: RecurringServiceErrorCode) { super(message); }
}

async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok) throw new RecurringRequestError(result.error ?? "処理に失敗しました。", result.code);
  return result as T;
}

export function RecurringPaymentsPanel({ selected, currentUserId }: { selected: WorkspaceData; currentUserId: string }) {
  const [data, setData] = useState<RecurringPaymentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: StateAction; payment: RecurringPayment } | null>(null);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const dataReceivedAt = useRef(0);
  const workspaceId = selected.workspace.id;
  const serverNow = data?.now;

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    try {
      const response = await fetch(`/api/recurring-payments?${new URLSearchParams({ workspaceId })}`, { cache: "no-store", signal });
      const result = await readResponse<RecurringPaymentsResponse>(response);
      if (!mounted.current || id !== requestId.current) return null;
      dataReceivedAt.current = performance.now();
      setData(result);
      setError(null);
      return result;
    } catch (failure) {
      if (!mounted.current || id !== requestId.current || signal?.aborted) return null;
      setError(failure instanceof Error ? failure.message : "定期支払いを読み込めませんでした。");
      return null;
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    // Schedule the external read; all state updates happen after the effect.
    queueMicrotask(() => { if (!controller.signal.aborted) void load(controller.signal); });
    return () => { mounted.current = false; requestId.current += 1; controller.abort(); };
  }, [load]);

  useEffect(() => {
    if (!serverNow) return;
    const now = new Date(serverNow);
    // JST 09:00 is UTC midnight. Use elapsed time after receipt so a device's
    // clock and time zone cannot move the server's daily boundary.
    const nextRun = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const delay = Math.max(0, nextRun - now.getTime() - (performance.now() - dataReceivedAt.current));
    const timer = window.setTimeout(() => { setLoading(true); void load(); }, delay);
    return () => window.clearTimeout(timer);
  }, [serverNow, load]);

  async function save(payload: RecurringPaymentMutationDraft) {
    requestId.current += 1;
    setBusy(true);
    try {
      const response = await fetch("/api/recurring-payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, workspaceId }) });
      const result = await readResponse<RecurringPaymentMutationResult>(response);
      if (mounted.current) {
        setData(current => current ? { ...current, payments: result.payment.state === "ARCHIVED"
          ? current.payments.filter(payment => payment.id !== result.payment.id)
          : [...current.payments.filter(payment => payment.id !== result.payment.id), result.payment] } : current);
        setForm(null);
        setConfirmation(null);
        // A read failure after a successful creation must not invite a duplicate retry.
        setLoading(true);
        void load();
      }
      return result;
    } finally { if (mounted.current) setBusy(false); }
  }

  async function reloadLatest(payment: RecurringPayment) {
    setLoading(true);
    const result = await load();
    if (!result) return;
    const latest = result.payments.find(item => item.id === payment.id);
    if (!latest) { setForm(null); setConfirmation(null); return; }
    if (form) setForm({ payment: latest });
    if (confirmation) {
      const changedState = confirmation.action === "pause" && latest.state !== "ACTIVE" || confirmation.action === "resume" && latest.state === "ACTIVE";
      if (changedState) setConfirmation(null);
      else setConfirmation({ ...confirmation, payment: latest });
    }
  }

  return <SettingsSection title="定期支払い" className={`${tableStyles.panel} ${styles.panel}`} contentClassName={styles.content}>
    <div className={`panel-head ${styles.heading}`}>
      <div className={styles.headingActions}><RefreshButton refreshing={loading} disabled={busy || loading || form !== null || confirmation !== null} onClick={() => { setLoading(true); void load(); }} />
        <button type="button" className="primary" disabled={busy || loading || !data || data.eligibleActorUserIds.length === 0} onClick={() => setForm({})}>＋ 定期支払いを追加</button></div>
    </div>
    <p className={tableStyles.note}>予定日の日本時間9時ごろに明細を追加します。未登録の過去分は自動追加しません。</p>
    {error && <p className={tableStyles.bulkError} role="alert">{error}<button type="button" className="text-button" disabled={busy || loading} onClick={() => { setLoading(true); void load(); }}>再読込</button></p>}
    {!data && loading && <p className={tableStyles.empty}>定期支払いを読み込み中…</p>}
    {data && data.payments.length === 0 && <div className="empty"><span aria-hidden="true">○</span><p>定期支払いはまだありません</p><small className={styles.muted}>家賃や月額サービスを追加できます。</small></div>}
    {data && data.eligibleActorUserIds.length === 0 && <p className={tableStyles.bulkError}>現在、支払者として選べる参加者がいません。</p>}
    {data && data.payments.length > 0 && <div className={tableStyles.tableWrap}><table className={`${tableStyles.table} ${styles.table}`} aria-label="定期支払い一覧">
      <colgroup>{["予定", "取引先", "方法", "金額", "支払者", "区分", "割合", "メモ", "状態", "操作"].map((label, index) => <col key={label} className={styles[`column${index}`]} />)}</colgroup>
      <thead><tr>{["毎月の日 / 次回", "取引先", "方法", "金額（円）", "支払者", "区分", `配分割合（${selected.members.map(member => member.name).join(", ")}）`, "メモ", "状態", "操作"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{data.payments.map(payment => <RecurringPaymentRow key={payment.id} payment={payment} members={selected.members} busy={busy || loading}
        onEdit={() => setForm({ payment })} onAction={action => setConfirmation({ action, payment })} />)}</tbody>
    </table></div>}
    {form && data && <RecurringPaymentForm key={form.payment ? `${form.payment.id}-${form.payment.revision}` : "new"} selected={selected} currentUserId={currentUserId} data={data} payment={form.payment}
      close={() => setForm(null)} save={save} reloadLatest={reloadLatest} />}
    {confirmation && data && <RecurringPaymentConfirmation key={`${confirmation.payment.id}-${confirmation.payment.revision}-${confirmation.action}`} {...confirmation}
      close={() => setConfirmation(null)} save={save} reloadLatest={reloadLatest} />}
  </SettingsSection>;
}

function RecurringPaymentRow({ payment, members, busy, onEdit, onAction }: { payment: RecurringPayment; members: WorkspaceMember[]; busy: boolean; onEdit: () => void; onAction: (action: StateAction) => void }) {
  const [expanded, setExpanded] = useState(false);
  const config = payment.currentConfig;
  const actorName = members.find(member => member.id === config.actorUserId)?.name ?? "確認が必要です";
  const stateLabel = recurringPaymentStateLabel(payment.state);
  return <tr className={tableStyles.transactionRow} data-expanded={expanded} data-recurring-payment-id={payment.id}>
    <td className={tableStyles.mobileSummary} colSpan={10}><SwipeDelete label={config.merchant} disabled={busy} onDelete={() => onAction("archive")}><button type="button" className={`${tableStyles.summaryButton} ${styles.summaryButton}`} aria-expanded={expanded}
      aria-label={`${config.merchant}の詳細を${expanded ? "閉じる" : "開く"}`} onClick={() => setExpanded(current => !current)}>
      <span className={tableStyles.summaryName}><b>{config.merchant}</b><small>毎月{config.dayOfMonth}日 · {actorName}</small></span>
      <span className={tableStyles.summaryAmount}><strong className={cashflowClass(-config.amountYen)}>{formatTransactionAmount("PAYMENT", config.amountYen)}</strong><small>{stateLabel}</small></span><span className={tableStyles.summaryChevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button></SwipeDelete></td>
    <td data-label="毎月の日 / 次回" className={tableStyles.fullCell}><b>毎月{config.dayOfMonth}日</b><small>次回：{payment.nextScheduledOn ? dateLabel(payment.nextScheduledOn) : "—"}</small>
      {config.dayOfMonth >= 29 && <small>その日がない月は月末に追加</small>}</td>
    <td data-label="取引先"><b>{config.merchant}</b></td><td data-label="方法">{config.method}</td><td data-label="金額（円）" className={cashflowClass(-config.amountYen)}>{formatTransactionAmount("PAYMENT", config.amountYen)}</td>
    <td data-label="支払者">{actorName}</td><td data-label="区分">{commonExpenseClassLabels[config.expenseClass]}</td>
    <td data-label={`配分割合（${members.map(member => member.name).join(", ")}）`} className={tableStyles.fullCell}><RecurringSplit config={config} members={members} /></td>
    <td data-label="メモ" className={`${tableStyles.fullCell} ${styles.memo}`}>{config.memo || "—"}</td>
    <td data-label="状態" className={tableStyles.fullCell}><span className={payment.state === "BLOCKED" ? "error-tag" : payment.state === "ACTIVE" ? "success-tag" : "class-tag personal"}>{stateLabel}</span>
      {payment.state === "BLOCKED" && <small className={styles.blocked}>{blockedReasonLabel(payment.blockedReason)} 設定を確認して、再開してください。</small>}</td>
    <td data-label="操作" className={tableStyles.fullCell}><div className={styles.rowActions}><button type="button" className="text-button" disabled={busy} onClick={onEdit}>編集</button>
      {payment.state === "ACTIVE" ? <button type="button" className="text-button" disabled={busy} onClick={() => onAction("pause")}>停止</button>
        : <button type="button" className="text-button" disabled={busy} onClick={() => onAction("resume")}>再開</button>}
      <button type="button" className="danger-text" disabled={busy} onClick={() => onAction("archive")}>削除</button></div></td>
  </tr>;
}

function RecurringSplit({ config, members }: { config: RecurringPaymentConfig; members: WorkspaceMember[] }) {
  let shares: { percentages: Record<string, number>; amounts: Record<string, number> } | null = null;
  try {
    const splitWeights = { ...config.splitWeights };
    for (const member of members) if (!(member.id in splitWeights)) splitWeights[member.id] = 0;
    validateSplitWeights(splitWeights, members, config.expenseClass, config.actorUserId);
    shares = { percentages: splitAmounts(1000, splitWeights, members), amounts: splitAmounts(config.amountYen, splitWeights, members) };
  } catch { /* Saved membership inconsistencies need review, not a fabricated split. */ }
  if (!shares) return <span className={styles.blocked}>割合を確認してください。</span>;
  return <span className={tableStyles.settledSplit}>{members.map(member => <span key={member.id}><span className={cashflowClass(-shares.amounts[member.id])}>{formatTransactionAmount("PAYMENT", shares.amounts[member.id])}</span><small>{shares.percentages[member.id] / 10}%</small></span>)}</span>;
}

function RecurringPaymentForm({ selected, currentUserId, data, payment, close, save, reloadLatest }: {
  selected: WorkspaceData; currentUserId: string; data: RecurringPaymentsResponse; payment?: RecurringPayment; close: () => void;
  save: (payload: RecurringPaymentMutationDraft) => Promise<RecurringPaymentMutationResult>; reloadLatest: (payment: RecurringPayment) => Promise<void>;
}) {
  const matchRule = useMemo(() => prepareDefaultRuleMatcher(selected.rules), [selected.rules]);
  const [config, setConfig] = useState(() => recurringFormConfig(selected, currentUserId, data.eligibleActorUserIds, data.today, payment));
  const [customized, setCustomized] = useState(!!payment);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const eligible = selected.members.filter(member => data.eligibleActorUserIds.includes(member.id));
  const unavailableActor = !eligible.some(member => member.id === config.actorUserId);
  const personalActorInvalid = config.expenseClass === "PERSONAL" && config.actorUserId !== currentUserId;
  let splitValid = true;
  try { validateSplitWeights(config.splitWeights, selected.members, config.expenseClass, config.actorUserId); } catch { splitValid = false; }
  let preview: ReturnType<typeof recurringFormPreview> | null = null;
  try { preview = recurringFormPreview(config, new Date(data.now)); } catch { /* Invalid config has no preview. */ }
  const patch = (update: Partial<RecurringPaymentConfig>) => { setConfig(current => ({ ...current, ...update })); if (!conflict) setError(null); };
  const applyDefaults = () => { patch(recurringFormDefaults(selected, config.merchant, config.actorUserId, matchRule)); setCustomized(false); };
  return <RecurringDialog title={payment ? "定期支払いを編集" : "定期支払いを追加"} close={close} busy={saving}>
    <form onSubmit={async event => {
      event.preventDefault(); if (savingRef.current) return; savingRef.current = true; setError(null); setSaving(true);
      try {
        if (personalActorInvalid) throw new Error("個人の定期支払いは本人だけが登録できます。支払者を自分に変更してください。");
        validateSplitWeights(config.splitWeights, selected.members, config.expenseClass, config.actorUserId);
        if (unavailableActor) throw new Error("有効な参加者を支払者として選んでください。");
        await save(payment
          ? { ...config, action: "update", paymentId: payment.id, expectedRevision: payment.revision }
          : { ...config, action: "create" });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "保存できませんでした。入力内容は保持しています。");
        if (failure instanceof RecurringRequestError && failure.code === "REVISION_CONFLICT") setConflict(true);
      } finally { savingRef.current = false; setSaving(false); }
    }}>
      {payment && payment.state !== "ACTIVE" && <p className={styles.hint}>保存後も自動追加は停止中です。再開は一覧から行ってください。</p>}
      <fieldset disabled={saving} className={styles.fields}><div className="form-grid">
        <label className="full">毎月の日<select required value={config.dayOfMonth} onChange={event => patch({ dayOfMonth: Number(event.target.value) })}>{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}日</option>)}</select></label>
        <label className="full">取引先<input required maxLength={MAX_MERCHANT_LENGTH} value={config.merchant} onChange={event => {
          const merchant = event.target.value;
          patch({ merchant, ...(!customized ? recurringFormDefaults(selected, merchant, config.actorUserId, matchRule) : {}) });
        }} /></label>
        <label>取引方法<input required maxLength={MAX_METHOD_LENGTH} value={config.method} onChange={event => patch({ method: event.target.value })} /></label>
        <label>金額（円）<span className="signed-amount-input"><span className="negative" aria-hidden="true">−</span><input aria-label="金額（円）" type="number" required min="1" max={MAX_AMOUNT_YEN} step="1" value={config.amountYen || ""} onChange={event => patch({ amountYen: Number(event.target.value) })} /></span></label>
        <label>支払者<select required value={config.actorUserId} onChange={event => {
          const actorUserId = event.target.value;
          patch({ actorUserId, ...(config.expenseClass === "PERSONAL" ? { splitWeights: personalSplitWeights(selected.members, actorUserId) } : {}) });
        }}>{unavailableActor && <option value={config.actorUserId} disabled>支払者を選択してください</option>}{eligible.map(member => <option key={member.id} value={member.id} disabled={config.expenseClass === "PERSONAL" && member.id !== currentUserId}>{member.name}</option>)}</select></label>
        <label>区分<select value={config.expenseClass} disabled={selected.workspace.type === "PERSONAL"} onChange={event => {
          const expenseClass = event.target.value as ExpenseClass;
          patch({ expenseClass, splitWeights: expenseClass === "PERSONAL" ? personalSplitWeights(selected.members, config.actorUserId) : defaultSplitWeights(selected.members) }); setCustomized(true);
        }}>{expenseClasses.map(value => <option key={value} value={value} disabled={value === "PERSONAL" && config.actorUserId !== currentUserId}>{commonExpenseClassLabels[value]}</option>)}</select></label>
        {config.actorUserId !== currentUserId && <p className="ratio-note full">個人の定期支払いを登録する場合は、支払者を自分に変更してください。</p>}
        <div className="full"><SplitEditor inline label={`配分割合（${selected.members.map(member => member.name).join(", ")}）`} amountYen={config.amountYen} members={selected.members} value={config.splitWeights}
          disabled={saving || config.expenseClass === "PERSONAL" || !splitValid} onChange={splitWeights => { patch({ splitWeights }); setCustomized(true); }} />
          {!splitValid && <p className="form-error">配分割合の参加者を確認してください。「取引先のルールを適用」で現在の参加者の割合に設定し直せます。</p>}
          <p className="ratio-note">{config.expenseClass === "PERSONAL" ? "区分が「個人」の場合、支払者に100%を配分します。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          <button type="button" className="text-button" disabled={!config.actorUserId} onClick={applyDefaults}>取引先のルールを適用</button></div>
      </div><label className={`new-transaction-memo ${styles.memoLabel}`}>メモ<textarea rows={2} maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={config.memo} onChange={event => patch({ memo: event.target.value })} /></label></fieldset>
      {preview && <div className={styles.preview}><b>毎月{config.dayOfMonth}日 · <span className={cashflowClass(-config.amountYen)}>{formatTransactionAmount("PAYMENT", config.amountYen)}</span></b><span>{payment ? "変更後の予定" : "初回予定"}：{preview.firstOn && dateLabel(preview.firstOn)}</span><span>{eligible.find(member => member.id === config.actorUserId)?.name ?? "支払者を選択してください"}の支払い · {commonExpenseClassLabels[config.expenseClass]}</span><RecurringSplit config={config} members={selected.members} />
        {config.dayOfMonth >= 29 && <small>その日がない月は月末に追加します。</small>}</div>}
      {payment && <p className={styles.current}>現在：毎月{payment.currentConfig.dayOfMonth}日 / <span className={cashflowClass(-payment.currentConfig.amountYen)}>{formatTransactionAmount("PAYMENT", payment.currentConfig.amountYen)}</span> / {payment.currentConfig.merchant}</p>}
      {error && <p className="form-error" role="alert">{error} 入力内容は保持しています。</p>}
      {conflict && payment && <button type="button" className="text-button" disabled={saving} onClick={() => {
        if (window.confirm("入力中の内容を破棄して、最新の設定を読み込みますか？")) void reloadLatest(payment);
      }}>最新の設定で開き直す</button>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button type="submit" className="primary" disabled={saving || conflict || unavailableActor || personalActorInvalid || !preview || !splitValid}>{saving ? "保存中…" : payment ? "変更を保存" : "追加する"}</button></div>
    </form>
  </RecurringDialog>;
}

function RecurringPaymentConfirmation({ action, payment, close, save, reloadLatest }: { action: StateAction; payment: RecurringPayment; close: () => void;
  save: (payload: RecurringPaymentMutationDraft) => Promise<RecurringPaymentMutationResult>; reloadLatest: (payment: RecurringPayment) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const verb = action === "pause" ? "停止" : action === "resume" ? "再開" : "削除";
  return <RecurringDialog title={`定期支払いを${verb}`} busy={saving} close={close}>
    <form onSubmit={async event => {
      event.preventDefault(); if (savingRef.current) return; savingRef.current = true; setSaving(true); setError(null);
      try { await save({ action, paymentId: payment.id, expectedRevision: payment.revision }); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "処理に失敗しました。"); if (failure instanceof RecurringRequestError && failure.code === "REVISION_CONFLICT") setConflict(true); }
      finally { savingRef.current = false; setSaving(false); }
    }}>
      <p className={styles.confirmMerchant}>{payment.currentConfig.merchant}</p>
      {action === "pause" && <p className={styles.confirmText}>今後の自動追加を直ちに停止します。追加済みの明細は残ります。</p>}
      {action === "resume" && <p className={styles.confirmText}>自動追加を再開します。予定日に明細を追加します。停止期間分は追加しません。</p>}
      {action === "archive" && <p className={styles.confirmText}>今後の自動追加を終了します。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}{conflict && <button type="button" className="text-button" disabled={saving} onClick={() => { void reloadLatest(payment); }}>最新の設定を確認する</button>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button type="submit" className={action === "archive" ? `secondary ${styles.deleteButton}` : "primary"} disabled={saving || conflict}>{saving ? "保存中…" : `${verb}する`}</button></div>
    </form>
  </RecurringDialog>;
}

function RecurringDialog({ title, children, close, busy }: { title: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    return () => { element?.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return <dialog ref={dialog} className={`modal transaction-modal ${styles.dialog}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) close(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="閉じる" disabled={busy} onClick={close}>×</button></header>{children}
  </dialog>;
}
