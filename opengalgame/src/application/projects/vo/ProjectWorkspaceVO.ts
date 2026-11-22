export type ProjectWorkspaceVO = {
  projectId: string
  sceneId: string
  canvasId: string
}

export type ProjectWorkspaceInspectionVO = {
  ready: boolean
  sceneId?: string
  canvasId?: string
}
