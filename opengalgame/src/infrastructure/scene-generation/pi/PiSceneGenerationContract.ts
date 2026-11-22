import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ForkSceneGenerationDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { ForkSourceEvidence } from '@application/scene-generation/ports/SceneGenerationForkSourceEvidence'
import { replyFingerprint } from '@application/scene-generation/policies/SceneGenerationIdempotency'
import { repairContextIssue } from '@application/scene-generation/policies/SceneGenerationRepairContextPolicy'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { CandidateWriteReplay } from './PiSceneGenerationTypes'

/**
 * 校验执行记录已绑定工作区和目标入口，修复重跑还需持有来源上下文。
 * @throws {AppException} 输入不完整或模式不属于本阶段。
 */
export function validateExecution(execution: SceneGenerationExecution): SceneGenerationExecution {
  if (!execution.workspace || !execution.source.sceneDirectory || !execution.source.entryFile)
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '生成执行缺少候选工作区或场景入口'
    })
  if (!execution.inputSnapshot)
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '生成执行缺少输入快照' })
  if (execution.mode !== undefined && execution.mode !== 'generate' && execution.mode !== 'repair')
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '当前生成入口只接受新的生成或修复重跑操作'
    })
  const issue = repairContextIssue(execution)
  if (issue !== undefined) throw new AppException({ code: ErrorCodes.invalidRequest, msg: issue })
  return execution
}

/**
 * 分叉执行必须带来源身份和复制出的候选；普通生成、修复重跑或旧记录不能冒充。
 * @throws {AppException} 身份缺失、分支未更换或缺候选。
 */
export function validateForkExecution(
  execution: SceneGenerationExecution,
  request: ForkSceneGenerationDTO
): SceneGenerationExecution {
  const checked = validateExecution(execution)
  if (!checked.fork || !checked.forkRequest)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '当前操作不是带来源身份的分叉执行'
    })
  if (checked.repairSource !== undefined)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '修复重跑不能复用分叉入口'
    })
  if (checked.operationId !== request.operationId)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '分叉请求与当前操作不一致'
    })
  if (checked.candidateSnapshotId === undefined)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '分叉执行缺少复制的候选修订'
    })
  return checked
}

/**
 * 来源证据必须与请求所指的分支、检查点、候选修订以及当前分叉记录一致。
 * 证据本身已由不可变修订独立核对；这里不再读取来源操作当前的检查点或候选。
 * @throws {AppException} 来源身份、候选或输入摘要已变化。
 */
export function requireForkSource(
  execution: SceneGenerationExecution,
  evidence: ForkSourceEvidence,
  request: ForkSceneGenerationDTO
): void {
  const fork = execution.fork
  const forkRequest = execution.forkRequest
  if (!fork || !forkRequest)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '分叉执行缺少来源身份'
    })
  const conflict = (msg: string): never => {
    throw new AppException({ code: ErrorCodes.operationConflict, msg })
  }
  if (
    fork.projectId !== request.projectId ||
    fork.sceneId !== request.sceneId ||
    fork.threadId !== request.threadId ||
    fork.branchId !== request.branchId ||
    fork.checkpointId !== request.checkpointId
  )
    conflict('分叉来源身份与请求不一致')
  if (
    forkRequest.projectId !== execution.projectId ||
    forkRequest.sceneId !== execution.sceneId ||
    forkRequest.threadId !== execution.threadId ||
    forkRequest.operationId !== execution.operationId ||
    forkRequest.branchId !== fork.branchId ||
    forkRequest.checkpointId !== fork.checkpointId
  )
    conflict('分叉请求与执行记录不一致')
  if (execution.branchId === fork.branchId) conflict('分叉必须创建新分支')
  if (fork.sourceOperationId === undefined) conflict('分叉执行缺少来源操作身份')
  if (
    evidence.operationId !== execution.operationId ||
    evidence.projectId !== execution.projectId ||
    evidence.sceneId !== execution.sceneId ||
    evidence.threadId !== execution.threadId
  )
    conflict('分叉来源证据不属于当前操作')
  if (
    evidence.sourceOperationId !== fork.sourceOperationId ||
    evidence.sourceBranchId !== fork.branchId ||
    evidence.checkpointId !== fork.checkpointId ||
    evidence.candidateSnapshotId !== fork.candidateSnapshotId
  )
    conflict('分叉来源证据与请求身份不一致')
  if (
    evidence.sourceOperationId === execution.operationId ||
    evidence.sourceBranchId === execution.branchId
  )
    conflict('分叉来源必须来自另一操作与分支')
  if (evidence.revision.revisionId !== evidence.candidateSnapshotId)
    conflict('来源候选修订证据不一致')
}

