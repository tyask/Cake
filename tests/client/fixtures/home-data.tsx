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
      rerender: () => void;
    };
    homeRemount: () => void;
    homeObservations: { active: boolean; loading: boolean; paymentTotal: string | null }[];
    homeOperation?: Promise<void>;
    homeOperationError?: string;
  }
}

function Harness() {
  const [workspace, setWorkspace] = useState("workspace-a");
  const [month, setMonth] = useState("2026-10");
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState(true);
  const [render, setRender] = useState(0);
  const result = useHomeData(workspace, month, revision, active);
  useLayoutEffect(() => {
    window.homeHook = result;
    window.homeControls = { workspace: setWorkspace, month: setMonth, revision: setRevision, active: setActive,
      rerender: () => setRender(value => value + 1) };
    window.homeObservations.push({ active, loading: result.loading, paymentTotal: result.data?.monthly.total.paymentTotal ?? null });
  }, [result, active]);
  return <output id="state" data-render={render}>{JSON.stringify(result)}</output>;
}

const root = createRoot(document.getElementById("root")!);
let generation = 0;
window.homeObservations = [];
window.homeRemount = () => { root.render(<Harness key={++generation} />); };
root.render(<Harness key={generation} />);
