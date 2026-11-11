import type { DialogueTextEditDTO } from '../dto/DialogueSaveDTO'
import type { PreviewErrorVO } from './PreviewErrorVO'
import type { PreviewStageVO } from './PreviewRuntimeVO'
import type { SceneContentBasisVO } from './ScenePreviewSessionVO'

export type DialogueSaveRequestIdentityVO = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
}

export type PreviewUpdateUnavailableReason =
  'stageNeverPrepared' | 'runtimeNotReady' | 'sessionClosed'

export type PreviewKeptStageVO = PreviewStageVO & {
  readonly position: Extract<PreviewStageVO['position'], { kind: 'dialogue' }>
}

export type PreviewUpdateVO =
  | { readonly status: 'kept'; readonly stage: PreviewKeptStageVO }
  | { readonly status: 'failed'; readonly failure: PreviewErrorVO }
  | { readonly status: 'unavailable'; readonly reason: PreviewUpdateUnavailableReason }

export type SaveDialogueChangesVO =
  | {
      readonly status: 'saved'
      readonly contentBasis: SceneContentBasisVO
      /**
       * 保存后的运行时依据已经换代。
       * 0 表示保存时还没有可用的舞台代次；后续定位必须使用这里返回的代次。
       */
      readonly runtimeGeneration: number
      readonly committedEdits: readonly DialogueTextEditDTO[]
      readonly previewUpdate: PreviewUpdateVO
    }
  | {
      readonly status: 'unchanged'
      readonly contentBasis: SceneContentBasisVO
      readonly confirmedEdits: readonly DialogueTextEditDTO[]
    }
  | {
      readonly status: 'pendingVerification'
      readonly request: DialogueSaveRequestIdentityVO
      readonly failure: PreviewErrorVO
    }
  | {
      readonly status: 'rejected'
      readonly failure: PreviewErrorVO
    }

export type DialogueSaveSettlementVO =
  | {
      readonly status: 'saved'
      readonly contentBasis: SceneContentBasisVO
      readonly committedEdits: readonly DialogueTextEditDTO[]
    }
  | {
      readonly status: 'unchanged'
      readonly contentBasis: SceneContentBasisVO
      readonly confirmedEdits: readonly DialogueTextEditDTO[]
    }
  | {
      readonly status: 'pendingVerification'
      readonly request: DialogueSaveRequestIdentityVO
      readonly failure: PreviewErrorVO
    }
  | {
      readonly status: 'notCommitted'
      readonly request: DialogueSaveRequestIdentityVO
      readonly failure: PreviewErrorVO
    }
  | {
      readonly status: 'conflict'
      readonly request: DialogueSaveRequestIdentityVO
      readonly failure: PreviewErrorVO
    }
  | {
      readonly status: 'notFound'
      readonly request: DialogueSaveRequestIdentityVO
    }
