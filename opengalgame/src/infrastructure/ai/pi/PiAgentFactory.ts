import type * as PiAgentCore from '@earendil-works/pi-agent-core'

import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

import { PiAgentExecutor } from './PiAgentExecutor'
import { PiModelFactory, type PiModelCreationRequest } from './PiModelFactory'

/**
 * 按产品连接设置创建 Pi 执行器。
 *
 * 工厂只加载 Pi 的 ESM 模块和模型元数据，不发起模型请求。
 * 每次 `create` 绑定当前已保存设置；设置变化后应重新创建。
 */
export class PiAgentFactory {
  private agentModule?: Promise<typeof PiAgentCore>

  constructor(
    private readonly models: PiModelFactory,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * 读取已保存连接设置并创建执行器。构造过程不访问网络。
   * @param request - 用户级超时和本次覆盖。
   * @throws {AppException} 没有可用设置、密钥为空或参数不合法；模块加载失败原样抛出。
   */
  async create(request: PiModelCreationRequest = {}): Promise<PiAgentExecutor> {
    const [runtime, module] = await Promise.all([
      this.models.create(request),
      this.loadAgentModule()
    ])
    return new PiAgentExecutor({
      runtime,
      createAgent: (options) => new module.Agent(options),
      now: this.now
    })
  }

  /**
   * 使用显式产品设置创建执行器，不从环境补足连接字段。
   * @param settings - 已保存的连接设置。
   * @param request - 用户级超时和本次覆盖。
   */
  async createWithSettings(
    settings: ConnectionSettingsInfo,
    request: PiModelCreationRequest = {}
  ): Promise<PiAgentExecutor> {
    const [runtime, module] = await Promise.all([
      this.models.createFromSettings(settings, request),
      this.loadAgentModule()
    ])
    return new PiAgentExecutor({
      runtime,
      createAgent: (options) => new module.Agent(options),
      now: this.now
    })
  }

  /**
   * 首次使用时动态加载 ESM 包。CJS 主进程不能用 require 加载它，也不能把它静态打进主 bundle。
   * @returns 缓存的模块命名空间。
   */
  private loadAgentModule(): Promise<typeof PiAgentCore> {
    this.agentModule ??= import('@earendil-works/pi-agent-core')
    return this.agentModule
  }
}
