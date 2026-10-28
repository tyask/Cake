import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTransactionView } from "../../../components/use-transaction-view";

type Configuration = { userId: string; workspaceId: string; active: boolean };
declare global {
  interface Window {
    transactionViewHarness: { view: ReturnType<typeof useTransactionView>; configure: (next: Configuration) => void };
    transactionViewOperation?: Promise<boolean>;
  }
}

function Harness() {
  const [configuration, configure] = useState<Configuration>({ userId: "user", workspaceId: "a", active: true });
  const view = useTransactionView(configuration.userId, configuration.workspaceId, configuration.active);
  useLayoutEffect(() => { window.transactionViewHarness = { view, configure }; }, [view]);
  return <pre>{JSON.stringify({ selection: view.selection, data: view.data, loading: view.loading, error: view.error })}</pre>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
