import type { ConnectionExtension } from '@domain/settings/connections/models/ConnectionSettings'

interface ProviderClientControls {
  baseURL: string
  apiKey: string
  fetch: typeof fetch
  maxRetries: 0
}

export function mergeProviderClientOptions(
  extension: ConnectionExtension | undefined,
  controls: ProviderClientControls,
  timeout?: number
): ConnectionExtension & ProviderClientControls & { authToken: null; timeout?: number } {
  return {
    ...extension,
    baseURL: controls.baseURL,
    apiKey: controls.apiKey,
    fetch: controls.fetch,
    ...(timeout !== undefined ? { timeout } : {}),
    maxRetries: controls.maxRetries,
    authToken: null
  }
}
