import { createRoot } from "react-dom/client";
import { Dashboard } from "../../../components/dashboard";
import type { BootstrapMetadata } from "../../../lib/shared/types";
import "../../../app/globals.css";

declare global {
  interface Window { navigationInitialData: BootstrapMetadata; }
}

createRoot(document.getElementById("root")!).render(<Dashboard initialData={window.navigationInitialData} testAuth />);
