import type { ConnectionSettingsDTO } from '@application/connections/dto/ConnectionSettingsDTO'

/**
 * 扩展 JSON 的供应商差异提示：只说明自定义 User-Agent 是否会被保留，不涉及具体请求头值。
 * OpenAI 兼容客户端由官方 SDK 生成请求，自定义同名头可能被覆盖；Anthropic 客户端保留。
 * @returns 当前供应商的简短提示。
 */
export function extensionProviderHint(providerId: ConnectionSettingsDTO['providerId']): string {
  return providerId === 'anthropic'
    ? 'Anthropic 会保留自定义 User-Agent。'
    : 'OpenAI 兼容下，自定义 User-Agent 可能被 SDK 覆盖。'
}
