import type { ConnectionSettingsClient } from './ConnectionSettingsClient'
import type { DesktopBridge } from './DesktopBridge'
import { invokeAjaxResult } from './communicationFailure'
import type {
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/connections/dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '@application/connections/vo/ConnectionSettingsVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export class ConnectionSettingsClientImpl implements ConnectionSettingsClient {
  /**
   * @param bridge - 与主进程通信的固定桥接。
   */
  constructor(private readonly bridge: DesktopBridge) {}
  getSettingsSummary(): Promise<AjaxResult<ConnectionSettingsVO | null>> {
    return invokeAjaxResult(() => this.bridge.getSettingsSummary())
  }
  testConnection(request: ConnectionSettingsDTO): Promise<AjaxResult<ConnectionTestVO>> {
    return invokeAjaxResult(() => this.bridge.testConnection(request))
  }
  saveSettings(request: ConnectionSettingsDTO): Promise<AjaxResult<ConnectionSettingsVO>> {
    return invokeAjaxResult(() => this.bridge.saveSettings(request))
  }
  listModels(request: ListModelsDTO): Promise<AjaxResult<ModelListVO>> {
    return invokeAjaxResult(() => this.bridge.listModels(request))
  }
}
