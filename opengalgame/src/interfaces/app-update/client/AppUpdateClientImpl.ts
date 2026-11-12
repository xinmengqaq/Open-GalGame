import type {
  CheckForUpdateDTO,
  DownloadUpdateDTO,
  InstallUpdateDTO,
  ReadUpdateStatusDTO
} from '@application/app-update/dto/AppUpdateDTO'
import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseInstallUpdateResult,
  parseUpdateCheckResult,
  parseUpdateStatusEvent,
  parseUpdateStatusResult
} from '../contracts/AppUpdateResponseSchema'
import type { AppUpdateClient } from './AppUpdateClient'

export class AppUpdateClientImpl implements AppUpdateClient {
  constructor(private readonly bridge: DesktopBridge) {}

  async checkForUpdate(request: CheckForUpdateDTO): Promise<AjaxResult<UpdateCheckVO>> {
    try {
      return (
        parseUpdateCheckResult(await this.bridge.checkForUpdate(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async downloadUpdate(request: DownloadUpdateDTO): Promise<AjaxResult<UpdateStatusVO>> {
    try {
      return (
        parseUpdateStatusResult(await this.bridge.downloadUpdate(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async installUpdate(request: InstallUpdateDTO): Promise<AjaxResult<null>> {
    try {
      return (
        parseInstallUpdateResult(await this.bridge.installUpdate(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  async readUpdateStatus(request: ReadUpdateStatusDTO): Promise<AjaxResult<UpdateStatusVO>> {
    try {
      return (
        parseUpdateStatusResult(await this.bridge.readUpdateStatus(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }

  onStatus(listener: (status: UpdateStatusVO) => void): () => void {
    if (typeof this.bridge.onAppUpdateStatus !== 'function') return () => undefined
    return this.bridge.onAppUpdateStatus((value) => {
      const status = parseUpdateStatusEvent(value)
      if (status !== null) listener(status)
    })
  }
}
