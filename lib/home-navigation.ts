import type { DashboardTab } from "./bootstrap";

export interface HomeSearchParams {
  workspaceId?: string | string[];
  tab?: string | string[];
  error?: string | string[];
}

/** Only the import destination is accepted from a home URL; redirects stay on Cake. */
export function homeNavigation(params: HomeSearchParams) {
  const initialTab: DashboardTab = params.tab === "import" ? "import" : "home";
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : undefined;
  const query = new URLSearchParams();
  if (initialTab === "import") query.set("tab", initialTab);
  if (workspaceId) query.set("workspaceId", workspaceId);
  const search = query.toString();
  return { initialTab, workspaceId, redirectTo: search ? `/?${search}` : "/" };
}
