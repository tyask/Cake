"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { validateSplitWeights, defaultSplitWeights, personalSplitWeights } from "@/lib/expense-splits";
import { splitAmounts } from "@/lib/split-allocations";
import { recurringFormConfig, recurringFormDefaults, recurringFormPreview } from "@/lib/recurring-payment-form";
import { MAX_TRANSACTION_MEMO_LENGTH } from "@/lib/transaction-memo";
import type { RecurringPayment, RecurringPaymentConfig, RecurringPaymentMutationResult, RecurringPaymentsResponse } from "@/lib/recurring-payment-types";
import type { ExpenseClass, WorkspaceData, WorkspaceMember } from "@/lib/types";
import { RefreshButton } from "./refresh-button";
import { SplitEditor } from "./split-editor";
import tableStyles from "./transactions-panel.module.css";
import styles from "./recurring-payments-panel.module.css";

const money = (value: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(value);
const dateLabel = (date: string) => date.replaceAll("-", "/");
type StateAction = "pause" | "resume" | "archive";
type FormState = { payment?: RecurringPayment };

class RecurringRequestError extends Error {
  constructor(message: string, public readonly code?: string) { super(message); }
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
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: StateAction; payment: RecurringPayment } | null>(null);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const workspaceId = selected.workspace.id;

  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    try {
      const response = await fetch(`/api/recurring-payments?${new URLSearchParams({ workspaceId })}`, { cache: "no-store", signal });
      const result = await readResponse<RecurringPaymentsResponse>(response);
      if (!mounted.current || id !== requestId.current) return null;
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

  async function save(payload: Record<string, unknown>) {
    requestId.current += 1;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/recurring-payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, workspaceId }) });
      const result = await readResponse<RecurringPaymentMutationResult>(response);
      if (mounted.current) {
        setData(current => current ? { ...current, payments: result.payment.state === "ARCHIVED"
          ? current.payments.filter(payment => payment.id !== result.payment.id)
          : [...current.payments.filter(payment => payment.id !== result.payment.id), result.payment] } : current);
        setForm(null);
        setConfirmation(null);
        setNotice(payload.action === "update" ? null
          : payload.action === "pause" ? "自動追加を停止しました。"
          : payload.action === "resume" ? "自動追加を再開しました。"
          : payload.action === "archive" ? "定期支払いを削除しました。追加済みの明細は残ります。" : "定期支払いを追加しました。");
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
    if (!latest) { setForm(null); setConfirmation(null); setNotice("この定期支払いは削除されています。"); return; }
    if (form) setForm({ payment: latest });
    if (confirmation) {
      const changedState = confirmation.action === "pause" && latest.state !== "ACTIVE" || confirmation.action === "resume" && latest.state === "ACTIVE";
      if (changedState) { setConfirmation(null); setNotice("状態が変更されています。最新の一覧を確認してください。"); }
      else setConfirmation({ ...confirmation, payment: latest });
    }
  }

  return <section className={`panel ${tableStyles.panel} ${styles.panel}`} aria-labelledby="recurring-payments-title">
    <div className={`panel-head ${styles.heading}`}><div><span>RECURRING PAYMENTS</span><h2 id="recurring-payments-title">定期支払い</h2></div>
      <div className={styles.headingActions}><RefreshButton refreshing={loading} disabled={busy || loading || form !== null || confirmation !== null} onClick={() => { setLoading(true); void load(); }} />
        <button type="button" className="primary" disabled={busy || loading || !data || data.eligibleActorUserIds.length === 0} onClick={() => { setNotice(null); setForm({}); }}>＋ 定期支払いを追加</button></div>
    </div>
    <p className={tableStyles.note}>予定日の日本時間9時ごろに明細を追加します。未登録の過去分は自動追加しません。</p>
    {error && <p className={tableStyles.bulkError} role="alert">{error}<button type="button" className="text-button" disabled={busy || loading} onClick={() => { setLoading(true); void load(); }}>再読込</button></p>}
    {notice && <p className={tableStyles.bulkNotice} role="status">{notice}</p>}
    {!data && loading && <p className={tableStyles.empty}>定期支払いを読み込み中…</p>}
    {data && data.payments.length === 0 && <div className="empty"><span aria-hidden="true">○</span><p>定期支払いはまだありません</p><small className={styles.muted}>家賃や月額サービスを追加できます。</small></div>}
    {data && data.eligibleActorUserIds.length === 0 && <p className={tableStyles.bulkError}>現在、支払者として選べる参加者がいません。</p>}
    {data && data.payments.length > 0 && <div className={tableStyles.tableWrap}><table className={`${tableStyles.table} ${styles.table}`} aria-label="定期支払い一覧">
      <colgroup>{["予定", "取引先", "方法", "金額", "支払者", "区分", "割合", "メモ", "状態", "操作"].map((label, index) => <col key={label} className={styles[`column${index}`]} />)}</colgroup>
      <thead><tr>{["毎月の日 / 次回", "取引先", "方法", "金額（円）", "支払者", "費用区分", `支払い割合（${selected.members.map(member => member.name).join(", ")}）`, "メモ", "状態", "操作"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{data.payments.map(payment => <RecurringPaymentRow key={payment.id} payment={payment} members={selected.members} busy={busy || loading}
        onEdit={() => { setNotice(null); setForm({ payment }); }} onAction={action => { setNotice(null); setConfirmation({ action, payment }); }} />)}</tbody>
    </table></div>}
    {form && data && <RecurringPaymentForm key={form.payment ? `${form.payment.id}-${form.payment.revision}` : "new"} selected={selected} currentUserId={currentUserId} data={data} payment={form.payment}
      close={() => setForm(null)} save={save} reloadLatest={reloadLatest} />}
    {confirmation && data && <RecurringPaymentConfirmation key={`${confirmation.payment.id}-${confirmation.payment.revision}-${confirmation.action}`} {...confirmation}
      close={() => setConfirmation(null)} save={save} reloadLatest={reloadLatest} />}
  </section>;
}

function RecurringPaymentRow({ payment, members, busy, onEdit, onAction }: { payment: RecurringPayment; members: WorkspaceMember[]; busy: boolean; onEdit: () => void; onAction: (action: StateAction) => void }) {
  const [expanded, setExpanded] = useState(false);
  const config = payment.currentConfig;
  const actorName = members.find(member => member.id === config.actorUserId)?.name ?? "確認が必要です";
  const stateLabel = payment.state === "ACTIVE" ? "有効" : payment.state === "PAUSED" ? "停止中" : "要確認";
  return <tr className={tableStyles.transactionRow} data-expanded={expanded} data-recurring-payment-id={payment.id}>
    <td className={tableStyles.mobileSummary} colSpan={10}><button type="button" className={`${tableStyles.summaryButton} ${styles.summaryButton}`} aria-expanded={expanded}
      aria-label={`${config.merchant}の詳細を${expanded ? "閉じる" : "開く"}`} onClick={() => setExpanded(current => !current)}>
      <span className={tableStyles.summaryName}><b>{config.merchant}</b><small>毎月{config.dayOfMonth}日 · {actorName}</small></span>
      <span className={tableStyles.summaryAmount}><strong>{money(config.amountYen)}</strong><small>{stateLabel}</small></span><span className={tableStyles.summaryChevron} aria-hidden="true">{expanded ? "⌃" : "⌄"}</span>
    </button></td>
    <td data-label="毎月の日 / 次回" className={tableStyles.fullCell}><b>毎月{config.dayOfMonth}日</b><small>次回：{payment.nextScheduledOn ? dateLabel(payment.nextScheduledOn) : "—"}</small>
      {config.dayOfMonth >= 29 && <small>その日がない月は月末に追加</small>}</td>
    <td data-label="取引先"><b>{config.merchant}</b></td><td data-label="方法">{config.method}</td><td data-label="金額（円）">{money(config.amountYen)}</td>
    <td data-label="支払者">{actorName}</td><td data-label="費用区分">{config.expenseClass === "PERSONAL" ? "個人費" : "共通費"}</td>
    <td data-label={`支払い割合（${members.map(member => member.name).join(", ")}）`} className={tableStyles.fullCell}><RecurringSplit config={config} members={members} /></td>
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
  return <span className={tableStyles.settledSplit}>{members.map(member => <span key={member.id}><span>{money(shares.amounts[member.id])}</span><small>{shares.percentages[member.id] / 10}%</small></span>)}</span>;
}

function blockedReasonLabel(reason: string | null) {
  switch (reason) {
    case "AUTHORIZER_UNAVAILABLE": return "実行を承認した利用者が利用できなくなりました。";
    case "ACTOR_UNAVAILABLE": return "支払者が利用できなくなりました。";
    case "SPLIT_MEMBERS_INVALID": return "負担割合の参加者が一致しません。";
    case "SPLIT_USER_UNAVAILABLE": return "費用を負担する利用者が利用できなくなりました。";
    default: return "定期支払いの設定を確認する必要があります。";
  }
}

function RecurringPaymentForm({ selected, currentUserId, data, payment, close, save, reloadLatest }: {
  selected: WorkspaceData; currentUserId: string; data: RecurringPaymentsResponse; payment?: RecurringPayment; close: () => void;
  save: (payload: Record<string, unknown>) => Promise<RecurringPaymentMutationResult>; reloadLatest: (payment: RecurringPayment) => Promise<void>;
}) {
  const [config, setConfig] = useState(() => recurringFormConfig(selected, currentUserId, data.eligibleActorUserIds, data.today, payment));
  const [customized, setCustomized] = useState(!!payment);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const eligible = selected.members.filter(member => data.eligibleActorUserIds.includes(member.id));
  const unavailableActor = !eligible.some(member => member.id === config.actorUserId);
  let splitValid = true;
  try { validateSplitWeights(config.splitWeights, selected.members, config.expenseClass, config.actorUserId); } catch { splitValid = false; }
  let preview: ReturnType<typeof recurringFormPreview> | null = null;
  try { preview = recurringFormPreview(config, data.today, payment); } catch { /* Invalid config has no preview. */ }
  const patch = (update: Partial<RecurringPaymentConfig>) => { setConfig(current => ({ ...current, ...update })); if (!conflict) setError(null); };
  const applyDefaults = () => { patch(recurringFormDefaults(selected, config.merchant, config.actorUserId)); setCustomized(false); };
  return <RecurringDialog title={payment ? "定期支払いを編集" : "定期支払いを追加"} close={close} busy={saving}>
    <form onSubmit={async event => {
      event.preventDefault(); if (savingRef.current) return; savingRef.current = true; setError(null); setSaving(true);
      try {
        validateSplitWeights(config.splitWeights, selected.members, config.expenseClass, config.actorUserId);
        if (unavailableActor) throw new Error("有効な参加者を支払者として選んでください。");
        await save({ ...config, action: payment ? "update" : "create", ...(payment ? { paymentId: payment.id, expectedRevision: payment.revision } : {}) });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "保存できませんでした。入力内容は保持しています。");
        if (failure instanceof RecurringRequestError && failure.code === "REVISION_CONFLICT") setConflict(true);
      } finally { savingRef.current = false; setSaving(false); }
    }}>
      {payment && payment.state !== "ACTIVE" && <p className={styles.hint}>保存後も自動追加は停止中です。再開は一覧から行ってください。</p>}
      <fieldset disabled={saving} className={styles.fields}><div className="form-grid">
        <label className="full">毎月の日<select required value={config.dayOfMonth} onChange={event => patch({ dayOfMonth: Number(event.target.value) })}>{Array.from({ length: 31 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}日</option>)}</select></label>
        <label className="full">取引先<input required maxLength={240} value={config.merchant} onChange={event => {
          const merchant = event.target.value;
          patch({ merchant, ...(!customized ? recurringFormDefaults(selected, merchant, config.actorUserId) : {}) });
        }} /></label>
        <label>取引方法<input required maxLength={120} value={config.method} onChange={event => patch({ method: event.target.value })} /></label>
        <label>金額（円）<input type="number" required min="1" max="2147483647" step="1" value={config.amountYen || ""} onChange={event => patch({ amountYen: Number(event.target.value) })} /></label>
        <label>支払者<select required value={config.actorUserId} onChange={event => {
          const actorUserId = event.target.value;
          patch({ actorUserId, ...(config.expenseClass === "PERSONAL" ? { splitWeights: personalSplitWeights(selected.members, actorUserId) } : {}) });
        }}>{unavailableActor && <option value={config.actorUserId} disabled>支払者を選択してください</option>}{eligible.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>費用区分<select value={config.expenseClass} disabled={selected.workspace.type === "PERSONAL"} onChange={event => {
          const expenseClass = event.target.value as ExpenseClass;
          patch({ expenseClass, splitWeights: expenseClass === "PERSONAL" ? personalSplitWeights(selected.members, config.actorUserId) : defaultSplitWeights(selected.members) }); setCustomized(true);
        }}><option value="PERSONAL">個人費</option><option value="SHARED">共通費</option></select></label>
        <div className="full"><SplitEditor inline label={`支払い割合（${selected.members.map(member => member.name).join(", ")}）`} amountYen={config.amountYen} members={selected.members} value={config.splitWeights}
          disabled={saving || config.expenseClass === "PERSONAL" || !splitValid} onChange={splitWeights => { patch({ splitWeights }); setCustomized(true); }} />
          {!splitValid && <p className="form-error">負担割合の参加者を確認してください。「取引先のルールを適用」で現在の参加者の割合に設定し直せます。</p>}
          <p className="ratio-note">{config.expenseClass === "PERSONAL" ? "個人費は支払者の負担が100%になります。" : "割合・金額で設定できます。相手の分は自動計算します。"}</p>
          <button type="button" className="text-button" disabled={!config.actorUserId} onClick={applyDefaults}>取引先のルールを適用</button></div>
      </div><label className={`new-transaction-memo ${styles.memoLabel}`}>メモ<textarea rows={2} maxLength={MAX_TRANSACTION_MEMO_LENGTH} value={config.memo} onChange={event => patch({ memo: event.target.value })} /></label></fieldset>
      {preview && <div className={styles.preview}><b>毎月{config.dayOfMonth}日 · {money(config.amountYen)}</b><span>{payment ? "変更後の予定" : "初回予定"}：{preview.firstOn && dateLabel(preview.firstOn)}</span><span>{eligible.find(member => member.id === config.actorUserId)?.name ?? "支払者を選択してください"}の支払い · {config.expenseClass === "PERSONAL" ? "個人費" : "共通費"}</span><RecurringSplit config={config} members={selected.members} />
        {config.dayOfMonth >= 29 && <small>その日がない月は月末に追加します。</small>}{!payment && preview.firstOn === data.today && <small>本日の定期処理が終了している場合、今月分は追加されません。</small>}</div>}
      {payment && <p className={styles.current}>現在：毎月{payment.currentConfig.dayOfMonth}日 / {money(payment.currentConfig.amountYen)} / {payment.currentConfig.merchant}</p>}
      {error && <p className="form-error" role="alert">{error} 入力内容は保持しています。</p>}
      {conflict && payment && <button type="button" className="text-button" disabled={saving} onClick={() => {
        if (window.confirm("入力中の内容を破棄して、最新の設定を読み込みますか？")) void reloadLatest(payment);
      }}>最新の設定で開き直す</button>}
      <div className="modal-actions"><button type="button" className="secondary" disabled={saving} onClick={close}>キャンセル</button><button type="submit" className="primary" disabled={saving || conflict || unavailableActor || !preview || !splitValid}>{saving ? "保存中…" : payment ? "変更を保存" : "追加する"}</button></div>
    </form>
  </RecurringDialog>;
}

function RecurringPaymentConfirmation({ action, payment, close, save, reloadLatest }: { action: StateAction; payment: RecurringPayment; close: () => void;
  save: (payload: Record<string, unknown>) => Promise<RecurringPaymentMutationResult>; reloadLatest: (payment: RecurringPayment) => Promise<void> }) {
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
      {action === "archive" && <p className={styles.confirmText}>今後の自動追加を終了します。追加済みの明細は残ります。この設定は再開できません。</p>}
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
