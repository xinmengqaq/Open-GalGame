import type { ConnectionSettingsClient } from './ConnectionSettingsClient'
import type {
  ConnectionSettingsDTO,
  ListModelsDTO
} from '@application/settings/connections/dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '@application/settings/connections/vo/ConnectionSettingsVO'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { invokeAjaxResult } from '@interfaces/client/communicationFailure'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export class ConnectionSettingsClientImpl implements ConnectionSettingsClient {
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
