import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  ReplySceneGenerationInteractionDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO
} from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { replyFingerprint } from '../../policies/SceneGenerationIdempotency'
export { safeFailure } from './SceneGenerationFailureFacts'
export { requireAcceptableCandidate as requireAcceptable } from '../../policies/SceneGenerationCandidatePolicy'

/** 形成不混淆工程、场景和操作的键。 */
export function operationKey(scope: SceneGenerationScopeDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.operationId])
}

export function threadKey(scope: SceneGenerationThreadDTO): string {
  return JSON.stringify([scope.projectId, scope.sceneId, scope.threadId])
}

/** 提取调用方需要的身份，避免以展开内部执行模型的方式泄露状态。 */
export function operationVO(execution: SceneGenerationOperationVO): SceneGenerationOperationVO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId
  }
}

export function replyReceipt(
  execution: SceneGenerationExecution,
  reply: ReplySceneGenerationInteractionDTO
): SceneGenerationReplyReceiptVO {
  return {
    ...operationVO(execution),
    interactionId: reply.interactionId,
    replyId: reply.replyId,
    accepted: true
  }
}

/**
 * @throws {AppException} 已提交操作缺少结果定位，须保留恢复记录。
 */
export function completedExecution(
  execution: SceneGenerationExecution,
  commitId: string
): SceneGenerationExecution {
  if (!execution.preview)
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '作品已经提交，但结果定位记录不完整'
    })
  return {
    ...execution,
    state: 'succeeded',
    step: undefined,
    live: undefined,
    interaction: undefined,
    pendingReply: undefined,
    failure: undefined,
    result: { ...operationVO(execution), commitId, preview: execution.preview }
  }
}

/**
 * 按安全字段提取历史详情，丢弃适配返回值可能附带的内部恢复状态。
 * @returns 不包含执行种子或原始图状态的详情。
 */
export function checkpointVO(view: SceneGenerationCheckpointVO): SceneGenerationCheckpointVO {
  return structuredClone({
    ...operationVO(view),
    checkpointId: view.checkpointId,
    phase: view.phase,
    summary: view.summary,
    decisions: view.decisions,
    differences: view.differences,
    preview: view.preview,
    canView: view.canView,
    canContinue: view.canContinue,
    reason: view.reason
  })
}

/** 按明确用例字段建立稳定请求指纹，归一默认值并忽略对象字段顺序。 */
export function generationFingerprint(
  request: GenerateSceneDTO | ForkSceneGenerationDTO | RetrySceneGenerationRepairDTO
): string {
  const fork = isForkRequest(request) ? request : undefined
  const generation = isGenerateRequest(request) ? request : undefined
  const selection = generation?.inputs ?? fork?.inputChanges
  return JSON.stringify({
    projectId: request.projectId,
    sceneId: request.sceneId,
    inputs: selection
      ? {
          canvasId: selection.canvasId,
          confirmedControls: selection.confirmedControls
        }
      : undefined,
    threadId: generation?.branch?.threadId ?? fork?.threadId,
    branchId: generation?.branch?.branchId ?? fork?.branchId,
    checkpointId: fork?.checkpointId,
    decisionChanges: fork?.decisionChanges?.map((decision) => ({
      interactionId: decision.interactionId,
      reply: replyFingerprint(decision.reply)
    })),
    repair: 'repair' in request ? request.repair : undefined,
    policy: {
      maxCorrections: request.policy.maxCorrections
    },
    reviewCandidate: 'reviewCandidate' in request ? (request.reviewCandidate ?? false) : false
  })
}

function isForkRequest(
  request: GenerateSceneDTO | ForkSceneGenerationDTO | RetrySceneGenerationRepairDTO
): request is ForkSceneGenerationDTO {
  return 'checkpointId' in request && !('repair' in request)
}

function isGenerateRequest(
  request: GenerateSceneDTO | ForkSceneGenerationDTO | RetrySceneGenerationRepairDTO
): request is GenerateSceneDTO {
  return 'inputs' in request
}
