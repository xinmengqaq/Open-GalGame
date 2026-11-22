import type { ChooseSceneExportDirectoryDTO } from '@application/scene-export/dto/ChooseSceneExportDirectoryDTO'
import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { ReadLatestSavedSceneVersionDTO } from '@application/scene-export/dto/ReadLatestSavedSceneVersionDTO'
import type { SceneExportDirectoryChoiceVO } from '@application/scene-export/vo/SceneExportDestinationVO'
import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseLatestSavedSceneVersionResult,
  parseSceneExportDirectoryChoiceResult,
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

  async readLatestSavedSceneVersion(
    request: ReadLatestSavedSceneVersionDTO
  ): Promise<AjaxResult<SavedSceneVersionVO | null>> {
    try {
      return (
        parseLatestSavedSceneVersionResult(
          await this.bridge.readLatestSavedSceneVersion(request)
        ) ?? communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async chooseSceneExportDirectory(
    request: ChooseSceneExportDirectoryDTO
  ): Promise<AjaxResult<SceneExportDirectoryChoiceVO>> {
    try {
      return (
        parseSceneExportDirectoryChoiceResult(
          await this.bridge.chooseSceneExportDirectory(request)
        ) ?? communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }
}
