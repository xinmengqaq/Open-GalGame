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

export class ManageConnectionSettings implements ConnectionSettingsApplicationService {
  constructor(private readonly deps: ConnectionSettingsDependencies) {}

  getSettingsSummary(): Promise<ConnectionSettingsVO | null> {
    return this.deps.settings.getSummary()
  }

  async testConnection(request: ConnectionSettingsDTO): Promise<ConnectionTestVO> {
    return this.deps.model.testConnection(await this.resolveSettings(request))
  }

  async saveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsVO> {
    return this.deps.settings.saveSettings(await this.resolveSettings(request))
  }

  async listModels(request: ListModelsDTO): Promise<ModelListVO> {
    const normalized = withExtension(request)
    const current = await this.loadCurrent(normalized)
    const access = resolveConnectionAccess({ input: normalized, current })
    const extension = resolveConnectionExtension(normalized.extension, current?.extension)
    if (extension) this.deps.model.validateProviderOptions(access.providerId, extension)
    return this.deps.model.listModels(extension ? { ...access, extension } : access)
  }

  private async resolveSettings(request: ConnectionSettingsDTO): Promise<ConnectionSettingsInfo> {
    const normalized = withExtension(request)
    const current = await this.loadCurrent(normalized)
    const settings = resolveConnectionSettings({ input: normalized, current })
    if (settings.extension)
      this.deps.model.validateProviderOptions(settings.providerId, settings.extension)
    return settings
  }

  private loadCurrent(request: {
    apiKey: ConnectionSettingsDTO['apiKey']
    extension: ConnectionExtensionInput
  }): Promise<ConnectionSettingsInfo | null> {
    if (request.apiKey.kind === 'keep' || request.extension.kind === 'keep')
      return this.deps.settings.loadSettings()
    return Promise.resolve(null)
  }
}

function withExtension<T extends { extension?: ConnectionExtensionInput }>(
  request: T
): T & { extension: ConnectionExtensionInput } {
  return { ...request, extension: request.extension ?? { kind: 'keep' } }
}
