import type { SavedSceneExportSource } from './SceneExportSourceGateway'
import type { SceneExportDestination } from './SceneExportDestinationGateway'
import type { WindowsScenePackageVO } from '../vo/SceneExportVO'

export type WindowsScenePackageResult =
  | { readonly status: 'succeeded'; readonly artifact: WindowsScenePackageVO }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'unavailable'
      readonly reason: 'windowsPackagerUnavailable'
      readonly message: string
    }

export interface WindowsScenePackager {
  /**
   * 调用已锁定的 Windows 桌面打包入口，把产物发布到目的地父目录下的场景子目录。
   * 已有同版本归属产物时校验后复用；同名无归属目录不覆盖。
   * 没有真实入口时返回不可用，不生成网页包或假可执行文件。
   */
  packageWindowsScene(
    source: SavedSceneExportSource,
    destination: SceneExportDestination
  ): Promise<WindowsScenePackageResult>

  /**
   * 校验缓存中的产物仍完整、归属本次版本和目的地。
   * 返回 false 时调用方必须重新打包，不能把旧结果当成成功。
   */
  verifyWindowsScene(
    source: SavedSceneExportSource,
    destination: SceneExportDestination,
    artifact: WindowsScenePackageVO
  ): Promise<boolean>
}
