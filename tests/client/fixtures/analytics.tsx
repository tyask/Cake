import { createRoot } from "react-dom/client";
import { AnalyticsPanel } from "../../../components/analytics-panel";
import "../../../app/globals.css";

type PanelProps = { workspaceId: string; currentUserId: string; revision: number; active: boolean };
declare global {
  interface Window {
    analyticsProps: PanelProps;
    updateAnalytics: (props: Partial<PanelProps>) => void;
    ignoreAnalyticsAbort?: boolean;
  }
}
const root = createRoot(document.getElementById("root")!);
const originalFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  if (!window.ignoreAnalyticsAbort) return originalFetch(input, options);
  const remaining = { ...options };
  delete remaining.signal;
  return originalFetch(input, remaining);
};
function render() {
  root.render(<div className="app-shell"><main className="app-main"><header className="mobile-header"><b>Cake</b><span>テスト家計</span></header>
    <AnalyticsPanel key={window.analyticsProps.workspaceId} {...window.analyticsProps} />
  </main><nav className="bottom-nav">{["ホーム", "取引明細", "取込", "集計", "設定"].map(label => <button type="button" key={label}><i>⌂</i><span>{label}</span></button>)}</nav></div>);
}
window.updateAnalytics = props => { window.analyticsProps = { ...window.analyticsProps, ...props }; render(); };
render();
