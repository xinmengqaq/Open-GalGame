import type { ConnectionSettingsDTO, ListModelsDTO } from '../dto/ConnectionSettingsDTO'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '../vo/ConnectionSettingsVO'

export interface ConnectionSettingsApplicationService {
  getSettingsSummary(): Promise<ConnectionSettingsVO | null>

  testConnection(request: ConnectionSettingsDTO): Promise<ConnectionTestVO>

  saveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsVO>

  listModels(request: ListModelsDTO): Promise<ModelListVO>
}
