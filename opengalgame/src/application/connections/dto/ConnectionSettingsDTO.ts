export type ConnectionExtensionInput =
  { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'clear' }

export type ConnectionSettingsDTO = {
  providerId: 'openai-compatible' | 'anthropic'
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  topP?: number
  apiKey: { kind: 'keep' } | { kind: 'replace'; value: string }
  extension?: ConnectionExtensionInput
}

export type ListModelsDTO = {
  providerId: 'openai-compatible' | 'anthropic'
  baseUrl: string
  apiKey: { kind: 'keep' } | { kind: 'replace'; value: string }
  extension?: ConnectionExtensionInput
}
