import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

/**
 * 导出这一次已经保存成功的当前场景。
 * 请求只带场景身份、内容依据和预览保存引用，不带路径、命令、草稿或候选快照。
 * 身份字段直接列出，避免表现层经 DTO 间接依赖领域模型。
 */
export type ExportSavedSceneDTO = {
  readonly projectId: string
  readonly sceneId: string
  readonly contentBasis: SceneContentBasisVO
  readonly versionReference: {
    readonly kind: 'preview-save'
    readonly requestId: string
  }
}
