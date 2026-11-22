import type { PreviewDialoguePlaybackDTO, PreviewSessionRef } from '../dto/PreviewPlaybackDTO'
import type { SceneContentBasisVO } from '../vo/ScenePreviewSessionVO'
import type {
  PreviewCommandResultVO,
  PreviewRuntimeListener,
  PreviewStageResultVO
} from '../vo/PreviewRuntimeVO'
import type { ParsedScene } from '../../scenes/models/ParsedScene'

export type PreparePreviewRuntimeRequest = {
  readonly previewSessionId: string
  readonly contentBasis: SceneContentBasisVO
  readonly runtimeGeneration: number
  readonly projectRoot: string
  readonly entryFile: string
  readonly scene: ParsedScene
  readonly dialogueId: string
}

export type RebasePreviewRuntimeRequest = {
  readonly previewSessionId: string
  readonly contentBasis: SceneContentBasisVO
  readonly runtimeGeneration: number
  readonly scene: ParsedScene
}

export type SceneTextOverlayRequest = {
  readonly previewSessionId: string
  readonly sceneFileName: string
  readonly editRevision: number
  readonly text: string
  readonly digest: string
  readonly runtimeGeneration: number
}

export type SceneTextOverlayScope = {
  readonly previewSessionId: string
  readonly runtimeGeneration?: number
}
export type PlayPreviewDialogueRequest = PreviewDialoguePlaybackDTO & {
  readonly scene: ParsedScene
}

export interface PreviewRuntimeGateway {
  prepare(request: PreparePreviewRuntimeRequest): Promise<PreviewStageResultVO>

  rebaseSession(request: RebasePreviewRuntimeRequest): Promise<void>

  setSceneTextOverlay(request: SceneTextOverlayRequest): Promise<void>

  currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number>

  clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void>

  playDialogue(request: PlayPreviewDialogueRequest): Promise<PreviewCommandResultVO>
  subscribe(scope: PreviewSessionRef, listener: PreviewRuntimeListener): () => void

  release(scope: PreviewSessionRef): Promise<void>
}

export type SceneOverlayRejectCode =
  | 'staleRuntimeGeneration'
  | 'contentBasisChanged'
  | 'invalidRequest'
  | 'sessionNotFound'
  | 'sessionClosed'

export class SceneOverlayRejected extends Error {
  readonly name = 'SceneOverlayRejected'

  constructor(readonly code: SceneOverlayRejectCode) {
    super('场景覆盖不可用')
  }
}
