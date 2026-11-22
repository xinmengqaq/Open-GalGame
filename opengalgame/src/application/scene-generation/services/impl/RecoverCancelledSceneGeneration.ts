import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { isTerminal } from '../../mapping/SceneGenerationViewMapper'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import type { ActiveSceneGeneration } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

/** 工程打开时只结算已受理取消；失败计数留给调用方记录，不阻断打开工程。 */
export type SceneGenerationCancellationRecoveryResult = {
  readonly attempted: number
  readonly failed: number
}

/**
 * 复用无活动执行时的既有取消清理，处理上次退出时停在取消受理但未收尾的操作。
 * 只读本工程执行记录；不开启模型、不新建提交、不扫描其它工程。
 */
export class RecoverCancelledSceneGeneration {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  /**
   * @returns 本次尝试清理的操作数及其中未完成的个数；单个失败不阻断后续操作。
   * @throws {AppException} 工程执行记录整体不可读。
   */
  async recoverCancelledProject(
    projectId: string
  ): Promise<SceneGenerationCancellationRecoveryResult> {
    const executions = await this.context.deps.executions.listProjectExecutions(projectId)
    let attempted = 0
    let failed = 0
    for (const execution of executions) {
      if (!needsCancellationCleanup(execution)) continue
      if (this.context.coordinator.activeExecutions.has(operationKey(execution))) continue
      attempted += 1
      try {
        await this.context.coordinator.serialize(threadKey(execution), async () => {
          const current = await this.context.deps.executions.readExecution(execution)
          if (!current || !needsCancellationCleanup(current)) return
          if (this.context.coordinator.activeExecutions.has(operationKey(current))) return
          const cancellation: ActiveSceneGeneration = {
            execution: current,
            controller: new AbortController()
          }
          cancellation.controller.abort(
            new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })
          )
          await this.context.coordinator.recoverFailure(
            cancellation,
            new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' }),
            true,
            false
          )
        })
      } catch {
        // 失败保持 interrupted/requiresCleanup，后续打开或真实取消入口可再次尝试。
        failed += 1
      }
    }
    return { attempted, failed }
  }
}

/**
 * 只处理已受理取消且在退出时没有完成清理的记录。终态和结果不明中不应清理的记录跳过。
 */
function needsCancellationCleanup(execution: SceneGenerationExecution): boolean {
  if (execution.cancellationRequested !== true || isTerminal(execution)) return false
  // 写入或提交回执不明的现场不能由自动取消清理删除；等待证据核对。
  if (
    execution.interruptReason === 'writeUnknown' ||
    execution.interruptReason === 'commitUnknown'
  )
    return false
  return (
    execution.state === 'cancelling' ||
    (execution.state === 'interrupted' && execution.requiresCleanup === true)
  )
}
