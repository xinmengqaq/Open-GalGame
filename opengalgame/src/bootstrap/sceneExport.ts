import type { ProjectVersioningApplicationService } from '@application/project-versioning/services/ProjectVersioningApplicationService'
import {
  ChooseSceneExportDirectory,
  type ChooseSceneExportDirectoryService
} from '@application/scene-export/services/ChooseSceneExportDirectory'
import { ReadLatestSavedSceneVersionUseCase } from '@application/scene-export/services/ReadLatestSavedSceneVersionUseCase'
import type { SceneExportApplicationService } from '@application/scene-export/services/SceneExportApplicationService'
import { ExportSavedScene } from '@application/scene-export/services/impl/ExportSavedScene'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { LocalSavedSceneVersionQueryGateway } from '@infrastructure/scene-export/LocalSavedSceneVersionQueryGateway'
import { LocalSceneExportDestinationGateway } from '@infrastructure/scene-export/LocalSceneExportDestinationGateway'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { TerreWindowsScenePackager } from '@infrastructure/scene-export/TerreWindowsScenePackager'

export type SceneExportBootstrapOptions = {
  readonly userDirectory: string
  readonly logger: LoggerGateway
  readonly versioning: ProjectVersioningApplicationService
  readonly sources: ScenePreviewSourceGateway
  /** 主进程系统目录选择器；取消返回 null。浏览器开发模式注入系统命令实现。 */
  readonly chooseDirectory: () => Promise<string | null>
  /** 应用安装、资源或用户状态目录；不得被选作导出父目录。 */
  readonly protectedRoots?: readonly string[]
}

/** 装配已保存场景导出、最新可导出正式版本查询与目录选择。不创建页面。 */
export interface SceneExportServices {
  readonly exportSavedScene: SceneExportApplicationService
  readonly latestSavedSceneVersion: ReadLatestSavedSceneVersionUseCase
  readonly chooseDestination: ChooseSceneExportDirectoryService
}

export function createSceneExport(options: SceneExportBootstrapOptions): SceneExportServices {
  const destinations = new LocalSceneExportDestinationGateway({
    userDirectory: options.userDirectory,
    chooseDirectory: options.chooseDirectory,
    ...(options.protectedRoots === undefined
      ? {}
      : { protectedRoots: options.protectedRoots })
  })
  return {
    exportSavedScene: new ExportSavedScene({
      sources: new LocalSceneExportSourceGateway(
        options.userDirectory,
        options.versioning,
        options.sources
      ),
      destinations,
      packager: new TerreWindowsScenePackager(
        options.logger,
        options.userDirectory,
        options.protectedRoots ?? []
      )
    }),
    latestSavedSceneVersion: new ReadLatestSavedSceneVersionUseCase(
      new LocalSavedSceneVersionQueryGateway(
        options.userDirectory,
        options.versioning,
        options.sources
      )
    ),
    chooseDestination: new ChooseSceneExportDirectory(destinations)
  }
}
