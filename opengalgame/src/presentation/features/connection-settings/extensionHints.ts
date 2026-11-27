import type { ConnectionSettingsDTO } from '@application/settings/connections/dto/ConnectionSettingsDTO'

export function extensionProviderHint(providerId: ConnectionSettingsDTO['providerId']): string {
  return providerId === 'anthropic'
    ? 'Anthropic 会保留自定义 User-Agent。'
    : 'OpenAI 兼容连接可能忽略自定义 User-Agent。'
}
