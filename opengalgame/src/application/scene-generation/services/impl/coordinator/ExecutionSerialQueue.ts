import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneGenerationExecutionRepository
} from '@application/scene-generation/ports/SceneGenerationExecutionRepository'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 短操作串行队列与操作幂等回放。
 * 模型执行只经后台任务边界进入，不排入这里。
 */
export class ExecutionSerialQueue {
  private readonly serialTails = new Map<string, Promise<void>>()

  constructor(private readonly executions: SceneGenerationExecutionRepository) {}

  /** 仅串行启动、回复和状态变更，不把模型执行放入队列；失败不阻断后续短操作。 */
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.serialTails.get(key) ?? Promise.resolve()).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.serialTails.set(key, tail)
    void tail.then(() => {
      if (this.serialTails.get(key) === tail) this.serialTails.delete(key)
    })
    return result
  }

  /**
   * 返回相同请求的操作，拒绝相同标识对应其他请求。
   * @param fingerprint - 不含密钥的请求内容。
   * @returns 已有操作或 null。
   * @throws {AppException} 相同操作标识被用于不同请求。
   */
  async replay(
    scope: SceneGenerationScopeDTO,
    fingerprint: string
  ): Promise<SceneGenerationExecution | null> {
    const previous = await this.executions.readExecution(scope)
    if (previous && previous.fingerprint !== fingerprint)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一操作标识对应的请求内容不一致'
      })
    return previous
  }
}
