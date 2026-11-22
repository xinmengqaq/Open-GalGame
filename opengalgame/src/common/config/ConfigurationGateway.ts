import type { RuntimeConfig } from './RuntimeConfig'

export interface ConfigurationGateway {
  getSnapshot(): Readonly<RuntimeConfig>
}
