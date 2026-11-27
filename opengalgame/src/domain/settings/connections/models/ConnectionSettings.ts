export interface ConnectionAccess {
  providerId: 'openai-compatible' | 'anthropic'
  baseUrl: string
  apiKey: string
  extension?: ConnectionExtension
}

export type ConnectionExtension = Readonly<Record<string, unknown>>

export interface ConnectionSettingsInfo extends ConnectionAccess {
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  topP?: number
}
