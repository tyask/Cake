"use client";

import Image from "next/image";
import { useState } from "react";
import { signOut } from "next-auth/react";
import type { BootstrapMetadata } from "@/lib/shared/types";
import type { DashboardTab as Tab } from "@/lib/shared/types";
import { useDashboardController } from "./use-dashboard-controller";
import { HomePanel } from "./home-panel";
import { ImportPanel } from "./import-panel";
import { SettingsPanel } from "./workspace-settings-panel";
import { WorkspaceModal } from "./workspace-modal";
import { NewTransactionModal } from "./new-transaction-modal";
import { PageHeading } from "./dashboard-ui";
import { PersonalSettings } from "./personal-settings";
import { UserManagement } from "./user-management";
import { MobileAccessQr } from "./mobile-access-qr";
import { CakeIcon } from "./cake-icon";
import { TransactionsPanel } from "./transactions-panel";
import { RefreshButton } from "./refresh-button";
import { AnalyticsPanel } from "./analytics-panel";

const navItems: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "ホーム", icon: "⌂" },
  { id: "transactions", label: "取引明細", icon: "≡" },
  { id: "import", label: "取込", icon: "⇩" },
  { id: "analytics", label: "集計", icon: "▥" },
  { id: "settings", label: "設定", icon: "⚙" },
];

export function Dashboard({ initialData, initialTab = "home", testAuth = false }: { initialData: BootstrapMetadata; initialTab?: Tab; testAuth?: boolean }) {
  const { data, selected, selectedTransactions, transactionView, registerHomeRefresh, tab, loading, refreshing, workspaceSwitching, analyticsRevision, importHistoryRevision, notice, setNotice, refresh, refreshCurrentView, run, switchWorkspace, openTab } = useDashboardController(initialData, initialTab);
  const [workspaceModal, setWorkspaceModal] = useState(false);
  const [transactionModal, setTransactionModal] = useState(false);
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-logo"><CakeIcon decorative /><b>Cake</b></div>
        <div className="workspace-picker">
          <label>ワークスペース</label>
          <select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>
            {data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button className="small-link" onClick={() => setWorkspaceModal(true)}>＋ 新しく作成</button>
        </div>
        <nav className="app-nav">
          {navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => openTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}
        </nav>
        <div className="sidebar-footer">
          <MobileAccessQr />
          <div className="profile">
            <span className="avatar">{data.user.imageUrl ? <Image src={data.user.imageUrl} alt="" width={36} height={36} /> : data.user.name.slice(0, 1)}</span>
            <span><b>{data.user.name}</b><small>{data.user.email}</small></span>
            {testAuth && <span className="demo-chip">TEST</span>}
            <button title="ログアウト" onClick={() => signOut({ redirectTo: "/" })}>↪</button>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <header className="mobile-header"><div className="app-logo"><CakeIcon decorative size={34} /><b>Cake</b></div><select value={selected?.workspace.id ?? ""} onChange={(event) => switchWorkspace(event.target.value)}>{data.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></header>
        {testAuth && <div className="demo-banner">テストログインで使用中です（{data.user.name}）</div>}
        {notice && <div className="notice" role="status">{notice}<button type="button" aria-label="通知を閉じる" onClick={() => setNotice(null)}>×</button></div>}
        {loading && <div className="loading-line" />}
        {selected && tab === "home" && <HomePanel selected={selected} userId={data.user.id} pending={data.pendingInvitations.length} setTab={openTab} add={() => setTransactionModal(true)} run={run} revision={analyticsRevision} suspended={workspaceSwitching} registerRefresh={registerHomeRefresh} refreshAction={<RefreshButton refreshing={refreshing} disabled={loading} onClick={() => { void refreshCurrentView(); }} />} refreshing={refreshing} />}
        {selectedTransactions && tab === "transactions" && <TransactionsPanel key={selectedTransactions.workspace.id} selected={selectedTransactions} userId={data.user.id} add={() => setTransactionModal(true)} run={run} onRefresh={refreshCurrentView} refreshing={refreshing} view={transactionView} />}
        {selected && tab === "transactions" && !selectedTransactions && <div role="status"><p>{loading ? "取引明細を読み込んでいます。" : "取引明細を読み込めませんでした。"}</p>{!loading && <button type="button" onClick={() => { void refreshCurrentView(); }}>再試行</button>}</div>}
        {selected && <ImportPanel key={`import:${selected.workspace.id}`} selected={selected} currentUserId={data.user.id} run={run} importHistoryRevision={importHistoryRevision} active={tab === "import"} />}
        {selected && <AnalyticsPanel key={`analytics:${selected.workspace.id}`} workspaceId={selected.workspace.id} currentUserId={data.user.id} revision={analyticsRevision} active={tab === "analytics" && !workspaceSwitching} />}
        {tab === "settings" && <>
          <PageHeading title="設定" />
          <PersonalSettings key={`${data.user.id}-${data.user.name}`} user={data.user} run={run} />
          {selected && <section className="settings-group" aria-labelledby="workspace-settings-title">
            <div className="settings-group-heading"><h2 id="workspace-settings-title">ワークスペース設定</h2><p>{selected.workspace.name}の情報・共有の配分割合・ルールを設定します。</p></div>
            <SettingsPanel key={selected.workspace.id} selected={selected} currentUserId={data.user.id} run={run} afterDelete={async () => { await refresh(); }} />
          </section>}
          {data.user.isAdmin === true && !testAuth && <UserManagement />}
        </>}
      </main>

      <nav className="bottom-nav">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => openTab(item.id)}><i>{item.icon}</i><span>{item.label}</span></button>)}</nav>
      {workspaceModal && <WorkspaceModal close={() => setWorkspaceModal(false)} run={run} />}
      {transactionModal && selected && <NewTransactionModal key={selected.workspace.id} selected={selected} currentUserId={data.user.id} close={() => setTransactionModal(false)} run={run} />}
    </div>
  );
}
