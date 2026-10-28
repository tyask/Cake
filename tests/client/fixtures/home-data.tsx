import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useHomeData } from "../../../components/use-home-data";

declare global {
  interface Window {
    homeHook: ReturnType<typeof useHomeData>;
    homeControls: {
      workspace: (value: string) => void;
      month: (value: string) => void;
      revision: (value: number) => void;
      active: (value: boolean) => void;
    };
    homeOperation?: Promise<void>;
    homeOperationError?: string;
  }
}

function Harness() {
  const [workspace, setWorkspace] = useState("workspace-a");
  const [month, setMonth] = useState("2026-10");
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState(true);
  const result = useHomeData(workspace, month, revision, active);
  useLayoutEffect(() => {
    window.homeHook = result;
    window.homeControls = { workspace: setWorkspace, month: setMonth, revision: setRevision, active: setActive };
  }, [result]);
  return <output id="state">{JSON.stringify(result)}</output>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
