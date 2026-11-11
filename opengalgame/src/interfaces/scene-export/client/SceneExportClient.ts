import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'
import type { ReadLatestPreviewSaveDTO } from '@application/scene-export/dto/ReadLatestPreviewSaveDTO'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface SceneExportClient {
  exportSavedScene(request: ExportSavedSceneDTO): Promise<AjaxResult<SceneExportResultVO>>
  /** 读取该工程该场景最近一次已结算的预览保存版本；没有时为 null。 */
  readLatestPreviewSave(
    request: ReadLatestPreviewSaveDTO
  ): Promise<AjaxResult<PreviewSaveVersionVO | null>>
  /** 交给系统打开本机已存在的目录；服务端负责校验，客户端不接受任意命令。 */
  openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>>
}
