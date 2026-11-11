import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

/**
 * 最近一次已结算的预览保存版本引用。
 * 只包含导出所需的可核对身份与内容依据，不暴露路径或编辑内容。
 */
export type PreviewSaveVersionVO = {
  readonly requestId: string
  readonly revisionDigest: string
  readonly contentBasis: SceneContentBasisVO
}
