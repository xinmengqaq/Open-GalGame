import type { ConnectionTestVO, ModelListVO } from '../vo/ConnectionSettingsVO'
import type {
  ConnectionAccess,
  ConnectionExtension,
  ConnectionSettingsInfo
} from '@domain/connections/models/ConnectionSettings'

export interface ModelConnectionGateway {
  /**
   * @param settings - 只在主进程使用的连接。
   */
  testConnection(settings: ConnectionSettingsInfo): Promise<ConnectionTestVO>

  /**
   * 按已解析的地址与密钥拉取上游模型 id 列表，不保存。
   * @param access - 只在主进程使用的访问凭据。
   */
  listModels(access: ConnectionAccess): Promise<ModelListVO>

  /**
   * 按当前供应商核对扩展对象是否真能进入 SDK 配置。
   * 不访问网络，也不改写对象。
   * @throws {AppException} 未知键、不会生效的键或值形状不合法。消息点名键名，不含值。
   */
  validateProviderOptions(
    providerId: ConnectionAccess['providerId'],
    extension: ConnectionExtension
  ): void
}
