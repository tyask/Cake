import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { useDashboardController } from "../../components/use-dashboard-controller";
import type { BootstrapData } from "../../lib/types";

declare global {
  interface Window {
    initialData: BootstrapData;
    controller: ReturnType<typeof useDashboardController>;
    operation: Promise<unknown>;
    operationError?: string;
    releasePrepare: () => void;
    prepareCount: number;
  }
}

function Harness() {
  const controller = useDashboardController(window.initialData);
  useLayoutEffect(() => { window.controller = controller; }, [controller]);
  return <pre id="state">{JSON.stringify({ data: controller.data, tab: controller.tab, notice: controller.notice,
    loading: controller.loading, refreshing: controller.refreshing })}</pre>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
