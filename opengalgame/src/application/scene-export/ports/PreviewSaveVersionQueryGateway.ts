import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { ReadLatestPreviewSaveDTO } from '../dto/ReadLatestPreviewSaveDTO'

/** 单条已结算的预览保存记录；带记录时间用于比较先后。 */
export type PreviewSaveVersionCandidate = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
  readonly revisionDigest: string
  readonly contentBasis: SceneContentBasisVO
  /** 保存记录文件的最后修改时间（毫秒）。 */
  readonly savedAtMs: number
}

export interface PreviewSaveVersionQueryGateway {
  /**
   * 列出该工程该场景下已结算为已提交或无变更、且带内容摘要的预览保存记录。
   * 损坏或无法核对的记录直接跳过。
   */
  listSettledPreviewSaves(
    request: ReadLatestPreviewSaveDTO
  ): Promise<readonly PreviewSaveVersionCandidate[]>
}
