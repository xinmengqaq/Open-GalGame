import type {
  ConnectionExtensionInput,
  ConnectionSettingsDTO,
  ListModelsDTO
} from '../../dto/ConnectionSettingsDTO'
import type { ConnectionSettingsGateway } from '../../ports/ConnectionSettingsGateway'
import type { ModelConnectionGateway } from '../../ports/ModelConnectionGateway'
import type {
  ConnectionSettingsVO,
  ConnectionTestVO,
  ModelListVO
} from '../../vo/ConnectionSettingsVO'
import type { ConnectionSettingsApplicationService } from '../ConnectionSettingsApplicationService'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import {
  resolveConnectionAccess,
  resolveConnectionExtension,
  resolveConnectionSettings
} from '@domain/connections/services/resolveConnectionSettings'

interface ConnectionSettingsDependencies {
  readonly settings: ConnectionSettingsGateway
  readonly model: ModelConnectionGateway
}

export class ConnectionSettingsApplicationServiceImpl implements ConnectionSettingsApplicationService {
  constructor(private readonly deps: ConnectionSettingsDependencies) {}

  /**
   * @returns 不含密钥的摘要，未保存时为 null。
   */
  getSettingsSummary(): Promise<ConnectionSettingsVO | null> {
    return this.deps.settings.getSummary()
  }

  /**
   * 解析当前草稿并测试，不执行保存。
   * @param request - 当前连接草稿与密钥使用方式。
   * @throws {AppException} 草稿不合法、密钥不可用或模型访问失败。
   */
  async testConnection(request: ConnectionSettingsDTO): Promise<ConnectionTestVO> {
    return this.deps.model.testConnection(await this.resolveSettings(request))
  }

  /**
   * 解析并持久化设置，不隐式测试连接。
   * @param request - 当前连接草稿与密钥使用方式。
   * @throws {AppException} 草稿不合法、密钥不可用或持久化失败。
   */
  async saveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsVO> {
    return this.deps.settings.saveSettings(await this.resolveSettings(request))
  }

  /**
   * 解析访问凭据并拉取上游模型列表，不执行保存。
   * @param request - 服务协议、地址与密钥使用方式。
   * @throws {AppException} 访问凭据不合法或模型列表读取失败。
   */
  async listModels(request: ListModelsDTO): Promise<ModelListVO> {
    const normalized = withExtension(request)
    const current = await this.loadCurrent(normalized)
    const access = resolveConnectionAccess({ input: normalized, current })
    const extension = resolveConnectionExtension(normalized.extension, current?.extension)
    if (extension) this.deps.model.validateProviderOptions(access.providerId, extension)
    return this.deps.model.listModels(extension ? { ...access, extension } : access)
  }

  /** 结合已保存配置将草稿解析为内部设置，并按当前供应商校验扩展。 */
  private async resolveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsInfo> {
    const normalized = withExtension(request)
    const current = await this.loadCurrent(normalized)
    const settings = resolveConnectionSettings({ input: normalized, current })
    if (settings.extension)
      this.deps.model.validateProviderOptions(settings.providerId, settings.extension)
    return settings
  }

  /**
   * 保留密钥或保留扩展都要读已保存设置。两者都是替换时不读。
   * 未带扩展字段按保留处理，避免未改界面把已存扩展清空。
   */
  private loadCurrent(request: {
    apiKey: ConnectionSettingsDTO['apiKey']
    extension: ConnectionExtensionInput
  }): Promise<ConnectionSettingsInfo | null> {
    if (request.apiKey.kind === 'keep' || request.extension.kind === 'keep')
      return this.deps.settings.loadSettings()
    return Promise.resolve(null)
  }
}

/** 缺省扩展表示保留，不把“请求没带字段”当成清空。 */
function withExtension<T extends { extension?: ConnectionExtensionInput }>(
  request: T
): T & { extension: ConnectionExtensionInput } {
  return { ...request, extension: request.extension ?? { kind: 'keep' } }
}
