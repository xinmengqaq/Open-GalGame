import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import { ReadLatestPreviewSaveUseCase } from '@application/scene-export/services/ReadLatestPreviewSaveUseCase'
import type { SceneExportApplicationService } from '@application/scene-export/services/SceneExportApplicationService'
import { SceneExportApplicationServiceImpl } from '@application/scene-export/services/impl/SceneExportApplicationServiceImpl'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import { LocalPreviewSaveVersionQueryGateway } from '@infrastructure/scene-export/LocalPreviewSaveVersionQueryGateway'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { TerreWindowsScenePackager } from '@infrastructure/scene-export/TerreWindowsScenePackager'

export type SceneExportBootstrapOptions = {
  readonly userDirectory: string
  readonly versioning: ProjectVersioningApplicationService
  readonly sources: ScenePreviewSourceGateway
}

/** 装配已保存场景导出与最近预览保存版本查询。不创建页面。 */
export interface SceneExportServices {
  readonly exportSavedScene: SceneExportApplicationService
  readonly latestPreviewSave: ReadLatestPreviewSaveUseCase
}

export function createSceneExport(options: SceneExportBootstrapOptions): SceneExportServices {
  return {
    exportSavedScene: new SceneExportApplicationServiceImpl({
      sources: new LocalSceneExportSourceGateway(
        options.userDirectory,
        options.versioning,
        options.sources
      ),
      packager: new TerreWindowsScenePackager(options.userDirectory)
    }),
    latestPreviewSave: new ReadLatestPreviewSaveUseCase(
      new LocalPreviewSaveVersionQueryGateway(options.userDirectory, options.versioning)
    )
  }
}
