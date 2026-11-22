import type { ChooseSceneExportDirectoryService } from '@application/scene-export/services/ChooseSceneExportDirectory'
import type { ReadLatestSavedSceneVersionService } from '@application/scene-export/services/ReadLatestSavedSceneVersionUseCase'
import type { SceneExportApplicationService } from '@application/scene-export/services/SceneExportApplicationService'
import type { SceneExportDirectoryChoiceVO } from '@application/scene-export/vo/SceneExportDestinationVO'
import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  chooseSceneExportDirectorySchema,
  exportSavedSceneSchema,
  readLatestSavedSceneVersionSchema
} from './SceneExportRequestSchema'

export class SceneExportController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly sceneExport: SceneExportApplicationService,
    private readonly latestSavedSceneVersion: ReadLatestSavedSceneVersionService,
    private readonly chooseDirectory: ChooseSceneExportDirectoryService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  exportSavedScene(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneExportResultVO>> {
    return this.handle(exportSavedSceneSchema, input, access, '场景导出已返回', (request) =>
      this.sceneExport.exportSavedScene(request)
    )
  }

  readLatestSavedSceneVersion(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SavedSceneVersionVO | null>> {
    return this.handle(
      readLatestSavedSceneVersionSchema,
      input,
      access,
      '最新可导出正式版本已返回',
      (request) => this.latestSavedSceneVersion.readLatestSavedSceneVersion(request)
    )
  }

  chooseSceneExportDirectory(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneExportDirectoryChoiceVO>> {
    return this.handle(
      chooseSceneExportDirectorySchema,
      input,
      access,
      '导出位置选择已返回',
      (request) => this.chooseDirectory.chooseSceneExportDirectory(request)
    )
  }
}
