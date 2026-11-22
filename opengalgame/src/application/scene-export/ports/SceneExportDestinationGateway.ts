import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

import type { SceneExportDestinationDTO } from '../dto/ExportSavedSceneDTO'
import type { SceneExportDirectoryChoiceVO } from '../vo/SceneExportDestinationVO'

/**
 * 主进程解析出的导出目的地。
 * 绝对路径只在应用、基础设施与主进程之间传递；表现层只拿到展示结果。
 */
export type SceneExportDestination = {
  readonly kind: 'workspace' | 'selected'
  /**
   * 产物父目录。打包器只在该目录下创建或复用 `scene-<版本摘要>` 子目录，
   * 不删除父目录本身。
   */
  readonly parentDirectory: string
  /**
   * 解析目的地时已登记工程的根目录，用于发布前复核目的地仍在授权边界内。
   * 绝对路径只在主进程/基础设施内传递。
   */
  readonly projectRoot: string
}

export interface SceneExportDestinationGateway {
  /**
   * 打开主进程的系统目录选择器。
   * 用户取消时返回 `canceled`；选中时校验并登记目录，返回绑定本次工程/场景的
   * selectionId。登记在 10 分钟内可重试复用，最多保留 8 条；取消不登记。
   */
  chooseParentDirectory(scene: SceneIdentity): Promise<SceneExportDirectoryChoiceVO>

  /**
   * 把请求中的目的地意向解析成父目录。
   * 缺省或 `workspace` 使用当前已登记工程的 `exports`；显式选择只接受未过期且
   * 绑定当前工程/场景的 selectionId。
   */
  resolveDestination(
    scene: SceneIdentity,
    intent: SceneExportDestinationDTO | undefined
  ): Promise<SceneExportDestination>
}
