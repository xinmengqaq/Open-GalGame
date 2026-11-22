import type { ExportSavedSceneDTO } from '../dto/ExportSavedSceneDTO'
import type { SceneExportResultVO } from '../vo/SceneExportVO'

export interface SceneExportApplicationService {
  exportSavedScene(request: ExportSavedSceneDTO): Promise<SceneExportResultVO>
}
