import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'

import type { ScenePreviewSourceFact } from '../models/ScenePreviewSourceFact'

export type PreparedDialogueRevision = {
  readonly relativePath: string
  readonly bytes: Uint8Array
  readonly digest: string
}

export interface SceneDialogueRevisionGateway {
  /**
   * 按同一份源快照准备替换后的正文字节。
   * 没有可精确替换的正文范围时失败，不写盘，不提交。
   */
  prepareDialogueRevision(
    source: ScenePreviewSourceFact,
    plan: DialogueEditPlan
  ): Promise<PreparedDialogueRevision>
}
