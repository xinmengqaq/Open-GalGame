import type { WorkbenchActionScope } from './actionObserverScope'

/** 试玩预览开始一次保存；requestId 用于区分迟到的确认、失败和清除。 */
export type DialogueSaveStartedAction = {
  scope: WorkbenchActionScope
  requestId: string
}

/** 试玩预览直接保存成功；同一 requestId 只应上报一次。 */
export type DialogueSavedAction = {
  scope: WorkbenchActionScope
  requestId: string
  revision: number
  outcome: 'confirmed'
}

/** 保存失败或结果待核对；只显示原位状态，不推进。 */
export type DialogueSaveUnsettledAction = {
  scope: WorkbenchActionScope
  requestId?: string
  outcome: 'failed' | 'unverified'
}

/** 预览里出现或消除了真实未保存改词；只传有无，不传正文。 */
export type DialogueDraftChangedAction = {
  scope: WorkbenchActionScope
  dirty: boolean
}

/** 未处理的保存已结束：核对为无改动，或用户明确放弃草稿退出。 */
export type DialogueSaveClearedAction = {
  scope: WorkbenchActionScope
  requestId?: string
  reason: 'unchanged' | 'abandoned'
}

export interface WorkbenchPreviewActionObservers {
  onDialogueSaveStarted?: (event: DialogueSaveStartedAction) => void
  onDialogueSaved?: (event: DialogueSavedAction) => void
  onDialogueSaveUnsettled?: (event: DialogueSaveUnsettledAction) => void
  onDialogueDraftChanged?: (event: DialogueDraftChangedAction) => void
  onDialogueSaveCleared?: (event: DialogueSaveClearedAction) => void
}
