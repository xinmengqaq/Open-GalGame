import type { SavedSceneExportSource } from './SceneExportSourceGateway'
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
   * 调用已锁定的 Windows 桌面打包入口。
   * 没有真实入口时返回不可用，不生成网页包或假可执行文件。
   */
  packageWindowsScene(source: SavedSceneExportSource): Promise<WindowsScenePackageResult>
}
