import type { BootstrapData, BootstrapMetadata, BootstrapScope, DashboardTab } from "../shared/types";

export function bootstrapScopeForTab(tab: DashboardTab): BootstrapScope {
  return tab === "import" || tab === "settings" || tab === "analytics" ? "metadata" : "full";
}

/** Keep transaction data only when the metadata belongs to the same workspace. */
export function mergeBootstrapMetadata(current: BootstrapData, next: BootstrapMetadata): BootstrapData | null {
  if (!next.selected) return { ...next, selected: null };
  if (!current.selected || current.selected.workspace.id !== next.selected.workspace.id) return null;
  return { ...next, selected: { ...current.selected, ...next.selected } };
}
