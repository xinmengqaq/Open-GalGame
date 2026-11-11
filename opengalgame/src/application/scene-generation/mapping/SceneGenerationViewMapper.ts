import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'
import type { ReplySceneGenerationInteractionDTO } from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO,
  SceneGenerationStatusVO
} from '../vo/SceneGenerationVO'
import { publicFailureOf } from '../services/impl/SceneGenerationFailureFacts'
import { isTerminalState, phaseOf } from './SceneGenerationStateProjection'

export function toOperationVO(execution: SceneGenerationOperationVO): SceneGenerationOperationVO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId
  }
}

/** 映射安全状态，隐藏路径、输入快照和内部检查点数据。 */
export function toStatusVO(
  execution: SceneGenerationExecution,
  running: boolean
): SceneGenerationStatusVO {
  return structuredClone({
    ...toOperationVO(execution),
    state: execution.state,
    phase: phaseOf(execution.state, execution.step),
    attempt: execution.attempt,
    sequence: execution.sequence,
    canResume: !running && !isTerminal(execution) && execution.state !== 'waiting',
    // running 时上一轮审阅交互已结算，状态查询不能继续返回旧入口；waiting 仍必须返回。
    interaction: execution.state === 'running' ? undefined : execution.interaction,
    result: execution.result,
    failure: execution.failure
      ? publicFailureOf(
          {
            ...execution.failure,
            ...(execution.candidateSnapshotId
              ? { candidateSnapshotId: execution.candidateSnapshotId }
              : {}),
            ...((execution.state === 'failed' || execution.state === 'cancelled') &&
            execution.candidateSnapshotId
              ? {
                  previewAuthorization:
                    execution.artifactValidation?.issues.length === 0 ? 'readOnly' : 'unavailable'
                }
              : {})
          },
          execution.interruptReason === 'commitUnknown'
        )
      : undefined,
    rollbackCommitId: execution.rollbackCommitId,
    checkpointId: execution.checkpointId,
    candidateSnapshotId: execution.candidateSnapshotId
  })
}

export function toReplyReceipt(
  execution: SceneGenerationExecution,
  reply: ReplySceneGenerationInteractionDTO
): SceneGenerationReplyReceiptVO {
  return {
    ...toOperationVO(execution),
    interactionId: reply.interactionId,
    replyId: reply.replyId,
    accepted: true
  }
}

export function toCheckpointVO(view: SceneGenerationCheckpointVO): SceneGenerationCheckpointVO {
  return structuredClone({
    ...toOperationVO(view),
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

export function isTerminal(execution: SceneGenerationExecution): boolean {
  return isTerminalState(execution.state)
}
