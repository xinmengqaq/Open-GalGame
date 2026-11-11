import type { PreviewErrorVO } from './PreviewErrorVO'
import type { SceneContentBasisVO } from './ScenePreviewSessionVO'

export type PreviewPhase = 'preparing' | 'playing' | 'paused' | 'completed' | 'unknown'

export type PreviewPositionVO =
  | { readonly kind: 'dialogue'; readonly dialogueId: string }
  | { readonly kind: 'nonDialogue' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'unknown' }

export type PreviewRuntimeStateVO = {
  readonly previewSessionId: string
  readonly contentBasis: SceneContentBasisVO
  readonly runtimeGeneration: number
  readonly sequence: number
  readonly phase: PreviewPhase
  readonly position: PreviewPositionVO
}

export type PreviewStageVO = PreviewRuntimeStateVO

export type PreviewConfirmedStateVO =
  | {
      readonly kind: 'known'
      readonly phase: PreviewPhase
      readonly position: PreviewPositionVO
    }
  | { readonly kind: 'unknown' }

export type PreviewRuntimeEventVO =
  | ({ readonly type: 'stage' } & PreviewRuntimeStateVO)
  | {
      readonly type: 'failed'
      readonly previewSessionId: string
      readonly contentBasis: SceneContentBasisVO
      readonly runtimeGeneration: number
      readonly sequence: number
      readonly failure: PreviewErrorVO
      readonly lastConfirmed: PreviewConfirmedStateVO
    }

export type PreviewRuntimeListener = (event: PreviewRuntimeEventVO) => void

export type PreviewStageResultVO =
  | { readonly status: 'ready'; readonly stage: PreviewStageVO; readonly stageUrl: string }
  | { readonly status: 'failed'; readonly failure: PreviewErrorVO }

export type PreviewCommandResultVO =
  | { readonly status: 'confirmed'; readonly stage: PreviewStageVO }
  | { readonly status: 'failed'; readonly failure: PreviewErrorVO }

export type PreviewDraftUnavailableReason =
  'runtimeNotPrepared' | 'runtimeNotReady' | 'staleRuntimeGeneration' | 'dialogueNotMounted'

export type PreviewDraftResultVO =
  | {
      readonly status: 'applied'
      readonly dialogueId: string
      readonly editRevision: number
      readonly runtimeGeneration: number
      readonly sequence: number
    }
  | {
      readonly status: 'unavailable'
      readonly reason: PreviewDraftUnavailableReason
    }
