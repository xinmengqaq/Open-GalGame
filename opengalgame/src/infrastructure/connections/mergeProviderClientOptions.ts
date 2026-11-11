import type { ConnectionExtension } from '@domain/connections/models/ConnectionSettings'

/** 扩展先展开，随后由应用值覆盖。LangChain 还会再覆盖其中一部分。 */
interface ProviderClientControls {
  baseURL: string
  apiKey: string
  fetch: typeof fetch
  maxRetries: 0
}

/**
 * 扩展先进入 SDK 配置，再写回应用控制的地址、凭据、超时和 fetch。
 * `defaultHeaders`、`defaultQuery`、`fetchOptions`、`logLevel` 原样保留。
 * 不在这里标成某一份 SDK 的 `ClientOptions`：LangChain 内嵌的 Anthropic SDK
 * 与应用直接依赖的 Anthropic SDK 不是同一类型，交叉后不能再传给构造器。
 * 调用前应已通过 `validateProviderOptions`；这里仍覆盖控制键，避免旧文件绕过校验。
 * 未给出超时时不写入该字段，避免 SDK 用自身默认超时补上。
 */
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
