import type { RuntimeConfig } from './RuntimeConfig'

export interface ConfigurationGateway {
  /**
   * @returns 启动时已校验的只读配置。调用时不再读盘。
   */
  getSnapshot(): Readonly<RuntimeConfig>
}
