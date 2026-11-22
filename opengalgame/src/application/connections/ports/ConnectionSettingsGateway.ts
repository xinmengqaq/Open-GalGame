import type { ConnectionSettingsVO } from '../vo/ConnectionSettingsVO'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

export interface ConnectionSettingsGateway {
  getSummary(): Promise<ConnectionSettingsVO | null>

  loadSettings(): Promise<ConnectionSettingsInfo | null>

  saveSettings(settings: ConnectionSettingsInfo): Promise<ConnectionSettingsVO>
}
