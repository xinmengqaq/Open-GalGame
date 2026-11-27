/** 事实发生时的工程/场景/画布；切走之后迟到的动作靠它被丢弃。 */
export type WorkbenchActionScope = {
  projectId: string
  sceneId: string
  canvasId: string
}
