import type { ConnectionSettingsDTO, ListModelsDTO } from '../dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '../vo/ConnectionSettingsVO'

export interface ConnectionSettingsApplicationService {
  /**
   * @returns 不含凭据的摘要。
   */
  getSettingsSummary(): Promise<ConnectionSettingsVO | null>

  testConnection(request: ConnectionSettingsDTO): Promise<ConnectionTestVO>

  saveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsVO>

  /**
   * 按当前地址与密钥拉取上游模型列表，不保存。
   * @param request - 协议、地址与密钥。
   */
  listModels(request: ListModelsDTO): Promise<ModelListVO>
}
