export type WorkspaceView = { workspaceId: string | undefined; generation: number };
export type DashboardView = WorkspaceView & { tabGeneration: number };
export type BootstrapRequest = WorkspaceView & { revision: number; requestId: number };

export function isWorkspaceViewCurrent(origin: WorkspaceView, current: WorkspaceView): boolean {
  return origin.workspaceId === current.workspaceId && origin.generation === current.generation;
}

export function isDashboardViewCurrent(origin: DashboardView, current: DashboardView): boolean {
  return isWorkspaceViewCurrent(origin, current) && origin.tabGeneration === current.tabGeneration;
}

export function canApplyBootstrapResponse(request: BootstrapRequest, current: BootstrapRequest): boolean {
  return isWorkspaceViewCurrent(request, current) && request.revision === current.revision && request.requestId === current.requestId;
}
