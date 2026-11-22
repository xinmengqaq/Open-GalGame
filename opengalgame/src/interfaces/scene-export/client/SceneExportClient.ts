import type { ChooseSceneExportDirectoryDTO } from '@application/scene-export/dto/ChooseSceneExportDirectoryDTO'
import type { ReadLatestSavedSceneVersionDTO } from '@application/scene-export/dto/ReadLatestSavedSceneVersionDTO'
import type { SceneExportDirectoryChoiceVO } from '@application/scene-export/vo/SceneExportDestinationVO'
import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface SceneExportClient {
  exportSavedScene(request: ExportSavedSceneDTO): Promise<AjaxResult<SceneExportResultVO>>
  /** 读取该工程该场景最新可导出的正式保存版本；没有时为 null。 */
  readLatestSavedSceneVersion(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<AjaxResult<SavedSceneVersionVO | null>>
  /** 打开主进程目录选择器；取消返回 canceled，选中只回传 selectionId。 */
  chooseSceneExportDirectory(
    request: ChooseSceneExportDirectoryDTO
  ): Promise<AjaxResult<SceneExportDirectoryChoiceVO>>
}
