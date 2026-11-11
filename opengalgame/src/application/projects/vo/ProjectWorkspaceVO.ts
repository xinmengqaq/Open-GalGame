/** 已持久化的默认场景和画布身份。不包含路径或版本状态。 */
export type ProjectWorkspaceVO = {
  projectId: string
  sceneId: string
  canvasId: string
}

/**
 * 只读工作区检查。
 * 只含是否就绪，以及已经持久化、可以引用的场景和画布身份。
 * 不含路径、缺失清单、版本状态或锁内容。
 */
export type ProjectWorkspaceInspectionVO = {
  ready: boolean
  sceneId?: string
  canvasId?: string
}
