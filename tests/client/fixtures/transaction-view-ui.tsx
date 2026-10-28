import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { TransactionsPanel } from "../../../components/transactions-panel";
import { useDashboardController } from "../../../components/use-dashboard-controller";
import type { BootstrapMetadata } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window {
    viewUiInitial: BootstrapMetadata;
    viewUiController: ReturnType<typeof useDashboardController>;
  }
}

function Harness() {
  const controller = useDashboardController(window.viewUiInitial, "transactions");
  useLayoutEffect(() => { window.viewUiController = controller; }, [controller]);
  return <main style={{ padding: 12, maxWidth: 1200, margin: "auto" }}>
    <nav aria-label="検証用画面切替">
      <button type="button" onClick={() => controller.openTab("settings")}>別画面へ</button>
      <button type="button" onClick={() => controller.openTab("transactions")}>取引明細へ戻る</button>
    </nav>
    {controller.notice && <p role="status">{controller.notice}</p>}
    {controller.tab === "transactions" && controller.selectedTransactions && <TransactionsPanel
      selected={controller.selectedTransactions} userId={controller.data.user.id}
      view={controller.transactionView} run={controller.run} add={() => {}}
      onRefresh={controller.refreshCurrentView} refreshing={controller.refreshing} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
