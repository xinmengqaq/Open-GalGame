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
  commitPreviewSave(request: PreviewSaveCommitRequest): Promise<PreviewSaveCommitResult>

  readPreviewSaveSettlement(
    request: ReadDialogueSaveSettlementDTO & { readonly editsSnapshot?: string }
  ): Promise<DialogueSaveSettlementVO>

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
