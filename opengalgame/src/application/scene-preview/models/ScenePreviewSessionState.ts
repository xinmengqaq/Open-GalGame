import type { ScenePreviewSourceFact } from './ScenePreviewSourceFact'

/**
 * 活动预览会话。
 * `runtimeGeneration` 在成功准备后从 1 递增；0 表示还没有舞台代次。
 * 保存成功后内容依据变化，代次继续递增，旧代次事件和命令随之作废。
 */
export type ScenePreviewSessionState = {
  readonly previewSessionId: string
  readonly source: ScenePreviewSourceFact
  readonly runtimeGeneration: number
  readonly lastSequence: number
  readonly prepared: boolean
  readonly closed: boolean
  readonly currentDialogueId?: string
}
