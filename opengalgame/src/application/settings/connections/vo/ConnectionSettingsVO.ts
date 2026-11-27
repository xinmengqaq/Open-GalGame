export type ConnectionSettingsVO = {
  providerId: 'openai-compatible' | 'anthropic'
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  topP?: number
  hasApiKey: boolean
  hasExtension: boolean
}

export type ConnectionTestVO = {
  available: true
}

export type ModelListVO = {
  models: string[]
}
