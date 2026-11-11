import type { ConnectionSettingsVO } from '../vo/ConnectionSettingsVO'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

export interface ConnectionSettingsGateway {
  /**
   * @returns 无设置时为 null。
   */
  getSummary(): Promise<ConnectionSettingsVO | null>

  /**
   * 只读加载并解密已保存的内部设置。
   * @returns 内部配置；未保存时为 null。
   */
  loadSettings(): Promise<ConnectionSettingsInfo | null>

  saveSettings(settings: ConnectionSettingsInfo): Promise<ConnectionSettingsVO>
}
