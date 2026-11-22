import type { ConnectionSettingsDTO } from '@application/connections/dto/ConnectionSettingsDTO'

export function extensionProviderHint(providerId: ConnectionSettingsDTO['providerId']): string {
  return providerId === 'anthropic'
    ? 'Anthropic 会保留自定义 User-Agent。'
    : 'OpenAI 兼容下，自定义 User-Agent 可能被 SDK 覆盖。'
}
