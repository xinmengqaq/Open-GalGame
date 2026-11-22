import type { ListUnfinishedSceneGenerationsDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import { isTerminalState } from '../../mapping/SceneGenerationStateProjection'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { operationKey } from '../../policies/SceneGenerationIdempotency'
import { canVerifyUnknownResult } from '../../policies/SceneGenerationRecoveryBoundary'
import { isActiveGenerationExecution } from '../../policies/SceneGenerationStartConflict'
import type {
  SceneGenerationRenderStatusVO,
  SceneGenerationUnfinishedPageVO
} from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { checkpointCanContinue } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

/** 响应 schema 的单数组上限；未完成页与历史页各自使用独立游标。 */
const MAX_PAGE_SIZE = 100

/**
 * 只读分页列出需要作者显式处理的操作：没有检查点的遗留、带检查点的写入/提交
 * 回执待核对，以及会阻止同场景新普通生成的非终态 generate（含等待审阅与安全暂停）。
 * 本用例不恢复、不写状态、不调用模型；单条检查点读取失败只降级该条。
 */
export class ListUnfinishedSceneGenerationsUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async listUnfinishedSceneGenerations(
    request: ListUnfinishedSceneGenerationsDTO
  ): Promise<SceneGenerationUnfinishedPageVO> {
    const limit = request.limit ?? MAX_PAGE_SIZE
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '需要处理的操作页大小必须为 1 到 100'
      })
    }
    // 仓储按场景返回全部记录，limit 只用于满足查询契约；筛选与分页在这里完成，
    // 不能先截断再筛选，否则较早的待核对记录会被活跃/终态记录挤出结果。
    const executions = await this.context.deps.executions.listSceneExecutions({
      projectId: request.projectId,
      sceneId: request.sceneId,
      limit: MAX_PAGE_SIZE
    })
    const ordered = executions
      .map((execution, appendIndex) => ({ execution, appendIndex }))
      .sort(byNewestThenLaterAppend)
    const start =
      request.cursor === undefined ? 0 : cursorStart(ordered, request.cursor)
    const actionable = ordered
      .slice(start)
      .filter(({ execution }) => needsAuthorAction(execution))
    const page = actionable.slice(0, limit)
    const capabilities = this.context.deps.workflow.capabilities()
    const statuses: SceneGenerationRenderStatusVO[] = []
    for (const { execution } of page) {
      statuses.push(
        toRenderStatusVO(
          execution,
          await checkpointCanContinueOf(this.context, execution),
          capabilities,
          this.context.coordinator.activeExecutions.has(operationKey(execution))
        )
      )
    }
    const last = page.at(-1)
    return actionable.length > page.length && last !== undefined
      ? { items: statuses, nextCursor: last.execution.operationId }
      : { items: statuses }
  }
}

/**
 * 没有检查点的遗留按原语义发现；带检查点的写入/提交回执不明仍可核对。
 * 另外，所有会阻止同场景新普通生成的非终态 generate（含等待审阅与安全暂停）
 * 也进入发现列表：它们不因此获得继续/核对资格，只让作者能从历史选中并按原权限处理。
 */
function needsAuthorAction(execution: SceneGenerationExecution): boolean {
  if (isTerminalState(execution.state)) return false
  if (isActiveGenerationExecution(execution)) return true
  if (execution.checkpointId === undefined) return true
  return canVerifyUnknownResult(execution, false)
}

/** 游标定位在完整时间序上，游标条目后来变为终态也仍能继续读取更早条目。 */
function cursorStart(
  ordered: readonly { execution: SceneGenerationExecution }[],
  cursor: string
): number {
  const index = ordered.findIndex(({ execution }) => execution.operationId === cursor)
  if (index < 0)
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '需要处理的操作游标不存在' })
  return index + 1
}

/** 最新记录在前；时间相同时，持久追加更后的操作在前。 */
function byNewestThenLaterAppend(
  left: { execution: SceneGenerationExecution; appendIndex: number },
  right: { execution: SceneGenerationExecution; appendIndex: number }
): number {
  const leftTime = left.execution.updatedAt ?? left.execution.timeline?.at(-1)?.createdAt ?? ''
  const rightTime = right.execution.updatedAt ?? right.execution.timeline?.at(-1)?.createdAt ?? ''
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
  return right.appendIndex - left.appendIndex
}

/**
 * 单条检查点不可读时只让该条失去继续资格，不影响同页其它操作被发现。
 * 待核对的合成检查点往往本来就没有可读文件，走同一降级路径。
 */
async function checkpointCanContinueOf(
  context: SceneGenerationServiceContext,
  execution: SceneGenerationExecution
): Promise<boolean> {
  try {
    return await checkpointCanContinue(context.deps, execution)
  } catch {
    return false
  }
}
