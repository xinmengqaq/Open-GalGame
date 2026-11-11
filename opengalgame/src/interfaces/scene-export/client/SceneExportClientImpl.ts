import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { ReadLatestPreviewSaveDTO } from '@application/scene-export/dto/ReadLatestPreviewSaveDTO'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import { parseOpenDirectoryResult } from '../../system-path/contracts/SystemPathResponseSchema'
import {
  parseLatestPreviewSaveResult,
  parseSceneExportResult
} from '../contracts/SceneExportResponseSchema'
import type { SceneExportClient } from './SceneExportClient'

export class SceneExportClientImpl implements SceneExportClient {
  constructor(private readonly bridge: DesktopBridge) {}

  async exportSavedScene(request: ExportSavedSceneDTO): Promise<AjaxResult<SceneExportResultVO>> {
    try {
      return (
        parseSceneExportResult(await this.bridge.exportSavedScene(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async readLatestPreviewSave(
    request: ReadLatestPreviewSaveDTO
  ): Promise<AjaxResult<PreviewSaveVersionVO | null>> {
    try {
      return (
        parseLatestPreviewSaveResult(await this.bridge.readLatestPreviewSave(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>> {
    try {
      return parseOpenDirectoryResult(await this.bridge.openDirectory(request)) ?? communicationFailureResult()
    } catch {
      return communicationFailureResult()
    }
  }
}
