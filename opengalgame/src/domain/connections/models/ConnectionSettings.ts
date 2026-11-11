export interface ConnectionAccess {
  providerId: 'openai-compatible' | 'anthropic'
  baseUrl: string
  apiKey: string
  extension?: ConnectionExtension
}

/** 已通过结构校验的扩展对象。键值语义由供应商校验解释，领域不引用 SDK。 */
export type ConnectionExtension = Readonly<Record<string, unknown>>

export interface ConnectionSettingsInfo extends ConnectionAccess {
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  topP?: number
}
