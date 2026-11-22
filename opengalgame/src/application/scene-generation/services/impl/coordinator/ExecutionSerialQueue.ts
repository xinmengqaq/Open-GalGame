import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  SceneGenerationExecutionRepository
} from '@application/scene-generation/ports/SceneGenerationExecutionRepository'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class ExecutionSerialQueue {
  private readonly serialTails = new Map<string, Promise<void>>()

  constructor(private readonly executions: SceneGenerationExecutionRepository) {}

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
