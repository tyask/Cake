import { createRoot } from "react-dom/client";
import { Dashboard } from "../../../components/dashboard";
import type { BootstrapData } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window { navigationInitialData: BootstrapData; }
}

createRoot(document.getElementById("root")!).render(<Dashboard initialData={window.navigationInitialData} testAuth />);
