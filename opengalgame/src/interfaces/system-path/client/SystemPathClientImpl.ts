import type { OpenDirectoryDTO } from '@application/system-path/dto/OpenDirectoryDTO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import { parseOpenDirectoryResult } from '../contracts/SystemPathResponseSchema'
import type { SystemPathClient } from './SystemPathClient'

export class SystemPathClientImpl implements SystemPathClient {
  constructor(private readonly bridge: DesktopBridge) {}

  async openDirectory(request: OpenDirectoryDTO): Promise<AjaxResult<null>> {
    try {
      return (
        parseOpenDirectoryResult(await this.bridge.openDirectory(request)) ??
        communicationFailureResult()
      )
    } catch {
      return communicationFailureResult()
    }
  }
}
