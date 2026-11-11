import type { ExportSavedSceneDTO } from '../dto/ExportSavedSceneDTO'
import type { SceneExportResultVO } from '../vo/SceneExportVO'

export interface SceneExportApplicationService {
  /**
   * 导出当前已保存场景的 Windows 桌面产物。
   * 保存未成功时不打包；没有真实打包入口时返回不可用，不返回成功。
   */
  exportSavedScene(request: ExportSavedSceneDTO): Promise<SceneExportResultVO>
}
