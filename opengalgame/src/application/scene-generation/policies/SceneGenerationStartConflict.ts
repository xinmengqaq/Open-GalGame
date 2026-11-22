import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'
import { isTerminalState } from '../mapping/SceneGenerationStateProjection'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export const SCENE_GENERATION_START_CONFLICT_MESSAGE = '当前场景已有进行中的生成，先完成或结束它'

export function isActiveGenerationExecution(
  execution: Pick<SceneGenerationExecution, 'mode' | 'state'>
): boolean {
  return execution.mode === 'generate' && !isTerminalState(execution.state)
}

export function requireNoActiveGeneration(executions: readonly SceneGenerationExecution[]): void {
  if (executions.some(isActiveGenerationExecution))
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: SCENE_GENERATION_START_CONFLICT_MESSAGE
    })
}
