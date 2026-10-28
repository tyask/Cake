import type { BootstrapData, BootstrapMetadata, BootstrapScope, DashboardTab } from "../shared/types";

const scopes: Record<DashboardTab, BootstrapScope> = {
  home: "metadata", transactions: "metadata", import: "metadata", analytics: "metadata", settings: "metadata",
};

export function bootstrapScopeForTab(tab: DashboardTab): BootstrapScope {
  return scopes[tab];
}

/** Keep transaction data only when the metadata belongs to the same workspace. */
export function mergeBootstrapMetadata(current: BootstrapData, next: BootstrapMetadata): BootstrapData | null;
export function mergeBootstrapMetadata(current: BootstrapMetadata, next: BootstrapMetadata): BootstrapMetadata | null;
export function mergeBootstrapMetadata(current: BootstrapMetadata, next: BootstrapMetadata): BootstrapMetadata | null {
  if (!next.selected) return { ...next, selected: null };
  if (!current.selected || current.selected.workspace.id !== next.selected.workspace.id) return null;
  return { ...next, selected: { ...current.selected, ...next.selected } };
}
