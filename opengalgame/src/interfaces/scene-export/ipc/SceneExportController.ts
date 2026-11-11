import type { ReadLatestPreviewSaveService } from '@application/scene-export/services/ReadLatestPreviewSaveUseCase'
import type { SceneExportApplicationService } from '@application/scene-export/services/SceneExportApplicationService'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  exportSavedSceneSchema,
  readLatestPreviewSaveSchema
} from './SceneExportRequestSchema'

export class SceneExportController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly sceneExport: SceneExportApplicationService,
    private readonly latestPreviewSave: ReadLatestPreviewSaveService,
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

  readLatestPreviewSave(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<PreviewSaveVersionVO | null>> {
    return this.handle(
      readLatestPreviewSaveSchema,
      input,
      access,
      '最近一次预览保存已返回',
      (request) => this.latestPreviewSave.readLatestPreviewSave(request)
    )
  }
}
