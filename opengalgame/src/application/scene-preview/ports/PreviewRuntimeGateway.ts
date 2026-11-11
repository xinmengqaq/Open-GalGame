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

/**
 * 保存成功后内容依据已经换代。
 * 旧代次命令、快照和事件必须作废，后续定位使用新的依据和代次。
 */
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
  /**
   * 绑定工程并等待目标场景事实。
   * 只证明舞台已连接，不证明已定位到目标台词。
   */
  prepare(request: PreparePreviewRuntimeRequest): Promise<PreviewStageResultVO>

  /**
   * 保存成功后切换会话的内容依据和运行时代次。
   * 旧代次的在途命令、快照和事件不得再确认或转发。
   */
  rebaseSession(request: RebasePreviewRuntimeRequest): Promise<void>

  /**
   * 只替换当前会话的场景入口文本。
   * 旧修订、错属会话和摘要不一致时拒绝，不写源。
   */
  setSceneTextOverlay(request: SceneTextOverlayRequest): Promise<void>

  /** 返回当前宿主已接受的覆盖修订；没有覆盖时返回 0。 */
  currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number>

  clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void>

  /**
   * 用官方 sync-scene 定位到指定台词。
   * 空命令响应和未到达的快照都不算成功。
   */
  playDialogue(request: PlayPreviewDialogueRequest): Promise<PreviewCommandResultVO>
  /**
   * 按会话、内容依据、代次和序号发布事件。
   * 旧代次事件不交给监听器。
   */
  subscribe(scope: PreviewSessionRef, listener: PreviewRuntimeListener): () => void

  release(scope: PreviewSessionRef): Promise<void>
}

export type SceneOverlayRejectCode =
  | 'staleRuntimeGeneration'
  | 'contentBasisChanged'
  | 'invalidRequest'
  | 'sessionNotFound'
  | 'sessionClosed'

/** 宿主拒绝场景覆盖。调用方必须保留 code，不能改写成舞台未就绪或定位未到达。 */
export class SceneOverlayRejected extends Error {
  readonly name = 'SceneOverlayRejected'

  constructor(readonly code: SceneOverlayRejectCode) {
    super('场景覆盖不可用')
  }
}
