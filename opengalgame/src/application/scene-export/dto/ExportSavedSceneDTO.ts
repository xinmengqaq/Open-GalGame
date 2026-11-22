import type { SceneExportContentBasis } from '../vo/SceneExportContentBasis'
import type { SceneExportVersionReference } from '../vo/SceneExportVO'

/**
 * 导出目的地意向：只表达“工程默认位置”或“主进程保存过的目录选择”。
 * 表现层不携带绝对路径，避免绕过主进程选址。
 */
export type SceneExportDestinationDTO =
  | {
      readonly kind: 'workspace'
    }
  | {
      readonly kind: 'selected'
      readonly selectionId: string
    }

/**
 * 导出这一次已经保存成功的当前场景。
 * 请求只带场景身份、内容依据、正式版本引用和目的地意向，不带路径、命令、草稿或候选快照。
 * 身份字段直接列出，避免表现层经 DTO 间接依赖领域模型。
 */
export type ExportSavedSceneDTO = {
  readonly projectId: string
  readonly sceneId: string
  readonly contentBasis: SceneExportContentBasis
  readonly versionReference: SceneExportVersionReference
  /**
   * 缺省等同工程默认位置。
   * 显式选择目录时只带主进程签发的 selectionId（10 分钟内可重试复用），不带路径。
   */
  readonly destination?: SceneExportDestinationDTO
}
