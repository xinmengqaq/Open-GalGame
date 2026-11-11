import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'
import { isTerminalState } from '../mapping/SceneGenerationStateProjection'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 同一场景只允许一个进行中的生成。应用层预检与仓储兜底共用这一文案；
 * 表现层受分层边界限制不能导入应用层常量，使用同一字面量并由测试断言一致。
 */
export const SCENE_GENERATION_START_CONFLICT_MESSAGE = '当前场景已有进行中的生成，先完成或结束它'

/** 分叉、修复等模式不占用生成位置；只有非终态的 generate 才阻塞新的生成。 */
export function isActiveGenerationExecution(
  execution: Pick<SceneGenerationExecution, 'mode' | 'state'>
): boolean {
  return execution.mode === 'generate' && !isTerminalState(execution.state)
}

/** 启动前预检场景内是否已有进行中的生成；旧格式记录没有 mode，不参与判定。 */
export function requireNoActiveGeneration(
  executions: readonly SceneGenerationExecution[]
): void {
  if (executions.some(isActiveGenerationExecution))
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: SCENE_GENERATION_START_CONFLICT_MESSAGE
    })
}
