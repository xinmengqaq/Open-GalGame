import type { ConnectionTestVO, ModelListVO } from '../vo/ConnectionSettingsVO'
import type {
  ConnectionAccess,
  ConnectionExtension,
  ConnectionSettingsInfo
} from '@domain/settings/connections/models/ConnectionSettings'

export interface ModelConnectionGateway {
  testConnection(settings: ConnectionSettingsInfo): Promise<ConnectionTestVO>

  listModels(access: ConnectionAccess): Promise<ModelListVO>

  validateProviderOptions(
    providerId: ConnectionAccess['providerId'],
    extension: ConnectionExtension
  ): void
}
