import type { ReadLatestSavedSceneVersionDTO } from '../dto/ReadLatestSavedSceneVersionDTO'
import type { SceneExportContentBasis } from '../vo/SceneExportContentBasis'
import type { SceneExportVersionReference } from '../vo/SceneExportVO'

/** 一条当前仍可导出的正式保存版本；带记录时间用于比较先后。 */
export type SavedSceneVersionCandidate = {
  readonly projectId: string
  readonly sceneId: string
  readonly versionReference: SceneExportVersionReference
  readonly revisionDigest: string
  readonly contentBasis: SceneExportContentBasis
  /** 保存或正式提交的时间（毫秒）。 */
  readonly savedAtMs: number
}

export interface SavedSceneVersionQueryGateway {
  /**
   * 列出该工程该场景下当前内容仍与正式保存一致、且结算可核对的版本。
   * 损坏、过期、跨场景或无法核对的候选直接跳过。
   */
  listExportableSavedSceneVersions(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<readonly SavedSceneVersionCandidate[]>
}
