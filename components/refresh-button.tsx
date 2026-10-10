"use client";

export function RefreshButton({ refreshing, disabled = false, onClick }: {
  refreshing: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return <button type="button" className="secondary refresh-button" disabled={disabled || refreshing}
    aria-busy={refreshing} title="最新のデータに更新" onClick={onClick}>
    <svg className={refreshing ? "refresh-icon spinning" : "refresh-icon"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
    </svg>
    {refreshing ? "更新中…" : "更新"}
  </button>;
}