/**
 * 回复续跑必须仍绑定应用已接受的等待、当前候选和同一回复记录。
 * 丢弃由应用边界直接结算，不进入工作流续跑；写前整组回答必须在原操作首次生成。
 * @throws {AppException} 待回复缺失、候选已变化、等待已结束或回复未可靠保存。
 */
export function validateContinuation(
  execution: SceneGenerationExecution,
  answeredWriteReplay?: CandidateWriteReplay
): SceneGenerationExecution {
  const checked = validateExecution(execution)
  const pending = checked.pendingReply
  if (!pending)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '当前没有可继续的人工回复'
    })
  if (pending.reply.kind === 'discard')
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '丢弃回复由应用边界结算，不能继续生成'
    })
  const interaction = checked.interaction
  if (interaction && interaction.interactionId !== pending.interactionId)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '该人工等待已结束、已回复或已过期'
    })
  const recorded = checked.replies.find((reply) => reply.replyId === pending.replyId)
  if (
    !recorded ||
    recorded.interactionId !== pending.interactionId ||
    replyFingerprint(recorded.reply) !== replyFingerprint(pending.reply)
  )
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '人工回复未可靠保存，请重新提交'
    })
  if (pending.reply.kind === 'answers') {
    // 题组只在写前存在；候选出现后旧回答不能覆盖新候选。
    // 唯一例外：持久写账本已证明该候选正是这次回答写出的修订，此时只重放结算。
    if (
      checked.candidateSnapshotId !== undefined &&
      checked.candidateSnapshotId !== answeredWriteReplay?.candidateSnapshotId
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选已存在，旧题组已失效，请按候选继续修改或重新生成'
      })
    if (pending.candidateSnapshotId !== undefined)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '创作回答不能绑定候选修订'
      })
    if (checked.repairSource !== undefined || checked.mode === 'repair')
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '修复重跑不能再回答写前问题'
      })
    if (interaction === undefined) {
      // 运行开始时会清空上一轮交互；此时只能依据应用已持久化的整组选项事实。
      if (!confirmedAnswerFacts(pending))
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '创作回答缺少服务端确认的选项事实，请重新提交'
        })
      return checked
    }
    if (interaction.kind !== 'decision' || (interaction.questions?.length ?? 0) === 0)
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '当前等待不接受整组创作回答'
      })
    if (interaction.candidateSnapshotId !== undefined)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选已存在，旧题组已失效，请按候选继续修改或重新生成'
      })
    if (!selectionsCover(interaction.questions ?? [], pending.selections))
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '创作回答与当前提问不一致'
      })
    return checked
  }
  if (!checked.candidateSnapshotId)
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '当前操作没有可继续的候选'
    })
  if (
    pending.reply.kind === 'accept' &&
    pending.candidateSnapshotId !== checked.candidateSnapshotId
  )
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: '候选内容已变化，请重新审阅'
    })
  if (pending.reply.kind === 'accept' && interaction && interaction.kind !== 'review')
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '当前等待不允许接受候选'
    })
  return checked
}

/** 题组答案必须由服务端按当前题目构造，且题号唯一、不跨题。 */
function selectionsCover(
  questions: readonly { readonly questionId: string }[],
  selections: readonly { readonly questionId: string }[] | undefined
): boolean {
  if (!selections || selections.length !== questions.length) return false
  const ids = new Set(selections.map((item) => item.questionId))
  if (ids.size !== selections.length) return false
  return questions.every((question) => ids.has(question.questionId))
}

/**
 * 交互已被运行清空时，仍需整组服务端事实才能继续；不能用请求里的题号或选项冒充。
 */
function confirmedAnswerFacts(
  pending: NonNullable<SceneGenerationExecution['pendingReply']>
): boolean {
  const selections = pending.selections
  if (!selections || selections.length < 1 || selections.length > 4) return false
  if (pending.reply.kind !== 'answers' || selections.length !== pending.reply.answers.length)
    return false
  const ids = new Set(selections.map((item) => item.questionId))
  return ids.size === selections.length
}
