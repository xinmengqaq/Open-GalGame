import type { DialogueTextEdit } from '@domain/scene-preview/models/DialogueTextEdit'

import type { ReadDialogueSaveSettlementDTO } from '../dto/DialogueSaveDTO'
import type { PreparedDialogueRevision } from './SceneDialogueRevisionGateway'
import type { DialogueSaveSettlementVO } from '../vo/DialogueSaveVO'
import type { PreviewErrorVO } from '../vo/PreviewErrorVO'
import type { SceneContentBasisVO } from '../vo/ScenePreviewSessionVO'

export const PREVIEW_SAVE_SOURCE_MODULE = 'scene-preview'
export const PREVIEW_SAVE_TARGET_KIND = 'scene-preview'

export type PreviewSaveCommitRequest = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
  readonly baseContentBasis: SceneContentBasisVO
  readonly editsSnapshot: string
  readonly committedEdits: readonly DialogueTextEdit[]
  readonly revision: PreparedDialogueRevision
}

export type PreviewSaveCommitResult =
  | { readonly status: 'committed'; readonly contentBasis: SceneContentBasisVO }
  | { readonly status: 'unchanged'; readonly contentBasis: SceneContentBasisVO }
  | { readonly status: 'pendingVerification' }
  | { readonly status: 'rejected'; readonly failure: PreviewErrorVO }

export interface PreviewSaveVersionGateway {
  /**
   * 只经通用版本边界提交预览正文。
   * `requestId` 绑定为 `scene-preview` 的调用方身份和 `editsSnapshot`；不使用生成提交或候选快照。
   * 同一身份和同一负载返回原结算，负载变化拒绝，证据不足只返回待核对。
   */
  commitPreviewSave(request: PreviewSaveCommitRequest): Promise<PreviewSaveCommitResult>

  /**
   * 按项目、场景和 `requestId` 读取持久结算，不依赖预览会话。
   * `editsSnapshot` 存在时，同一身份的不同负载必须返回 `conflict`，不能返回另一份结算。
   */
  readPreviewSaveSettlement(
    request: ReadDialogueSaveSettlementDTO & { readonly editsSnapshot?: string }
  ): Promise<DialogueSaveSettlementVO>

  /**
   * 在版本提交前记录确定拒绝。
   * 不准备、不发布版本；同一请求之后按原负载读取该拒绝。
   */
  recordPreviewSaveRefusal(request: {
    projectId: string
    sceneId: string
    requestId: string
    baseContentBasis: SceneContentBasisVO
    editsSnapshot: string
    committedEdits: readonly DialogueTextEdit[]
    failure: PreviewErrorVO
  }): Promise<void>
}
